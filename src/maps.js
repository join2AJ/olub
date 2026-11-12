'use strict';

const C = require('./config');
const { haversineKm } = require('./geo');

// Routing and address search. Order of preference:
//   1. Google Maps (when GOOGLE_MAPS_API_KEY is set): road route with live traffic, Google Places search
//   2. OpenStreetMap services (default): road route from OSRM, address search from Photon — no live traffic
//   3. Built-in estimate: straight line × factor
// The public OSRM and Photon servers are free community services with no guarantee;
// for real traffic use Google or host your own. OLUB_OSM=0 switches them off.
const OSM_ENABLED = process.env.OLUB_OSM !== '0';
const OSRM_URL = process.env.OLUB_OSRM_URL || 'https://router.project-osrm.org';
const PHOTON_URL = process.env.OLUB_PHOTON_URL || 'https://photon.komoot.io';

const secs = (s) => Number(String(s || '0s').replace('s', '')) || 0;

const STATE_CODES = {
  'andhra pradesh': 'AP', 'arunachal pradesh': 'AR', assam: 'AS', bihar: 'BR', chhattisgarh: 'CG', goa: 'GA', gujarat: 'GJ', haryana: 'HR',
  'himachal pradesh': 'HP', jharkhand: 'JH', karnataka: 'KA', kerala: 'KL', 'madhya pradesh': 'MP', maharashtra: 'MH', manipur: 'MN',
  meghalaya: 'ML', mizoram: 'MZ', nagaland: 'NL', odisha: 'OD', punjab: 'PB', rajasthan: 'RJ', sikkim: 'SK', 'tamil nadu': 'TN',
  telangana: 'TS', tripura: 'TR', 'uttar pradesh': 'UP', uttarakhand: 'UK', 'west bengal': 'WB', delhi: 'DL', chandigarh: 'CH',
  'jammu and kashmir': 'JK', ladakh: 'LA', puducherry: 'PY',
};

function fallbackBand(date) {
  // India Standard Time, regardless of server timezone.
  const h = (date.getUTCHours() + 5.5) % 24;
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return 'peak';
  if ((h >= 7 && h < 8) || (h >= 11 && h < 17) || (h >= 21 && h < 22)) return 'shoulder';
  return 'off';
}
const BAND_LABEL = { peak: 'Heavy (rush hour)', shoulder: 'Moderate', off: 'Light' };

/** Estimate without any maps provider: straight line × factor + time-of-day traffic. */
function fallbackRoute(src, dst, when = new Date()) {
  const distanceKm = haversineKm(src, dst) * C.ROAD_FACTOR;
  const freeFlowMin = (distanceKm / C.FREE_FLOW_KMPH) * 60;
  const band = fallbackBand(when);
  const delayMin = distanceKm * C.FALLBACK_DELAY_MIN_PER_KM[band];
  return { distanceKm, freeFlowMin, delayMin, etaMin: freeFlowMin + delayMin, source: 'estimate', trafficLabel: BAND_LABEL[band], polyline: null };
}

function trafficLabel(delayMin, freeFlowMin) {
  const r = freeFlowMin > 0 ? delayMin / freeFlowMin : 0;
  return r > 0.5 ? 'Heavy' : r > 0.2 ? 'Moderate' : 'Light';
}

async function googleRoute(src, dst, { vehicleType, fetchImpl, key }) {
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
}

/** Road route from OpenStreetMap data (OSRM). Real road distance and path; traffic is estimated by time of day. */
async function osrmRoute(src, dst, { when, fetchImpl }) {
  const url = `${OSRM_URL}/route/v1/driving/${src.lng},${src.lat};${dst.lng},${dst.lat}?overview=full&geometries=polyline`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Olub/0.3 (ride app)' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const r = (await res.json()).routes?.[0];
  if (!r?.distance) throw new Error('No road route');
  const distanceKm = r.distance / 1000;
  const freeFlowMin = r.duration / 60;
  const band = fallbackBand(when);
  const delayMin = distanceKm * C.FALLBACK_DELAY_MIN_PER_KM[band];
  return { distanceKm, freeFlowMin, delayMin, etaMin: freeFlowMin + delayMin, source: 'osm-road', trafficLabel: BAND_LABEL[band], polyline: r.geometry || null };
}

/** Road distance, path and traffic delay between two points. Never throws: falls back step by step. */
async function getRoute(src, dst, { vehicleType, when = new Date(), fetchImpl = fetch, key = C.GOOGLE_MAPS_API_KEY, osm = OSM_ENABLED } = {}) {
  if (key) {
    try { return await googleRoute(src, dst, { vehicleType, fetchImpl, key }); } catch (e) { console.warn('[maps] Google route failed:', e.message); }
  }
  if (osm) {
    try { return await osrmRoute(src, dst, { when, fetchImpl }); } catch (e) { console.warn('[maps] OSM route failed:', e.message); }
  }
  return fallbackRoute(src, dst, when);
}

async function googlePlaces(query, { fetchImpl, key, near }) {
  const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      textQuery: query, regionCode: 'IN', maxResultCount: 6,
      ...(near && { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30000 } } }),
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Places API ${res.status}`);
  return ((await res.json()).places || []).map((p) => ({
    name: `${p.displayName?.text || ''}${p.formattedAddress ? ', ' + p.formattedAddress : ''}`.slice(0, 120),
    lat: p.location.latitude, lng: p.location.longitude,
  }));
}

/** Address search on OpenStreetMap data (Photon), nearest matches first. */
async function photonPlaces(query, { fetchImpl, near }) {
  const url = `${PHOTON_URL}/api/?q=${encodeURIComponent(query)}&limit=8&lang=en${near ? `&lat=${near.lat}&lon=${near.lng}` : ''}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Olub/0.3 (ride app)' }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const seen = new Set();
  return ((await res.json()).features || [])
    .filter((f) => f.properties?.countrycode === 'IN' && f.geometry?.coordinates)
    .map((f) => {
      const p = f.properties;
      const parts = [p.name, p.street, p.district || p.locality, p.city, p.state].filter(Boolean);
      return {
        name: [...new Set(parts)].join(', ').slice(0, 120),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        state: STATE_CODES[String(p.state || '').toLowerCase()] || undefined,
      };
    })
    .filter((p) => p.name && !seen.has(p.name) && seen.add(p.name))
    .slice(0, 6);
}

/** Address search near a point. Never throws. */
async function searchPlaces(query, { fetchImpl = fetch, key = C.GOOGLE_MAPS_API_KEY, near = null, osm = OSM_ENABLED } = {}) {
  if (!query) return [];
  if (key) {
    try { return await googlePlaces(query, { fetchImpl, key, near }); } catch (e) { console.warn('[maps] Google search failed:', e.message); }
  }
  if (osm) {
    try { return await photonPlaces(query, { fetchImpl, near }); } catch (e) { console.warn('[maps] OSM search failed:', e.message); }
  }
  return [];
}

module.exports = { getRoute, fallbackRoute, searchPlaces, STATE_CODES };
