'use strict';

const C = require('./config');

const round2 = (n) => Math.round(n * 100) / 100;

function experienceTier(completedTrips) {
  return C.EXPERIENCE_TIERS.find((t) => completedTrips >= t.minTrips);
}

/** Olub's fee: ₹5 up to 10 km, ₹15 beyond; half in calamity mode. */
function platformFeeFor(distanceKm, calamity) {
  const fee = distanceKm > C.PLATFORM_FEE_LONG_KM ? C.PLATFORM_FEE_LONG : C.PLATFORM_FEE;
  return calamity ? round2(fee * C.CALAMITY_FEE_FACTOR) : fee;
}

function defaultTollFor(state) {
  return C.STATE_DEFAULT_TOLL[state] ?? C.DEFAULT_TOLL;
}

/**
 * Pure fare calculation, used for both the up-front quote and the final bill.
 *
 * @param {object} p
 * @param {number} p.distanceKm      road distance
 * @param {string} p.vehicleType
 * @param {object} [p.rates]         rate card ({base, perKm, perWaitMin, minFare}); defaults to config
 * @param {string} p.condition       vehicle condition
 * @param {number} p.completedTrips  driver's completed Olub trips
 * @param {number} [p.waitMinutes]   traffic delay / waiting (live traffic for quotes, actual for bills)
 * @param {Array<{name:string,amount:number}>} [p.tolls]
 * @param {number} [p.petCharge]     driver's own pet surcharge (goes to driver)
 * @param {boolean} [p.calamity]     rain / disaster mode → reduced platform fee
 * @param {number} [p.discount]      e.g. driver-verification reward
 */
function calculateFare(p) {
  const v = p.rates || C.VEHICLES[p.vehicleType];
  if (!v) throw new Error(`Unknown vehicle type: ${p.vehicleType}`);
  const distanceKm = Math.max(0, Number(p.distanceKm) || 0);
  const conditionMul = C.CONDITION_MULTIPLIER[p.condition] ?? 1;
  const tier = experienceTier(Math.max(0, p.completedTrips || 0));
  const waitMinutes = Math.max(0, Number(p.waitMinutes) || 0);
  const billableWait = Math.max(0, waitMinutes - C.FREE_WAIT_MINUTES);

  const adjusted = (v.base + distanceKm * v.perKm) * conditionMul * tier.multiplier;
  const rideFare = Math.round(Math.max(v.minFare, adjusted));
  const waitCharge = Math.round(billableWait * v.perWaitMin);
  const petCharge = Math.max(0, Math.round(Number(p.petCharge) || 0));
  const tolls = (p.tolls || []).map((t) => ({ ...t, amount: round2(t.amount) }));
  const tollTotal = round2(tolls.reduce((s, t) => s + t.amount, 0));

  const driverFare = rideFare + waitCharge + petCharge + tollTotal;
  const platformFee = platformFeeFor(distanceKm, p.calamity);
  // GST: the platform fee is GST-inclusive; ride GST is charged on top of the ride (not on tolls).
  const gstRate = p.gstRate ?? C.RIDE_GST_RATE;
  const rideGst = Math.round((rideFare + waitCharge + petCharge) * gstRate); // rounded to the rupee
  const platformFeeGst = round2(platformFee - platformFee / (1 + C.PLATFORM_FEE_GST_RATE));
  const discount = Math.max(0, p.discount || 0);
  // Unpaid cancellation fee from an earlier booking, collected with this ride.
  const dues = Math.max(0, round2(p.dues || 0));
  const riderPays = round2(Math.max(0, driverFare + rideGst + platformFee + dues - discount));

  return {
    vehicleType: p.vehicleType,
    distanceKm: round2(distanceKm),
    breakdown: {
      base: v.base,
      perKm: v.perKm,
      distanceCharge: round2(distanceKm * v.perKm),
      conditionMultiplier: conditionMul,
      experienceMultiplier: tier.multiplier,
      experienceLabel: tier.label,
      minFareApplied: adjusted < v.minFare,
      rideFare,
      waitMinutes: Math.round(waitMinutes),
      waitCharge,
      petCharge,
      tolls,
      tollTotal,
    },
    driverFare,            // 100% to the driver (ride + wait + pet + tolls)
    platformFee,           // Olub's only cut (GST inclusive)
    taxes: {
      rideGstRate: gstRate, rideGst,
      platformFeeGstRate: C.PLATFORM_FEE_GST_RATE, platformFeeGst, platformFeeBase: round2(platformFee - platformFeeGst),
      totalGst: round2(rideGst + platformFeeGst),
    },
    // Taken from the driver's wallet when the trip ends (the rider pays the driver directly).
    dues,
    walletDeduction: round2(platformFee + rideGst + dues),
    calamity: !!p.calamity,
    discount,
    riderPays,
    // Positive: driver owes Olub. Negative: Olub owes driver.
    platformNet: round2(platformFee - discount),
  };
}

module.exports = { calculateFare, experienceTier, defaultTollFor, platformFeeFor };
