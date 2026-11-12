'use strict';

const C = require('./config');
const { haversineKm } = require('./geo');

const secs = (s) => Number(String(s || '0s').replace('s', '')) || 0;

function fallbackBand(date) {
  // India Standard Time, regardless of server timezone.
  const h = (date.getUTCHours() + 5.5) % 24;
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 'peak';
  if ((h >= 7 && h < 8) || (h >= 11 && h < 17) || (h >= 21 && h < 22)) return 'shoulder';
  return 'off';
}

/** Estimate without a maps provider: straight line × factor + time-of-day traffic. */
function fallbackRoute(src, dst, when = new Date()) {
  const distanceKm = haversineKm(src, dst) * C.ROAD_FACTOR;
  const freeFlowMin = (distanceKm / C.FREE_FLOW_KMPH) * 60;
  const band = fallbackBand(when);
  const delayMin = distanceKm * C.FALLBACK_DELAY_MIN_PER_KM[band];
  return {
    distanceKm, freeFlowMin, delayMin, etaMin: freeFlowMin + delayMin,
    source: 'estimate', trafficLabel: { peak: 'Heavy (rush hour)', shoulder: 'Moderate', off: 'Light' }[band],
    polyline: null,
  };
}

function trafficLabel(delayMin, freeFlowMin) {
  const r = freeFlowMin > 0 ? delayMin / freeFlowMin : 0;
  return r > 0.5 ? 'Heavy' : r > 0.2 ? 'Moderate' : 'Light';
}

/**
 * Road distance and live-traffic delay between two points.
 * Uses Google Routes API (TRAFFIC_AWARE) when GOOGLE_MAPS_API_KEY is set,
 * otherwise (or on any API failure) the built-in estimate.
 */
async function getRoute(src, dst, { vehicleType, when = new Date(), fetchImpl = fetch, key = C.GOOGLE_MAPS_API_KEY } = {}) {
  if (!key) return fallbackRoute(src, dst, when);
  try {
    const pt = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline',
      },
      body: JSON.stringify({
        origin: pt(src), destination: pt(dst),
        travelMode: vehicleType === 'bike' ? 'TWO_WHEELER' : 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        regionCode: 'IN',
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Routes API ${res.status}`);
    const r = (await res.json()).routes?.[0];
    if (!r?.distanceMeters) throw new Error('No route');
    const freeFlowMin = secs(r.staticDuration) / 60;
    const etaMin = secs(r.duration) / 60;
    const delayMin = Math.max(0, etaMin - freeFlowMin);
    return {
      distanceKm: r.distanceMeters / 1000, freeFlowMin, delayMin, etaMin,
      source: 'google-live-traffic', trafficLabel: trafficLabel(delayMin, freeFlowMin),
      polyline: r.polyline?.encodedPolyline || null,
    };
  } catch (e) {
    console.warn('[maps] falling back to estimate:', e.message);
    return fallbackRoute(src, dst, when);
  }
}

/** Address search (Google Places) — only when a key is configured. */
async function searchPlaces(query, { fetchImpl = fetch, key = C.GOOGLE_MAPS_API_KEY } = {}) {
  if (!key || !query) return [];
  try {
    const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({ textQuery: query, regionCode: 'IN', maxResultCount: 6 }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    return ((await res.json()).places || []).map((p) => ({
      name: `${p.displayName?.text || ''}${p.formattedAddress ? ', ' + p.formattedAddress : ''}`.slice(0, 120),
      lat: p.location.latitude, lng: p.location.longitude,
    }));
  } catch { return []; }
}

module.exports = { getRoute, fallbackRoute, searchPlaces };
