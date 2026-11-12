'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateFare, defaultTollFor } = require('../src/fare');
const { getRoute, fallbackRoute } = require('../src/maps');

const base = { distanceKm: 10, vehicleType: 'sedan', condition: 'good', completedTrips: 20 };

test('platform fee is ₹5 and everything else goes to the driver', () => {
  const f = calculateFare(base);
  assert.equal(f.platformFee, 5);
  assert.equal(f.driverFare, 60 + 10 * 16);
  assert.equal(f.taxes.rideGst, 11, '5% GST on the ride');
  assert.equal(f.riderPays, f.driverFare + 11 + 5);
  assert.equal(f.taxes.platformFeeGst, 0.76, 'the ₹5 fee already includes 18% GST');
  assert.equal(f.walletDeduction, 16, 'fee + ride GST come out of the driver wallet');
  assert.equal(calculateFare({ ...base, gstRate: 0 }).riderPays, f.driverFare + 5);
});

test('calamity mode drops platform fee to ₹2.5', () => {
  assert.equal(calculateFare({ ...base, calamity: true }).platformFee, 2.5);
});

test('verification discount: fare + ₹5 − ₹10, funded by Olub', () => {
  const f = calculateFare({ ...base, discount: 10 });
  assert.equal(f.riderPays, f.driverFare + f.taxes.rideGst + 5 - 10);
  assert.equal(f.platformNet, -5);
});

test('vehicle condition and experience adjust the fare; road condition is not a factor', () => {
  const good = calculateFare(base).driverFare;
  assert.ok(calculateFare({ ...base, condition: 'excellent' }).driverFare > good);
  assert.ok(calculateFare({ ...base, condition: 'poor' }).driverFare < good);
  assert.ok(calculateFare({ ...base, completedTrips: 0 }).driverFare < good);
  assert.equal(calculateFare({ ...base, road: 'poor' }).driverFare, good);
});

test('traffic waiting is charged after the free minutes', () => {
  assert.equal(calculateFare({ ...base, waitMinutes: 13 }).breakdown.waitCharge, 20);
  assert.equal(calculateFare({ ...base, waitMinutes: 2 }).breakdown.waitCharge, 0);
});

test('tolls and pet charge go fully to the driver', () => {
  const f = calculateFare({ ...base, tolls: [{ name: 'A', amount: 70 }], petCharge: 50 });
  assert.equal(f.driverFare, 220 + 70 + 50);
  assert.equal(f.taxes.rideGst, 14, 'GST applies to ride + pet charge, not to tolls');
  assert.equal(f.breakdown.petCharge, 50);
});

test('admin rate card overrides the default per-km price', () => {
  const f = calculateFare({ ...base, rates: { base: 40, perKm: 10, perWaitMin: 1, minFare: 50 } });
  assert.equal(f.driverFare, 140);
});

test('minimum fare and state default tolls', () => {
  assert.equal(calculateFare({ ...base, distanceKm: 0.5 }).driverFare, 100);
  assert.equal(defaultTollFor('MH'), 80);
  assert.equal(defaultTollFor('ZZ'), 70);
});

test('live traffic: Google Routes response becomes distance + delay', async () => {
  const fetchImpl = async (url, opts) => {
    assert.match(url, /routes\.googleapis\.com/);
    assert.equal(JSON.parse(opts.body).routingPreference, 'TRAFFIC_AWARE');
    return { ok: true, json: async () => ({ routes: [{ distanceMeters: 12000, duration: '1800s', staticDuration: '1200s' }] }) };
  };
  const r = await getRoute({ lat: 12.9, lng: 77.6 }, { lat: 13, lng: 77.7 }, { key: 'k', fetchImpl });
  assert.equal(r.distanceKm, 12);
  assert.equal(r.delayMin, 10);
  assert.equal(r.source, 'google-live-traffic');
});

test('traffic falls back to a time-of-day estimate when Google is unavailable', async () => {
  const failing = async () => ({ ok: false, status: 500 });
  const peak = new Date('2026-11-12T13:00:00Z'); // 18:30 IST
  const r = await getRoute({ lat: 12.9, lng: 77.6 }, { lat: 13, lng: 77.7 }, { key: 'k', fetchImpl: failing, when: peak });
  assert.equal(r.source, 'estimate');
  assert.ok(r.delayMin > 0);
  const night = fallbackRoute({ lat: 12.9, lng: 77.6 }, { lat: 13, lng: 77.7 }, new Date('2026-11-12T21:00:00Z')); // 02:30 IST
  assert.equal(night.delayMin, 0);
});

test('Olub fee: ₹5 up to 10 km (even 0.01 km), ₹15 beyond; half in calamity mode', () => {
  const fee = (km, calamity) => calculateFare({ ...base, distanceKm: km, calamity }).platformFee;
  assert.deepEqual([fee(0.01), fee(10), fee(10.1), fee(40)], [5, 5, 15, 15]);
  assert.deepEqual([fee(3, true), fee(25, true)], [2.5, 7.5]);
});
