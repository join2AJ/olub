'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

test('demo sign-in, analytics for a chosen period, driver time, IP location, recent places', async (t) => {
  const time = { t: Date.parse('2026-11-13T06:00:00Z') };
  const maps = { getRoute: async () => ({ distanceKm: 8, freeFlowMin: 16, delayMin: 0, etaMin: 16, source: 'test', trafficLabel: 'Light', polyline: null }), searchPlaces: async () => [] };
  const app = createApp({ dbFile: ':memory:', clock: () => time.t, maps });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const demo = async (role) => (await call('POST', '/api/auth/demo', { role })).body;

  // One tap loads the demo data and signs in; each role lands on the right kind of account.
  const p = await demo('rider');
  assert.equal(p.user.name, 'Priya Sharma');
  assert.equal(p.user.todo.length, 0, 'the demo passenger can book straight away');
  assert.equal((await demo('admin')).user.role, 'admin');
  const d = await demo('driver');
  assert.equal(d.user.role, 'driver');
  assert.equal(d.user.name, 'Imran Khan', 'the driver button opens the driver who has a request waiting');

  // Analytics: everything, then only this month. Grouped by month, date, weekday and hour.
  const all = (await call('GET', '/api/insights', null, p.token)).body;
  assert.equal(all.sel.trips, 3);
  assert.equal(all.sel.riderPaid, all.all.riderPaid);
  assert.equal(all.groups.weekday.length, 7);
  assert.equal(all.groups.hour.length, 24);
  assert.equal(all.groups.month.reduce((s, g) => s + g.trips, 0), 3);
  assert.equal(all.cancelled, 1);
  const nov = (await call('GET', '/api/insights?from=2026-11-01&to=2026-11-30', null, p.token)).body;
  const oct = (await call('GET', '/api/insights?from=2026-10-01&to=2026-10-31', null, p.token)).body;
  assert.equal(nov.sel.trips + oct.sel.trips, 3, 'every trip falls in exactly one month');
  assert.equal(Math.round((nov.sel.riderPaid + oct.sel.riderPaid) * 100), Math.round(all.all.riderPaid * 100));
  assert.equal(nov.all.riderPaid, all.all.riderPaid, 'the overall figure does not change with the period');
  assert.ok(oct.groups.date.every((g) => g.key.startsWith('2026-10')));

  // Driver: time on the road is split into online, with a passenger, going to pickups and waiting.
  const ramesh = (await call('POST', '/api/auth/request-otp', { phone: '9000000101' })).body;
  const rt = (await call('POST', '/api/auth/verify-otp', { phone: '9000000101', code: ramesh.devCode })).body.token;
  const h = (await call('GET', '/api/insights', null, rt)).body.hours;
  assert.ok(h.withPassengerMin > 0 && h.toPickupMin > 0);
  assert.ok(h.onlineMin >= h.withPassengerMin + h.toPickupMin);
  assert.equal(h.waitingForCustomersMin, h.onlineMin - h.withPassengerMin - h.toPickupMin);
  assert.match(h.limitNote, /12-hour/);

  // The map opens on the default city when the address cannot be located (here: a local address).
  const w = (await call('GET', '/api/where', null, p.token)).body;
  assert.deepEqual([w.name, w.source], ['New Delhi', 'default']);
  assert.ok(app.locals.db.prepare("SELECT last_ip FROM users WHERE phone = '9000000201'").get().last_ip, 'the sign-in address is recorded');

  // Recent destinations for one-tap rebooking.
  const recent = (await call('GET', '/api/places/recent', null, p.token)).body;
  assert.ok(recent.length >= 2 && recent[0].digipin);
  assert.equal(new Set(recent.map((x) => x.name)).size, recent.length, 'no repeats');
});
