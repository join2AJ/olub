'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const C = require('./config');
const { openDb } = require('./db');
const { calculateFare, experienceTier, platformFeeFor } = require('./fare');
const { haversineKm } = require('./geo');
const { isValidPoint, pointToSegmentKm, decodePolyline, pointToPathKm } = require('./geo');
const Digipin = require('../public/js/digipin.js');
const registerExtras = require('./extras');
const seedDemo = require('./demo');
const Hex = require('./hex');
const defaultMaps = require('./maps');
const T = require('./tolls');
const legal = require('./legal');
const { createAudit } = require('./audit');
const { encrypt, decrypt, sha256, publicId } = require('./crypto');
const { exportUserData, eraseUser } = require('./privacy');

const { httpError } = T;
const json = (s) => (s ? JSON.parse(s) : null);
const r2 = (n) => Math.round(n * 100) / 100;

const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const normVehicle = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isPhone = (s) => /^[6-9]\d{9}$/.test(s);
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const fourDigit = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');
const sixDigit = () => String(crypto.randomInt(100000, 1000000));
const mask = (s, keep = 4) => (s ? '•'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep) : null);
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'Olub user';
const text = (s, max = 300) => String(s || '').trim().slice(0, max) || null;

const DOC_KEYS = ['license', 'rc', 'kyc', 'vehicle', 'selfie'];
const ID_PREFIX = { rider: 'OLB-C', driver: 'OLB-D', admin: 'OLB-A' };

function createApp({ dbFile = path.join(__dirname, '..', 'data', 'olub-v6.db'), clock = Date.now, maps = defaultMaps } = {}) {
  const db = openDb(dbFile);
  const now = () => clock();
  const audit = createAudit(db, clock);
  const app = express();
  app.set('trust proxy', process.env.OLUB_TRUST_PROXY === '1');
  let publicBase = process.env.OLUB_PUBLIC_URL || '';

  // ---------- security headers + CORS (the Android app calls from its own origin) ----------
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=(self)',
    });
    const origin = req.get('origin');
    if (origin && (C.ALLOWED_ORIGINS.includes('*') || C.ALLOWED_ORIGINS.includes(origin))) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Max-Age': '600',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '12mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---------- audit: every change (and every admin read) is recorded ----------
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      const p = req.route?.path;
      if (!p) return;
      const adminRead = req.method === 'GET' && req.user?.role === 'admin' && req.baseUrl.includes('/admin');
      if (req.method === 'GET' && !adminRead) return;
      if (p === '/api/trips/:id/location' || (p === '/api/trips/:id/call' && req.body?.type === 'ice')) return;
      const full = p.startsWith('/api') ? p : `${req.baseUrl}${p}`;
      audit.log({
        actor: req.user, action: `${req.method} ${full.replace('/api', '')}`,
        entity: req.params?.id ? full.split('/')[2] : null, entityId: req.params?.id ?? null, req,
        details: { status: res.statusCode, ...(req.method !== 'GET' && { body: req.body }), ...(req.auditNote && { note: req.auditNote }) },
      });
    });
    next();
  });

  // ---------- small in-memory rate limit for auth endpoints ----------
  const hits = new Map();
  function rateLimit(req, _res, next) {
    const k = req.ip; const t = now();
    const h = hits.get(k);
    if (!h || h.reset < t) hits.set(k, { n: 1, reset: t + C.AUTH_RATE_LIMIT.windowMs });
    else if (++h.n > C.AUTH_RATE_LIMIT.max) return next(httpError(429, 'Too many attempts. Please wait a few minutes.'));
    next();
  }

  // ---------- realtime (Server-Sent Events) ----------
  const streams = new Map();
  function emit(userId, event, data) {
    for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ---------- helpers ----------
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const getDriver = (id) => db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(id);
  const getTrip = (id) => db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  const calamityFor = (state) => db.prepare("SELECT * FROM calamity WHERE state = ? OR state = '*' LIMIT 1").get(state || '') || null;

  function newPublicId(prefix, table) {
    for (;;) {
      const id = publicId(prefix);
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE public_id = ?`).get(id)) return id;
    }
  }

  function getRates() {
    const saved = json(db.prepare("SELECT value FROM settings WHERE key = 'rates'").get()?.value) || {};
    const out = {};
    for (const [k, v] of Object.entries(C.VEHICLES)) out[k] = { ...v, ...(saved[k] || {}) };
    return out;
  }

  function queue(channel, to, template, body, { tripId = null, userId = null } = {}) {
    if (!to) return;
    // TODO(prod): a worker delivers queued rows through an SMS / email gateway.
    db.prepare('INSERT INTO outbox (ts, channel, to_addr, template, body, trip_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now(), channel, to, template, body, tripId, userId);
  }

  const withPin = (p) => ({ ...p, digipin: Digipin.encode(p.lat, p.lng) });

  // ---------- driver wallet ----------
  function walletTxn(driverId, type, amount, { tripId = null, note = null } = {}) {
    if (!amount) return;
    db.prepare('UPDATE drivers SET wallet_balance = ROUND(wallet_balance + ?, 2) WHERE user_id = ?').run(amount, driverId);
    db.prepare('INSERT INTO wallet_txns (driver_id, ts, type, amount, balance_after, trip_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(driverId, now(), type, amount, getDriver(driverId).wallet_balance, tripId, note);
  }

  // ---------- duty hours: 12 h on duty, then 10 h continuous rest ----------
  function dutyStatus(driverId) {
    const REST = C.DUTY_REST_HOURS * 3600e3, MAX = C.DUTY_MAX_HOURS * 3600e3;
    const rows = db.prepare('SELECT * FROM duty_sessions WHERE driver_id = ? AND started_at > ? ORDER BY started_at').all(driverId, now() - 4 * C.DAY);
    let worked = 0, lastEnd = null, open = false;
    for (const r of rows) {
      if (lastEnd != null && r.started_at - lastEnd >= REST) worked = 0; // a full rest resets the duty day
      const end = r.ended_at ?? now();
      worked += (end - r.started_at) + r.declared_other_min * 60000;
      lastEnd = end; open = r.ended_at == null;
    }
    if (!open && lastEnd != null && now() - lastEnd >= REST) worked = 0;
    const locked = worked >= MAX;
    return {
      workedMin: Math.floor(worked / 60000), remainingMin: Math.max(0, Math.floor((MAX - worked) / 60000)),
      limitHours: C.DUTY_MAX_HOURS, restHours: C.DUTY_REST_HOURS, locked,
      restUntil: locked && !open ? lastEnd + REST : null,
    };
  }
  function forceOffline(driverId, reason) {
    db.prepare('UPDATE drivers SET online = 0 WHERE user_id = ?').run(driverId);
    db.prepare('UPDATE duty_sessions SET ended_at = ?, end_reason = ? WHERE driver_id = ? AND ended_at IS NULL').run(now(), reason, driverId);
    emit(driverId, 'duty', { reason });
  }
  const activeFlag = (vehicleNumber) => db.prepare("SELECT * FROM vehicle_flags WHERE vehicle_number = ? AND status = 'active'").get(vehicleNumber || '');
  /** Why this driver cannot take customers right now (null = available). */
  function unavailableReason(d) {
    if (d.suspended_reason) return 'This driver is not available on Olub right now';
    if (d.wallet_balance < C.WALLET_MIN_BALANCE) return `This driver cannot take rides until they top up their Olub wallet (minimum ₹${C.WALLET_MIN_BALANCE})`;
    if (dutyStatus(d.user_id).locked) return `This driver has reached the ${C.DUTY_MAX_HOURS}-hour driving limit and must rest`;
    return null;
  }

  const ageFrom = (dob, at = now()) => {
    if (!dob) return null;
    const d = new Date(dob), t = new Date(at);
    let a = t.getUTCFullYear() - d.getUTCFullYear();
    if (t.getUTCMonth() < d.getUTCMonth() || (t.getUTCMonth() === d.getUTCMonth() && t.getUTCDate() < d.getUTCDate())) a--;
    return a;
  };

  function ratingOf(userId) {
    const r = db.prepare('SELECT AVG(overall) AS avg, COUNT(*) AS n FROM ratings WHERE to_id = ?').get(userId);
    return { average: r.n ? Math.round(r.avg * 10) / 10 : null, count: r.n };
  }

  function pendingConsents(u) {
    return legal.required[u.role].filter((doc) => !db.prepare(
      'SELECT 1 FROM consents WHERE user_id = ? AND doc = ? AND version = ? AND withdrawn_at IS NULL').get(u.id, doc, legal.VERSION));
  }
  function recordConsents(u, req) {
    const ins = db.prepare('INSERT INTO consents (user_id, doc, version, accepted_at, ip) VALUES (?, ?, ?, ?, ?)');
    for (const doc of pendingConsents(u)) ins.run(u.id, doc, legal.VERSION, now(), req.ip);
  }

  /** What is still missing before this person can book (rider) or go online (driver). */
  function todoFor(u) {
    const todo = [];
    if (pendingConsents(u).length) todo.push('terms');
    if (!u.email_verified_at) todo.push('email');
    if (!u.dob || !u.gender) todo.push('personal');
    if (u.role === 'rider' && !(u.trusted_name && u.trusted_phone)) todo.push('trusted');
    if (u.role === 'driver') {
      const d = getDriver(u.id);
      if (!['submitted', 'verified'].includes(d.status)) todo.push('vehicle');
    }
    return todo;
  }
  const TODO_TEXT = {
    terms: 'accept the latest terms', email: 'confirm your email', personal: 'add your date of birth and sex',
    trusted: 'add a trusted contact', vehicle: 'complete your vehicle & documents',
  };
  function requireReady(u) {
    const todo = todoFor(u);
    if (todo.length) throw Object.assign(httpError(412, `Please ${TODO_TEXT[todo[0]]} first`), { todo });
  }

  function meView(u) {
    const out = {
      id: u.id, publicId: u.public_id, name: u.name, role: u.role,
      phone: u.phone, phoneVerified: !!u.phone_verified_at,
      email: u.email, emailVerified: !!u.email_verified_at,
      dob: u.dob, age: ageFrom(u.dob), gender: u.gender,
      trusted: u.trusted_name ? { name: u.trusted_name, phone: u.trusted_phone, relation: u.trusted_relation } : null,
      todo: todoFor(u), pendingConsents: pendingConsents(u), rating: ratingOf(u.id), cancelDues: u.cancel_dues, photo: u.photo,
    };
    if (u.role === 'driver') {
      const d = getDriver(u.id);
      out.driver = {
        ...publicDriver(d, { full: true }),
        wallet: { balance: d.wallet_balance, min: C.WALLET_MIN_BALANCE, ok: d.wallet_balance >= C.WALLET_MIN_BALANCE },
        duty: dutyStatus(u.id), qr: `olub:D:${u.public_id}`, suspended: d.suspended_reason,
      };
    }
    return out;
  }

  const readDocs = (d) => json(decrypt(d.docs)) || {};

  function publicDriver(d, { full = false } = {}) {
    const u = getUser(d.user_id);
    const docs = readDocs(d);
    const prefs = json(d.prefs) || {};
    const tier = experienceTier(d.completed_trips);
    const out = {
      id: d.user_id, publicId: u.public_id,
      name: u.name, age: ageFrom(u.dob), gender: u.gender,
      // "Driving since" comes from the licence issue date.
      drivingYears: d.license_issued_on ? Math.max(0, ageFrom(d.license_issued_on)) : null,
      vehicleNumber: d.vehicle_number, vehicleType: d.vehicle_type,
      vehicleLabel: C.VEHICLES[d.vehicle_type]?.label, vehicleModel: d.vehicle_model, condition: d.vehicle_condition,
      state: d.state, status: d.status, verifiedVia: d.verified_via, online: !!d.online,
      completedTrips: d.completed_trips, experience: tier.label, rating: ratingOf(d.user_id),
      rules: Object.keys(C.DRIVER_RULES).filter((k) => prefs[k]),
      petsOk: !!prefs.petsOk, petCharge: prefs.petsOk ? (prefs.petCharge || 0) : 0,
      licenseNo: mask(d.license_no), rcNo: d.rc_no,
      // Only what a rider needs to recognise the driver. KYC ID stays private.
      photos: { selfie: docs.selfie || u.photo || null, vehicle: docs.vehicle || null },
    };
    if (full) {
      Object.assign(out, {
        phone: u.phone, email: u.email, licenseNo: d.license_no, licenseIssuedOn: d.license_issued_on,
        insuranceValidTill: d.insurance_valid_till, kycIdNo: d.kyc_id_no, permitNo: d.permit_no, docs, prefs,
      });
    }
    return out;
  }

  function auth(req, _res, next) {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
    const s = token && db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!s || s.expires_at < now()) return next(httpError(401, 'Please log in'));
    const user = getUser(s.user_id);
    if (!user || user.status !== 'active') return next(httpError(401, 'Please log in'));
    req.user = user;
    req.tokenHash = s.token_hash;
    next();
  }
  const role = (...roles) => (req, _res, next) =>
    (roles.includes(req.user.role) ? next() : next(httpError(403, 'Not allowed for your account type')));

  function findDriver(query) {
    const q = String(query || '').trim();
    if (!q) throw httpError(400, "Enter the driver's mobile number or vehicle number");
    const phone = normPhone(q);
    let d = null;
    const idMatch = q.toUpperCase().match(/OLB-D-[2-9A-Z]{6}/); // typed Olub ID or scanned QR ("olub:D:OLB-D-…")
    if (idMatch) {
      const u = db.prepare("SELECT id FROM users WHERE public_id = ? AND role = 'driver'").get(idMatch[0]);
      d = u && getDriver(u.id);
    } else if (isPhone(phone) && /^[\d\s+-]+$/.test(q)) {
      const u = db.prepare("SELECT id FROM users WHERE phone = ? AND role = 'driver'").get(phone);
      d = u && getDriver(u.id);
    } else {
      d = db.prepare('SELECT * FROM drivers WHERE vehicle_number = ?').get(normVehicle(q));
    }
    if (!d) throw httpError(404, 'No Olub driver found for that QR, vehicle number or mobile number');
    return d;
  }

  function resolvePoint(p, label) {
    if (!p) throw httpError(400, `Choose a ${label.toLowerCase()} point`);
    if (p.placeId) {
      const pl = db.prepare('SELECT * FROM places WHERE id = ?').get(p.placeId);
      if (!pl) throw httpError(400, `Unknown ${label.toLowerCase()} place`);
      return withPin({ name: pl.name, lat: pl.lat, lng: pl.lng, state: pl.state });
    }
    if (p.digipin && p.lat == null) {
      const c = Digipin.looksLike(p.digipin) && Digipin.decode(p.digipin);
      if (!c) throw httpError(400, `${label} DIGIPIN is not valid`);
      p = { ...p, lat: c.lat, lng: c.lng };
    }
    const pt = withPin({ name: text(p.name, 120), lat: Number(p.lat), lng: Number(p.lng), state: p.state });
    if (!isValidPoint(pt)) throw httpError(400, `${label} location is invalid`);
    pt.name = pt.name || (pt.digipin ? `DIGIPIN ${pt.digipin}` : `${label} pin`);
    return pt;
  }

  async function buildQuote(body, rider, extra = {}) {
    const d = extra.driver || findDriver(body.driver);
    const pickupKm = extra.pickupKm || 0; // the cab's road distance to the customer, when Olub found the cab
    if (d.user_id === rider.id) throw httpError(400, 'You cannot book yourself');
    if (d.status === 'incomplete' || d.status === 'rejected') throw httpError(409, 'This driver has not completed Olub registration');
    if (!d.online) throw httpError(409, 'Driver is offline. Ask them to go online in the Olub app.');
    if (db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(d.user_id)) {
      throw httpError(409, 'Driver is on another trip');
    }
    const why = unavailableReason(d);
    if (why) throw httpError(409, why);
    const prefs = json(d.prefs) || {};
    const pet = !!body.pet;
    if (pet && !prefs.petsOk) throw httpError(409, 'This driver does not take pets');

    const src = resolvePoint(body.src, 'Pickup');
    const dst = resolvePoint(body.dst, 'Drop');
    const state = src.state || d.state;
    const route = await maps.getRoute(src, dst, { vehicleType: d.vehicle_type, when: new Date(now()) });
    if (route.distanceKm < 0.005) throw httpError(400, 'Pickup and drop are the same spot');
    const routeTolls = T.tollsOnRoute(db, src, dst);
    const cal = calamityFor(state);
    const rates = getRates()[d.vehicle_type];
    const quote = calculateFare({
      distanceKm: route.distanceKm, pickupKm, vehicleType: d.vehicle_type, rates,
      condition: d.vehicle_condition, completedTrips: d.completed_trips,
      waitMinutes: route.delayMin,
      tolls: T.tollsForVehicle(routeTolls, d.vehicle_type),
      petCharge: pet ? Math.min(C.MAX_PET_CHARGE, prefs.petCharge || 0) : 0,
      calamity: !!cal, dues: rider.cancel_dues,
    });
    quote.driverCompletedTrips = d.completed_trips;
    quote.rates = rates;
    return { d, src, dst, state, route, routeTolls, quote, calamity: cal, pet };
  }

  const tripTolls = (trip) => db.prepare('SELECT t.* FROM trip_tolls tt JOIN tolls t ON t.id = tt.toll_id WHERE tt.trip_id = ?').all(trip.id);

  function computeFinal(trip) {
    const d = getDriver(trip.driver_id);
    const quote = json(trip.quote);
    return calculateFare({
      distanceKm: trip.distance_km - (trip.pickup_km || 0), pickupKm: trip.pickup_km || 0, vehicleType: quote.vehicleType, rates: quote.rates,
      condition: d.vehicle_condition,
      completedTrips: quote.driverCompletedTrips ?? d.completed_trips, // locked at booking
      waitMinutes: trip.wait_minutes ?? quote.breakdown.waitMinutes,
      tolls: T.tollsForVehicle(tripTolls(trip), quote.vehicleType),
      petCharge: quote.breakdown.petCharge, dues: quote.dues,
      calamity: quote.calamity || !!calamityFor(trip.state),
      discount: trip.verify_discount ? C.VERIFY_DISCOUNT : 0,
    });
  }

  // Indian financial year, e.g. "2026-27".
  const fy = (ts) => { const d = new Date(ts + 5.5 * 3600e3); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };

  /** Driving score for a trip from its GPS trail (overspeed and harsh braking). */
  function safetyScore(trip) {
    const pts = db.prepare('SELECT * FROM trip_points WHERE trip_id = ? ORDER BY id').all(trip.id);
    let overspeed = 0, harsh = 0, maxKmph = 0, inRun = false, prev = null;
    for (const p of pts) {
      let v = p.kmph;
      if (v == null && prev) { const dt = (p.ts - prev.ts) / 3600e3; v = dt > 0 ? Math.min(200, pointToSegmentKm(p, prev, prev) / dt) : null; }
      if (v != null) {
        maxKmph = Math.max(maxKmph, v);
        if (v > C.OVERSPEED_KMPH) { if (!inRun) overspeed++; inRun = true; } else inRun = false;
        if (prev && prev.v != null) {
          const dt = (p.ts - prev.ts) / 1000;
          if (dt > 0 && dt <= 15 && ((prev.v - v) / 3.6) / dt >= C.HARSH_BRAKE_MS2) harsh++;
        }
      }
      prev = { ...p, v };
    }
    const deviated = !!db.prepare("SELECT 1 FROM safety_events WHERE trip_id = ? AND type = 'route_deviation'").get(trip.id);
    return {
      score: pts.length < 2 ? null : Math.max(0, 100 - overspeed * 6 - harsh * 8 - (deviated ? 5 : 0)),
      overspeed, harshBrakes: harsh, maxKmph: Math.round(maxKmph), points: pts.length, routeDeviation: deviated,
    };
  }

  /**
   * Who pays for a cancellation? Exactly one side or nobody — the app's decision is final.
   *  - before the driver accepts, or inside the free window: nobody
   *  - driver cancels: driver
   *  - customer cancels saying "driver is not coming" and GPS agrees: driver
   *  - otherwise: customer (capped at 10% of the fare)
   */
  function cancellationVerdict(trip, by, reason) {
    const quote = json(trip.quote);
    const base = platformFeeFor(trip.distance_km, false);
    const none = (why) => ({ fee: 0, charged: null, why });
    if (trip.status === 'requested') return none('the driver had not accepted yet');
    if (by === 'driver') return { fee: base, charged: 'driver', why: 'the driver cancelled after accepting' };
    const sinceAccept = (now() - trip.accepted_at) / 60000;
    if (reason === 'driver_not_coming' && sinceAccept >= C.CANCEL_DRIVER_GRACE_MIN) {
      const arrived = trip.pickup_dist_last != null && trip.pickup_dist_last <= C.CANCEL_ARRIVED_KM;
      const progressed = trip.pickup_dist_start != null && trip.pickup_dist_start - trip.pickup_dist_last >= C.CANCEL_PROGRESS_KM;
      if (!arrived && !progressed) return { fee: base, charged: 'driver', why: 'GPS shows the driver was not coming to the pickup' };
    }
    if ((now() - trip.created_at) / 60000 < C.CANCEL_FREE_WINDOW_MIN) return none(`cancelled within ${C.CANCEL_FREE_WINDOW_MIN} minutes of booking`);
    const cap = Math.min(C.CANCEL_CUSTOMER_CAP.max, Math.floor(quote.riderPays * C.CANCEL_CUSTOMER_CAP.percent));
    const fee = Math.min(base, cap);
    if (fee <= 0) return none('the fare is too small for a fee');
    return { fee, charged: 'rider', why: reason === 'driver_not_coming' ? 'GPS shows the driver was on the way or at the pickup' : 'the customer cancelled after the driver accepted' };
  }

  function withDiscount(q, discount) {
    if (!discount || q.discount) return q;
    return { ...q, discount, riderPays: r2(Math.max(0, q.riderPays - discount)), platformNet: r2(q.platformNet - discount) };
  }

  function lateMinutes(trip) {
    if (trip.status !== 'started' || !trip.expected_end_at) return 0;
    return Math.max(0, Math.floor((now() - trip.expected_end_at) / 60000));
  }

  function tripView(trip, viewer) {
    const isRider = viewer.id === trip.rider_id;
    const d = getDriver(trip.driver_id);
    const rider = getUser(trip.rider_id);
    const guest = trip.guest_id ? db.prepare('SELECT public_id, name FROM guests WHERE id = ?').get(trip.guest_id) : null;
    const bill = json(trip.final) || withDiscount(json(trip.quote), trip.verify_discount ? C.VERIFY_DISCOUNT : 0);
    return {
      id: trip.id, status: trip.status, you: isRider ? 'rider' : 'driver',
      src: withPin({ name: trip.src_name, lat: trip.src_lat, lng: trip.src_lng }),
      dst: withPin({ name: trip.dst_name, lat: trip.dst_lat, lng: trip.dst_lng }),
      payTiming: trip.pay_timing, prepaid: trip.prepaid_amount ? { amount: trip.prepaid_amount, method: trip.prepaid_method } : null,
      balanceDue: trip.paid_at ? 0 : r2(Math.max(0, bill.riderPays - (trip.prepaid_amount || 0))),
      invoiceNo: trip.invoice_no, safety: json(trip.safety),
      matched: !!trip.match_mode, pickupKm: trip.pickup_km || 0,
      cancellation: trip.status === 'cancelled' ? {
        by: trip.cancel_by, reason: trip.cancel_reason, fee: trip.cancel_fee, charged: trip.cancel_charged,
        youPay: trip.cancel_charged === (isRider ? 'rider' : 'driver') ? trip.cancel_fee : 0,
      } : undefined,
      offRoute: !!trip.off_route_alerted, sosAt: trip.sos_at,
      state: trip.state, distanceKm: trip.distance_km,
      etaMin: Math.round(trip.eta_min), traffic: { label: trip.traffic_label, source: trip.traffic_source },
      pet: !!trip.pet,
      quote: withDiscount(json(trip.quote), trip.verify_discount ? C.VERIFY_DISCOUNT : 0),
      final: json(trip.final),
      tolls: tripTolls(trip).map((t) => T.publicToll(db, t, isRider ? undefined : trip.driver_id)),
      otp: isRider && ['requested', 'accepted'].includes(trip.status) ? trip.otp : undefined, // rider only
      driver: publicDriver(d),
      rider: { publicId: rider.public_id, name: firstName(rider.name), rating: ratingOf(rider.id), photo: rider.photo },
      routePolyline: trip.route_poly,
      guest: guest ? { publicId: guest.public_id, name: guest.name } : null,
      canVerifyDriver: isRider && d.status === 'submitted' && !trip.verify_discount &&
        ['accepted', 'started', 'completed'].includes(trip.status) && !trip.paid_at,
      verifyDiscount: trip.verify_discount ? C.VERIFY_DISCOUNT : 0,
      waitMinutes: trip.wait_minutes,
      // Live tracking link — only the rider can share it.
      trackPath: isRider && trip.track_token ? `/track/${trip.track_token}` : undefined,
      trusted: isRider && rider.trusted_name ? { name: rider.trusted_name } : undefined,
      expectedEndAt: trip.expected_end_at, lateMin: lateMinutes(trip), overdueLevel: trip.overdue_level,
      last: trip.last_lat != null ? withPin({ lat: trip.last_lat, lng: trip.last_lng, at: trip.last_loc_at }) : null,
      rated: !!db.prepare('SELECT 1 FROM ratings WHERE trip_id = ? AND from_id = ?').get(trip.id, viewer.id),
      paymentMethod: trip.payment_method, paidAt: trip.paid_at,
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
  const canTalk = (trip) => ['accepted', 'started'].includes(trip.status) ||
    (trip.status === 'completed' && now() - trip.completed_at < 60 * 60 * 1000);

  const route = (fn) => async (req, res, next) => {
    try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };
  const baseUrl = (req) => publicBase || `${req.protocol}://${req.get('host')}`;

  // ================= public =================
  app.get('/healthz', route(() => ({ ok: true, time: now(), db: db.prepare('SELECT 1 AS x').get().x === 1 })));

  app.get('/api/config', route(() => ({
    platformFee: C.PLATFORM_FEE, platformFeeCalamity: C.PLATFORM_FEE_CALAMITY,
    verifyDiscount: C.VERIFY_DISCOUNT, platformFeeLong: C.PLATFORM_FEE_LONG, platformFeeLongKm: C.PLATFORM_FEE_LONG_KM,
    cancel: { freeMin: C.CANCEL_FREE_WINDOW_MIN, capPercent: C.CANCEL_CUSTOMER_CAP.percent * 100 },
    monthly: { enabled: C.MONTHLY_FEE_ENABLED, max: C.MONTHLY_FEE_MAX, sharePercent: C.MONTHLY_FEE_SHARE * 100 },
    defaultToll: C.DEFAULT_TOLL, stateDefaultToll: C.STATE_DEFAULT_TOLL, tollConfirmationsRequired: C.TOLL_CONFIRMATIONS_REQUIRED,
    vehicles: getRates(), conditions: Object.keys(C.CONDITION_MULTIPLIER),
    driverRules: C.DRIVER_RULES, maxPetCharge: C.MAX_PET_CHARGE, ratingCriteria: C.RATING_CRITERIA,
    overdue: { warn: C.OVERDUE_WARN_MIN, alert: C.OVERDUE_ALERT_MIN }, minAge: C.MIN_AGE,
    dsrTypes: C.DSR_TYPES, dsrPublicDays: C.DSR_PUBLIC_SLA_DAYS,
    dsrCorrectionFields: Object.fromEntries(Object.entries(C.DSR_CORRECTION_FIELDS).map(([k, v]) => [k, { label: v.label, mode: v.mode }])),
    liveTraffic: !!C.GOOGLE_MAPS_API_KEY, legalVersion: legal.VERSION, matchOfferSeconds: C.MATCH_OFFER_SECONDS,
    gst: { ride: C.RIDE_GST_RATE, platformFee: C.PLATFORM_FEE_GST_RATE }, company: C.COMPANY,
    wallet: { min: C.WALLET_MIN_BALANCE, maxTopup: C.WALLET_MAX_TOPUP },
    duty: { maxHours: C.DUTY_MAX_HOURS, restHours: C.DUTY_REST_HOURS },
    lea: { agencies: C.LEA_AGENCIES, publicDays: C.LEA_PUBLIC_SLA_DAYS },
    calamity: db.prepare('SELECT * FROM calamity').all(),
  })));
  app.get('/api/legal', route(() => ({ version: legal.VERSION, docs: legal.docs, required: legal.required })));
  app.get('/api/places', route(() => db.prepare('SELECT * FROM places ORDER BY name').all()));
  app.get('/api/places/search', auth, route(async (req) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const local = db.prepare('SELECT * FROM places').all().filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ placeId: p.id, name: p.name, lat: p.lat, lng: p.lng }));
    const near = isValidPoint({ lat: Number(req.query.lat), lng: Number(req.query.lng) }) && req.query.lat ? { lat: Number(req.query.lat), lng: Number(req.query.lng) } : null;
    return [...local, ...(q.length >= 3 ? await maps.searchPlaces(q, { near }) : [])];
  }));

  // Live tracking page for the trusted contact (no login; the link is the secret).
  app.get('/track/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'track.html')));
  app.get('/api/track/:token', route((req) => {
    const trip = db.prepare('SELECT * FROM trips WHERE track_token = ?').get(req.params.token);
    if (!trip) throw httpError(404, 'Tracking link not found');
    const ended = trip.completed_at || (['cancelled', 'rejected'].includes(trip.status) ? trip.created_at : null);
    if (ended && now() - ended > 2 * 3600 * 1000) throw httpError(410, 'This ride has ended. The tracking link has expired.');
    const d = publicDriver(getDriver(trip.driver_id));
    const guest = trip.guest_id ? db.prepare('SELECT name FROM guests WHERE id = ?').get(trip.guest_id) : null;
    return {
      status: trip.status,
      traveller: firstName(guest?.name || getUser(trip.rider_id).name),
      src: withPin({ name: trip.src_name, lat: trip.src_lat, lng: trip.src_lng }),
      dst: withPin({ name: trip.dst_name, lat: trip.dst_lat, lng: trip.dst_lng }),
      offRoute: !!trip.off_route_alerted, sosAt: trip.sos_at, routePolyline: trip.route_poly,
      driver: { name: firstName(d.name), vehicleNumber: d.vehicleNumber, vehicleLabel: d.vehicleLabel, vehicleModel: d.vehicleModel, rating: d.rating, photo: d.photos.selfie },
      startedAt: trip.started_at, expectedEndAt: trip.expected_end_at, completedAt: trip.completed_at,
      lateMin: lateMinutes(trip), overdueLevel: trip.overdue_level,
      last: trip.last_lat != null ? withPin({ lat: trip.last_lat, lng: trip.last_lng, at: trip.last_loc_at }) : null,
      path: db.prepare('SELECT lat, lng FROM (SELECT * FROM trip_points WHERE trip_id = ? ORDER BY id DESC LIMIT 300) ORDER BY id').all(trip.id),
      now: now(),
    };
  }));

  // ================= auth (mobile OTP) =================
  app.post('/api/auth/request-otp', rateLimit, route((req) => {
    const phone = normPhone(req.body.phone);
    if (!isPhone(phone)) throw httpError(400, 'Enter a valid 10-digit Indian mobile number');
    const code = sixDigit();
    db.prepare(`INSERT INTO login_otps (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)
      ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`)
      .run(phone, code, now() + C.LOGIN_OTP_TTL_MS);
    queue('sms', phone, 'login_otp', 'Your Olub login code is ******. Do not share it with anyone.');
    const existing = db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone);
    return { ok: true, isNewUser: !existing, ...(C.DEV_OTP && { devCode: code }) };
  }));

  app.post('/api/auth/verify-otp', rateLimit, route((req) => {
    const phone = normPhone(req.body.phone);
    const row = db.prepare('SELECT * FROM login_otps WHERE phone = ?').get(phone);
    if (!row || row.expires_at < now()) throw httpError(400, 'OTP expired, request a new one');
    if (row.attempts >= 5) throw httpError(429, 'Too many attempts, request a new OTP');
    if (String(req.body.code) !== row.code) {
      db.prepare('UPDATE login_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
      throw httpError(400, 'Wrong OTP');
    }

    let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) {
      const r = C.ADMIN_PHONES.includes(phone) ? 'admin' : (req.body.role === 'driver' ? 'driver' : 'rider');
      const name = text(req.body.name, 60);
      if (!name) throw httpError(400, 'Please enter your name');
      if (!req.body.acceptTerms) throw httpError(400, 'Please accept the terms to continue');
      const ins = db.prepare('INSERT INTO users (public_id, phone, phone_verified_at, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(newPublicId(ID_PREFIX[r], 'users'), phone, now(), name, r, now());
      user = getUser(ins.lastInsertRowid);
      if (r === 'driver') db.prepare('INSERT INTO drivers (user_id) VALUES (?)').run(user.id);
      recordConsents(user, req);
      req.auditNote = `signed up as ${r}; accepted ${legal.required[r].join(', ')} v${legal.VERSION}`;
    } else {
      db.prepare('UPDATE users SET phone_verified_at = ? WHERE id = ?').run(now(), user.id);
    }
    db.prepare('DELETE FROM login_otps WHERE phone = ?').run(phone);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), user.id, now(), now() + C.SESSION_TTL_MS);
    req.user = user;
    return { token, user: meView(getUser(user.id)) };
  }));

  app.post('/api/auth/logout', auth, route((req) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    return { ok: true };
  }));

  // ================= my profile =================
  app.get('/api/me', auth, route((req) => meView(req.user)));

  /** Validate and save profile fields. Used by the profile screen and by automatic "correct my data" requests. */
  function applyProfile(u, b) {
    const set = {};
    if (b.photo !== undefined) {
      if (b.photo && (!/^data:image\//.test(b.photo) || b.photo.length > 400_000)) throw httpError(400, 'Choose a smaller photo');
      set.photo = b.photo || null;
    }
    if (b.name !== undefined) { set.name = text(b.name, 60); if (!set.name) throw httpError(400, 'Name is required'); }
    if (b.dob !== undefined) {
      if (!isDate(b.dob)) throw httpError(400, 'Enter your date of birth');
      const age = ageFrom(b.dob);
      if (age < C.MIN_AGE || age > 100) throw httpError(400, `You must be at least ${C.MIN_AGE} years old to use Olub`);
      set.dob = b.dob;
    }
    if (b.gender !== undefined) {
      if (!['male', 'female', 'other'].includes(b.gender)) throw httpError(400, 'Choose your sex');
      set.gender = b.gender;
    }
    if (b.trusted !== undefined) {
      const p = normPhone(b.trusted?.phone);
      if (!text(b.trusted?.name, 60) || !isPhone(p)) throw httpError(400, "Enter your trusted contact's name and mobile number");
      if (p === u.phone) throw httpError(400, 'Your trusted contact must be someone else');
      Object.assign(set, { trusted_name: text(b.trusted.name, 60), trusted_phone: p, trusted_relation: text(b.trusted.relation, 30) });
    }
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), u.id);
    return keys;
  }

  app.patch('/api/me', auth, route((req) => {
    applyProfile(req.user, req.body);
    return meView(getUser(req.user.id));
  }));

  app.post('/api/me/consents', auth, route((req) => {
    if (!req.body.accept) throw httpError(400, 'Please accept to continue');
    recordConsents(req.user, req);
    return meView(req.user);
  }));

  // Email confirmation by one-time code.
  app.post('/api/me/email', auth, rateLimit, route((req) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, 'Enter a valid email address');
    const code = sixDigit();
    db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').run(email, req.user.id);
    db.prepare(`INSERT INTO email_otps (user_id, email, code, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code = excluded.code, expires_at = excluded.expires_at, attempts = 0`)
      .run(req.user.id, email, code, now() + 15 * 60 * 1000);
    queue('email', email, 'email_otp', 'Your Olub email confirmation code is ******.', { userId: req.user.id });
    return { ok: true, ...(C.DEV_OTP && { devCode: code }) };
  }));

  app.post('/api/me/email/verify', auth, rateLimit, route((req) => {
    const row = db.prepare('SELECT * FROM email_otps WHERE user_id = ?').get(req.user.id);
    if (!row || row.expires_at < now()) throw httpError(400, 'Code expired, request a new one');
    if (row.attempts >= 5) throw httpError(429, 'Too many attempts, request a new code');
    if (String(req.body.code) !== row.code) {
      db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE user_id = ?').run(req.user.id);
      throw httpError(400, 'Wrong code');
    }
    db.prepare('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?').run(row.email, now(), req.user.id);
    db.prepare('DELETE FROM email_otps WHERE user_id = ?').run(req.user.id);
    return meView(getUser(req.user.id));
  }));

  // Guests: people a customer books for. Each gets their own Olub ID.
  app.get('/api/guests', auth, role('rider'), route((req) =>
    db.prepare('SELECT id, public_id AS publicId, name, phone FROM guests WHERE owner_id = ? ORDER BY id DESC').all(req.user.id)));

  function resolveGuest(body, rider) {
    if (!body) return null;
    if (body.id) {
      const g = db.prepare('SELECT * FROM guests WHERE id = ? AND owner_id = ?').get(body.id, rider.id);
      if (!g) throw httpError(400, 'Guest not found');
      return g;
    }
    const name = text(body.name, 60);
    if (!name) throw httpError(400, "Enter your guest's name");
    const phone = body.phone ? normPhone(body.phone) : null;
    if (phone && !isPhone(phone)) throw httpError(400, "Guest's mobile number is not valid");
    const r = db.prepare('INSERT INTO guests (public_id, owner_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newPublicId('OLB-G', 'guests'), rider.id, name, phone, now());
    return db.prepare('SELECT * FROM guests WHERE id = ?').get(r.lastInsertRowid);
  }

  // ================= realtime stream =================
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

  // ================= driver =================
  function cleanPrefs(p = {}) {
    const out = {};
    for (const k of Object.keys(C.DRIVER_RULES)) out[k] = !!p[k];
    out.petsOk = !!p.petsOk;
    const charge = Math.round(Number(p.petCharge) || 0);
    if (charge < 0 || charge > C.MAX_PET_CHARGE) throw httpError(400, `Pet charge must be between ₹0 and ₹${C.MAX_PET_CHARGE}`);
    out.petCharge = out.petsOk ? charge : 0;
    return out;
  }

  app.put('/api/driver/profile', auth, role('driver'), route((req) => {
    const b = req.body;
    const d = getDriver(req.user.id);
    if (db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(d.user_id)) {
      throw httpError(409, 'Finish your current trip before editing your profile');
    }
    const vehicleNumber = normVehicle(b.vehicleNumber);
    if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/.test(vehicleNumber)) throw httpError(400, 'Enter a valid vehicle number, e.g. KA01AB1234');
    if (!C.VEHICLES[b.vehicleType]) throw httpError(400, 'Choose a vehicle type');
    if (!C.CONDITION_MULTIPLIER[b.condition]) throw httpError(400, 'Choose vehicle condition');
    const state = String(b.state || vehicleNumber.slice(0, 2)).toUpperCase().slice(0, 4);
    if (db.prepare('SELECT 1 FROM drivers WHERE vehicle_number = ? AND user_id != ?').get(vehicleNumber, d.user_id)) {
      throw httpError(409, 'This vehicle is already registered with another driver');
    }
    const today = new Date(now()).toISOString().slice(0, 10);
    const issued = b.licenseIssuedOn || d.license_issued_on;
    if (issued && (!isDate(issued) || issued > today)) throw httpError(400, 'Licence issue date is not valid');
    const insurance = b.insuranceValidTill || d.insurance_valid_till;
    if (insurance && (!isDate(insurance) || insurance < today)) throw httpError(400, 'Your vehicle insurance must be valid today');

    const docs = readDocs(d);
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
      license_issued_on: issued || '', insurance_valid_till: insurance || '',
      permit_no: String(b.permitNo || d.permit_no || '').toUpperCase().trim(),
    };
    const missing = [...DOC_KEYS.filter((k) => !docs[k]), ...Object.entries(fields).filter(([, v]) => !v).map(([k]) => k)];
    const changed = d.vehicle_number !== vehicleNumber || DOC_KEYS.some((k) => b.docs?.[k]);
    let status = d.status;
    if (missing.length) status = 'incomplete';
    else if (status !== 'verified' || changed) status = 'submitted';
    const prefs = b.prefs ? cleanPrefs(b.prefs) : (json(d.prefs) || cleanPrefs());

    db.prepare(`UPDATE drivers SET vehicle_number = ?, vehicle_type = ?, vehicle_model = ?, vehicle_condition = ?, state = ?,
      license_no = ?, license_issued_on = ?, rc_no = ?, kyc_id_no = ?, insurance_valid_till = ?, permit_no = ?, docs = ?, prefs = ?, status = ?,
      verified_via = CASE WHEN ? = 'verified' THEN verified_via ELSE NULL END,
      online = CASE WHEN ? = 'incomplete' THEN 0 ELSE online END WHERE user_id = ?`).run(
      vehicleNumber, b.vehicleType, text(b.vehicleModel, 60), b.condition, state,
      fields.license_no, fields.license_issued_on || null, fields.rc_no, fields.kyc_id_no, fields.insurance_valid_till || null, fields.permit_no,
      encrypt(JSON.stringify(docs)), JSON.stringify(prefs), status, status, status, d.user_id,
    );
    return { me: meView(getUser(d.user_id)), missing };
  }));

  // Cab rules & pets can be changed any time without re-verification.
  app.put('/api/driver/prefs', auth, role('driver'), route((req) => {
    db.prepare('UPDATE drivers SET prefs = ? WHERE user_id = ?').run(JSON.stringify(cleanPrefs(req.body)), req.user.id);
    return meView(req.user);
  }));

  app.post('/api/driver/online', auth, role('driver'), route((req) => {
    const d = getDriver(req.user.id);
    const online = !!req.body.online;
    if (online) {
      requireReady(req.user);
      const today = new Date(now()).toISOString().slice(0, 10);
      if (d.insurance_valid_till < today) throw httpError(409, 'Your vehicle insurance has expired. Update it to go online.');
      if (d.suspended_reason) throw httpError(403, `Your account is on hold: ${d.suspended_reason}`);
      if (d.wallet_balance < C.WALLET_MIN_BALANCE) throw httpError(402, `Keep at least ₹${C.WALLET_MIN_BALANCE} in your Olub wallet to get customers. Please top up.`);
      const duty = dutyStatus(d.user_id);
      if (duty.locked) {
        throw httpError(409, `You have driven ${C.DUTY_MAX_HOURS} hours. Rest ${C.DUTY_REST_HOURS} hours — you can go online after ${new Date(duty.restUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}.`);
      }
      if (!db.prepare('SELECT 1 FROM duty_sessions WHERE driver_id = ? AND ended_at IS NULL').get(d.user_id)) {
        // Hours already driven on other apps today count towards the same 12-hour limit.
        const other = Math.min(12 * 60, Math.max(0, Math.round(Number(req.body.otherAppHours) * 60) || 0));
        db.prepare('INSERT INTO duty_sessions (driver_id, started_at, declared_other_min) VALUES (?, ?, ?)').run(d.user_id, now(), other);
      }
      db.prepare('UPDATE drivers SET online = 1 WHERE user_id = ?').run(d.user_id);
    } else {
      if (db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(d.user_id)) throw httpError(409, 'Finish your current trip first');
      forceOffline(d.user_id, 'driver');
    }
    return { online, duty: dutyStatus(d.user_id) };
  }));

  app.get('/api/driver/earnings', auth, role('driver'), route((req) => {
    const rows = db.prepare("SELECT final FROM trips WHERE driver_id = ? AND status = 'completed' AND paid_at IS NOT NULL").all(req.user.id);
    let earned = 0, tolls = 0, platformNet = 0;
    for (const r of rows) { const f = json(r.final); earned += f.driverFare; tolls += f.breakdown.tollTotal; platformNet += f.platformNet; }
    return { trips: rows.length, earned: r2(earned), tollsCollected: r2(tolls), owedToOlub: r2(platformNet) };
  }));

  // Where an online driver is waiting, so customers can see cabs around them.
  app.post('/api/driver/location', auth, role('driver'), route((req) => {
    const p = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
    if (!isValidPoint(p)) throw httpError(400, 'Bad location');
    db.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_loc_at = ? WHERE user_id = ?').run(p.lat, p.lng, now(), req.user.id);
    return { ok: true };
  }));

  // Cabs near the customer: type and rough position only (rounded to about 100 m), never who they are.
  app.get('/api/drivers/nearby', auth, route((req) => {
    const c = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
    if (!isValidPoint(c)) return [];
    return db.prepare(`SELECT d.user_id, d.vehicle_type, d.last_lat, d.last_lng FROM drivers d
      WHERE d.online = 1 AND d.suspended_reason IS NULL AND d.last_lat IS NOT NULL AND d.last_loc_at > ?
        AND ABS(d.last_lat - ?) < 0.08 AND ABS(d.last_lng - ?) < 0.08
        AND d.user_id NOT IN (SELECT driver_id FROM trips WHERE status IN ('accepted','started')) LIMIT 30`)
      .all(now() - 30 * 60000, c.lat, c.lng)
      .map((d) => ({ type: d.vehicle_type, lat: Math.round(d.last_lat * 1000) / 1000, lng: Math.round(d.last_lng * 1000) / 1000 }));
  }));


  // ================= finding the nearest cab (hexagonal search) =================
  /** Online, free cabs around a point, nearest ring first. */
  function nearbyCabs(src, { vehicleType = null, pet = false, exclude = [], riderId = null } = {}) {
    return db.prepare(`SELECT * FROM drivers WHERE online = 1 AND suspended_reason IS NULL AND status IN ('submitted','verified')
        AND last_lat IS NOT NULL AND last_loc_at > ?
        AND user_id NOT IN (SELECT driver_id FROM trips WHERE status IN ('requested','accepted','started'))`).all(now() - 30 * 60000)
      .filter((d) => d.user_id !== riderId && !exclude.includes(d.user_id) && (!vehicleType || d.vehicle_type === vehicleType))
      .filter((d) => !pet || (json(d.prefs) || {}).petsOk)
      .filter((d) => !unavailableReason(d))
      .map((d) => {
        const pos = { lat: d.last_lat, lng: d.last_lng };
        return { d, pos, ring: Hex.ring(pos, src, C.MATCH_HEX_KM), km: haversineKm(pos, src) };
      })
      .filter((c) => c.ring <= C.MATCH_MAX_RINGS)
      .sort((a, b) => a.ring - b.ring || a.km - b.km);
  }

  /** Road distance and time for a cab to reach the pickup. */
  async function pickupLeg(cab, src) {
    const leg = await maps.getRoute(cab.pos, src, { vehicleType: cab.d.vehicle_type, when: new Date(now()) });
    return { km: Math.round(leg.distanceKm * 100) / 100, min: Math.max(1, Math.round(leg.etaMin)) };
  }

  // What is around me: one option per vehicle type (the nearest cab of that type), with the full fare.
  app.post('/api/trips/nearby', auth, role('rider'), route(async (req) => {
    const src = resolvePoint(req.body.src, 'Pickup');
    const cabs = nearbyCabs(src, { pet: !!req.body.pet, riderId: req.user.id });
    const nearest = new Map();
    for (const c of cabs) if (!nearest.has(c.d.vehicle_type)) nearest.set(c.d.vehicle_type, c);
    const options = [];
    for (const [type, c] of nearest) {
      const leg = await pickupLeg(c, src);
      const q = await buildQuote(req.body, req.user, { driver: c.d, pickupKm: leg.km });
      options.push({
        type, label: C.VEHICLES[type].label, ring: c.ring, awayKm: leg.km, awayMin: leg.min,
        riderPays: q.quote.riderPays, platformFee: q.quote.platformFee, tripKm: q.quote.breakdown.tripKm, pickupKm: leg.km,
        rating: ratingOf(c.d.user_id), experience: experienceTier(c.d.completed_trips).label,
        count: cabs.filter((x) => x.d.vehicle_type === type).length,
      });
    }
    const far = cabs.length ? Math.min(C.MATCH_MAX_RINGS, cabs[cabs.length - 1].ring) : 2;
    const show = Math.min(5, Math.max(2, cabs.length ? cabs[0].ring + 1 : 2)); // rings drawn on the map
    return {
      options: options.sort((a, b) => a.awayKm - b.awayKm),
      searchedRings: far, hexKm: C.MATCH_HEX_KM,
      hexes: Hex.cellsWithin(show).map((cell) => ({
        ring: Hex.ringOf(cell), corners: Hex.corners(cell, src, C.MATCH_HEX_KM),
        cabs: cabs.filter((c) => { const k = Hex.cellOf(c.pos, src, C.MATCH_HEX_KM); return k.q === cell.q && k.r === cell.r; }).length,
      })),
      cabs: cabs.map((c) => ({ type: c.d.vehicle_type, ring: c.ring, lat: Math.round(c.pos.lat * 1000) / 1000, lng: Math.round(c.pos.lng * 1000) / 1000 })),
    };
  }));

  /** Offer a matched trip to the next nearest cab; cancel it free of charge if nobody is left. */
  async function offerNext(trip, why) {
    const tried = json(trip.tried) || [];
    const quote = json(trip.quote);
    const src = { lat: trip.src_lat, lng: trip.src_lng };
    const body = { src: { ...src, name: trip.src_name, state: trip.state }, dst: { lat: trip.dst_lat, lng: trip.dst_lng, name: trip.dst_name }, pet: !!trip.pet };
    const oldDriver = trip.driver_id;
    for (const c of nearbyCabs(src, { vehicleType: quote.vehicleType, pet: !!trip.pet, exclude: tried, riderId: trip.rider_id })) {
      try {
        const leg = await pickupLeg(c, src);
        const q = await buildQuote(body, getUser(trip.rider_id), { driver: c.d, pickupKm: leg.km });
        db.prepare('UPDATE trips SET driver_id = ?, quote = ?, distance_km = ?, pickup_km = ?, tried = ?, offered_at = ? WHERE id = ?')
          .run(c.d.user_id, JSON.stringify(q.quote), q.quote.distanceKm, leg.km, JSON.stringify([...tried, c.d.user_id]), now(), trip.id);
        audit.log({ action: 'match.offered_next', entity: 'trips', entityId: trip.id, details: { why, ring: c.ring, awayKm: leg.km } });
        emit(oldDriver, 'trip', {}); notifyTrip(trip);
        return true;
      } catch { /* this cab cannot take it; try the next */ }
    }
    db.prepare("UPDATE trips SET status = 'cancelled', cancelled_at = ?, cancel_by = 'system', cancel_reason = 'no_driver', cancel_fee = 0 WHERE id = ?").run(now(), trip.id);
    audit.log({ action: 'match.no_driver', entity: 'trips', entityId: trip.id, details: { why } });
    emit(oldDriver, 'trip', {}); notifyTrip(trip);
    return false;
  }

  // ================= booking =================
  app.get('/api/drivers/lookup', auth, route((req) => publicDriver(findDriver(req.query.q))));

  app.post('/api/trips/quote', auth, role('rider'), route(async (req) => {
    const q = await buildQuote(req.body, req.user);
    return {
      driver: publicDriver(q.d), src: q.src, dst: q.dst, state: q.state, pet: q.pet,
      quote: q.quote, calamity: q.calamity,
      route: { etaMin: Math.round(q.route.etaMin), traffic: q.route.trafficLabel, source: q.route.source, polyline: q.route.polyline },
      tolls: q.routeTolls.map((t) => T.publicToll(db, t)),
      verifyOffer: q.d.status === 'submitted' ? C.VERIFY_DISCOUNT : 0,
    };
  }));

  app.post('/api/trips', auth, role('rider'), route(async (req, res) => {
    requireReady(req.user);
    if (db.prepare(`SELECT 1 FROM trips WHERE rider_id = ? AND (status IN ('requested','accepted','started')
      OR (status = 'completed' AND paid_at IS NULL))`).get(req.user.id)) throw httpError(409, 'You already have an active trip');
    // Either the customer names the cab (QR / number), or Olub finds the nearest one of the chosen type.
    let extra = {}; let matched = null;
    if (req.body.match) {
      const src0 = resolvePoint(req.body.src, 'Pickup');
      matched = nearbyCabs(src0, { vehicleType: req.body.match.vehicleType, pet: !!req.body.pet, riderId: req.user.id })[0];
      if (!matched) throw httpError(409, 'No cab of that type is free near you right now');
      extra = { driver: matched.d, pickupKm: (await pickupLeg(matched, src0)).km };
    }
    const q = await buildQuote(req.body, req.user, extra);
    const guest = resolveGuest(req.body.guest, req.user);
    const r = db.prepare(`INSERT INTO trips (rider_id, driver_id, guest_id, src_name, src_lat, src_lng, dst_name, dst_lat, dst_lng,
      state, distance_km, eta_min, free_flow_min, traffic_source, traffic_label, pet, quote, status, otp, track_token, created_at, pay_timing, route_poly)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`).run(
      req.user.id, q.d.user_id, guest?.id ?? null, q.src.name, q.src.lat, q.src.lng, q.dst.name, q.dst.lat, q.dst.lng,
      q.state, q.quote.distanceKm, q.route.etaMin, q.route.freeFlowMin, q.route.source, q.route.trafficLabel, q.pet ? 1 : 0,
      JSON.stringify(q.quote), fourDigit(), crypto.randomBytes(16).toString('hex'), now(),
      req.body.payTiming === 'start' ? 'start' : 'end', q.route.polyline || null,
    );
    const tripId = Number(r.lastInsertRowid);
    if (matched) db.prepare('UPDATE trips SET match_mode = 1, tried = ?, pickup_km = ?, offered_at = ? WHERE id = ?').run(JSON.stringify([q.d.user_id]), extra.pickupKm, now(), tripId);
    const ins = db.prepare('INSERT OR IGNORE INTO trip_tolls (trip_id, toll_id) VALUES (?, ?)');
    for (const t of q.routeTolls) ins.run(tripId, t.id);
    notifyTrip({ id: tripId });
    res.status(201);
    return tripView(getTrip(tripId), req.user);
  }));

  app.get('/api/trips/current', auth, route((req) => {
    const trip = db.prepare(`SELECT * FROM trips WHERE (rider_id = ? OR driver_id = ?)
      AND (status IN ('requested','accepted','started') OR (status = 'completed' AND paid_at IS NULL))
      ORDER BY status = 'requested', id DESC LIMIT 1`).get(req.user.id, req.user.id);
    const requests = req.user.role === 'driver'
      ? db.prepare("SELECT * FROM trips WHERE driver_id = ? AND status = 'requested' ORDER BY id").all(req.user.id).map((t) => tripView(t, req.user))
      : [];
    return { trip: trip ? tripView(trip, req.user) : null, requests };
  }));

  app.get('/api/trips', auth, route((req) => db.prepare('SELECT * FROM trips WHERE rider_id = ? OR driver_id = ? ORDER BY id DESC LIMIT 50')
    .all(req.user.id, req.user.id).map((t) => tripView(t, req.user))));

  app.get('/api/trips/:id', auth, route((req) => tripView(loadTripFor(req), req.user)));

  app.post('/api/trips/:id/accept', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'requested') throw httpError(409, `Trip is already ${trip.status}`);
    if (db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(req.user.id)) throw httpError(409, 'Finish your current trip first');
    const d = getDriver(req.user.id);
    db.prepare("UPDATE trips SET status = 'accepted', accepted_at = ? WHERE id = ?").run(now(), trip.id);
    for (const o of db.prepare("SELECT * FROM trips WHERE driver_id = ? AND status = 'requested' AND id != ?").all(req.user.id, trip.id)) {
      db.prepare("UPDATE trips SET status = 'rejected' WHERE id = ?").run(o.id);
      notifyTrip(o);
    }
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/reject', auth, role('driver'), route(async (req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'requested') throw httpError(409, `Trip is already ${trip.status}`);
    // A cab Olub found: pass the request to the next nearest cab instead of ending it.
    if (trip.match_mode) { await offerNext(trip, 'declined'); return { ok: true }; }
    db.prepare("UPDATE trips SET status = 'rejected' WHERE id = ?").run(trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/cancel', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!['requested', 'accepted'].includes(trip.status)) throw httpError(409, 'Trip can no longer be cancelled');
    const by = trip.rider_id === req.user.id ? 'rider' : 'driver';
    const reason = text(req.body?.reason, 60) || (by === 'rider' ? 'changed_plan' : 'driver_cancelled');
    const verdict = cancellationVerdict(trip, by, reason);
    db.prepare(`UPDATE trips SET status = 'cancelled', cancelled_at = ?, cancel_by = ?, cancel_reason = ?, cancel_fee = ?, cancel_charged = ? WHERE id = ?`)
      .run(now(), by, reason, verdict.fee, verdict.charged, trip.id);
    if (verdict.charged === 'driver') {
      walletTxn(trip.driver_id, 'cancel_fee', -verdict.fee, { tripId: trip.id, note: `Cancellation fee — ${verdict.why}` });
      if (getDriver(trip.driver_id).wallet_balance < C.WALLET_MIN_BALANCE) forceOffline(trip.driver_id, 'wallet_low');
    } else if (verdict.charged === 'rider') {
      db.prepare('UPDATE users SET cancel_dues = ROUND(cancel_dues + ?, 2) WHERE id = ?').run(verdict.fee, trip.rider_id);
    }
    req.auditNote = `cancelled by ${by}; ${verdict.charged ? `${verdict.charged} charged ₹${verdict.fee}` : 'no charge'}: ${verdict.why}`;
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/start', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'accepted') throw httpError(409, 'Accept the trip first');
    // Mandatory health declaration — the ride cannot start without it.
    if (req.body.fitDeclaration !== true) {
      throw httpError(400, 'Please tick the box to confirm you are healthy, fit and have not had alcohol or drugs. The ride cannot start without it.');
    }
    if (trip.otp_attempts >= C.TRIP_OTP_MAX_ATTEMPTS) throw httpError(429, 'Too many wrong OTPs. Ask the rider to cancel and rebook.');
    if (String(req.body.otp || '').trim() !== trip.otp) {
      db.prepare('UPDATE trips SET otp_attempts = otp_attempts + 1 WHERE id = ?').run(trip.id);
      throw httpError(400, 'Wrong OTP — ask the rider for the 4-digit code shown in their app');
    }
    const t = now();
    db.prepare("UPDATE trips SET status = 'started', started_at = ?, fit_declared_at = ?, expected_end_at = ? WHERE id = ?")
      .run(t, t, t + Math.ceil(trip.eta_min) * 60000, trip.id);
    req.auditNote = 'driver declared: healthy, fit, no alcohol/drugs';
    if (!publicBase) publicBase = baseUrl(req);
    const rider = getUser(trip.rider_id);
    const d = getDriver(trip.driver_id);
    queue('sms', rider.trusted_phone, 'ride_started',
      `${firstName(rider.name)} started an Olub ride to ${trip.dst_name} in ${d.vehicle_number}. Expected in ${Math.ceil(trip.eta_min)} min. Track live: ${baseUrl(req)}/track/${trip.track_token}`,
      { tripId: trip.id, userId: rider.id });
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  // Live GPS from either phone during the ride.
  app.post('/api/trips/:id/location', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!['accepted', 'started'].includes(trip.status)) return { ok: false };
    const p = { lat: Number(req.body.lat), lng: Number(req.body.lng) };
    if (!isValidPoint(p)) throw httpError(400, 'Bad location');
    // Prefer the driver's phone; use the rider's only if the driver's is silent.
    const fromDriver = trip.driver_id === req.user.id;
    if (fromDriver && trip.status === 'accepted') {
      // Is the driver actually coming? Used to decide who pays if the ride is cancelled.
      const dist = haversineKm(p, { lat: trip.src_lat, lng: trip.src_lng });
      db.prepare('UPDATE trips SET pickup_dist_start = COALESCE(pickup_dist_start, ?), pickup_dist_last = ? WHERE id = ?').run(dist, dist, trip.id);
    }
    if (!fromDriver && trip.last_loc_at && now() - trip.last_loc_at < 20000) return { ok: true, used: false };
    if (trip.status === 'started' && (!trip.last_loc_at || now() - trip.last_loc_at >= 4000)) {
      const kmph = Number.isFinite(Number(req.body.kmph)) && req.body.kmph != null ? Math.min(250, Math.max(0, Number(req.body.kmph))) : null;
      db.prepare('INSERT INTO trip_points (trip_id, lat, lng, ts, kmph) VALUES (?, ?, ?, ?, ?)').run(trip.id, p.lat, p.lng, now(), kmph);
      // Route watch: how far is the cab from the pickup→drop corridor?
      // Measured from the road path when we have one, otherwise from the straight line.
      const path = trip.route_poly ? decodePolyline(trip.route_poly) : null;
      const off = path && path.length > 1 ? pointToPathKm(p, path) : pointToSegmentKm(p, { lat: trip.src_lat, lng: trip.src_lng }, { lat: trip.dst_lat, lng: trip.dst_lng });
      const allowed = path ? C.ROUTE_CORRIDOR_KM : Math.max(C.ROUTE_CORRIDOR_KM, trip.distance_km * C.ROUTE_CORRIDOR_SHARE);
      if (off > allowed && !trip.off_route_since) db.prepare('UPDATE trips SET off_route_since = ? WHERE id = ?').run(now(), trip.id);
      if (off <= allowed && trip.off_route_since) db.prepare('UPDATE trips SET off_route_since = NULL, off_route_alerted = 0 WHERE id = ?').run(trip.id);
    }
    db.prepare('UPDATE trips SET last_lat = ?, last_lng = ?, last_loc_at = ? WHERE id = ?').run(p.lat, p.lng, now(), trip.id);
    if (fromDriver) db.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_loc_at = ? WHERE user_id = ?').run(p.lat, p.lng, now(), req.user.id);
    const loc = { tripId: trip.id, ...p, at: now() };
    emit(trip.rider_id, 'loc', loc); emit(trip.driver_id, 'loc', loc);
    return { ok: true, used: true };
  }));

  // Rider confirms they are fine after a "running late" alert.
  app.post('/api/trips/:id/safe', auth, role('rider'), route((req) => {
    const trip = loadTripFor(req, { as: 'rider' });
    if (trip.status !== 'started') throw httpError(409, 'Trip is not in progress');
    db.prepare('UPDATE trips SET safe_confirmed_at = ?, expected_end_at = ?, overdue_level = 0 WHERE id = ?').run(now(), now(), trip.id);
    const rider = req.user;
    if (trip.overdue_level > 0) {
      queue('sms', rider.trusted_phone, 'ride_safe', `${firstName(rider.name)} confirmed in the Olub app that they are safe.`, { tripId: trip.id, userId: rider.id });
    }
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.get('/api/trips/:id/toll-prompts', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    return tripTolls(trip).filter((t) => t.status !== 'verified').map((t) => T.publicToll(db, t, req.user.id)).filter((t) => !t.reportedByMe);
  }));

  app.post('/api/trips/:id/tolls', auth, role('driver'), route((req) => {
    const trip = loadTripFor(req, { as: 'driver' });
    if (trip.status !== 'started') throw httpError(409, 'You can add tolls only during a trip');
    const d = getDriver(req.user.id);
    const { toll, alreadyReported } = T.reportToll(db, req.user.id, { ...req.body, state: req.body.state || trip.state || d.state, vehicleType: d.vehicle_type });
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
    // Waiting / traffic time is measured, not typed in: actual time minus free-flow time.
    const actualMin = (now() - trip.started_at) / 60000;
    const wait = Math.min(240, Math.max(0, actualMin - trip.free_flow_min));
    db.prepare('UPDATE trips SET wait_minutes = ? WHERE id = ?').run(wait, trip.id);
    const final = computeFinal(getTrip(trip.id));
    const invoiceNo = `OLB/${fy(now())}/${String(trip.id).padStart(6, '0')}`;
    const prepaidCovers = trip.prepaid_amount != null && trip.prepaid_amount >= final.riderPays;
    db.prepare(`UPDATE trips SET status = 'completed', completed_at = ?, final = ?, invoice_no = ?, safety = ?,
      paid_at = ?, payment_method = ? WHERE id = ?`).run(now(), JSON.stringify(final), invoiceNo, JSON.stringify(safetyScore(trip)),
      prepaidCovers ? now() : null, prepaidCovers ? trip.prepaid_method : null, trip.id);
    db.prepare('UPDATE drivers SET completed_trips = completed_trips + 1 WHERE user_id = ?').run(trip.driver_id);
    if (final.dues) {
      // The customer's earlier cancellation fee was collected with this fare; pass it on to Olub.
      db.prepare('UPDATE users SET cancel_dues = MAX(0, ROUND(cancel_dues - ?, 2)) WHERE id = ?').run(final.dues, trip.rider_id);
      walletTxn(trip.driver_id, 'cancel_fee_passthrough', -final.dues, { tripId: trip.id, note: "Customer's earlier cancellation fee, collected with this fare" });
    }
    // Olub's fee and the ride GST come out of the driver's wallet (the rider pays the driver directly).
    walletTxn(trip.driver_id, 'platform_fee', -final.platformFee, { tripId: trip.id, note: `Olub fee${final.calamity ? ' (calamity relief)' : ''}, incl. GST` });
    walletTxn(trip.driver_id, 'ride_gst', -final.taxes.rideGst, { tripId: trip.id, note: `GST ${final.taxes.rideGstRate * 100}% on ride, remitted by Olub` });
    const dAfter = getDriver(trip.driver_id);
    if (dutyStatus(trip.driver_id).locked) forceOffline(trip.driver_id, 'duty_limit');
    else if (dAfter.wallet_balance < C.WALLET_MIN_BALANCE) forceOffline(trip.driver_id, 'wallet_low');
    const rider = getUser(trip.rider_id);
    queue('sms', rider.trusted_phone, 'ride_ended', `${firstName(rider.name)} has reached ${trip.dst_name}. The Olub ride has ended.`, { tripId: trip.id, userId: rider.id });
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/verify-driver', auth, role('rider'), route((req) => {
    const trip = loadTripFor(req, { as: 'rider' });
    const d = getDriver(trip.driver_id);
    const c = req.body.checks || {};
    if (!(c.face && c.vehicleNumber && c.vehicleMatches)) throw httpError(400, 'Confirm all checks to verify the driver');
    if (!['accepted', 'started', 'completed'].includes(trip.status) || trip.paid_at) throw httpError(409, 'Verify during the trip');
    if (d.status !== 'submitted') throw httpError(409, 'This driver is already verified');
    db.prepare("UPDATE drivers SET status = 'verified', verified_via = 'customer', verified_by = ? WHERE user_id = ?").run(req.user.id, d.user_id);
    db.prepare('UPDATE trips SET verify_discount = 1 WHERE id = ?').run(trip.id);
    // Olub funds the reward: the rider pays the driver ₹10 less, so Olub credits the driver's wallet.
    walletTxn(d.user_id, 'verify_reward', C.VERIFY_DISCOUNT, { tripId: trip.id, note: 'Rider verification reward, paid by Olub' });
    if (trip.status === 'completed') db.prepare('UPDATE trips SET final = ? WHERE id = ?').run(JSON.stringify(computeFinal(getTrip(trip.id))), trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  app.post('/api/trips/:id/pay', auth, route((req) => {
    const trip = loadTripFor(req);
    const method = ['cash', 'upi'].includes(req.body.method) ? req.body.method : 'cash';
    // Pay at the start: the quoted amount is paid up front; any difference is settled at the end.
    if (['accepted', 'started'].includes(trip.status)) {
      if (trip.prepaid_at) throw httpError(409, 'Already paid for this ride');
      const q = withDiscount(json(trip.quote), trip.verify_discount ? C.VERIFY_DISCOUNT : 0);
      db.prepare("UPDATE trips SET pay_timing = 'start', prepaid_amount = ?, prepaid_method = ?, prepaid_at = ? WHERE id = ?").run(q.riderPays, method, now(), trip.id);
      notifyTrip(trip);
      return tripView(getTrip(trip.id), req.user);
    }
    if (trip.status !== 'completed') throw httpError(409, 'Trip is not completed');
    if (trip.paid_at) throw httpError(409, 'Already paid');
    db.prepare('UPDATE trips SET payment_method = ?, paid_at = ? WHERE id = ?').run(method, now(), trip.id);
    notifyTrip(trip);
    return tripView(getTrip(trip.id), req.user);
  }));

  // ================= ratings & feedback =================
  app.post('/api/trips/:id/rating', auth, route((req) => {
    const trip = loadTripFor(req);
    if (trip.status !== 'completed') throw httpError(409, 'You can rate after the trip ends');
    const toRole = trip.rider_id === req.user.id ? 'driver' : 'rider';
    const criteria = Object.keys(C.RATING_CRITERIA[toRole]);
    const scores = {};
    for (const k of criteria) {
      const v = Number(req.body.scores?.[k]);
      if (!Number.isInteger(v) || v < 1 || v > 5) throw httpError(400, `Give 1 to 5 stars for "${C.RATING_CRITERIA[toRole][k]}"`);
      scores[k] = v;
    }
    const overall = r2(criteria.reduce((s, k) => s + scores[k], 0) / criteria.length);
    try {
      db.prepare(`INSERT INTO ratings (trip_id, from_id, to_id, to_role, scores, overall, good, bad, improve, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(trip.id, req.user.id, otherParty(trip, req.user.id), toRole,
        JSON.stringify(scores), overall, text(req.body.good), text(req.body.bad), text(req.body.improve), now());
    } catch { throw httpError(409, 'You have already rated this trip'); }
    return { ok: true, overall };
  }));

  /**
   * My feedback, month by month, with the authors hidden. Comments are released
   * only for finished months and only in batches of FEEDBACK_MIN_FOR_ANON or
   * more (thin months roll into the next), so nobody can tell who wrote what.
   */
  app.get('/api/feedback/mine', auth, route((req) => {
    const rows = db.prepare('SELECT * FROM ratings WHERE to_id = ? ORDER BY id').all(req.user.id);
    const monthOf = (ts) => new Date(ts + 5.5 * 3600 * 1000).toISOString().slice(0, 7); // IST
    const thisMonth = monthOf(now());
    const byMonth = new Map();
    for (const r of rows) { const m = monthOf(r.created_at); byMonth.set(m, [...(byMonth.get(m) || []), r]); }
    const avgOf = (list) => {
      const crit = {};
      for (const r of list) for (const [k, v] of Object.entries(json(r.scores))) (crit[k] = crit[k] || []).push(v);
      return {
        count: list.length,
        average: list.length ? Math.round((list.reduce((s, r) => s + r.overall, 0) / list.length) * 10) / 10 : null,
        criteria: Object.fromEntries(Object.entries(crit).map(([k, v]) => [k, Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10])),
      };
    };
    const shuffle = (a) => a.map((v) => [crypto.randomInt(1 << 30), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    const months = []; let carry = [];
    for (const [month, list] of [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const m = { month, ...avgOf(list) };
      if (month === thisMonth) {
        m.comments = null; m.note = 'Comments for this month appear after the month ends.';
      } else {
        const batch = [...carry, ...list];
        if (batch.length >= C.FEEDBACK_MIN_FOR_ANON) {
          m.comments = Object.fromEntries(['good', 'bad', 'improve'].map((k) => [k, shuffle(batch.map((r) => r[k]).filter(Boolean))]));
          carry = [];
        } else {
          m.comments = null; m.note = 'Too few reviews to show without revealing who wrote them. They will appear with a later month.';
          carry = batch;
        }
      }
      months.push(m);
    }
    const labels = C.RATING_CRITERIA[req.user.role === 'driver' ? 'driver' : 'rider'];
    return { overall: avgOf(rows), labels, months: months.reverse() };
  }));

  // ================= masked chat & voice call =================
  app.get('/api/trips/:id/messages', auth, route((req) => {
    const trip = loadTripFor(req);
    return db.prepare('SELECT id, sender_id, body, created_at FROM messages WHERE trip_id = ? ORDER BY id').all(trip.id)
      .map((m) => ({ id: m.id, mine: m.sender_id === req.user.id, body: m.body, createdAt: m.created_at }));
  }));

  app.post('/api/trips/:id/messages', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!canTalk(trip)) throw httpError(409, 'Chat is available only during the trip');
    const body = text(req.body.body, 500);
    if (!body) throw httpError(400, 'Message is empty');
    const r = db.prepare('INSERT INTO messages (trip_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)').run(trip.id, req.user.id, body, now());
    const msg = { id: Number(r.lastInsertRowid), tripId: trip.id, body, createdAt: now() };
    emit(otherParty(trip, req.user.id), 'message', { ...msg, mine: false });
    return { ...msg, mine: true };
  }));

  app.post('/api/trips/:id/call', auth, route((req) => {
    const trip = loadTripFor(req);
    if (!canTalk(trip)) throw httpError(409, 'Calling is available only during the trip');
    const type = req.body.type;
    if (!['ring', 'offer', 'answer', 'ice', 'hangup', 'decline'].includes(type)) throw httpError(400, 'Bad signal');
    emit(otherParty(trip, req.user.id), 'call', { tripId: trip.id, type, data: req.body.data ?? null, fromName: firstName(req.user.name) });
    return { ok: true };
  }));

  app.get('/api/tolls', auth, route(() => db.prepare('SELECT * FROM tolls ORDER BY id DESC').all().map((t) => T.publicToll(db, t))));

  // ================= privacy requests (DPDP / GDPR) =================
  const dsrView = (r, { admin = false } = {}) => ({
    id: r.id, publicId: r.public_id, type: r.type, details: r.details, status: r.status,
    typeLabel: C.DSR_TYPES[r.type] + (r.field && C.DSR_CORRECTION_FIELDS[r.field] ? ` — ${C.DSR_CORRECTION_FIELDS[r.field].label.toLowerCase()}` : ''),
    createdAt: r.created_at, answerBy: r.public_due_at, completedAt: r.completed_at, response: r.response, hasExport: !!r.export,
    ...(admin && {
      processAfter: r.process_after, internalDueAt: r.internal_due_at, handledBy: r.handled_by,
      user: (() => { const u = getUser(r.user_id); return { id: u.id, publicId: u.public_id, name: u.name, role: u.role }; })(),
      overdueInternally: r.status === 'received' && now() > r.internal_due_at,
    }),
  });

  app.post('/api/privacy/requests', auth, rateLimit, route((req) => {
    const u = req.user;
    // Only verified identities: confirmed mobile (login) and confirmed email.
    if (!u.phone_verified_at || !u.email_verified_at) throw httpError(403, 'Confirm your email first. Privacy requests are accepted only from verified accounts.');
    const type = req.body.type;
    if (!C.DSR_TYPES[type]) throw httpError(400, 'Choose a request type');
    if (db.prepare("SELECT 1 FROM dsr_requests WHERE user_id = ? AND type = ? AND status = 'received'").get(u.id, type)) {
      throw httpError(409, 'You already have an open request of this type');
    }
    const t = now();
    // "Correct my data" says exactly what to correct, so most corrections are handled at once.
    let field = null, auto = null;
    if (type === 'correction') {
      field = req.body.field;
      const f = C.DSR_CORRECTION_FIELDS[field];
      if (!f) throw httpError(400, 'Choose what needs correcting');
      if (f.mode === 'auto') {
        const v = req.body.value;
        const changed = applyProfile(u, field === 'trusted' ? { trusted: v } : { [field]: v });
        if (!changed.length) throw httpError(400, 'Enter the correct value');
        auto = `${f.label} has been corrected.`;
      } else if (f.mode === 'guide') {
        auto = f.guide;
      } else if (!text(req.body.details, 1000)) {
        throw httpError(400, 'Tell us what is wrong and what it should be');
      }
    }
    const r = db.prepare(`INSERT INTO dsr_requests (public_id, user_id, type, details, created_at, process_after, internal_due_at, public_due_at, field)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newPublicId('DSR', 'dsr_requests'), u.id, type, text(req.body.details, 1000), t,
      t + C.DSR_AUTO_PROCESS_AFTER_DAYS * C.DAY, t + C.DSR_INTERNAL_SLA_DAYS * C.DAY, t + C.DSR_PUBLIC_SLA_DAYS * C.DAY, field);
    if (auto) {
      db.prepare("UPDATE dsr_requests SET status = 'completed', completed_at = ?, handled_by = 'auto', response = ? WHERE id = ?").run(t, auto, r.lastInsertRowid);
      const done = db.prepare('SELECT * FROM dsr_requests WHERE id = ?').get(r.lastInsertRowid);
      audit.log({ action: 'dsr.completed', entity: 'dsr', entityId: done.public_id, details: { type, field, handledBy: 'auto', userId: u.id } });
      queue('email', u.email, 'dsr_completed', `Privacy request ${done.public_id}: ${auto}`, { userId: u.id });
      return dsrView(done);
    }
    const row = db.prepare('SELECT * FROM dsr_requests WHERE id = ?').get(r.lastInsertRowid);
    queue('email', u.email, 'dsr_received', `We received your privacy request ${row.public_id} (${C.DSR_TYPES[type]}). We will answer within ${C.DSR_PUBLIC_SLA_DAYS - 2}–${C.DSR_PUBLIC_SLA_DAYS} days.`, { userId: u.id });
    return dsrView(row);
  }));

  app.get('/api/privacy/requests', auth, route((req) =>
    db.prepare('SELECT * FROM dsr_requests WHERE user_id = ? ORDER BY id DESC').all(req.user.id).map((r) => dsrView(r))));

  app.get('/api/privacy/requests/:id/export', auth, route((req) => {
    const r = db.prepare('SELECT * FROM dsr_requests WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!r?.export) throw httpError(404, 'No data export for this request');
    return JSON.parse(decrypt(r.export));
  }));

  app.post('/api/privacy/requests/:id/withdraw', auth, route((req) => {
    const r = db.prepare("SELECT * FROM dsr_requests WHERE id = ? AND user_id = ? AND status = 'received'").get(Number(req.params.id), req.user.id);
    if (!r) throw httpError(404, 'Open request not found');
    db.prepare("UPDATE dsr_requests SET status = 'withdrawn', completed_at = ?, handled_by = 'user' WHERE id = ?").run(now(), r.id);
    return dsrView(db.prepare('SELECT * FROM dsr_requests WHERE id = ?').get(r.id));
  }));

  /** Fulfil one request. Returns false if it must wait (e.g. erasure during a trip). */
  function fulfilDsr(r, handledBy, note) {
    const u = getUser(r.user_id);
    const email = u.email;
    let response = note || null; let exportBlob = null;
    if (r.type === 'access') {
      exportBlob = encrypt(JSON.stringify(exportUserData(db, u.id)));
      response = response || 'Your data is ready. Download it from Profile → Privacy & my data.';
    } else if (r.type === 'erasure') {
      const blocked = eraseUser(db, u.id);
      if (blocked) { audit.log({ action: 'dsr.erasure_deferred', entity: 'dsr', entityId: r.public_id, details: { reason: blocked } }); return false; }
      response = response || 'Your account and personal data have been deleted. Records the law requires us to keep no longer carry your identity.';
    } else if (r.type === 'withdraw_consent') {
      db.prepare('UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL').run(now(), u.id);
      db.prepare('UPDATE drivers SET online = 0 WHERE user_id = ?').run(u.id);
      response = response || 'Your consent has been withdrawn. You cannot book or accept rides until you accept the terms again.';
    } else if (!note) {
      return false; // corrections and complaints need a person to answer
    }
    db.prepare("UPDATE dsr_requests SET status = 'completed', completed_at = ?, handled_by = ?, response = ?, export = ? WHERE id = ?")
      .run(now(), handledBy, response, exportBlob, r.id);
    queue('email', email, 'dsr_completed', `Privacy request ${r.public_id}: ${response}`, { userId: u.id });
    audit.log({ action: 'dsr.completed', entity: 'dsr', entityId: r.public_id, details: { type: r.type, handledBy, userId: u.id } });
    return true;
  }

  // ================= admin =================
  const admin = express.Router();
  app.use('/api/admin', auth, role('admin'), admin);

  admin.get('/drivers', route((req) => {
    const rows = req.query.status ? db.prepare('SELECT * FROM drivers WHERE status = ?').all(req.query.status) : db.prepare('SELECT * FROM drivers').all();
    return rows.map((d) => publicDriver(d, { full: true }));
  }));

  admin.post('/drivers/:id/review', route((req) => {
    const d = getDriver(Number(req.params.id));
    if (!d) throw httpError(404, 'Driver not found');
    const approve = !!req.body.approve;
    db.prepare('UPDATE drivers SET status = ?, verified_via = ?, verified_by = ?, online = CASE WHEN ? THEN online ELSE 0 END WHERE user_id = ?')
      .run(approve ? 'verified' : 'rejected', approve ? 'admin' : null, req.user.id, approve ? 1 : 0, d.user_id);
    return publicDriver(getDriver(d.user_id), { full: true });
  }));

  admin.get('/tolls/:id/reports', route((req) =>
    db.prepare('SELECT driver_id, amount, photo, created_at FROM toll_reports WHERE toll_id = ?').all(Number(req.params.id))));

  admin.post('/calamity', route((req) => {
    const state = String(req.body.state || '*').toUpperCase().slice(0, 4);
    if (req.body.on) {
      db.prepare(`INSERT INTO calamity (state, reason, since) VALUES (?, ?, ?)
        ON CONFLICT(state) DO UPDATE SET reason = excluded.reason, since = excluded.since`).run(state, text(req.body.reason, 120) || 'Heavy rain', now());
    } else db.prepare('DELETE FROM calamity WHERE state = ?').run(state);
    return db.prepare('SELECT * FROM calamity').all();
  }));

  // Rate card: per-km price etc. for each vehicle type.
  admin.get('/rates', route(() => getRates()));
  admin.put('/rates', route((req) => {
    const saved = {};
    for (const k of Object.keys(C.VEHICLES)) {
      const v = req.body[k]; if (!v) continue;
      saved[k] = {};
      for (const f of ['base', 'perKm', 'perWaitMin', 'minFare']) {
        const n = Number(v[f]);
        if (!Number.isFinite(n) || n < 0 || n > 2000) throw httpError(400, `Invalid ${f} for ${k}`);
        saved[k][f] = n;
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('rates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(saved));
    return getRates();
  }));

  admin.get('/users', route((req) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    return db.prepare(`SELECT id, public_id AS publicId, name, role, phone, email, status, created_at AS createdAt FROM users
      WHERE name LIKE ? OR phone LIKE ? OR public_id LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 50`).all(q, q, q, q);
  }));

  // Complete audit trail of one customer or driver.
  admin.get('/users/:id/trail', route((req) => {
    const u = getUser(Number(req.params.id));
    if (!u) throw httpError(404, 'User not found');
    const who = (id) => { const x = getUser(id); return x ? `${x.name} (${x.public_id})` : '—'; };
    return {
      user: meView(u),
      consents: db.prepare('SELECT doc, version, accepted_at AS acceptedAt, withdrawn_at AS withdrawnAt, ip FROM consents WHERE user_id = ?').all(u.id),
      trips: db.prepare('SELECT * FROM trips WHERE rider_id = ? OR driver_id = ? ORDER BY id DESC LIMIT 100').all(u.id, u.id).map((t) => ({
        id: t.id, status: t.status, rider: who(t.rider_id), driver: who(t.driver_id), from: t.src_name, to: t.dst_name,
        fitDeclaredAt: t.fit_declared_at, overdueLevel: t.overdue_level, createdAt: t.created_at, paid: !!t.paid_at,
        amount: json(t.final)?.riderPays ?? json(t.quote)?.riderPays,
      })),
      ratingsReceived: db.prepare('SELECT * FROM ratings WHERE to_id = ? ORDER BY id DESC').all(u.id).map((r) => ({ ...r, scores: json(r.scores), from: who(r.from_id) })),
      ratingsGiven: db.prepare('SELECT * FROM ratings WHERE from_id = ? ORDER BY id DESC').all(u.id).map((r) => ({ ...r, scores: json(r.scores), to: who(r.to_id) })),
      audit: db.prepare(`SELECT id, ts, actor_id AS actorId, actor_role AS actorRole, action, entity, entity_id AS entityId, ip, details FROM audit_log
        WHERE actor_id = ? OR (entity = 'users' AND entity_id = ?) ORDER BY id DESC LIMIT 500`).all(u.id, String(u.id)).map((a) => ({ ...a, details: json(a.details) })),
    };
  }));

  admin.get('/audit', route((req) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    return db.prepare(`SELECT a.id, a.ts, a.actor_id AS actorId, u.public_id AS actorPublicId, u.name AS actorName, a.actor_role AS actorRole,
      a.action, a.entity, a.entity_id AS entityId, a.ip, a.details FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT ?`).all(limit).map((a) => ({ ...a, details: json(a.details) }));
  }));
  admin.get('/audit/verify', route(() => audit.verify()));

  // Feedback with identities — only admins can see who wrote what.
  admin.get('/feedback', route(() => db.prepare(`SELECT r.*, f.name AS fromName, f.public_id AS fromId, t.name AS toName, t.public_id AS toId
    FROM ratings r JOIN users f ON f.id = r.from_id JOIN users t ON t.id = r.to_id ORDER BY r.id DESC LIMIT 200`).all()
    .map((r) => ({
      id: r.id, tripId: r.trip_id, from: `${r.fromName} (${r.fromId})`, to: `${r.toName} (${r.toId})`, toRole: r.to_role,
      overall: r.overall, scores: json(r.scores), good: r.good, bad: r.bad, improve: r.improve, createdAt: r.created_at,
    }))));

  admin.get('/dsr', route(() => db.prepare("SELECT * FROM dsr_requests ORDER BY status = 'received' DESC, id DESC LIMIT 200").all().map((r) => dsrView(r, { admin: true }))));
  admin.post('/dsr/:id/resolve', route((req) => {
    const r = db.prepare("SELECT * FROM dsr_requests WHERE id = ? AND status = 'received'").get(Number(req.params.id));
    if (!r) throw httpError(404, 'Open request not found');
    const note = text(req.body.response, 1000);
    if (req.body.action === 'reject') {
      if (!note) throw httpError(400, 'Give the reason for rejecting');
      db.prepare("UPDATE dsr_requests SET status = 'rejected', completed_at = ?, handled_by = ?, response = ? WHERE id = ?").run(now(), `admin:${req.user.id}`, note, r.id);
      queue('email', getUser(r.user_id).email, 'dsr_rejected', `Privacy request ${r.public_id}: ${note}`, { userId: r.user_id });
    } else {
      if (['correction', 'grievance'].includes(r.type) && !note) throw httpError(400, 'Write your answer to the person');
      if (!fulfilDsr(r, `admin:${req.user.id}`, note)) throw httpError(409, 'Cannot complete yet (the person has a trip in progress)');
    }
    return dsrView(db.prepare('SELECT * FROM dsr_requests WHERE id = ?').get(r.id), { admin: true });
  }));

  // Test data: drivers, customers and trips in every state.
  const loadDemo = () => seedDemo({ db, C, now, legal, getRates, newPublicId, fy, audit });
  admin.post('/demo', route(() => loadDemo()));
  admin.get('/demo', route(() => ({
    loaded: !!db.prepare("SELECT 1 FROM users WHERE phone = '9000000101'").get(),
    logins: db.prepare("SELECT name, phone, role, public_id AS publicId FROM users WHERE email LIKE '%@demo.olub.example' ORDER BY role, id").all(),
  })));

  admin.get('/outbox', route(() => db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 100').all()));

  // ---------- monthly charge: ₹937 or 20% of the month's earnings, whichever is less ----------
  const monthOf = (ts) => new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 7); // IST
  function monthlyCharge(driverId, month) {
    const rows = db.prepare("SELECT final, completed_at FROM trips WHERE driver_id = ? AND status = 'completed'").all(driverId)
      .filter((t) => monthOf(t.completed_at) === month).map((t) => json(t.final));
    const earned = r2(rows.reduce((s, f) => s + f.driverFare - f.breakdown.tollTotal, 0)); // tolls are not earnings
    const tripFees = r2(rows.reduce((s, f) => s + f.platformFee, 0));
    let amount = Math.min(C.MONTHLY_FEE_MAX, earned * C.MONTHLY_FEE_SHARE);
    // Olub's whole take for the month (trip fees + this charge) stays within 20% of earnings.
    if (C.MONTHLY_FEE_RESPECT_LEGAL_CAP) amount = Math.min(amount, Math.max(0, earned * C.COMMISSION_CAP - tripFees));
    return { month, trips: rows.length, earned, tripFees, amount: Math.round(amount) };
  }
  function chargeLastMonth() {
    if (!C.MONTHLY_FEE_ENABLED) return;
    const d0 = new Date(now() + 5.5 * 3600e3); d0.setUTCDate(0); // last day of the previous month (IST)
    const month = d0.toISOString().slice(0, 7);
    for (const d of db.prepare('SELECT user_id FROM drivers WHERE user_id NOT IN (SELECT driver_id FROM monthly_charges WHERE month = ?)').all(month)) {
      const m = monthlyCharge(d.user_id, month);
      db.prepare('INSERT INTO monthly_charges (driver_id, month, earned, trip_fees, amount, charged_at) VALUES (?, ?, ?, ?, ?, ?)').run(d.user_id, month, m.earned, m.tripFees, m.amount, now());
      if (!m.amount) continue;
      walletTxn(d.user_id, 'monthly_fee', -m.amount, { note: `Monthly charge for ${month}: lower of ₹${C.MONTHLY_FEE_MAX} and ${C.MONTHLY_FEE_SHARE * 100}% of ₹${m.earned} earned` });
      audit.log({ action: 'billing.monthly_charge', entity: 'users', entityId: d.user_id, details: m });
      if (getDriver(d.user_id).wallet_balance < C.WALLET_MIN_BALANCE && !db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(d.user_id)) forceOffline(d.user_id, 'wallet_low');
    }
  }

  const ticks = [chargeLastMonth];
  registerExtras({
    app, admin, db, C, now, audit, auth, role, route, rateLimit, queue, emit, maps, ticks, json, r2, text, firstName, fy, withPin,
    getUser, getDriver, getTrip, tripView, publicDriver, notifyTrip, loadTripFor, newPublicId, resolvePoint, getRates, calamityFor,
    walletTxn, dutyStatus, forceOffline, monthlyCharge, activeFlag, meView, baseUrl, ageFrom, normVehicle, isEmail,
  });

  // ================= background jobs =================
  function tick() {
    // 1. Rides running late → warn, then alert, the trusted contact.
    for (const t of db.prepare("SELECT * FROM trips WHERE status = 'started' AND expected_end_at IS NOT NULL AND overdue_level < 2").all()) {
      const late = (now() - t.expected_end_at) / 60000;
      const level = late >= C.OVERDUE_ALERT_MIN ? 2 : late >= C.OVERDUE_WARN_MIN ? 1 : 0;
      if (level <= t.overdue_level) continue;
      db.prepare('UPDATE trips SET overdue_level = ? WHERE id = ?').run(level, t.id);
      const rider = getUser(t.rider_id); const d = getDriver(t.driver_id);
      const link = publicBase ? ` Track: ${publicBase}/track/${t.track_token}` : '';
      queue('sms', rider.trusted_phone, level === 2 ? 'ride_overdue_alert' : 'ride_running_late', level === 2
        ? `ALERT: ${firstName(rider.name)}'s Olub ride to ${t.dst_name} (${d.vehicle_number}) is ${Math.floor(late)} min late and they have not confirmed they are safe. Please call and check on them now.${link}`
        : `${firstName(rider.name)}'s Olub ride to ${t.dst_name} is running about ${Math.floor(late)} min late.${link}`,
      { tripId: t.id, userId: rider.id });
      audit.log({ action: level === 2 ? 'safety.overdue_alert' : 'safety.running_late', entity: 'trips', entityId: t.id, details: { lateMin: Math.floor(late) } });
      emit(t.rider_id, 'safety', { tripId: t.id, level, lateMin: Math.floor(late) });
      emit(t.driver_id, 'safety', { tripId: t.id, level, lateMin: Math.floor(late) });
      notifyTrip(t);
    }
    // 2. Privacy requests: answer automatically once the cooling-off period has passed.
    for (const r of db.prepare("SELECT * FROM dsr_requests WHERE status = 'received'").all()) {
      if (now() >= r.process_after && ['access', 'erasure', 'withdraw_consent'].includes(r.type)) fulfilDsr(r, 'auto');
      else if (now() > r.internal_due_at && !db.prepare("SELECT 1 FROM audit_log WHERE action = 'dsr.internal_sla_missed' AND entity_id = ?").get(r.public_id)) {
        audit.log({ action: 'dsr.internal_sla_missed', entity: 'dsr', entityId: r.public_id, details: { type: r.type } });
      }
    }
    // 3. Duty hours: drivers who reach 12 hours are taken offline (after any trip in progress).
    for (const d of db.prepare('SELECT * FROM drivers WHERE online = 1').all()) {
      if (db.prepare("SELECT 1 FROM trips WHERE driver_id = ? AND status IN ('accepted','started')").get(d.user_id)) continue;
      if (dutyStatus(d.user_id).locked) {
        forceOffline(d.user_id, 'duty_limit');
        audit.log({ action: 'duty.limit_reached', entity: 'users', entityId: d.user_id, details: { hours: C.DUTY_MAX_HOURS } });
      }
    }
    // 4. Route watch: the cab has been off the route for longer than the grace time.
    for (const t of db.prepare("SELECT * FROM trips WHERE status = 'started' AND off_route_since IS NOT NULL AND off_route_alerted = 0").all()) {
      if (now() - t.off_route_since < C.ROUTE_GRACE_MIN * 60000) continue;
      db.prepare('UPDATE trips SET off_route_alerted = 1 WHERE id = ?').run(t.id);
      db.prepare("INSERT INTO safety_events (trip_id, ts, type, lat, lng) VALUES (?, ?, 'route_deviation', ?, ?)").run(t.id, now(), t.last_lat, t.last_lng);
      const rider = getUser(t.rider_id);
      queue('sms', rider.trusted_phone, 'ride_off_route', `${firstName(rider.name)}'s Olub ride to ${t.dst_name} has moved away from the expected route.${publicBase ? ` Track: ${publicBase}/track/${t.track_token}` : ''}`, { tripId: t.id, userId: rider.id });
      audit.log({ action: 'safety.route_deviation', entity: 'trips', entityId: t.id });
      emit(t.rider_id, 'safety', { tripId: t.id, offRoute: true });
      notifyTrip(t);
    }
    // 5. Matched requests nobody answered in time go to the next nearest cab.
    for (const t of db.prepare("SELECT * FROM trips WHERE status = 'requested' AND match_mode = 1 AND offered_at < ?").all(now() - C.MATCH_OFFER_SECONDS * 1000)) {
      offerNext(t, 'no answer').catch((e) => console.error('[match]', e));
    }
    for (const fn of ticks) fn();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  }

  // ================= errors =================
  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, ...(err.todo && { todo: err.todo }) });
  });

  app.locals.loadDemo = loadDemo;
  if (process.env.OLUB_DEMO === '1') { try { loadDemo(); } catch (e) { console.error('[demo]', e); } }
  app.locals.db = db;
  app.locals.tick = tick;
  app.locals.audit = audit;
  return app;
}

module.exports = { createApp };
