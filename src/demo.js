'use strict';

// Demo data for testing: 9 drivers, 4 customers and 15 trips around Lucknow in every
// state (completed, cancelled by either side, declined, waiting, in progress), with
// ratings, wallet history, a toll, a guest booking and a privacy request.
// Load it from Admin → Demo data, or start the server with OLUB_DEMO=1.

const crypto = require('node:crypto');
const { calculateFare, platformFeeFor } = require('./fare');
const { fallbackRoute } = require('./maps');
const { encrypt } = require('./crypto');
const Digipin = require('../public/js/digipin.js');

const P = {
  charbagh: ['Charbagh Railway Station, Lucknow', 26.8320, 80.9230],
  hazratganj: ['Hazratganj, Lucknow', 26.8500, 80.9460],
  lulu: ['Lulu Mall, Shaheed Path, Lucknow', 26.7877, 80.9919],
  gomti: ['Patrakarpuram, Gomti Nagar, Lucknow', 26.8530, 80.9990],
  airport: ['Chaudhary Charan Singh Airport, Lucknow', 26.7606, 80.8893],
  alambagh: ['Alambagh Bus Station, Lucknow', 26.8170, 80.9070],
  indira: ['Munshi Pulia, Indira Nagar, Lucknow', 26.8880, 80.9980],
  kgmu: ['KGMU, Chowk, Lucknow', 26.8690, 80.9150],
};

const DRIVERS = [
  { key: 'ramesh', phone: '9000000101', name: 'Ramesh Yadav', gender: 'male', dob: '1984-03-12', vn: 'UP32AB1234', type: 'sedan', model: 'Swift Dzire', cond: 'good', issued: '2008-06-01', status: 'verified', base: 212, topup: 1500, at: 'hazratganj', online: 1, prefs: { noSmoking: true, noAlcohol: true, petsOk: true, petCharge: 50 }, color: '#0f7b4a' },
  { key: 'imran', phone: '9000000102', name: 'Imran Khan', gender: 'male', dob: '1991-11-02', vn: 'UP32CD5678', type: 'auto', model: 'Bajaj RE', cond: 'average', issued: '2014-02-20', status: 'verified', base: 64, topup: 400, at: 'charbagh', online: 1, prefs: { noSmoking: true, noTobacco: true }, color: '#b86e00' },
  { key: 'sunita', phone: '9000000103', name: 'Sunita Verma', gender: 'female', dob: '1989-07-25', vn: 'UP32EF9012', type: 'hatchback', model: 'WagonR', cond: 'excellent', issued: '2019-09-10', status: 'submitted', base: 0, topup: 300, at: 'gomti', online: 1, prefs: { noSmoking: true, noAlcohol: true, noFood: true, petsOk: false }, color: '#7a3fb0' },
  { key: 'amit', phone: '9000000105', name: 'Amit Tiwari', gender: 'male', dob: '1997-04-21', vn: 'UP32JK1111', type: 'bike', model: 'Splendor', cond: 'good', issued: '2017-08-01', status: 'verified', base: 31, topup: 300, at: 'hazratganj', off: [0.007, -0.006], online: 1, prefs: {}, color: '#00838f' },
  { key: 'salim', phone: '9000000106', name: 'Salim Ansari', gender: 'male', dob: '1986-10-05', vn: 'UP32LM2222', type: 'auto', model: 'Piaggio Ape', cond: 'good', issued: '2010-01-12', status: 'verified', base: 120, topup: 300, at: 'hazratganj', off: [-0.009, 0.008], online: 1, prefs: { noSmoking: true }, color: '#6d4c41' },
  { key: 'deepak', phone: '9000000107', name: 'Deepak Mishra', gender: 'male', dob: '1982-06-17', vn: 'UP32NP3333', type: 'sedan', model: 'Honda Amaze', cond: 'excellent', issued: '2005-11-30', status: 'verified', base: 340, topup: 500, at: 'kgmu', off: [0, 0], online: 1, prefs: { noSmoking: true, noAlcohol: true, petsOk: true, petCharge: 60 }, color: '#283593' },
  { key: 'neha', phone: '9000000108', name: 'Neha Srivastava', gender: 'female', dob: '1993-02-08', vn: 'UP32QR4444', type: 'hatchback', model: 'Swift', cond: 'good', issued: '2016-05-19', status: 'verified', base: 77, topup: 300, at: 'charbagh', off: [0.005, 0.012], online: 1, prefs: { noSmoking: true, noAlcohol: true }, color: '#ad1457' },
  { key: 'vikram', phone: '9000000109', name: 'Vikram Chauhan', gender: 'male', dob: '1980-12-25', vn: 'UP32ST5555', type: 'suv', model: 'Innova', cond: 'good', issued: '2003-03-03', status: 'verified', base: 510, topup: 500, at: 'gomti', off: [-0.012, -0.015], online: 1, prefs: { noAlcohol: true, petsOk: true, petCharge: 100 }, color: '#2e7d32' },
  { key: 'gurpreet', phone: '9000000104', name: 'Gurpreet Singh', gender: 'male', dob: '1978-01-30', vn: 'UP32GH3456', type: 'suv', model: 'Ertiga', cond: 'good', issued: '2001-04-15', status: 'verified', base: 18, topup: 130, at: 'alambagh', online: 0, prefs: { noAlcohol: true, petsOk: true, petCharge: 80 }, color: '#1f5fbf' },
];
const RIDERS = [
  { key: 'priya', phone: '9000000201', name: 'Priya Sharma', gender: 'female', dob: '1996-05-18', trusted: ['Anita Sharma', '9000000301', 'Mother'], color: '#c2185b' },
  { key: 'arjun', phone: '9000000202', name: 'Arjun Mehta', gender: 'male', dob: '1990-09-09', trusted: ['Kavya Mehta', '9000000302', 'Wife'], color: '#00796b' },
  { key: 'fatima', phone: '9000000203', name: 'Fatima Ali', gender: 'female', dob: '1999-12-01', trusted: ['Zoya Ali', '9000000303', 'Sister'], color: '#5d4037' },
  { key: 'rohan', phone: '9000000204', name: 'Rohan Gupta', gender: 'male', dob: '2001-02-14', trusted: ['Sanjay Gupta', '9000000304', 'Father'], color: '#455a64' },
];

// when: 'prev' = last month (so monthly anonymous comments are visible), number = fraction of this month elapsed
const TRIPS = [
  { r: 'priya', d: 'ramesh', from: 'charbagh', to: 'lulu', when: ['prev', 7], st: 'completed', pay: 'upi', rd: [5, 5, 4, 5, 5, 'Very safe and polite driver', null, 'AC could be cooler'], dr: [5, 5, 5, 5, 5, 'Ready at pickup', null, null] },
  { r: 'arjun', d: 'ramesh', from: 'hazratganj', to: 'airport', when: ['prev', 5], st: 'completed', pay: 'cash', toll: true, rd: [4, 5, 5, 3, 5, 'Clean car', 'Reached pickup 10 minutes late', 'Call if running late'], dr: [5, 4, 5, 5, 5, null, null, null] },
  { r: 'fatima', d: 'ramesh', from: 'airport', to: 'gomti', when: ['prev', 3], st: 'completed', pay: 'upi', rd: [5, 5, 5, 5, 4, 'Knew the best route', null, null], dr: [5, 5, 5, 5, 5, 'Very courteous', null, null] },
  { r: 'priya', d: 'imran', from: 'gomti', to: 'hazratganj', when: ['prev', 2], st: 'completed', pay: 'cash', rd: [4, 4, 3, 5, 5, 'Quick ride', 'Auto seat was torn', 'Fix the seat'], dr: [5, 5, 5, 5, 5, null, null, null] },
  { r: 'rohan', d: 'imran', from: 'alambagh', to: 'hazratganj', when: 0.85, st: 'cancelled', cancel: ['rider', 'changed_plan', 'rider'] },
  { r: 'arjun', d: 'ramesh', from: 'indira', to: 'lulu', when: 0.75, st: 'completed', pay: 'upi', guest: 'Meena Mehta', rd: [5, 5, 5, 5, 5, 'Took good care of my mother', null, null], dr: [5, 5, 5, 5, 5, null, null, null] },
  { r: 'fatima', d: 'sunita', from: 'hazratganj', to: 'indira', when: 0.65, st: 'completed', pay: 'upi', rd: [5, 5, 5, 4, 5, 'Felt very safe', null, null], dr: [5, 5, 5, 5, 4, null, null, 'Keep change ready'] },
  { r: 'priya', d: 'imran', from: 'kgmu', to: 'charbagh', when: 0.55, st: 'cancelled', cancel: ['driver', 'driver_cancelled', 'driver'] },
  { r: 'rohan', d: 'ramesh', from: 'charbagh', to: 'gomti', when: 0.45, st: 'rejected' },
  { r: 'arjun', d: 'gurpreet', from: 'gomti', to: 'airport', when: 0.35, st: 'completed', pay: 'cash', pet: true, safety: { score: 82, overspeed: 3, harshBrakes: 0, maxKmph: 96 }, rd: [3, 4, 5, 5, 5, 'Spacious car, fine with my dog', 'Drove too fast on Shaheed Path', 'Please keep to the speed limit'], dr: [4, 5, 4, 4, 5, null, 'Dog hair on the seat', 'Bring a seat cover for pets'] },
  { r: 'fatima', d: 'ramesh', from: 'lulu', to: 'kgmu', when: 0.25, st: 'cancelled', cancel: ['rider', 'driver_not_coming', 'driver'] },
  { r: 'priya', d: 'ramesh', from: 'hazratganj', to: 'lulu', when: 0.15, st: 'completed', pay: 'upi', prepaid: true, rd: [5, 5, 5, 5, 5, 'Always reliable', null, null], dr: [5, 5, 5, 5, 5, null, null, null] },
  { r: 'rohan', d: 'sunita', from: 'indira', to: 'hazratganj', when: 0.06, st: 'completed', pay: 'cash', rd: [5, 4, 5, 5, 5, null, null, null] },
  { r: 'fatima', d: 'ramesh', from: 'charbagh', to: 'gomti', when: 'live', st: 'started' },
  { r: 'arjun', d: 'imran', from: 'hazratganj', to: 'alambagh', when: 'now', st: 'requested' },
];

const avatar = (name, color) => {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="${color}"/><text x="80" y="100" font-family="Arial" font-size="64" font-weight="700" text-anchor="middle" fill="#fff">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};
const docCard = (label) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e6f4ec"/><text x="160" y="96" font-family="Arial" font-size="20" text-anchor="middle" fill="#0f7b4a">DEMO DOCUMENT</text><text x="160" y="126" font-family="Arial" font-size="16" text-anchor="middle" fill="#5f6f68">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

module.exports = function seedDemo({ db, C, now, legal, getRates, newPublicId, fy, audit }) {
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(DRIVERS[0].phone)) return { seeded: false, message: 'Demo data is already loaded.' };
  const t0 = now();
  const DAY = C.DAY;
  const ist = new Date(t0 + 5.5 * 3600e3);
  const monthStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600e3;
  const at = (w) => {
    if (w === 'now') return t0 - 40 * 1000;
    if (w === 'live') return t0 - 9 * 60000;
    if (Array.isArray(w)) return monthStart - w[1] * DAY + 11 * 3600e3;          // last month, around 11:00
    return Math.min(t0 - 3 * 3600e3, t0 - w * Math.max(t0 - monthStart, 2 * DAY)); // spread over this month
  };
  const ids = {};
  const insUser = db.prepare(`INSERT INTO users (public_id, phone, phone_verified_at, email, email_verified_at, name, role, dob, gender,
    trusted_name, trusted_phone, trusted_relation, photo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const consent = db.prepare('INSERT INTO consents (user_id, doc, version, accepted_at, ip) VALUES (?, ?, ?, ?, ?)');
  const created = t0 - 40 * DAY;

  for (const r of RIDERS) {
    const id = Number(insUser.run(newPublicId('OLB-C', 'users'), r.phone, created, `${r.key}@demo.olub.example`, created, r.name, 'rider', r.dob, r.gender,
      r.trusted[0], r.trusted[1], r.trusted[2], avatar(r.name, r.color), created).lastInsertRowid);
    ids[r.key] = id;
    for (const doc of legal.required.rider) consent.run(id, doc, legal.VERSION, created, 'demo');
  }
  const today = new Date(t0).toISOString().slice(0, 10);
  const insuranceTill = new Date(t0 + 200 * DAY).toISOString().slice(0, 10);
  for (const d of DRIVERS) {
    const id = Number(insUser.run(newPublicId('OLB-D', 'users'), d.phone, created, `${d.key}@demo.olub.example`, created, d.name, 'driver', d.dob, d.gender,
      null, null, null, avatar(d.name, d.color), created).lastInsertRowid);
    ids[d.key] = id;
    for (const doc of legal.required.driver) consent.run(id, doc, legal.VERSION, created, 'demo');
    const docs = { selfie: avatar(d.name, d.color), vehicle: docCard(`${d.model} · ${d.vn}`), license: docCard('Driving licence'), rc: docCard('Registration certificate'), kyc: docCard('ID proof') };
    const pos = P[d.at];
    db.prepare(`INSERT INTO drivers (user_id, vehicle_number, vehicle_type, vehicle_model, vehicle_condition, state, license_no, license_issued_on,
      rc_no, kyc_id_no, insurance_valid_till, docs, prefs, status, verified_via, online, completed_trips, permit_no, wallet_balance, last_lat, last_lng, last_loc_at)
      VALUES (?, ?, ?, ?, ?, 'UP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
      id, d.vn, d.type, d.model, d.cond, `UP32${d.issued.slice(0, 4)}00${id}1234`, d.issued, `RC${d.vn}`, `XXXX-XXXX-${1000 + id}`, insuranceTill,
      encrypt(JSON.stringify(docs)), JSON.stringify({ noSmoking: false, noAlcohol: false, noTobacco: false, noFood: false, petsOk: false, petCharge: 0, ...d.prefs }),
      d.status, d.status === 'verified' ? 'admin' : null, d.online, d.base, `UP/CC/2025/${100 + id}`, pos[1] + (d.off ? d.off[0] : 0.002), pos[2] + (d.off ? d.off[1] : -0.002), t0);
    if (d.online) db.prepare('INSERT INTO duty_sessions (driver_id, started_at) VALUES (?, ?)').run(id, t0 - 2 * 3600e3);
  }
  void today;

  // ---- trips ----
  const rates = getRates();
  const txns = []; // wallet movements, applied in time order afterwards
  for (const d of DRIVERS) txns.push({ d: d.key, ts: created + DAY, type: 'topup', amount: d.topup, note: 'Wallet top-up (upi)' });
  const done = Object.fromEntries(DRIVERS.map((d) => [d.key, d.base]));
  const dues = Object.fromEntries(RIDERS.map((r) => [r.key, 0]));
  const tollId = Number(db.prepare("INSERT INTO tolls (name, state, lat, lng, status, verified_amount, created_by, created_at) VALUES ('Shaheed Path Toll (demo)', 'UP', 26.7790, 80.9300, 'verified', 45, ?, ?)").run(ids.ramesh, created).lastInsertRowid);
  const insTrip = db.prepare(`INSERT INTO trips (rider_id, driver_id, guest_id, src_name, src_lat, src_lng, dst_name, dst_lat, dst_lng, state, distance_km,
    eta_min, free_flow_min, traffic_source, traffic_label, pet, quote, final, status, otp, fit_declared_at, wait_minutes, track_token, expected_end_at,
    last_lat, last_lng, last_loc_at, payment_method, paid_at, pay_timing, prepaid_amount, prepaid_method, prepaid_at, invoice_no, safety,
    cancel_by, cancel_reason, cancel_fee, cancel_charged, cancelled_at, created_at, accepted_at, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UP', ?, ?, ?, 'estimate', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insRating = db.prepare('INSERT INTO ratings (trip_id, from_id, to_id, to_role, scores, overall, good, bad, improve, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const rate = (tripId, from, to, role, v, ts) => {
    const keys = Object.keys(C.RATING_CRITERIA[role]);
    const scores = Object.fromEntries(keys.map((k, i) => [k, v[i]]));
    insRating.run(tripId, from, to, role, JSON.stringify(scores), Math.round((v.slice(0, 5).reduce((a, b) => a + b, 0) / 5) * 100) / 100, v[5], v[6], v[7], ts);
  };

  const ordered = TRIPS.map((t) => ({ ...t, ts: at(t.when) })).sort((a, b) => a.ts - b.ts);
  for (const t of ordered) {
    const drv = DRIVERS.find((d) => d.key === t.d);
    const src = { lat: P[t.from][1], lng: P[t.from][2] }, dst = { lat: P[t.to][1], lng: P[t.to][2] };
    const route = fallbackRoute(src, dst, new Date(t.ts));
    const tolls = t.toll ? [{ id: tollId, name: 'Shaheed Path Toll (demo)', amount: 45, status: 'verified' }] : [];
    const fareArgs = {
      distanceKm: route.distanceKm, vehicleType: drv.type, rates: rates[drv.type], condition: drv.cond, completedTrips: done[t.d],
      waitMinutes: route.delayMin, tolls, petCharge: t.pet ? drv.prefs.petCharge || 0 : 0, dues: t.st === 'completed' ? dues[t.r] : 0,
    };
    const quote = { ...calculateFare(fareArgs), driverCompletedTrips: done[t.d], rates: rates[drv.type] };
    const completed = t.st === 'completed';
    const final = completed ? calculateFare(fareArgs) : null;
    const accepted = ['completed', 'started', 'cancelled'].includes(t.st) ? t.ts + 60000 : null;
    const started = ['completed', 'started'].includes(t.st) ? t.ts + 5 * 60000 : null;
    const ended = completed ? started + Math.round(route.etaMin) * 60000 : null;
    let guestId = null;
    if (t.guest) guestId = Number(db.prepare('INSERT INTO guests (public_id, owner_id, name, phone, created_at) VALUES (?, ?, ?, NULL, ?)').run(newPublicId('OLB-G', 'guests'), ids[t.r], t.guest, t.ts).lastInsertRowid);
    const c = t.cancel; const cancelFee = c ? platformFeeFor(route.distanceKm, false) : null;
    const live = t.st === 'started';
    const mid = live ? { lat: src.lat + (dst.lat - src.lat) * 0.3, lng: src.lng + (dst.lng - src.lng) * 0.3 } : null;
    const tripId = Number(insTrip.run(
      ids[t.r], ids[t.d], guestId, P[t.from][0], src.lat, src.lng, P[t.to][0], dst.lat, dst.lng, quote.distanceKm,
      route.etaMin, route.freeFlowMin, route.trafficLabel, t.pet ? 1 : 0, JSON.stringify(quote), final && JSON.stringify(final), t.st,
      String(crypto.randomInt(0, 10000)).padStart(4, '0'), started, completed ? route.delayMin : null, crypto.randomBytes(16).toString('hex'),
      started ? started + Math.ceil(route.etaMin) * 60000 : null, mid && mid.lat, mid && mid.lng, mid && t0,
      completed ? t.pay : null, completed ? ended + 2 * 60000 : null, t.prepaid ? 'start' : 'end',
      t.prepaid ? quote.riderPays : null, t.prepaid ? t.pay : null, t.prepaid ? started + 30000 : null, null,
      completed ? JSON.stringify(t.safety || { score: 96 + (tripSeed(t) % 5), overspeed: 0, harshBrakes: 0, maxKmph: 52 + (tripSeed(t) % 12), points: 40 }) : null,
      c ? c[0] : null, c ? c[1] : null, c ? cancelFee : null, c ? c[2] : null, c ? t.ts + 6 * 60000 : null,
      t.ts, accepted, started, ended).lastInsertRowid);
    if (completed) {
      db.prepare('UPDATE trips SET invoice_no = ? WHERE id = ?').run(`OLB/${fy(ended)}/${String(tripId).padStart(6, '0')}`, tripId);
      if (t.toll) db.prepare('INSERT INTO trip_tolls (trip_id, toll_id) VALUES (?, ?)').run(tripId, tollId);
      done[t.d]++;
      txns.push({ d: t.d, ts: ended, type: 'platform_fee', amount: -final.platformFee, tripId, note: 'Olub fee, incl. GST' });
      txns.push({ d: t.d, ts: ended + 1, type: 'ride_gst', amount: -final.taxes.rideGst, tripId, note: 'GST 5% on ride, remitted by Olub' });
      if (final.dues) { txns.push({ d: t.d, ts: ended + 2, type: 'cancel_fee_passthrough', amount: -final.dues, tripId, note: "Customer's earlier cancellation fee, collected with this fare" }); dues[t.r] = 0; }
      if (t.rd) rate(tripId, ids[t.r], ids[t.d], 'driver', t.rd, ended + 5 * 60000);
      if (t.dr) rate(tripId, ids[t.d], ids[t.r], 'rider', t.dr, ended + 6 * 60000);
    }
    if (c && c[2] === 'driver') txns.push({ d: t.d, ts: t.ts + 6 * 60000, type: 'cancel_fee', amount: -cancelFee, tripId, note: c[1] === 'driver_not_coming' ? 'Cancellation fee — GPS shows the driver was not coming to the pickup' : 'Cancellation fee — the driver cancelled after accepting' });
    if (c && c[2] === 'rider') dues[t.r] += cancelFee;
    if (t.safety) db.prepare("INSERT INTO safety_events (trip_id, ts, type, lat, lng) VALUES (?, ?, 'overspeed', ?, ?)").run(tripId, started + 8 * 60000, dst.lat, dst.lng);
    if (live) {
      const pts = db.prepare('INSERT INTO trip_points (trip_id, lat, lng, ts, kmph) VALUES (?, ?, ?, ?, ?)');
      for (let k = 0; k <= 6; k++) pts.run(tripId, src.lat + (dst.lat - src.lat) * 0.05 * k, src.lng + (dst.lng - src.lng) * 0.05 * k, started + k * 40000, 32);
      db.prepare('UPDATE drivers SET last_lat = ?, last_lng = ? WHERE user_id = ?').run(mid.lat, mid.lng, ids[t.d]);
    }
  }

  // ---- wallets ----
  const bal = {};
  const insTxn = db.prepare('INSERT INTO wallet_txns (driver_id, ts, type, amount, balance_after, trip_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const x of txns.sort((a, b) => a.ts - b.ts)) {
    bal[x.d] = Math.round(((bal[x.d] || 0) + x.amount) * 100) / 100;
    insTxn.run(ids[x.d], x.ts, x.type, x.amount, bal[x.d], x.tripId || null, x.note);
  }
  for (const d of DRIVERS) db.prepare('UPDATE drivers SET wallet_balance = ?, completed_trips = ? WHERE user_id = ?').run(bal[d.key], done[d.key], ids[d.key]);
  for (const r of RIDERS) db.prepare('UPDATE users SET cancel_dues = ? WHERE id = ?').run(dues[r.key], ids[r.key]);

  // ---- one open privacy request for the admin queue ----
  db.prepare(`INSERT INTO dsr_requests (public_id, user_id, type, details, created_at, process_after, internal_due_at, public_due_at)
    VALUES (?, ?, 'grievance', 'I was charged a cancellation fee although the driver cancelled.', ?, ?, ?, ?)`)
    .run(newPublicId('DSR', 'dsr_requests'), ids.priya, t0 - DAY, t0 + 4 * DAY, t0 + 6 * DAY, t0 + 11 * DAY);

  audit.log({ action: 'demo.seeded', details: { drivers: DRIVERS.length, customers: RIDERS.length, trips: TRIPS.length } });
  return {
    seeded: true,
    message: `Loaded ${DRIVERS.length} drivers, ${RIDERS.length} customers and ${TRIPS.length} trips around Lucknow.`,
    logins: {
      drivers: DRIVERS.map((d) => ({ name: d.name, phone: d.phone, vehicle: d.vn, type: d.type, note: { ramesh: 'on a ride right now', imran: 'has a ride request waiting', sunita: 'new, awaiting verification', gurpreet: 'wallet below ₹100, cannot go online' }[d.key] || 'free, waiting for customers' })),
      customers: RIDERS.map((r) => ({ name: r.name, phone: r.phone, note: { priya: 'most trips; open privacy complaint', arjun: 'waiting for a driver to accept', fatima: 'in a ride right now', rohan: 'paid an earlier cancellation fee with his last ride' }[r.key] })),
    },
  };
};

function tripSeed(t) { return (t.r.length * 7 + t.d.length * 3 + t.from.length) % 97; }
module.exports.PLACES = Object.values(P).map(([name, lat, lng]) => [name, 'UP', lat, lng]);
module.exports.digipin = (k) => Digipin.encode(P[k][1], P[k][2]);
