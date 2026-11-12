'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getRoute, searchPlaces } = require('../src/maps');
const { decodePolyline, pointToPathKm } = require('../src/geo');
const { createApp } = require('../src/app');

const A = { lat: 26.7606, lng: 80.8893 }, B = { lat: 26.785, lng: 80.9462 };

test('road route comes from OpenStreetMap when there is no Google key', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/route\/v1\/driving\/80\.8893,26\.7606;80\.9462,26\.785\?/);
    return { ok: true, json: async () => ({ routes: [{ distance: 9153.1, duration: 998.2, geometry: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] }) };
  };
  const r = await getRoute(A, B, { key: '', osm: true, fetchImpl, when: new Date('2026-11-12T21:00:00Z') });
  assert.equal(r.source, 'osm-road');
  assert.equal(Math.round(r.distanceKm * 10) / 10, 9.2, 'road distance, not straight-line');
  assert.ok(r.polyline, 'the road path is returned for drawing on the map');
});

test('polyline decoding and distance from the road path', () => {
  const path = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(path, [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
  assert.ok(pointToPathKm({ lat: 40.7, lng: -120.95 }, path) < 0.01);
  assert.ok(pointToPathKm({ lat: 40.7, lng: -119.95 }, path) > 50);
});

test('address search is biased to where the customer is', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /q=lulu%20mall/); assert.match(url, /lat=26\.7606&lon=80\.8893/);
    return { ok: true, json: async () => ({ features: [
      { properties: { name: 'Lulu Mall, Lucknow', street: 'Shaheed Path', city: 'Lucknow', state: 'Uttar Pradesh', countrycode: 'IN' }, geometry: { coordinates: [80.9919, 26.7877] } },
      { properties: { name: 'Lulu Mall', city: 'Dubai', countrycode: 'AE' }, geometry: { coordinates: [55.3, 25.2] } },
    ] }) };
  };
  const r = await searchPlaces('lulu mall', { key: '', osm: true, near: A, fetchImpl });
  assert.equal(r.length, 1, 'only places in India');
  assert.equal(r[0].name, 'Lulu Mall, Lucknow, Shaheed Path, Lucknow, Uttar Pradesh');
  assert.equal(r[0].state, 'UP');
  assert.deepEqual(await searchPlaces('x', { key: '', osm: true, fetchImpl: async () => ({ ok: false, status: 503 }) }), [], 'a failing service never breaks booking');
});

test('personal details with photo; "correct my data" is handled automatically by sub-category', async (t) => {
  const time = { t: Date.parse('2026-11-12T06:00:00Z') };
  const app = createApp({ dbFile: ':memory:', clock: () => time.t, maps: { getRoute: async () => ({}), searchPlaces: async () => [] } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const otp = (await call('POST', '/api/auth/request-otp', { phone: '9876512345' })).body.devCode;
  const tok = (await call('POST', '/api/auth/verify-otp', { phone: '9876512345', code: otp, name: 'Ajay Kumr', role: 'rider', acceptTerms: true })).body.token;
  const e = (await call('POST', '/api/me/email', { email: 'a@example.com' }, tok)).body.devCode;
  await call('POST', '/api/me/email/verify', { code: e }, tok);

  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  const me = (await call('PATCH', '/api/me', { dob: '1990-01-01', gender: 'male', photo: PHOTO }, tok)).body;
  assert.equal(me.photo, PHOTO);
  assert.equal((await call('PATCH', '/api/me', { photo: 'http://evil.example/x.png' }, tok)).status, 400);

  // Name: corrected at once, no waiting.
  assert.equal((await call('POST', '/api/privacy/requests', { type: 'correction' }, tok)).status, 400, 'must say what to correct');
  const r1 = (await call('POST', '/api/privacy/requests', { type: 'correction', field: 'name', value: 'Ajay Kumar' }, tok)).body;
  assert.equal(r1.status, 'completed');
  assert.match(r1.typeLabel, /my name/);
  assert.equal((await call('GET', '/api/me', null, tok)).body.name, 'Ajay Kumar');
  // The same checks apply as in the profile screen.
  assert.equal((await call('POST', '/api/privacy/requests', { type: 'correction', field: 'dob', value: '2020-01-01' }, tok)).status, 400);
  const r2 = (await call('POST', '/api/privacy/requests', { type: 'correction', field: 'trusted', value: { name: 'Meera', phone: '9000000002' } }, tok)).body;
  assert.equal(r2.status, 'completed');
  // Email needs a fresh confirmation, so the answer says where to do it.
  const r3 = (await call('POST', '/api/privacy/requests', { type: 'correction', field: 'email' }, tok)).body;
  assert.equal(r3.status, 'completed');
  assert.match(r3.response, /Profile → Email/);
  // A mobile-number change needs a person.
  assert.equal((await call('POST', '/api/privacy/requests', { type: 'correction', field: 'phone' }, tok)).status, 400, 'details needed');
  const r4 = (await call('POST', '/api/privacy/requests', { type: 'correction', field: 'phone', details: 'New number 9876500000' }, tok)).body;
  assert.equal(r4.status, 'received');
  const log = app.locals.db.prepare("SELECT details FROM audit_log WHERE action = 'dsr.completed'").all().map((a) => JSON.parse(a.details).field);
  assert.deepEqual(log, ['name', 'trusted', 'email']);
});
