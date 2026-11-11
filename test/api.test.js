'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setup() {
  const app = createApp({ dbFile: ':memory:' });
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
  const login = async (phone, role, name) => {
    const r = await call('POST', '/api/auth/request-otp', { phone });
    const v = await call('POST', '/api/auth/verify-otp', { phone, code: r.body.devCode, role, name });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body.token;
  };
  const makeDriver = async (phone, vehicleNumber, type = 'sedan') => {
    const tok = await login(phone, 'driver', `Driver ${phone.slice(-2)}`);
    const docs = { license: PIXEL, rc: PIXEL, kyc: PIXEL, vehicle: PIXEL, selfie: PIXEL };
    const p = await call('PUT', '/api/driver/profile', {
      vehicleNumber, vehicleType: type, vehicleModel: 'Dzire', condition: 'good',
      licenseNo: 'KA0120200001234', rcNo: 'RC123', kycIdNo: '1234', docs,
    }, tok);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.driver.status, 'submitted');
    assert.equal((await call('POST', '/api/driver/online', { online: true }, tok)).status, 200);
    return tok;
  };
  return { app, server, call, login, makeDriver };
}

test('full trip: book by vehicle number → accept → OTP → toll → complete → verify → pay', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call } = s;

  const driver = await s.makeDriver('9876500001', 'KA 01 AB 1234');
  const rider = await s.login('9876500002', 'rider', 'Asha');
  const places = (await call('GET', '/api/places')).body;
  const mg = places.find((p) => p.name.startsWith('MG Road'));
  const ec = places.find((p) => p.name.startsWith('Electronic City'));

  // Rider books the cab in front of them using the number plate.
  const booking = { driver: 'ka01ab1234', src: { placeId: mg.id }, dst: { placeId: ec.id }, traffic: 'moderate' };
  const quote = await call('POST', '/api/trips/quote', booking, rider);
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  assert.equal(quote.body.quote.platformFee, 5);
  assert.equal(quote.body.verifyOffer, 10);
  assert.equal(quote.body.driver.phone, undefined, 'driver phone must never be exposed');

  const trip = (await call('POST', '/api/trips', booking, rider)).body;
  assert.equal(trip.status, 'requested');
  assert.match(trip.otp, /^\d{4}$/);

  // Driver sees the request but not the OTP.
  const cur = (await call('GET', '/api/trips/current', null, driver)).body;
  assert.equal(cur.requests.length, 1);
  assert.equal(cur.requests[0].otp, undefined);

  assert.equal((await call('POST', `/api/trips/${trip.id}/accept`, {}, driver)).body.status, 'accepted');
  assert.equal((await call('POST', `/api/trips/${trip.id}/start`, { otp: '0000' === trip.otp ? '1111' : '0000' }, driver)).status, 400);
  assert.equal((await call('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp }, driver)).body.status, 'started');

  // Masked chat.
  await call('POST', `/api/trips/${trip.id}/messages`, { body: 'I am at the gate' }, rider);
  const msgs = (await call('GET', `/api/trips/${trip.id}/messages`, null, driver)).body;
  assert.equal(msgs[0].body, 'I am at the gate');
  assert.equal(msgs[0].mine, false);

  // Driver crosses a new toll → uses KA default (₹75) until 5 more drivers confirm.
  const toll = await call('POST', `/api/trips/${trip.id}/tolls`, { name: 'Test Plaza', lat: 12.9, lng: 77.63, amount: 60, photo: PIXEL }, driver);
  assert.equal(toll.status, 200, JSON.stringify(toll.body));
  assert.equal(toll.body.toll.amount, 75);

  const done = (await call('POST', `/api/trips/${trip.id}/complete`, { waitMinutes: 8 }, driver)).body;
  assert.equal(done.status, 'completed');
  assert.equal(done.final.breakdown.tollTotal, 75);
  assert.equal(done.final.breakdown.waitCharge, 10);

  // Rider verifies the new driver in person → ₹10 off.
  const before = done.final.riderPays;
  const v = (await call('POST', `/api/trips/${trip.id}/verify-driver`, { checks: { face: true, vehicleNumber: true, vehicleMatches: true } }, rider)).body;
  assert.equal(v.final.riderPays, before - 10);
  assert.equal(v.driver.status, 'verified');

  const paid = (await call('POST', `/api/trips/${trip.id}/pay`, { method: 'upi' }, rider)).body;
  assert.ok(paid.paidAt);
  const earn = (await call('GET', '/api/driver/earnings', null, driver)).body;
  assert.equal(earn.trips, 1);
  assert.equal(earn.owedToOlub, -5);
});

test('toll becomes verified after the reporter + 5 more drivers agree', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call } = s;
  const rider = await s.login('9876511111', 'rider', 'R');
  const places = (await call('GET', '/api/places')).body;
  const mg = places.find((p) => p.name.startsWith('MG Road'));
  const ec = places.find((p) => p.name.startsWith('Electronic City'));

  let tollId;
  for (let i = 0; i < 6; i++) {
    const vn = `KA05AB10${i}0`;
    const drv = await s.makeDriver(`98765222${String(i).padStart(2, '0')}`, vn);
    const trip = (await call('POST', '/api/trips', { driver: vn, src: { placeId: mg.id }, dst: { placeId: ec.id } }, rider)).body;
    await call('POST', `/api/trips/${trip.id}/accept`, {}, drv);
    await call('POST', `/api/trips/${trip.id}/start`, { otp: trip.otp }, drv);
    if (i > 0) {
      const prompts = (await call('GET', `/api/trips/${trip.id}/toll-prompts`, null, drv)).body;
      assert.equal(prompts.length, 1, 'later drivers are prompted to confirm the toll on their route');
    }
    const r = (await call('POST', `/api/trips/${trip.id}/tolls`, tollId
      ? { tollId, amount: 50, photo: PIXEL }
      : { name: 'Hosur Rd Plaza', lat: 12.9, lng: 77.635, amount: 50, photo: PIXEL }, drv)).body;
    tollId = r.toll.id;
    assert.equal(r.toll.status, i < 5 ? 'pending' : 'verified');
    const done = (await call('POST', `/api/trips/${trip.id}/complete`, {}, drv)).body;
    assert.equal(done.final.breakdown.tollTotal, i < 5 ? 75 : 50);
    await call('POST', `/api/trips/${trip.id}/pay`, { method: 'cash' }, rider);
  }

  // New quotes on that route now include the verified toll automatically.
  const q = (await call('POST', '/api/trips/quote', { driver: 'KA05AB1000', src: { placeId: mg.id }, dst: { placeId: ec.id } }, rider)).body;
  assert.equal(q.quote.breakdown.tollTotal, 50);
});

test('calamity mode and lookup by mobile; offline drivers cannot be booked', async (t) => {
  const s = await setup();
  t.after(() => s.server.close());
  const { call } = s;
  const admin = await s.login('9999999999');
  const driver = await s.makeDriver('9876533333', 'DL01CA0001', 'auto');
  const rider = await s.login('9876544444', 'rider', 'R');
  const places = (await call('GET', '/api/places')).body;
  const cp = places.find((p) => p.name.startsWith('Connaught'));
  const cc = places.find((p) => p.name.startsWith('Cyber City'));

  await call('POST', '/api/admin/calamity', { state: 'DL', on: true, reason: 'Flooding' }, admin);
  const q = await call('POST', '/api/trips/quote', { driver: '98765 33333', src: { placeId: cp.id }, dst: { placeId: cc.id } }, rider);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.quote.platformFee, 2.5);
  assert.equal(q.body.quote.breakdown.tollTotal, 0, 'autos are toll-exempt');

  await call('POST', '/api/driver/online', { online: false }, driver);
  const off = await call('POST', '/api/trips/quote', { driver: 'DL01CA0001', src: { placeId: cp.id }, dst: { placeId: cc.id } }, rider);
  assert.equal(off.status, 409);
});
