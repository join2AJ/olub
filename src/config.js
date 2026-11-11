'use strict';

// Business rules for Olub. Every rupee amount lives here so it can be tuned
// without touching the logic.
module.exports = {
  // Olub keeps only this per trip; everything else goes to the driver.
  PLATFORM_FEE: 5,
  // During rain / natural calamity (toggled per state by admin).
  PLATFORM_FEE_CALAMITY: 2.5,

  // Monthly driver subscription. Off for launch; flip OLUB_SUBSCRIPTION=1 later.
  SUBSCRIPTION_ENABLED: process.env.OLUB_SUBSCRIPTION === '1',
  SUBSCRIPTION_MONTHLY: 100,

  // Rider who verifies a new driver's documents in person gets this off the trip.
  VERIFY_DISCOUNT: 10,

  // A toll reported by one driver becomes "verified" once this many *other*
  // drivers confirm it.
  TOLL_CONFIRMATIONS_REQUIRED: 5,
  // A toll counts as "on the route" if within this many km of the src→dst line.
  TOLL_ROUTE_CORRIDOR_KM: 1.5,
  // Unverified / unknown tolls use a per-state default (placeholder values —
  // tune with real data before launch).
  DEFAULT_TOLL: 70,
  STATE_DEFAULT_TOLL: {
    DL: 70, HR: 75, UP: 65, MH: 80, KA: 75, TN: 70, TS: 70, AP: 70,
    GJ: 70, RJ: 65, MP: 65, WB: 60, KL: 70, PB: 70,
  },

  // Straight-line distance × this ≈ road distance (no maps API in the MVP).
  // Two/three-wheelers are exempt at most Indian toll plazas.
  TOLL_EXEMPT_VEHICLES: ['bike', 'auto'],
  // Reports within this distance of an existing toll are treated as the same plaza.
  TOLL_MERGE_RADIUS_KM: 0.3,

  ROAD_FACTOR: 1.3,

  VEHICLES: {
    bike:      { label: 'Bike',      base: 20, perKm: 7,  perWaitMin: 0.5, minFare: 25 },
    auto:      { label: 'Auto',      base: 30, perKm: 12, perWaitMin: 1,   minFare: 30 },
    hatchback: { label: 'Hatchback', base: 50, perKm: 14, perWaitMin: 1.5, minFare: 80 },
    sedan:     { label: 'Sedan',     base: 60, perKm: 16, perWaitMin: 2,   minFare: 100 },
    suv:       { label: 'SUV',       base: 80, perKm: 20, perWaitMin: 2.5, minFare: 150 },
  },
  // Better-kept vehicles earn a little more.
  CONDITION_MULTIPLIER: { excellent: 1.1, good: 1.0, average: 0.92, poor: 0.85 },
  ROAD_MULTIPLIER: { good: 1.0, average: 1.05, poor: 1.12 },
  // Estimated waiting minutes per km, used for the up-front quote.
  TRAFFIC_WAIT_PER_KM: { light: 0, moderate: 0.5, heavy: 1.2 },
  FREE_WAIT_MINUTES: 3,
  // Driver experience = completed Olub trips.
  EXPERIENCE_TIERS: [
    { minTrips: 200, multiplier: 1.05, label: 'Veteran' },
    { minTrips: 50,  multiplier: 1.03, label: 'Experienced' },
    { minTrips: 10,  multiplier: 1.0,  label: 'Regular' },
    { minTrips: 0,   multiplier: 0.95, label: 'New on Olub' },
  ],

  TRIP_OTP_MAX_ATTEMPTS: 5,
  LOGIN_OTP_TTL_MS: 5 * 60 * 1000,
  // Dev only: return the login OTP in the API response instead of sending SMS.
  DEV_OTP: process.env.OLUB_DEV_OTP !== '0',
  ADMIN_PHONES: (process.env.OLUB_ADMIN_PHONES || '9999999999').split(',').map((s) => s.trim()),
};
