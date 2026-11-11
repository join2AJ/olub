'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateFare, defaultTollFor } = require('../src/fare');

const base = { distanceKm: 10, vehicleType: 'sedan', condition: 'good', completedTrips: 20 };

test('platform fee is ₹5 and everything else goes to the driver', () => {
  const f = calculateFare(base);
  assert.equal(f.platformFee, 5);
  assert.equal(f.driverFare, 60 + 10 * 16); // base + perKm
  assert.equal(f.riderPays, f.driverFare + 5);
  assert.equal(f.platformNet, 5);
});

test('calamity mode drops platform fee to ₹2.5', () => {
  const f = calculateFare({ ...base, calamity: true });
  assert.equal(f.platformFee, 2.5);
  assert.equal(f.riderPays, f.driverFare + 2.5);
});

test('verification discount: fare + ₹5 − ₹10', () => {
  const f = calculateFare({ ...base, discount: 10 });
  assert.equal(f.riderPays, f.driverFare + 5 - 10);
  assert.equal(f.platformNet, -5); // Olub funds the reward
});

test('vehicle condition, road and experience adjust the fare', () => {
  const good = calculateFare(base).driverFare;
  assert.ok(calculateFare({ ...base, condition: 'excellent' }).driverFare > good);
  assert.ok(calculateFare({ ...base, condition: 'poor' }).driverFare < good);
  assert.ok(calculateFare({ ...base, road: 'poor' }).driverFare > good);
  assert.ok(calculateFare({ ...base, completedTrips: 0 }).driverFare < good);
  assert.ok(calculateFare({ ...base, completedTrips: 500 }).driverFare > good);
});

test('waiting time is charged after free minutes', () => {
  const f = calculateFare({ ...base, waitMinutes: 13 });
  assert.equal(f.breakdown.waitCharge, 10 * 2);
  const est = calculateFare({ ...base, traffic: 'moderate' });
  assert.equal(est.breakdown.waitMinutes, 5);
  assert.equal(est.breakdown.waitCharge, 4);
});

test('tolls are added in full to the driver fare', () => {
  const f = calculateFare({ ...base, tolls: [{ name: 'A', amount: 70 }, { name: 'B', amount: 45 }] });
  assert.equal(f.breakdown.tollTotal, 115);
  assert.equal(f.driverFare, 220 + 115);
});

test('minimum fare applies on short trips', () => {
  const f = calculateFare({ ...base, distanceKm: 0.5 });
  assert.equal(f.driverFare, 100);
  assert.equal(f.breakdown.minFareApplied, true);
});

test('state default tolls fall back to ₹70', () => {
  assert.equal(defaultTollFor('MH'), 80);
  assert.equal(defaultTollFor('ZZ'), 70);
});
