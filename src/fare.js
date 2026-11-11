'use strict';

const C = require('./config');

const round2 = (n) => Math.round(n * 100) / 100;

function experienceTier(completedTrips) {
  return C.EXPERIENCE_TIERS.find((t) => completedTrips >= t.minTrips);
}

function defaultTollFor(state) {
  return C.STATE_DEFAULT_TOLL[state] ?? C.DEFAULT_TOLL;
}

/**
 * Pure fare calculation. Same function is used for the up-front quote and the
 * final bill (with actual wait minutes and tolls).
 *
 * @param {object} p
 * @param {number} p.distanceKm      road distance
 * @param {string} p.vehicleType     key of C.VEHICLES
 * @param {string} p.condition       key of C.CONDITION_MULTIPLIER
 * @param {number} p.completedTrips  driver's completed Olub trips
 * @param {string} [p.road]          key of C.ROAD_MULTIPLIER
 * @param {string} [p.traffic]       key of C.TRAFFIC_WAIT_PER_KM (quote only)
 * @param {number} [p.waitMinutes]   actual wait; overrides traffic estimate
 * @param {Array<{name:string,amount:number}>} [p.tolls]
 * @param {boolean} [p.calamity]     rain / disaster mode → reduced platform fee
 * @param {number} [p.discount]      e.g. driver-verification reward
 */
function calculateFare(p) {
  const v = C.VEHICLES[p.vehicleType];
  if (!v) throw new Error(`Unknown vehicle type: ${p.vehicleType}`);
  const distanceKm = Math.max(0, Number(p.distanceKm) || 0);
  const conditionMul = C.CONDITION_MULTIPLIER[p.condition] ?? 1;
  const roadMul = C.ROAD_MULTIPLIER[p.road || 'good'] ?? 1;
  const tier = experienceTier(Math.max(0, p.completedTrips || 0));

  const waitMinutes = p.waitMinutes != null
    ? Math.max(0, Number(p.waitMinutes) || 0)
    : distanceKm * (C.TRAFFIC_WAIT_PER_KM[p.traffic || 'light'] ?? 0);
  const billableWait = Math.max(0, waitMinutes - C.FREE_WAIT_MINUTES);

  const distanceFare = v.base + distanceKm * v.perKm;
  const adjusted = distanceFare * conditionMul * roadMul * tier.multiplier;
  const rideFare = Math.round(Math.max(v.minFare, adjusted));
  const waitCharge = Math.round(billableWait * v.perWaitMin);
  const tolls = (p.tolls || []).map((t) => ({ ...t, amount: round2(t.amount) }));
  const tollTotal = tolls.reduce((s, t) => s + t.amount, 0);

  const driverFare = rideFare + waitCharge + round2(tollTotal);
  const platformFee = p.calamity ? C.PLATFORM_FEE_CALAMITY : C.PLATFORM_FEE;
  const discount = Math.max(0, p.discount || 0);
  const riderPays = round2(Math.max(0, driverFare + platformFee - discount));

  return {
    vehicleType: p.vehicleType,
    distanceKm: round2(distanceKm),
    breakdown: {
      base: v.base,
      distanceCharge: round2(distanceKm * v.perKm),
      conditionMultiplier: conditionMul,
      roadMultiplier: roadMul,
      experienceMultiplier: tier.multiplier,
      experienceLabel: tier.label,
      minFareApplied: adjusted < v.minFare,
      rideFare,
      waitMinutes: Math.round(waitMinutes),
      waitCharge,
      tolls,
      tollTotal: round2(tollTotal),
    },
    driverFare,            // 100% to the driver (ride + wait + tolls)
    platformFee,           // Olub's only cut
    calamity: !!p.calamity,
    discount,
    riderPays,
    // Positive: driver owes Olub this (rider paid driver directly).
    // Negative: Olub owes driver (e.g. verification discount > fee).
    platformNet: round2(platformFee - discount),
  };
}

module.exports = { calculateFare, experienceTier, defaultTollFor };
