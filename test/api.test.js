'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const C = require('../src/config');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MIN = 60000;

async function setup() {
  const time = { t: Date.parse('2026-11-12T06:00:00Z') };
  // Deterministic route: 20 km, 30 min free-flow, 10 min traffic delay.
  const maps = {
    getRoute: async () => ({ distanceKm: 20, freeFlowMin: 30, delayMin: 10, etaMin: 40, source: 'test', trafficLabel: 'Moderate', polyline: null }),
    searchPlaces: async () => [],
  };
  const app = createApp({ dbFile: ':memory:', clock: () => time.t, maps });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const login = async (phone, role, name) => {
    const r = await ok('POST', '/api/auth/request-otp', { phone });
    return (await ok('POST', '/api/auth/verify-otp', { phone, code: r.devCode, role, name, acceptTerms: true })).token;
  };
  const personal = async (tok, n) => {
    const e = await ok('POST', '/api/me/email', { email: `user${n}@example.com` }, tok);
    await ok('POST', '/api/me/email/verify', { code: e.devCode }, tok);
    await ok('PATCH', '/api/me', { dob: '1990-05-01', gender: 'male' }, tok);
  };
  const makeRider = async (phone, name = 'Asha Rao') => {
    const tok = await login(phone, 'rider', name);
    await personal(tok, phone);
    await ok('PATCH', '/api/me', { trusted: { name: 'Meera', phone: '9000000001', relation: 'Sister' } }, tok);
    return tok;
  };
  const makeDriver = async (phone, vehicleNumber, type = 'sedan', prefs = {}) => {
    const tok = await login(phone, 'driver', `Driver ${phone.slice(-2)}`);
    await personal(tok, phone);
    const p = await ok('PUT', '/api/driver/profile', {
      vehicleNumber, vehicleType: type, vehicleModel: 'Dzire', condition: 'good',
      licenseNo: 'KA0120200001234', licenseIssuedOn: '2014-03-10', insuranceValidTill: '2027-12-31', rcNo: 'RC123', kycIdNo: '1234', permitNo: 'KA/CC/2024/1',
      docs: { license: PIXEL, rc: PIXEL, kyc: PIXEL, vehicle: PIXEL, selfie: PIXEL }, prefs,
    }, tok);
    assert.deepEqual(p.missing, []);
    await ok('POST', '/api/driver/wallet/topup', { amount: 500 }, tok);
    await ok('POST', '/api/driver/online', { online: true }, tok);
    return tok;
  };
  const places = await ok('GET', '/api/places');
  const place = (s) => ({ placeId: places.find((p) => p.name.startsWith(s)).id });
  return { app, server, call, ok, login, makeRider, makeDriver, place, time, db: app.locals.db };
}

test('full trip with every safety rule', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;

  const driver = await s.makeDriver('9876500001', 'KA 01 AB 1234', 'sedan', { noSmoking: true, noAlcohol: true, petsOk: true, petCharge: 40 });
  const rider = await s.makeRider('9876500002');
  const me = await ok('GET', '/api/me', null, rider);
  assert.match(me.publicId, /^OLB-C-[2-9A-Z]{6}$/);
  assert.equal(me.emailVerified && me.phoneVerified, true);
  assert.equal(me.age, 36);

  // Booking for a guest, with a pet, by number plate.
  const booking = { driver: 'ka01ab1234', src: s.place('MG Road'), dst: s.place('Electronic City'), pet: true, guest: { name: 'Grandma Lakshmi' } };
  const q = await ok('POST', '/api/trips/quote', booking, rider);
  assert.equal(q.quote.platformFee, 5);
  assert.equal(q.quote.breakdown.petCharge, 40);
  assert.equal(q.quote.breakdown.waitCharge, (10 - 3) * 2, 'traffic delay comes from the maps provider');
  assert.equal(q.quote.breakdown.roadMultiplier, undefined, 'road condition is no longer part of the fare');
  assert.deepEqual(q.driver.rules, ['noSmoking', 'noAlcohol']);
  assert.match(q.driver.publicId, /^OLB-D-/);
  assert.equal(q.driver.age, 36);
  assert.equal(q.driver.gender, 'male');
  assert.equal(q.driver.drivingYears, 12, 'experience comes from the licence issue date');
  assert.equal(q.driver.phone, undefined, 'phone numbers are never exposed');

  const trip = await ok('POST', '/api/trips', booking, rider);
  assert.match(trip.guest.publicId, /^OLB-G-/);
  assert.match(trip.trackPath, /^\/track\/[0-9a-f]{32}$/);
  await ok('POST', `/api/trips/${trip.id}/accept`, {}, driver);

  // The ride cannot start without the "healthy and fit" tick, even with the right OTP.
  const noTick = await call('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp }, driver);
  assert.equal(noTick.status, 400);
  assert.match(noTick.body.error, /healthy/);
  const wrong = await call('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp === '0000' ? '1111' : '0000', fitDeclaration: true }, driver);
  assert.equal(wrong.status, 400);
  const started = await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, driver);
  assert.equal(started.status, 'started');
  assert.equal(started.guest.name, 'Grandma Lakshmi');

  // Trusted contact gets the tracking link; the public page shows live location, no phone numbers.
  const sms = s.db.prepare("SELECT * FROM outbox WHERE template = 'ride_started'").get();
  assert.equal(sms.to_addr, '9000000001');
  assert.match(sms.body, /track\//);
  await ok('POST', `/api/trips/${trip.id}/location`, { lat: 12.93, lng: 77.62 }, driver);
  const track = await ok('GET', `/api/track/${trip.trackPath.split('/').pop()}`);
  assert.equal(track.traveller, 'Grandma');
  assert.deepEqual([track.last.lat, track.last.lng], [12.93, 77.62]);
  assert.equal(JSON.stringify(track).includes('98765'), false);

  // Ride runs late: warn the contact at +5 min, alert at +10 min.
  s.time.t += (40 + 6) * MIN; s.app.locals.tick();
  assert.equal((await ok('GET', `/api/trips/${trip.id}`, null, rider)).overdueLevel, 1);
  assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE template = 'ride_running_late'").get());
  s.time.t += 5 * MIN; s.app.locals.tick();
  assert.match(s.db.prepare("SELECT body FROM outbox WHERE template = 'ride_overdue_alert'").get().body, /check on them/);
  // Rider says "I'm safe" → contact is told, timer re-arms.
  assert.equal((await ok('POST', `/api/trips/${trip.id}/safe`, {}, rider)).overdueLevel, 0);
  assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE template = 'ride_safe'").get());

  // Final bill: waiting is measured (51 min actual − 30 min free-flow = 21 min → 18 billable × ₹2).
  const done = await ok('POST', `/api/trips/${trip.id}/complete`, {}, driver);
  assert.equal(done.final.breakdown.waitCharge, 36);
  assert.equal(done.final.breakdown.petCharge, 40);
  await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'upi' }, rider);

  // Both sides rate each other on 5 points with good / bad / improve notes.
  const five = (role) => Object.fromEntries(Object.keys(C.RATING_CRITERIA[role]).map((k) => [k, 5]));
  const bad = await call('POST', `/api/trips/${trip.id}/rating`, { scores: { safety: 5 } }, rider);
  assert.equal(bad.status, 400);
  await ok('POST', `/api/trips/${trip.id}/rating`, { scores: { ...five('driver'), punctuality: 3 }, good: 'Very safe driver', improve: 'Start a bit earlier' }, rider);
  await ok('POST', `/api/trips/${trip.id}/rating`, { scores: five('rider'), good: 'Polite' }, driver);
  assert.equal((await call('POST', `/api/trips/${trip.id}/rating`, { scores: five('rider') }, driver)).status, 409);
  assert.equal((await ok('GET', '/api/me', null, driver)).rating.average, 4.6);
});

test('monthly feedback hides who wrote it; admin sees everything; audit chain is intact', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { ok } = s;
  const driver = await s.makeDriver('9876500011', 'KA02AB0001');
  const five = Object.fromEntries(Object.keys(C.RATING_CRITERIA.driver).map((k) => [k, 5]));
  for (let i = 0; i < 3; i++) {
    const rider = await s.makeRider(`98765001${i}0`, `Rider${i} Secret`);
    const trip = await ok('POST', '/api/trips', { driver: 'KA02AB0001', src: s.place('MG Road'), dst: s.place('Whitefield') }, rider);
    await ok('POST', `/api/trips/${trip.id}/accept`, {}, driver);
    await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, driver);
    await ok('POST', `/api/trips/${trip.id}/complete`, {}, driver);
    await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'cash' }, rider);
    await ok('POST', `/api/trips/${trip.id}/rating`, { scores: five, good: `good-${i}`, bad: `bad-${i}` }, rider);
  }
  // During the month: averages only, no comments.
  let fb = await ok('GET', '/api/feedback/mine', null, driver);
  assert.equal(fb.overall.count, 3);
  assert.equal(fb.months[0].comments, null);
  // After the month ends: comments appear, shuffled, with no names, ids or dates.
  s.time.t += 30 * C.DAY;
  fb = await ok('GET', '/api/feedback/mine', null, driver);
  assert.deepEqual([...fb.months[0].comments.good].sort(), ['good-0', 'good-1', 'good-2']);
  assert.equal(JSON.stringify(fb).includes('Secret'), false);
  assert.equal(JSON.stringify(fb).includes('OLB-C'), false);

  const admin = await s.login('9999999999', undefined, 'Admin');
  const all = await ok('GET', '/api/admin/feedback', null, admin);
  assert.match(all[0].from, /Rider\d Secret \(OLB-C-/);
  const users = await ok('GET', '/api/admin/users?q=9876500011', null, admin);
  const trail = await ok('GET', `/api/admin/users/${users[0].id}/trail`, null, admin);
  assert.ok(trail.audit.some((a) => a.action === 'POST /trips/:id/start' && a.details.note.includes('healthy')));
  assert.ok(trail.consents.some((c) => c.doc === 'driver_terms'));
  assert.equal(trail.trips.length, 3);
  assert.equal(JSON.stringify(trail.audit).includes('data:image'), false, 'documents are never copied into the audit log');
  assert.equal((await ok('GET', '/api/admin/audit/verify', null, admin)).ok, true);
  // Tampering with any audit row is detected.
  s.db.prepare("UPDATE audit_log SET action = 'x' WHERE id = 5").run();
  assert.deepEqual(await ok('GET', '/api/admin/audit/verify', null, admin), { ok: false, brokenAt: 5 });
});

test('toll becomes verified after the reporter + 5 more drivers agree', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { ok } = s;
  const rider = await s.makeRider('9876511111');
  let tollId;
  for (let i = 0; i < 6; i++) {
    const vn = `KA05AB10${i}0`;
    const drv = await s.makeDriver(`98765222${String(i).padStart(2, '0')}`, vn);
    const trip = await ok('POST', '/api/trips', { driver: vn, src: s.place('MG Road'), dst: s.place('Electronic City') }, rider);
    await ok('POST', `/api/trips/${trip.id}/accept`, {}, drv);
    await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, drv);
    if (i > 0) assert.equal((await ok('GET', `/api/trips/${trip.id}/toll-prompts`, null, drv)).length, 1);
    const r = await ok('POST', `/api/trips/${trip.id}/tolls`, tollId
      ? { tollId, amount: 50, photo: PIXEL }
      : { name: 'Hosur Rd Plaza', lat: 12.9, lng: 77.635, amount: 50, photo: PIXEL }, drv);
    tollId = r.toll.id;
    assert.equal(r.toll.status, i < 5 ? 'pending' : 'verified');
    const done = await ok('POST', `/api/trips/${trip.id}/complete`, {}, drv);
    assert.equal(done.final.breakdown.tollTotal, i < 5 ? 75 : 50);
    await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'cash' }, rider);
  }
});

test('booking rules: profile must be complete, pets need a pet-friendly driver, calamity fee, admin rates', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;
  const admin = await s.login('9999999999', undefined, 'Admin');
  const driver = await s.makeDriver('9876533333', 'DL01CA0001', 'auto');
  const booking = { driver: '98765 33333', src: s.place('Connaught'), dst: s.place('Cyber City') };

  // A rider without confirmed email / trusted contact cannot book.
  const raw = await s.login('9876544440', 'rider', 'New Rider');
  const blocked = await call('POST', '/api/trips', booking, raw);
  assert.equal(blocked.status, 412);
  assert.deepEqual(blocked.body.todo, ['email', 'personal', 'trusted']);
  assert.equal((await call('PATCH', '/api/me', { dob: '2015-01-01' }, raw)).status, 400, 'must be an adult');

  const rider = await s.makeRider('9876544444');
  assert.equal((await call('POST', '/api/trips/quote', { ...booking, pet: true }, rider)).status, 409, 'driver does not take pets');

  await ok('POST', '/api/admin/calamity', { state: 'DL', on: true, reason: 'Flooding' }, admin);
  await ok('PUT', '/api/admin/rates', { auto: { base: 35, perKm: 18, perWaitMin: 2, minFare: 40 } }, admin);
  const q = await ok('POST', '/api/trips/quote', booking, rider);
  assert.equal(q.quote.platformFee, 2.5);
  assert.equal(q.quote.breakdown.perKm, 18, 'admin-set per-km rate is used');

  // Expired insurance blocks going online.
  s.time.t = Date.parse('2028-01-05T06:00:00Z');
  assert.equal((await call('GET', '/api/me', null, driver)).status, 401, 'sessions expire after 30 days');
  const again = await s.login('9876533333');
  await ok('POST', '/api/driver/online', { online: false }, again);
  assert.equal((await call('POST', '/api/driver/online', { online: true }, again)).status, 409);
});

test('privacy requests: verified accounts only, answered automatically, fully logged', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;

  const unverified = await s.login('9876555550', 'rider', 'No Email');
  assert.equal((await call('POST', '/api/privacy/requests', { type: 'access' }, unverified)).status, 403);

  const rider = await s.makeRider('9876555555', 'Priya Nair');
  const access = await ok('POST', '/api/privacy/requests', { type: 'access' }, rider);
  assert.match(access.publicId, /^DSR-/);
  assert.equal(access.answerBy - access.createdAt, 12 * C.DAY, 'the public promise is 12 days');
  const erase = await ok('POST', '/api/privacy/requests', { type: 'erasure' }, rider);

  // Nothing happens before the cooling-off period…
  s.time.t += 4 * C.DAY; s.app.locals.tick();
  assert.equal((await ok('GET', '/api/privacy/requests', null, rider))[0].status, 'received');
  // …user changes their mind about deletion…
  await ok('POST', `/api/privacy/requests/${erase.id}/withdraw`, {}, rider);
  // …and on day 5 the access request is answered automatically (inside the 7-day internal target).
  s.time.t += 1 * C.DAY + MIN; s.app.locals.tick();
  const mine = await ok('GET', '/api/privacy/requests', null, rider);
  assert.deepEqual(mine.map((r) => r.status), ['withdrawn', 'completed']);
  const data = await ok('GET', `/api/privacy/requests/${access.id}/export`, null, rider);
  assert.equal(data.profile.name, 'Priya Nair');
  assert.ok(data.consents.length >= 2);

  // Deletion: personal data is wiped, login stops working, audit keeps the evidence.
  await ok('POST', '/api/privacy/requests', { type: 'erasure' }, rider);
  s.time.t += 5 * C.DAY + MIN; s.app.locals.tick();
  assert.equal((await call('GET', '/api/me', null, rider)).status, 401);
  const u = s.db.prepare("SELECT * FROM users WHERE status = 'erased'").get();
  assert.equal(u.name, 'Deleted user');
  assert.equal(u.email, null);
  assert.equal(u.trusted_phone, null);
  const actions = s.db.prepare("SELECT action FROM audit_log WHERE entity = 'dsr'").all().map((a) => a.action);
  assert.deepEqual(actions, ['dsr.completed', 'dsr.completed']);
  assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE template = 'dsr_completed' AND to_addr = 'user9876555555@example.com'").get());
  assert.equal(s.app.locals.audit.verify().ok, true);
});

test('QR + DIGIPIN booking, wallet, GST invoice, pay at start, insights', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;
  const driver = await s.makeDriver('9876600001', 'KA09ZZ0001');
  const rider = await s.makeRider('9876600002');
  const dme = await ok('GET', '/api/me', null, driver);
  assert.match(dme.driver.qr, /^olub:D:OLB-D-/);
  assert.equal(dme.driver.wallet.balance, 500);

  // Destination first → estimate for every vehicle type; pickup given as a DIGIPIN.
  const src = { digipin: '4P3-J4C-FJMF' }; // MG Road Metro
  const est = await ok('POST', '/api/trips/estimate', { src, dst: s.place('Whitefield') }, rider);
  assert.equal(est.src.digipin, '4P3-J4C-FJMF');
  assert.ok(Math.abs(est.src.lat - 12.9756) < 0.0001);
  assert.deepEqual(est.options.map((o) => o.type), ['bike', 'auto', 'hatchback', 'sedan', 'suv']);

  // Then scan the driver's QR → exact fare for that vehicle and driver.
  const booking = { driver: dme.driver.qr, src, dst: s.place('Whitefield'), payTiming: 'start' };
  const q = await ok('POST', '/api/trips/quote', booking, rider);
  assert.equal(q.driver.vehicleNumber, 'KA09ZZ0001');
  const fare = q.quote;
  assert.equal(fare.riderPays, fare.driverFare + fare.taxes.rideGst + 5);

  const trip = await ok('POST', '/api/trips', booking, rider);
  assert.match(trip.dst.digipin, /^[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{3}-[2-9CFJKLMPT]{4}$/);
  await ok('POST', `/api/trips/${trip.id}/accept`, {}, driver);
  await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, driver);
  // Customer pays at the start.
  const pre = await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'upi' }, rider);
  assert.equal(pre.prepaid.amount, fare.riderPays);
  assert.equal(pre.balanceDue, 0);
  s.time.t += 30 * MIN; // no traffic delay → final is not more than the prepaid quote
  const done = await ok('POST', `/api/trips/${trip.id}/complete`, {}, driver);
  assert.ok(done.paidAt, 'prepaid ride is settled automatically');
  assert.match(done.invoiceNo, /^OLB\/2026-27\/\d{6}$/);

  // ₹5 (incl. GST) and the ride GST leave the driver's wallet when the trip ends.
  const w = await ok('GET', '/api/driver/wallet', null, driver);
  assert.equal(w.balance, 500 - 5 - done.final.taxes.rideGst);
  assert.deepEqual(w.txns.map((x) => x.type), ['ride_gst', 'platform_fee', 'topup']);

  // Invoices: the rider gets the ride invoice, the driver the platform-fee invoice.
  const inv = await ok('GET', `/api/trips/${trip.id}/invoice`, null, rider);
  assert.equal(inv.total, done.final.riderPays);
  assert.equal(r2(inv.taxes[0].amount + inv.taxes[1].amount), done.final.taxes.rideGst);
  const dinv = await ok('GET', `/api/trips/${trip.id}/invoice`, null, driver);
  assert.equal(dinv.total, 5);
  assert.equal(dinv.summary.youKeep, done.final.driverFare);

  const ins = await ok('GET', '/api/insights', null, driver);
  assert.equal(ins.all.trips, 1);
  assert.equal(ins.all.driverKeeps, done.final.driverFare);
  assert.equal(ins.all.rideGst, done.final.taxes.rideGst);
  assert.ok(ins.commissionPercent < 20);
  assert.equal((await ok('GET', '/api/insights', null, rider)).all.riderPaid, done.final.riderPays);

  // Wallet below ₹100 → driver cannot get customers until they top up.
  s.db.prepare('UPDATE drivers SET wallet_balance = 60').run();
  const low = await call('POST', '/api/trips/quote', booking, rider);
  assert.equal(low.status, 409);
  assert.match(low.body.error, /top up/);
  await ok('POST', '/api/driver/online', { online: false }, driver);
  assert.equal((await call('POST', '/api/driver/online', { online: true }, driver)).status, 402);
});
const r2 = (n) => Math.round(n * 100) / 100;

test('12-hour duty limit with 10-hour rest; SOS and off-route alerts', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;
  const driver = await s.makeDriver('9876700001', 'KA09ZZ0002');
  const rider = await s.makeRider('9876700002');
  const booking = { driver: 'KA09ZZ0002', src: s.place('MG Road'), dst: s.place('Electronic City') };

  s.time.t += 11 * 60 * MIN;
  assert.equal((await ok('GET', '/api/me', null, driver)).driver.duty.remainingMin, 60);
  const trip = await ok('POST', '/api/trips', booking, rider);
  await ok('POST', `/api/trips/${trip.id}/accept`, {}, driver);
  await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, driver);

  // SOS: trusted contact gets location with DIGIPIN.
  await ok('POST', `/api/trips/${trip.id}/sos`, { lat: 12.93, lng: 77.62 }, rider);
  assert.match(s.db.prepare("SELECT body FROM outbox WHERE template = 'ride_sos'").get().body, /DIGIPIN [2-9A-Z-]+ .*112/);
  // Cab drives far away from the route for more than 3 minutes → contact is told.
  await ok('POST', `/api/trips/${trip.id}/location`, { lat: 13.15, lng: 77.3, kmph: 95 }, driver);
  s.time.t += 4 * MIN; s.app.locals.tick();
  assert.ok(s.db.prepare("SELECT 1 FROM outbox WHERE template = 'ride_off_route'").get());
  assert.equal((await ok('GET', `/api/trips/${trip.id}`, null, rider)).offRoute, true);
  await ok('POST', `/api/trips/${trip.id}/location`, { lat: 13.14, lng: 77.31, kmph: 20 }, driver);

  // The trip in progress is allowed to finish, then the driver is taken offline.
  s.time.t += 60 * MIN;
  const done = await ok('POST', `/api/trips/${trip.id}/complete`, {}, driver);
  assert.equal(done.safety.overspeed, 1);
  assert.equal(done.safety.harshBrakes, 0);
  assert.ok(done.safety.score < 100);
  const me = await ok('GET', '/api/me', null, driver);
  assert.equal(me.driver.online, false);
  assert.equal(me.driver.duty.locked, true);
  await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'cash' }, rider);
  const blocked = await call('POST', '/api/driver/online', { online: true }, driver);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /Rest 10 hours/);
  // After 10 hours of rest the duty day resets.
  s.time.t += 10 * 60 * MIN + MIN;
  const back = await ok('POST', '/api/driver/online', { online: true, otherAppHours: 3 }, driver);
  assert.equal(back.duty.workedMin, 180, 'hours declared for other apps count too');
});

test('police / RTO requests: government email only, auto-answer after 3 days, flags, compliance report', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call, ok } = s;
  const driver = await s.makeDriver('9876800001', 'KA09ZZ0003');
  const rider = await s.makeRider('9876800002', 'Kiran Customer');
  const trip = await ok('POST', '/api/trips', { driver: 'KA09ZZ0003', src: s.place('MG Road'), dst: s.place('Hebbal') }, rider);
  await ok('POST', `/api/trips/${trip.id}/accept`, {}, driver);
  await ok('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp, fitDeclaration: true }, driver);
  await ok('POST', `/api/trips/${trip.id}/complete`, {}, driver);
  await ok('POST', `/api/trips/${trip.id}/pay`, { method: 'cash' }, rider);

  const form = {
    agency: 'police', officerName: 'Insp. R. Gowda', designation: 'Inspector', office: 'Cubbon Park PS', caseRef: 'FIR 123/2026',
    legalBasis: 'BNSS s.94', details: 'Trips of this vehicle on the given dates', vehicleNumber: 'KA 09 ZZ 0003', proof: PIXEL,
  };
  assert.equal((await call('POST', '/api/authority/requests', { ...form, email: 'someone@gmail.com' })).status, 400, 'private email is refused');
  const made = await ok('POST', '/api/authority/requests', { ...form, email: 'sho.cubbonpark@ksp.gov.in' });
  assert.match(made.ref, /^LEA-/);
  assert.equal((await call('POST', `/api/authority/requests/${made.ref}/verify`, { code: '000000' })).status, 400);
  const ver = await ok('POST', `/api/authority/requests/${made.ref}/verify`, { code: made.devCode });
  assert.equal(ver.answerWithinDays, 10);

  // Nothing is disclosed during the review window, and never without the access key.
  let st = await ok('GET', `/api/authority/requests/${made.ref}?key=${ver.accessKey}`);
  assert.equal(st.status, 'under_review');
  assert.equal(st.data, undefined);
  assert.equal((await call('GET', `/api/authority/requests/${made.ref}?key=wrong`)).status, 404);
  // Day 3: answered automatically.
  s.time.t += 3 * C.DAY + MIN; s.app.locals.tick();
  st = await ok('GET', `/api/authority/requests/${made.ref}?key=${ver.accessKey}`);
  assert.equal(st.status, 'released');
  assert.equal(st.data.driver.vehicleNumber, 'KA09ZZ0003');
  assert.equal(st.data.trips[0].customer.name, 'Kiran Customer');
  assert.match(st.data.trips[0].to.digipin, /-/);

  // RTO flags the vehicle; admin sees it, suspends the driver; an admin can also refuse a request.
  const flag = await ok('POST', '/api/authority/requests', { ...form, kind: 'flag', agency: 'rto', email: 'rto.blr@karnataka.gov.in', details: 'Permit expired' });
  await ok('POST', `/api/authority/requests/${flag.ref}/verify`, { code: flag.devCode });
  const admin = await s.login('9999999999', undefined, 'Admin');
  const flags = await ok('GET', '/api/admin/flags', null, admin);
  assert.equal(flags[0].vehicleNumber, 'KA09ZZ0003');
  assert.equal(flags[0].agency, 'rto');
  await ok('POST', `/api/admin/drivers/${flags[0].driver.id}/suspend`, { suspend: true, reason: 'Flagged by RTO' }, admin);
  const again = await s.login('9876800001');
  assert.equal((await call('POST', '/api/driver/online', { online: true }, again)).status, 403);
  const third = await ok('POST', '/api/authority/requests', { ...form, email: 'x@nic.in' });
  await ok('POST', `/api/authority/requests/${third.ref}/verify`, { code: third.devCode });
  const open = (await ok('GET', '/api/admin/lea', null, admin)).find((r) => r.ref === third.ref);
  assert.equal((await ok('POST', `/api/admin/lea/${open.id}/resolve`, { action: 'reject', response: 'Letter is not signed' }, admin)).status, 'rejected');

  // Compliance tab + trip register for the transport authority.
  const comp = await ok('GET', '/api/admin/compliance', null, admin);
  assert.equal(comp.trips.completed, 1);
  assert.ok(comp.trips.commissionPercent < 20);
  assert.equal(comp.trips.withoutFitDeclaration, 0);
  assert.equal(comp.activeVehicleFlags, 1);
  assert.equal(comp.drivers.suspended, 1);
  assert.equal(comp.dutyHours[0].vehicle, 'KA09ZZ0003');
  assert.deepEqual(comp.authorityRequests, { rejected: 1, released: 2 });
  const reg = await ok('GET', '/api/admin/compliance/trip-register', null, admin);
  assert.equal(reg[0].vehicle, 'KA09ZZ0003');
  assert.equal(reg[0].fitDeclared, true);
  const actions = s.db.prepare("SELECT action FROM audit_log WHERE entity = 'lea'").all().map((a) => a.action);
  for (const a of ['lea.submitted', 'lea.email_verified', 'lea.released', 'lea.data_viewed', 'lea.vehicle_flagged', 'lea.wrong_code']) assert.ok(actions.includes(a), a);
  assert.equal(comp.auditLog.ok, true);
});
