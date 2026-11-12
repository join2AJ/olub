package app.olub.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sends the phone's GPS position to the Olub server during a ride, so the
 * customer's trusted contact can follow it even when the screen is off.
 * Stops when the ride ends (the app calls stopTracking) or the server says the ride is over.
 */
public class TrackingService extends Service implements LocationListener {
    private static final String CHANNEL = "olub_tracking";
    private static final long MIN_INTERVAL_MS = 8000;
    private static volatile String runningTripId;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private LocationManager locations;
    private String server, token, tripId;
    private long lastSent;

    static boolean isRunningFor(String tripId) {
        return tripId != null && tripId.equals(runningTripId);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        server = intent.getStringExtra("server");
        token = intent.getStringExtra("token");
        tripId = intent.getStringExtra("tripId");
        runningTripId = tripId;

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.tracking_channel), NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setSmallIcon(R.drawable.ic_stat_olub)
                .setContentTitle(getString(R.string.tracking_title))
                .setContentText(getString(R.string.tracking_text))
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(1, n);
        } catch (Exception e) { stopSelf(); return START_NOT_STICKY; }

        locations = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            locations.removeUpdates(this);
            if (locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_INTERVAL_MS, 5f, this);
            }
            if (locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locations.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_INTERVAL_MS * 2, 20f, this);
            }
        } catch (SecurityException e) { stopSelf(); }
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onLocationChanged(Location loc) {
        long now = System.currentTimeMillis();
        if (now - lastSent < MIN_INTERVAL_MS - 500) return;
        lastSent = now;
        final String body = String.format(Locale.US, "{\"lat\":%.6f,\"lng\":%.6f,\"kmph\":%s}",
                loc.getLatitude(), loc.getLongitude(), loc.hasSpeed() ? String.format(Locale.US, "%.1f", loc.getSpeed() * 3.6f) : "null");
        io.execute(() -> post(body));
    }

    private void post(String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(server + "/api/trips/" + tripId + "/location").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + token);
            try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            // Logged out or the ride no longer exists: stop quietly.
            if (code == 401 || code == 404) stopSelf();
        } catch (Exception ignored) {
            // No signal: skip this point, the next one will go through.
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onProviderDisabled(String provider) { }

    @Override
    public void onDestroy() {
        runningTripId = null;
        if (locations != null) locations.removeUpdates(this);
        io.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
