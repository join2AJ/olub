'use strict';

const R = 6371; // km
const rad = (d) => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance (km) from point p to segment a→b, using a local flat projection.
// Good enough for city / intercity corridors.
function pointToSegmentKm(p, a, b) {
  const kx = 111.32 * Math.cos(rad((a.lat + b.lat) / 2));
  const ky = 110.57;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const px = p.lng * kx, py = p.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function isValidPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Decode a Google/OSRM encoded polyline (precision 5) into [{lat, lng}]. */
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < str.length);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  while (i < str.length) { lat += next(); lng += next(); out.push({ lat: lat / 1e5, lng: lng / 1e5 }); }
  return out;
}

/** Shortest distance (km) from a point to a path of points. */
function pointToPathKm(p, path) {
  let best = Infinity;
  for (let k = 1; k < path.length; k++) best = Math.min(best, pointToSegmentKm(p, path[k - 1], path[k]));
  return best;
}

module.exports = { haversineKm, pointToSegmentKm, isValidPoint, decodePolyline, pointToPathKm };
