'use strict';

// Hexagonal search around a pickup point, the way ride apps look for the nearest cab:
// the area is tiled with hexagons, the pickup sits in the centre cell, and the search
// widens ring by ring (ring 1 = the 6 neighbours, ring 2 = the next 12, …).
// Hexagons are used because every neighbour is the same distance away.

const KX = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180); // km per degree of longitude
const KY = 110.57;                                            // km per degree of latitude

/** Axial hex cell (pointy-top) of point p, in a grid centred on `origin`, edge length `size` km. */
function cellOf(p, origin, size) {
  const x = (p.lng - origin.lng) * KX(origin.lat), y = (p.lat - origin.lat) * KY;
  const qf = ((Math.sqrt(3) / 3) * x - y / 3) / size, rf = ((2 / 3) * y) / size;
  // cube rounding
  let q = Math.round(qf), r = Math.round(rf); const s = Math.round(-qf - rf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s + qf + rf);
  if (dq > dr && dq > ds) q = -r - s; else if (dr > ds) r = -q - s;
  return { q, r };
}

/** How many rings out from the centre cell this cell is. */
const ringOf = (c) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;

/** Ring number (0 = same cell as the pickup) of a point. */
const ring = (p, origin, size) => ringOf(cellOf(p, origin, size));

/** The six corners of a cell as [lat, lng] pairs, for drawing. */
function corners(c, origin, size) {
  const cx = size * Math.sqrt(3) * (c.q + c.r / 2), cy = size * 1.5 * c.r;
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    out.push([origin.lat + (cy + size * Math.sin(a)) / KY, origin.lng + (cx + size * Math.cos(a)) / KX(origin.lat)]);
  }
  return out;
}

/** All cells within `k` rings of the centre. */
function cellsWithin(k) {
  const out = [];
  for (let q = -k; q <= k; q++) for (let r = Math.max(-k, -q - k); r <= Math.min(k, -q + k); r++) out.push({ q, r });
  return out;
}

module.exports = { cellOf, ringOf, ring, corners, cellsWithin };
