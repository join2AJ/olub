'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const Hex = require('../src/hex');
const { haversineKm } = require('../src/geo');
const { calculateFare } = require('../src/fare');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HERE = { lat: 26.85, lng: 80.946 }; // Hazratganj

test('hexagons: the pickup is the centre cell and rings grow about 1 km at a time', () => {
  assert.equal(Hex.ring(HERE, HERE, 0.6), 0);
  assert.equal(Hex.ring({ lat: HERE.lat + 0.0095, lng: HERE.lng }, HERE, 0.6), 1);   // ~1 km north
  assert.equal(Hex.ring({ lat: HERE.lat + 0.045, lng: HERE.lng }, HERE, 0.6), 6);    // ~5 km north
  assert.equal(Hex.cellsWithin(2).length, 19);                                       // 1 + 6 + 12 cells
  const c = Hex.corners({ q: 0, r: 0 }, HERE, 0.6);
  assert.equal(c.length, 6);
  for (const [lat, lng] of c) assert.ok(Math.abs(haversineKm({ lat, lng }, HERE) - 0.6) < 0.02, 'every corner is one edge-length from the centre');
});

test('fare covers the cab coming to you: 10 km to reach + 1 km trip = 11 km, so the Olub fee is ₹15', () => {
  const direct = calculateFare({ distanceKm: 1, vehicleType: 'sedan', condition: 'good', completedTrips: 20 });
  const fetched = calculateFare({ distanceKm: 1, pickupKm: 10, vehicleType: 'sedan', condition: 'good', completedTrips: 20 });
  assert.equal(direct.platformFee, 5);
  assert.equal(fetched.platformFee, 15);
  assert.equal(fetched.distanceKm, 11);
  assert.deepEqual([fetched.breakdown.pickupKm, fetched.breakdown.tripKm], [10, 1]);
  assert.equal(fetched.breakdown.rideFare, 60 + 11 * 16, 'both distances are charged at the vehicle\'s per-km rate');
});

test('nearest cab is asked first; if it declines or does not answer, the next nearest is asked', async (t) => {
  const time = { t: Date.parse('2026-11-12T06:00:00Z') };
  // Road distance = straight line × 1.3 so the numbers are predictable.
  const maps = {
    getRoute: async (a, b) => { const km = haversineKm(a, b) * 1.3; return { distanceKm: km, freeFlowMin: km * 2, delayMin: 0, etaMin: km * 2, source: 'test', trafficLabel: 'Light', polyline: null }; },
    searchPlaces: async () => [],
  };
  const app = createApp({ dbFile: ':memory:', clock: () => time.t, maps });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const login = async (phone, role, name) => {
    const o = await ok('POST', '/api/auth/request-otp', { phone });
    const tok = (await ok('POST', '/api/auth/verify-otp', { phone, code: o.devCode, role, name, acceptTerms: true })).token;
    const e = await ok('POST', '/api/me/email', { email: `u${phone}@example.com` }, tok);
    await ok('POST', '/api/me/email/verify', { code: e.devCode }, tok);
    await ok('PATCH', '/api/me', { dob: '1990-05-01', gender: 'male' }, tok);
    return tok;
  };
  const driver = async (phone, vn, type, north) => {
    const tok = await login(phone, 'driver', `Driver ${vn}`);
    await ok('PUT', '/api/driver/profile', { vehicleNumber: vn, vehicleType: type, vehicleModel: 'X', condition: 'good', licenseNo: 'UP1', licenseIssuedOn: '2014-03-10',
      insuranceValidTill: '2027-12-31', rcNo: 'RC1', kycIdNo: '1', permitNo: 'P1', docs: { license: PIXEL, rc: PIXEL, kyc: PIXEL, vehicle: PIXEL, selfie: PIXEL } }, tok);
    await ok('POST', '/api/driver/wallet/topup', { amount: 500 }, tok);
    await ok('POST', '/api/driver/online', { online: true }, tok);
    await ok('POST', '/api/driver/location', { lat: HERE.lat + north, lng: HERE.lng }, tok); // km north ≈ north × 110.57
    return tok;
  };
  const near = await driver('9876000001', 'UP32AA0001', 'sedan', 0.009);   // ~1 km
  const mid = await driver('9876000002', 'UP32AA0002', 'sedan', 0.03);     // ~3.3 km
  await driver('9876000003', 'UP32AA0003', 'auto', 0.02);                  // ~2.2 km
  await driver('9876000004', 'UP32AA0004', 'sedan', 0.2);                  // ~22 km — outside the search
  const rider = await login('9876000009', 'rider', 'Asha Rao');
  await ok('PATCH', '/api/me', { trusted: { name: 'Meera', phone: '9000000001' } }, rider);

  const trip = { src: HERE, dst: { lat: HERE.lat, lng: HERE.lng + 0.01, name: 'Nearby' } }; // ~1 km trip
  const found = await ok('POST', '/api/trips/nearby', trip, rider);
  assert.deepEqual(found.options.map((o) => o.type), ['sedan', 'auto'], 'nearest first, one option per vehicle type');
  const sedan = found.options[0];
  assert.equal(sedan.ring, 1);
  assert.equal(sedan.count, 2, 'the 22 km cab is outside the search area');
  assert.ok(sedan.pickupKm > 1.2 && sedan.pickupKm < 1.4);
  assert.equal(found.cabs.length, 3, 'three free cabs inside the search area');
  assert.equal(JSON.stringify(found).includes('UP32AA'), false, 'cabs stay anonymous until one is booked');

  // Request a sedan: the nearest one gets the request, and the fare includes its trip to the pickup.
  const booked = await ok('POST', '/api/trips', { ...trip, match: { vehicleType: 'sedan' } }, rider);
  assert.equal(booked.driver.vehicleNumber, 'UP32AA0001');
  assert.equal(booked.matched, true);
  assert.equal(booked.quote.breakdown.pickupKm, sedan.pickupKm);
  assert.equal(booked.quote.platformFee, 5, 'about 1.3 + 1.3 km in total, so ₹5');
  assert.equal((await ok('GET', '/api/trips/current', null, mid)).requests.length, 0);

  // The nearest driver declines → the next nearest sedan is asked, with its own (longer) pickup distance.
  await ok('POST', `/api/trips/${booked.id}/reject`, {}, near);
  let now = await ok('GET', `/api/trips/${booked.id}`, null, rider);
  assert.equal(now.status, 'requested');
  assert.equal(now.driver.vehicleNumber, 'UP32AA0002');
  assert.ok(now.quote.breakdown.pickupKm > 4 && now.quote.riderPays > booked.quote.riderPays);
  assert.equal((await ok('GET', '/api/trips/current', null, near)).requests.length, 0);

  // That driver does not answer in 45 seconds → no sedan is left → cancelled with no fee.
  time.t += 50 * 1000; app.locals.tick(); await new Promise((r) => setTimeout(r, 80));
  now = await ok('GET', `/api/trips/${booked.id}`, null, rider);
  assert.equal(now.status, 'cancelled');
  assert.deepEqual([now.cancellation.reason, now.cancellation.fee], ['no_driver', 0]);

  // A long pickup pushes the total past 10 km → ₹15 fee, and the final bill charges both distances.
  await ok('POST', '/api/driver/location', { lat: HERE.lat + 0.075, lng: HERE.lng }, mid); // ~8.3 km → ~10.8 km by road
  await ok('POST', '/api/driver/online', { online: false }, near);
  const far = await ok('POST', '/api/trips', { ...trip, match: { vehicleType: 'sedan' } }, rider);
  assert.equal(far.driver.vehicleNumber, 'UP32AA0002');
  assert.equal(far.quote.platformFee, 15);
  await ok('POST', `/api/trips/${far.id}/accept`, {}, mid);
  await ok('POST', `/api/trips/${far.id}/start`, { otp: far.otp, fitDeclaration: true }, mid);
  const done = await ok('POST', `/api/trips/${far.id}/complete`, {}, mid);
  assert.equal(done.final.breakdown.pickupKm, far.quote.breakdown.pickupKm);
  assert.equal(done.final.breakdown.rideFare, far.quote.breakdown.rideFare);
  assert.equal(done.final.platformFee, 15);
});
