'use strict';

const C = require('./config');
const { defaultTollFor } = require('./fare');
const { haversineKm, pointToSegmentKm } = require('./geo');

/** Amount riders are charged for a toll today. */
function tollAmount(toll) {
  return toll.status === 'verified' ? toll.verified_amount : defaultTollFor(toll.state);
}

function publicToll(db, t, driverId) {
  const reports = db.prepare('SELECT COUNT(*) AS n FROM toll_reports WHERE toll_id = ?').get(t.id).n;
  const mine = driverId
    ? !!db.prepare('SELECT 1 FROM toll_reports WHERE toll_id = ? AND driver_id = ?').get(t.id, driverId)
    : undefined;
  return {
    id: t.id, name: t.name, state: t.state, lat: t.lat, lng: t.lng,
    status: t.status,
    amount: tollAmount(t),
    amountSource: t.status === 'verified' ? 'verified by drivers' : `${t.state} default`,
    reports,
    reportsNeeded: 1 + C.TOLL_CONFIRMATIONS_REQUIRED,
    ...(mine !== undefined && { reportedByMe: mine }),
  };
}

function tollsOnRoute(db, src, dst) {
  const pad = C.TOLL_ROUTE_CORRIDOR_KM / 100; // ~degrees, generous bounding box
  const rows = db.prepare(`SELECT * FROM tolls
    WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`).all(
    Math.min(src.lat, dst.lat) - pad, Math.max(src.lat, dst.lat) + pad,
    Math.min(src.lng, dst.lng) - pad, Math.max(src.lng, dst.lng) + pad,
  );
  return rows.filter((t) => pointToSegmentKm(t, src, dst) <= C.TOLL_ROUTE_CORRIDOR_KM);
}

function tollsForVehicle(tolls, vehicleType) {
  if (C.TOLL_EXEMPT_VEHICLES.includes(vehicleType)) return [];
  return tolls.map((t) => ({ id: t.id, name: t.name, amount: tollAmount(t), status: t.status }));
}

/**
 * Re-check whether a pending toll can be verified: an amount becomes official
 * once the first reporter + TOLL_CONFIRMATIONS_REQUIRED more drivers report the
 * same figure (₹, rounded).
 */
function recomputeVerification(db, tollId) {
  const toll = db.prepare('SELECT * FROM tolls WHERE id = ?').get(tollId);
  if (!toll || toll.status === 'verified') return toll;
  const top = db.prepare(`SELECT ROUND(amount) AS amt, COUNT(DISTINCT driver_id) AS n
    FROM toll_reports WHERE toll_id = ? GROUP BY ROUND(amount) ORDER BY n DESC LIMIT 1`).get(tollId);
  if (top && top.n >= 1 + C.TOLL_CONFIRMATIONS_REQUIRED) {
    db.prepare("UPDATE tolls SET status = 'verified', verified_amount = ? WHERE id = ?").run(top.amt, tollId);
  }
  return db.prepare('SELECT * FROM tolls WHERE id = ?').get(tollId);
}

/**
 * A driver reports crossing a toll: either an existing one (tollId) or a new
 * plaza (name + location). Each driver can report a given toll once.
 */
function reportToll(db, driverId, input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) throw httpError(400, 'Enter the amount you paid at the toll');
  if (!input.photo || !/^data:image\//.test(input.photo)) throw httpError(400, 'Upload a photo of the toll receipt / FASTag SMS');
  if (input.photo.length > 3_000_000) throw httpError(400, 'Photo too large (max ~2MB)');

  let toll;
  if (input.tollId) {
    toll = db.prepare('SELECT * FROM tolls WHERE id = ?').get(input.tollId);
    if (!toll) throw httpError(404, 'Toll not found');
  } else {
    const lat = Number(input.lat), lng = Number(input.lng);
    if (!input.name || !Number.isFinite(lat) || !Number.isFinite(lng) || !input.state) {
      throw httpError(400, 'Toll name, state and location are required');
    }
    const near = db.prepare('SELECT * FROM tolls WHERE ABS(lat - ?) < 0.01 AND ABS(lng - ?) < 0.01').all(lat, lng)
      .find((t) => haversineKm(t, { lat, lng }) <= C.TOLL_MERGE_RADIUS_KM);
    if (near) {
      toll = near;
    } else {
      const r = db.prepare(`INSERT INTO tolls (name, state, lat, lng, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(String(input.name).slice(0, 120), String(input.state).toUpperCase().slice(0, 4), lat, lng, driverId, Date.now());
      toll = db.prepare('SELECT * FROM tolls WHERE id = ?').get(r.lastInsertRowid);
    }
  }

  const dup = db.prepare('SELECT 1 FROM toll_reports WHERE toll_id = ? AND driver_id = ?').get(toll.id, driverId);
  if (!dup) {
    db.prepare(`INSERT INTO toll_reports (toll_id, driver_id, vehicle_type, amount, photo, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(toll.id, driverId, input.vehicleType || null, amount, input.photo, Date.now());
  }
  toll = recomputeVerification(db, toll.id);
  return { toll, alreadyReported: !!dup };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { tollAmount, tollsOnRoute, tollsForVehicle, reportToll, recomputeVerification, publicToll, httpError };
