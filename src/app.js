'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const C = require('./config');
const { openDb } = require('./db');
const { calculateFare, experienceTier } = require('./fare');
const { haversineKm, isValidPoint } = require('./geo');
const T = require('./tolls');

const { httpError } = T;
const now = () => Date.now();
const json = (s) => (s ? JSON.parse(s) : null);

const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const normVehicle = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isPhone = (s) => /^[6-9]\d{9}$/.test(s);
const fourDigit = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const mask = (s, keep = 4) => (s ? '•'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep) : null);

const DOC_KEYS = ['license', 'rc', 'kyc', 'vehicle', 'selfie'];

function createApp({ dbFile = path.join(__dirname, '..', 'data', 'olub.db') } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- realtime (Server-Sent Events) ----------
  const streams = new Map(); // userId -> Set<res>
  function emit(userId, event, data) {
    for (const res of streams.get(userId) || []) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  // ---------- helpers ----------
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const getDriver = (id) => db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(id);
  const getTrip = (id) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id);

  function calamityFor(state) {
    return db.prepare("SELECT * FROM calamity WHERE state = ? OR state = '*' LIMIT 1").get(state || '') || null;
  }

  function auth(req, _res, next) {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    const s = token && db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!s) return next(httpError(401, 'Please log in'));
    req.user = getUser(s.user_id);
    next();
  }
  const role = (...roles) => (req, _res, next) =>
    roles.includes(req.user.role) ? next() : next(httpError(403, 'Not allowed for your account type'));

  function publicDriver(d, { forAdmin = false } = {}) {
    const u = getUser(d.user_id);
    const docs = json(d.docs) || {};
    const tier = experienceTier(d.completed_trips);
    const out = {
      id: d.user_id,
      name: u.name,
      vehicleNumber: d.vehicle_number,
      vehicleType: d.vehicle_type,
      vehicleLabel: C.VEHICLES[d.vehicle_type]?.label,
      vehicleModel: d.vehicle_model,
      condition: d.vehicle_condition,
      state: d.state,
      status: d.status,
      verifiedVia: d.verified_via,
      online: !!d.online,
      completedTrips: d.completed_trips,
      experience: tier.label,
      licenseNo: mask(d.license_no),
      rcNo: d.rc_no,
      // Only photos a rider needs to confirm identity. KYC ID stays private.
      photos: { selfie: docs.selfie || null, vehicle: docs.vehicle || null },
    };
    if (forAdmin) {
      out.phone = u.phone;
      out.licenseNo = d.license_no;
      out.kycIdNo = d.kyc_id_no;
      out.docs = docs;
    }
    return out;
  }

  function findDriver(query) {
    const q = String(query || '').trim();
    if (!q) throw httpError(400, "Enter the driver's mobile number or vehicle number");
    const phone = normPhone(q);
    let d = null;
    if (isPhone(phone) && /^[\d\s+-]+$/.test(q)) {
      const u = db.prepare("SELECT id FROM users WHERE phone = ? AND role = 'driver'").get(phone);
      d = u && getDriver(u.id);
    } else {
      d = db.prepare('SELECT * FROM drivers WHERE vehicle_number = ?').get(normVehicle(q));
    }
    if (!d) throw httpError(404, 'No Olub driver found with that mobile / vehicle number');
    return d;
  }

  function resolvePoint(p, label) {
    if (!p) throw httpError(400, `${label} is required`);
    if (p.placeId) {
      const pl = db.prepare('SELECT * FROM places WHERE id = ?').get(p.placeId);
      if (!pl) throw httpError(400, `Unknown ${label.toLowerCase()} place`);
      return { name: pl.name, lat: pl.lat, lng: pl.lng, state: pl.state };
    }
    const pt = { name: String(p.name || `${label} pin`).slice(0, 120), lat: Number(p.lat), lng: Number(p.lng), state: p.state };
    if (!isValidPoint(pt)) throw httpError(400, `${label} location is invalid`);
    return pt;
  }

  function buildQuote(body, riderId) {
    const d = findDriver(body.driver);
    if (d.user_id === riderId) throw httpError(400, 'You cannot book yourself');
    if (d.status === 'incomplete' || d.status === 'rejected') throw httpError(409, 'This driver has not completed Olub registration');
    if (!d.online) throw httpError(409, 'Driver is offline. Ask them to go online in the Olub Driver app.');
    const busy = db.prepare(`SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')`).get(d.user_id);
    if (busy) throw httpError(409, 'Driver is on another trip');

    const src = resolvePoint(body.src, 'Pickup');
    const dst = resolvePoint(body.dst, 'Drop');
    const state = src.state || d.state;
    const distanceKm = haversineKm(src, dst) * C.ROAD_FACTOR;
    if (distanceKm < 0.2) throw httpError(400, 'Pickup and drop are too close');
    const road = C.ROAD_MULTIPLIER[body.road] ? body.road : 'good';
    const traffic = C.TRAFFIC_WAIT_PER_KM[body.traffic] ? body.traffic : 'light';
    const routeTolls = T.tollsOnRoute(db, src, dst);
    const cal = calamityFor(state);
    const quote = calculateFare({
      distanceKm, vehicleType: d.vehicle_type, condition: d.vehicle_condition,
      completedTrips: d.completed_trips, road, traffic,
      tolls: T.tollsForVehicle(routeTolls, d.vehicle_type),
      calamity: !!cal,
    });
    quote.driverCompletedTrips = d.completed_trips;
    return { d, src, dst, state, road, traffic, routeTolls, quote, calamity: cal };
  }

  function tripTolls(trip) {
    return db.prepare(`SELECT t.* FROM trip_tolls tt JOIN tolls t ON t.id = tt.toll_id WHERE tt.trip_id = ?`).all(trip.id);
  }

  function computeFinal(trip) {
    const d = getDriver(trip.driver_id);
    const quote = json(trip.quote);
    return calculateFare({
      distanceKm: trip.distance_km, vehicleType: d.vehicle_type, condition: d.vehicle_condition,
      // Experience is locked at booking so the bill matches the quote.
      completedTrips: quote.driverCompletedTrips ?? d.completed_trips,
      road: trip.road,
      waitMinutes: trip.wait_minutes ?? quote.breakdown.waitMinutes,
      tolls: T.tollsForVehicle(tripTolls(trip), d.vehicle_type),
      calamity: quote.calamity || !!calamityFor(trip.state),
      discount: trip.verify_discount ? C.VERIFY_DISCOUNT : 0,
    });
  }

  // Show an earned verification reward on the estimate too, before the final bill.
  function withDiscount(q, discount) {
    if (!discount || q.discount) return q;
    const r2 = (n) => Math.round(n * 100) / 100;
    return { ...q, discount, riderPays: r2(Math.max(0, q.riderPays - discount)), platformNet: r2(q.platformNet - discount) };
  }

  function tripView(trip, viewer) {
    const isRider = viewer.id === trip.rider_id;
    const d = getDriver(trip.driver_id);
    const rider = getUser(trip.rider_id);
    return {
      id: trip.id,
      status: trip.status,
      you: isRider ? 'rider' : 'driver',
      src: { name: trip.src_name, lat: trip.src_lat, lng: trip.src_lng },
      dst: { name: trip.dst_name, lat: trip.dst_lat, lng: trip.dst_lng },
      state: trip.state,
      distanceKm: trip.distance_km,
      quote: withDiscount(json(trip.quote), trip.verify_discount ? C.VERIFY_DISCOUNT : 0),
      final: json(trip.final),
      tolls: tripTolls(trip).map((t) => T.publicToll(db, t, isRider ? undefined : trip.driver_id)),
      // Trip OTP is shown only to the rider; driver must get it from them.
      otp: isRider && ['requested', 'accepted'].includes(trip.status) ? trip.otp : undefined,
      driver: publicDriver(d),
      rider: { name: rider.name || 'Rider' },
      canVerifyDriver: isRider && d.status === 'submitted' && !trip.verify_discount &&
        ['accepted', 'started', 'completed'].includes(trip.status) && !trip.paid_at,
      verifyDiscount: trip.verify_discount ? C.VERIFY_DISCOUNT : 0,
      waitMinutes: trip.wait_minutes,
      paymentMethod: trip.payment_method,
      paidAt: trip.paid_at,
      createdAt: trip.created_at, acceptedAt: trip.accepted_at, startedAt: trip.started_at, completedAt: trip.completed_at,
    };
  }

  function loadTripFor(req, { as } = {}) {
    const trip = getTrip(Number(req.params.id));
    if (!trip) throw httpError(404, 'Trip not found');
    const isRider = trip.rider_id === req.user.id;
    const isDriver = trip.driver_id === req.user.id;
    if (!isRider && !isDriver) throw httpError(404, 'Trip not found');
    if (as === 'rider' && !isRider) throw httpError(403, 'Only the rider can do this');
    if (as === 'driver' && !isDriver) throw httpError(403, 'Only the driver can do this');
    return trip;
  }

  function notifyTrip(trip) {
    const t = getTrip(trip.id);
    emit(t.rider_id, 'trip', tripView(t, { id: t.rider_id }));
    emit(t.driver_id, 'trip', tripView(t, { id: t.driver_id }));
  }

  const otherParty = (trip, userId) => (trip.rider_id === userId ? trip.driver_id : trip.rider_id);
  function canTalk(trip) {
    // Chat / call allowed while the trip is live and for 1 hour after (lost items).
    if (['accepted', 'started'].includes(trip.status)) return true;
    return trip.status === 'completed' && now() - trip.completed_at < 60 * 60 * 1000;
  }

  const route = (fn) => (req, res, next) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };

  // ---------- public ----------
  app.get('/api/config', route(() => ({
    platformFee: C.PLATFORM_FEE, platformFeeCalamity: C.PLATFORM_FEE_CALAMITY,
    verifyDiscount: C.VERIFY_DISCOUNT, subscriptionEnabled: C.SUBSCRIPTION_ENABLED,
    subscriptionMonthly: C.SUBSCRIPTION_MONTHLY, defaultToll: C.DEFAULT_TOLL,
    stateDefaultToll: C.STATE_DEFAULT_TOLL, tollConfirmationsRequired: C.TOLL_CONFIRMATIONS_REQUIRED,
    vehicles: C.VEHICLES, conditions: Object.keys(C.CONDITION_MULTIPLIER),
    roads: Object.keys(C.ROAD_MULTIPLIER), traffic: Object.keys(C.TRAFFIC_WAIT_PER_KM),
    calamity: db.prepare('SELECT * FROM calamity').all(),
  })));
  app.get('/api/places', route(() => db.prepare('SELECT * FROM places ORDER BY name').all()));

  // ---------- auth (phone + OTP) ----------
  app.post('/api/auth/request-otp', route((req) => {
    const phone = normPhone(req.body.phone);
    if (!isPhone(phone)) throw httpError(400, 'Enter a valid 10-digit Indian mobile number');
    const code = String(crypto.randomInt(100000, 1000000));
    db.prepare(`INSERT INTO login_otps (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)
      ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`)
      .run(phone, code, now() + C.LOGIN_OTP_TTL_MS);
    // TODO(prod): send via SMS gateway (MSG91 / Twilio etc.) instead of returning it.
    const existing = db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone);
    return { ok: true, isNewUser: !existing, ...(C.DEV_OTP && { devCode: code }) };
  }));

  app.post('/api/auth/verify-otp', route((req) => {
    const phone = normPhone(req.body.phone);
    const row = db.prepare('SELECT * FROM login_otps WHERE phone = ?').get(phone);
    if (!row || row.expires_at < now()) throw httpError(400, 'OTP expired, request a new one');
    if (row.attempts >= 5) throw httpError(429, 'Too many attempts, request a new OTP');
    if (String(req.body.code) !== row.code) {
      db.prepare('UPDATE login_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
      throw httpError(400, 'Wrong OTP');
    }
    db.prepare('DELETE FROM login_otps WHERE phone = ?').run(phone);

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const r = C.ADMIN_PHONES.includes(phone) ? 'admin' : (req.body.role === 'driver' ? 'driver' : 'rider');
      const name = String(req.body.name || '').trim().slice(0, 60) || null;
      const ins = db.prepare('INSERT INTO users (phone, name, role, created_at) VALUES (?, ?, ?, ?)').run(phone, name, r, now());
      user = getUser(ins.lastInsertRowid);
      if (r === 'driver') db.prepare('INSERT INTO drivers (user_id) VALUES (?)').run(user.id);
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, now());
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  }));

  app.post('/api/auth/logout', auth, route((req) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token = ?').run(req.user.id, (req.get('authorization') || '').slice(7));
    return { ok: true };
  }));

  app.get('/api/me', auth, route((req) => {
    const u = req.user;
    const out = { id: u.id, name: u.name, role: u.role, phone: u.phone };
    if (u.role === 'driver') {
      const d = getDriver(u.id);
      out.driver = { ...publicDriver(d, { forAdmin: true }), subscriptionUntil: d.subscription_until };
    }
    return out;
  }));

  app.patch('/api/me', auth, route((req) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) throw httpError(400, 'Name is required');
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
    return { ok: true };
  }));

  // ---------- realtime stream ----------
  app.get('/api/events', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: hello\ndata: {}\n\n');
    const set = streams.get(req.user.id) || new Set();
    set.add(res);
    streams.set(req.user.id, set);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); set.delete(res); });
  });

  // ---------- driver ----------
  app.put('/api/driver/profile', auth, role('driver'), route((req) => {
    const b = req.body;
    const d = getDriver(req.user.id);
    if (db.prepare(`SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')`).get(d.user_id)) {
      throw httpError(409, 'Finish your current trip before editing your profile');
    }
    const vehicleNumber = normVehicle(b.vehicleNumber);
    if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(vehicleNumber)) throw httpError(400, 'Enter a valid vehicle number, e.g. KA01AB1234');
    if (!C.VEHICLES[b.vehicleType]) throw httpError(400, 'Choose a vehicle type');
    if (!C.CONDITION_MULTIPLIER[b.condition]) throw httpError(400, 'Choose vehicle condition');
    const state = String(b.state || vehicleNumber.slice(0, 2)).toUpperCase().slice(0, 4);
    const taken = db.prepare('SELECT user_id FROM drivers WHERE vehicle_number = ? AND user_id != ?').get(vehicleNumber, d.user_id);
    if (taken) throw httpError(409, 'This vehicle is already registered with another driver');

    const docs = { ...(json(d.docs) || {}) };
    for (const k of DOC_KEYS) {
      const v = b.docs?.[k];
      if (v) {
        if (!/^data:(image\/|application\/pdf)/.test(v)) throw httpError(400, `${k} must be an image or PDF`);
        if (v.length > 3_000_000) throw httpError(400, `${k} file is too large (max ~2MB)`);
        docs[k] = v;
      }
    }
    const fields = {
      license_no: String(b.licenseNo || d.license_no || '').toUpperCase().trim(),
      rc_no: String(b.rcNo || d.rc_no || '').toUpperCase().trim(),
      kyc_id_no: String(b.kycIdNo || d.kyc_id_no || '').trim(),
    };
    const complete = fields.license_no && fields.rc_no && fields.kyc_id_no && DOC_KEYS.every((k) => docs[k]);
    // Changing vehicle or documents re-opens verification.
    const changed = d.vehicle_number !== vehicleNumber || DOC_KEYS.some((k) => b.docs?.[k]);
    let status = d.status;
    if (!complete) status = 'incomplete';
    else if (status !== 'verified' || changed) status = 'submitted';

    db.prepare(`UPDATE drivers SET vehicle_number = ?, vehicle_type = ?, vehicle_model = ?, vehicle_condition = ?,
      state = ?, license_no = ?, rc_no = ?, kyc_id_no = ?, docs = ?, status = ?,
      verified_via = CASE WHEN ? = 'verified' THEN verified_via ELSE NULL END,
      online = CASE WHEN ? = 'incomplete' THEN 0 ELSE online END
      WHERE user_id = ?`).run(
      vehicleNumber, b.vehicleType, String(b.vehicleModel || '').slice(0, 60), b.condition, state,
      fields.license_no, fields.rc_no, fields.kyc_id_no, JSON.stringify(docs), status, status, status, d.user_id,
    );
    if (b.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).trim().slice(0, 60), d.user_id);
    const missing = [
      ...DOC_KEYS.filter((k) => !docs[k]),
      ...Object.entries(fields).filter(([, v]) => !v).map(([k]) => k),
    ];
    return { driver: publicDriver(getDriver(d.user_id), { forAdmin: true }), missing };
  }));

  app.post('/api/driver/online', auth, role('driver'), route((req) => {
    const d = getDriver(req.user.id);
    const online = !!req.body.online;
    if (online && !['submitted', 'verified'].includes(d.status)) throw httpError(409, 'Complete your vehicle & KYC details first');
    if (online && C.SUBSCRIPTION_ENABLED && !(d.subscription_until > now())) {
      throw httpError(402, `Monthly Olub subscription of ₹${C.SUBSCRIPTION_MONTHLY} is due`);
    }
    db.prepare('UPDATE drivers SET online = ? WHERE user_id = ?').run(online ? 1 : 0, d.user_id);
    return { online };
  }));

  app.post('/api/driver/subscription', auth, role('driver'), route((req) => {
    if (!C.SUBSCRIPTION_ENABLED) return { enabled: false, message: 'Subscription is free during launch' };
    // TODO(prod): integrate a payment gateway; this just records a mock payment.
    const d = getDriver(req.user.id);
    const from = Math.max(now(), d.subscription_until || 0);
    const until = from + 30 * 24 * 3600 * 1000;
    db.prepare('UPDATE drivers SET subscription_until = ? WHERE user_id = ?').run(until, d.user_id);
    return { enabled: true, amount: C.SUBSCRIPTION_MONTHLY, until };
  }));

  app.get('/api/driver/earnings', auth, role('driver'), route((req) => {
    const rows = db.prepare(`SELECT final FROM trips WHERE driver_id = ? AND status = 'completed' AND paid_at IS NOT NULL`).all(req.user.id);
    let earned = 0, tolls = 0, platformNet = 0;
    for (const r of rows) {
      const f = json(r.final);
      earned += f.driverFare; tolls += f.breakdown.tollTotal; platformNet += f.platformNet;
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    return { trips: rows.length, earned: r2(earned), tollsCollected: r2(tolls), owedToOlub: r2(platformNet) };
  }));

  // ---------- booking ----------
  app.get('/api/drivers/lookup', auth, route((req) => {
    const d = findDriver(req.query.q);
    return publicDriver(d);
  }));

  app.post('/api/trips/quote', auth, role('rider'), route((req) => {
    const q = buildQuote(req.body, req.user.id);
    return {
      driver: publicDriver(q.d), src: q.src, dst: q.dst, state: q.state,
      quote: q.quote, calamity: q.calamity,
      tolls: q.routeTolls.map((t) => T.publicToll(db, t)),
      verifyOffer: q.d.status === 'submitted' ? C.VERIFY_DISCOUNT : 0,
    };
  }));

  app.post('/api/trips', auth, role('rider'), route((req, res) => {
    const mine = db.prepare(`SELECT id FROM trips WHERE rider_id = ? AND status IN ('requested','accepted','started')`).get(req.user.id);
    if (mine) throw httpError(409, 'You already have an active trip');
    const q = buildQuote(req.body, req.user.id);
    const r = db.prepare(`INSERT INTO trips (rider_id, driver_id, src_name, src_lat, src_lng, dst_name, dst_lat, dst_lng,
      state, distance_km, road, traffic, quote, status, otp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`).run(
      req.user.id, q.d.user_id, q.src.name, q.src.lat, q.src.lng, q.dst.name, q.dst.lat, q.dst.lng,
      q.state, q.quote.distanceKm, q.road, q.traffic, JSON.stringify(q.quote), fourDigit(), now(),
    );
    const tripId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT OR IGNORE INTO trip_tolls (trip_id, toll_id) VALUES (?, ?)');
    for (const t of q.routeTolls) ins.run(tripId, t.id);
    const trip = getTrip(tripId);
    notifyTrip(trip);
    res.status(201);
    return tripView(trip, req.user);
  }));

  app.get('/api/trips/current', auth, route((req) => {
    const trip = db.prepare(`SELECT * FROM trips WHERE (rider_id = ? OR driver_id = ?)
      AND (status IN ('requested','accepted','started') OR (status = 'completed' AND paid_at IS NULL))
      ORDER BY status = 'requested', id DESC LIMIT 1`).get(req.user.id, req.user.id);
    // A driver may have several pending requests; show them all.
    const requests = req.user.role === 'driver'
      ? db.prepare(`SELECT * FROM trips WHERE driver_id = ? AND status = 'requested' ORDER BY id`).all(req.user.id).map((t) => tripView(t, req.user))
      : [];
    return { trip: trip ? tripView(trip, req.user) : null, requests };
  }));

  app.get('/api/trips', auth, route((req) => db.prepare(`SELECT * FROM trips WHERE rider_id = ? OR driver_id = ?
    ORDER BY id DESC LIMIT 50`).all(req.user.id, req.user.id).map((t) => tripView(t, req.user))));

  app.get('/api/trips/:id', auth, route((req) => tripView(loadTripFor(req), req.user)));

  app.post('/api/trips/:id/accept', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'requested') throw httpError(409, `Trip is already ${trip.status}`);
    const busy = db.prepare(`SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')`).get(req.user.id);
    if (busy) throw httpError(409, 'Finish your current trip first');
    const d = getDriver(req.user.id);
    if (C.SUBSCRIPTION_ENABLED && !(d.subscription_until > now())) throw httpError(402, 'Subscription due');
    db.prepare(`UPDATE trips SET status = 'accepted', accepted_at = ? WHERE id = ?`).run(now(), trip.id);
    // Auto-decline any other pending requests to this driver.
    const others = db.prepare(`SELECT * FROM trips WHERE driver_id = ? AND status = 'requested' AND id != ?`).all(req.user.id, trip.id);
    for (const o of others) {
      db.prepare(`UPDATE trips SET status = 'rejected' WHERE id = ?`).run(o.id);
      notifyTrip(o);
    }
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/reject', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'requested') throw httpError(409, `Trip is already ${trip.status}`);
    db.prepare(`UPDATE trips SET status = 'rejected' WHERE id = ?`).run(trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/cancel', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!['requested', 'accepted'].includes(trip.status)) throw httpError(409, 'Trip can no longer be cancelled');
    db.prepare(`UPDATE trips SET status = 'cancelled' WHERE id = ?`).run(trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/start', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'accepted') throw httpError(409, 'Accept the trip first');
    if (trip.otp_attempts >= C.TRIP_OTP_MAX_ATTEMPTS) throw httpError(429, 'Too many wrong OTPs. Ask the rider to cancel and rebook.');
    if (String(req.body.otp || '').trim() !== trip.otp) {
      db.prepare('UPDATE trips SET otp_attempts = otp_attempts + 1 WHERE id = ?').run(trip.id);
      throw httpError(400, 'Wrong OTP — ask the rider for the 4-digit code shown in their app');
    }
    db.prepare(`UPDATE trips SET status = 'started', started_at = ? WHERE id = ?`).run(now(), trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  // Tolls on this trip the driver should photograph to help verify them.
  app.get('/api/trips/:id/toll-prompts', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    return tripTolls(trip)
      .filter((t) => t.status !== 'verified')
      .map((t) => T.publicToll(db, t, req.user.id))
      .filter((t) => !t.reportedByMe);
  }));

  app.post('/api/trips/:id/tolls', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'started') throw httpError(409, 'You can add tolls only during a trip');
    const d = getDriver(req.user.id);
    const { toll, alreadyReported } = T.reportToll(db, req.user.id, {
      ...req.body, state: req.body.state || trip.state || d.state, vehicleType: d.vehicle_type,
    });
    db.prepare('INSERT OR IGNORE INTO trip_tolls (trip_id, toll_id) VALUES (?, ?)').run(trip.id, toll.id);
    notifyTrip(trip);
    return { toll: T.publicToll(db, toll, req.user.id), alreadyReported };
  }));

  app.delete('/api/trips/:id/tolls/:tollId', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'started') throw httpError(409, 'Tolls can be changed only during a trip');
    db.prepare('DELETE FROM trip_tolls WHERE trip_id = ? AND toll_id = ?').run(trip.id, Number(req.params.tollId));
    notifyTrip(trip);
    return { ok: true };
  }));

  app.post('/api/trips/:id/complete', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'started') throw httpError(409, 'Trip has not started');
    const wait = req.body.waitMinutes == null ? null : Math.min(600, Math.max(0, Number(req.body.waitMinutes) || 0));
    db.prepare(`UPDATE trips SET wait_minutes = ? WHERE id = ?`).run(wait, trip.id);
    const final = computeFinal(getTrip(trip.id));
    db.prepare(`UPDATE trips SET status = 'completed', completed_at = ?, final = ? WHERE id = ?`).run(now(), JSON.stringify(final), trip.id);
    db.prepare('UPDATE drivers SET completed_trips = completed_trips + 1 WHERE user_id = ?').run(trip.driver_id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  // Rider confirms in person that the driver's face, vehicle and number plate
  // match the submitted documents → driver becomes verified, rider gets ₹10 off.
  app.post('/api/trips/:id/verify-driver', auth, role('rider'), route((req) => {
    const trip = loadTripFor(req, { as: 'rider' });
    const d = getDriver(trip.driver_id);
    const c = req.body.checks || {};
    if (!(c.face && c.vehicleNumber && c.vehicleMatches)) throw httpError(400, 'Confirm all checks to verify the driver');
    if (!['accepted', 'started', 'completed'].includes(trip.status) || trip.paid_at) throw httpError(409, 'Verify during the trip');
    if (d.status !== 'submitted') throw httpError(409, 'This driver is already verified');
    db.prepare(`UPDATE drivers SET status = 'verified', verified_via = 'customer', verified_by = ? WHERE user_id = ?`).run(req.user.id, d.user_id);
    db.prepare('UPDATE trips SET verify_discount = 1 WHERE id = ?').run(trip.id);
    if (trip.status === 'completed') {
      db.prepare('UPDATE trips SET final = ? WHERE id = ?').run(JSON.stringify(computeFinal(getTrip(trip.id))), trip.id);
    }
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/pay', auth, route((req) => {
    const trip = loadTripFor(req);
    if (trip.status !== 'completed') throw httpError(409, 'Trip is not completed');
    if (trip.paid_at) throw httpError(409, 'Already paid');
    const method = ['cash', 'upi'].includes(req.body.method) ? req.body.method : 'cash';
    // TODO(prod): UPI intent straight to driver's VPA; Olub fee settled from driver's wallet.
    db.prepare('UPDATE trips SET payment_method = ?, paid_at = ? WHERE id = ?').run(method, now(), trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  // ---------- masked chat & voice call ----------
  app.get('/api/trips/:id/messages', auth, route((req) => {
    const trip = loadTripFor(req);
    return db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE trip_id = ? ORDER BY id').all(trip.id)
      .map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, createdAt: m.created_at }));
  }));

  app.post('/api/trips/:id/messages', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!canTalk(trip)) throw httpError(409, 'Chat is available only during the trip');
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) throw httpError(400, 'Message is empty');
    const r = db.prepare('INSERT INTO messages (trip_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)').run(trip.id, req.user.id, body, now());
    const msg = { id: Number(r.lastInsertRowid), tripId: trip.id, body, createdAt: now() };
    emit(otherParty(trip, req.user.id), 'message', { ...msg, mine: false });
    return { ...msg, mine: true };
  }));

  // WebRTC signalling relay. Audio flows peer-to-peer; neither side ever sees
  // the other's phone number.
  app.post('/api/trips/:id/call', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!canTalk(trip)) throw httpError(409, 'Calling is available only during the trip');
    const type = req.body.type;
    if (!['ring', 'offer', 'answer', 'ice', 'hangup', 'decline'].includes(type)) throw httpError(400, 'Bad signal');
    const from = getUser(req.user.id);
    emit(otherParty(trip, req.user.id), 'call', { tripId: trip.id, type, data: req.body.data ?? null, fromName: from.name || 'Olub user' });
    return { ok: true };
  }));

  // ---------- tolls (public read) ----------
  app.get('/api/tolls', auth, route(() => db.prepare('SELECT * FROM tolls ORDER BY id DESC').all().map((t) => T.publicToll(db, t))));

  // ---------- admin ----------
  app.get('/api/admin/drivers', auth, role('admin'), route((req) => {
    const status = req.query.status;
    const rows = status
      ? db.prepare('SELECT * FROM drivers WHERE status = ?').all(status)
      : db.prepare('SELECT * FROM drivers').all();
    return rows.map((d) => publicDriver(d, { forAdmin: true }));
  }));

  app.post('/api/admin/drivers/:id/review', auth, role('admin'), route((req) => {
    const d = getDriver(Number(req.params.id));
    if (!d) throw httpError(404, 'Driver not found');
    const approve = !!req.body.approve;
    db.prepare(`UPDATE drivers SET status = ?, verified_via = ?, verified_by = ?, online = CASE WHEN ? THEN online ELSE 0 END WHERE user_id = ?`)
      .run(approve ? 'verified' : 'rejected', approve ? 'admin' : null, req.user.id, approve ? 1 : 0, d.user_id);
    return publicDriver(getDriver(d.user_id), { forAdmin: true });
  }));

  app.get('/api/admin/tolls/:id/reports', auth, role('admin'), route((req) =>
    db.prepare('SELECT driver_id, amount, photo, created_at FROM toll_reports WHERE toll_id = ?').all(Number(req.params.id))));

  app.post('/api/admin/calamity', auth, role('admin'), route((req) => {
    const state = String(req.body.state || '*').toUpperCase().slice(0, 4);
    if (req.body.on) {
      db.prepare(`INSERT INTO calamity (state, reason, since) VALUES (?, ?, ?)
        ON CONFLICT(state) DO UPDATE SET reason = excluded.reason, since = excluded.since`)
        .run(state, String(req.body.reason || 'Heavy rain').slice(0, 120), now());
    } else {
      db.prepare('DELETE FROM calamity WHERE state = ?').run(state);
    }
    return db.prepare('SELECT * FROM calamity').all();
  }));

  // ---------- errors ----------
  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  app.locals.db = db;
  return app;
}

module.exports = { createApp };
