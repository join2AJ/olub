package app.olub.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import android.content.ContentValues;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import android.widget.LinearLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;

import java.util.ArrayList;
import java.util.List;

/**
 * The Olub Android app. The screens are the bundled web files (the same ones the
 * server serves); this shell gives them camera (QR scan, documents), microphone
 * (in-app calls), GPS, sharing and background ride tracking.
 */
public class MainActivity extends Activity {
    private static final String APP_URL = "https://appassets.androidplatform.net/index.html";
    private static final int REQ_FILE = 1;
    private static final int REQ_WEB_PERMS = 2;
    private static final int REQ_GEO = 3;
    private static final int REQ_TRACKING = 4;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingWebRequest;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String[] pendingTracking;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        // Android 15 draws apps behind the status and navigation bars. Keep the screens clear of both
        // (and of the keyboard): green strip under the status bar, white strip under the bottom bar.
        final LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF0F7B4A);
        final View bottomStrip = new View(this);
        bottomStrip.setBackgroundColor(0xFFFFFFFF);
        root.addView(web, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(bottomStrip, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0));
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, 0);
            bottomStrip.getLayoutParams().height = Math.max(bars.bottom, ime.bottom);
            bottomStrip.requestLayout();
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Test builds may reach a plain-http server on the same Wi-Fi; release builds are https only.
        s.setMixedContentMode(BuildConfig.DEBUG ? WebSettings.MIXED_CONTENT_ALWAYS_ALLOW : WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                // tel:, upi:, mailto: and outside links open in their own apps.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { /* no app for this link */ }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                List<String> need = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) need.add(Manifest.permission.CAMERA);
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
                }
                List<String> missing = missing(need);
                if (missing.isEmpty()) {
                    request.grant(request.getResources());
                } else {
                    pendingWebRequest = request;
                    requestPermissions(missing.toArray(new String[0]), REQ_WEB_PERMS);
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_GEO);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/pdf"});
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a photo or document"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "OlubNative");
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(APP_URL);
    }

    /** Functions the web screens can call as window.OlubNative.*  */
    private class Bridge {
        @JavascriptInterface
        public String defaultServer() {
            return BuildConfig.DEFAULT_SERVER;
        }

        @JavascriptInterface
        public void share(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(send, "Share"));
        }

        @JavascriptInterface
        public void saveText(String name, String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_SUBJECT, name);
            send.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(send, name));
        }

        /** Save a download (invoice picture, Excel sheet, data export) into the phone's Downloads/Olub folder. */
        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64) {
            String message;
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Olub");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) throw new IllegalStateException("no destination");
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) { out.write(data); }
                    message = "Saved to Downloads/Olub: " + safe;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File f = new File(dir, safe);
                    try (OutputStream out = new FileOutputStream(f)) { out.write(data); }
                    message = "Saved: " + f.getAbsolutePath();
                }
            } catch (Exception e) {
                message = "Could not save the file";
            }
            final String shown = message;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, shown, Toast.LENGTH_LONG).show());
        }

        @JavascriptInterface
        public void startTracking(final String server, final String token, final String tripId) {
            runOnUiThread(() -> {
                pendingTracking = new String[]{server, token, tripId};
                List<String> need = new ArrayList<>();
                need.add(Manifest.permission.ACCESS_FINE_LOCATION);
                if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS);
                List<String> missing = missing(need);
                if (missing.isEmpty() || has(Manifest.permission.ACCESS_FINE_LOCATION) && TrackingService.isRunningFor(tripId)) launchTracking();
                else requestPermissions(missing.toArray(new String[0]), REQ_TRACKING);
            });
        }

        @JavascriptInterface
        public void stopTracking() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, TrackingService.class)));
        }
    }

    private void launchTracking() {
        if (pendingTracking == null || !has(Manifest.permission.ACCESS_FINE_LOCATION)) return;
        if (TrackingService.isRunningFor(pendingTracking[2])) return;
        Intent i = new Intent(this, TrackingService.class)
                .putExtra("server", pendingTracking[0])
                .putExtra("token", pendingTracking[1])
                .putExtra("tripId", pendingTracking[2]);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception ignored) { /* the in-page GPS watcher still works while the app is open */ }
    }

    private boolean has(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private List<String> missing(List<String> permissions) {
        List<String> out = new ArrayList<>();
        for (String p : permissions) if (!has(p)) out.add(p);
        return out;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_WEB_PERMS && pendingWebRequest != null) {
            List<String> granted = new ArrayList<>();
            for (String r : pendingWebRequest.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) granted.add(r);
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) granted.add(r);
            }
            if (granted.isEmpty()) pendingWebRequest.deny();
            else pendingWebRequest.grant(granted.toArray(new String[0]));
            pendingWebRequest = null;
        } else if (requestCode == REQ_GEO && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, has(Manifest.permission.ACCESS_FINE_LOCATION) || has(Manifest.permission.ACCESS_COARSE_LOCATION), false);
            pendingGeoCallback = null;
        } else if (requestCode == REQ_TRACKING) {
            launchTracking();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        // Back closes an open sheet first; otherwise the app goes to the background (a ride keeps tracking).
        web.evaluateJavascript(
                "(function(){var r=document.getElementById('sheet-root');if(r&&r.children.length){r.innerHTML='';return 1}"
                        + "var a=document.getElementById('alarm');if(a&&!a.hidden){a.hidden=true;return 1}return 0})()",
                value -> { if (!"1".equals(value)) moveTaskToBack(true); });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }
}
