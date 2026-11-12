'use strict';

// Business rules for Olub. Every number lives here so it can be tuned
// without touching the logic. Rates can also be edited live by an admin.
const DAY = 24 * 3600 * 1000;

module.exports = {
  DAY,
  // ---------- money ----------
  PLATFORM_FEE: 5,               // Olub keeps only this per trip
  PLATFORM_FEE_CALAMITY: 2.5,    // rain / natural calamity (admin toggles per state)
  SUBSCRIPTION_ENABLED: process.env.OLUB_SUBSCRIPTION === '1',
  SUBSCRIPTION_MONTHLY: 100,
  VERIFY_DISCOUNT: 10,           // rider who verifies a new driver in person

  // ---------- GST (confirm rates and treatment with your CA) ----------
  // The ₹5 platform fee already includes 18% GST (₹4.24 + ₹0.76).
  PLATFORM_FEE_GST_RATE: 0.18,
  // GST on the ride itself (5% on app-booked passenger transport, CGST Act s.9(5)).
  // Collected from the rider, taken from the driver's wallet, and remitted by Olub.
  // Set OLUB_RIDE_GST=0 if your tax advisor confirms it does not apply to Olub.
  RIDE_GST_RATE: process.env.OLUB_RIDE_GST === '0' ? 0 : 0.05,
  SAC_RIDE: '996412', SAC_PLATFORM: '998599',
  COMPANY: {
    name: process.env.OLUB_LEGAL_NAME || 'Olub (legal entity name pending)',
    gstin: process.env.OLUB_GSTIN || 'GSTIN pending',
    address: process.env.OLUB_ADDRESS || 'Registered address pending',
    grievanceOfficer: process.env.OLUB_GRIEVANCE || 'Grievance Officer — grievance@olub.example',
  },

  // ---------- driver wallet ----------
  // Olub's fee (and GST) is taken from this wallet when a trip ends.
  WALLET_MIN_BALANCE: 100,       // below this the driver cannot receive customers
  WALLET_MAX_TOPUP: 5000,

  // ---------- driver duty hours (Motor Vehicle Aggregator Guidelines) ----------
  DUTY_MAX_HOURS: 12,            // per duty day, online + on-trip time
  DUTY_REST_HOURS: 10,           // mandatory continuous rest after reaching the limit
  COMMISSION_CAP: 0.20,          // drivers must keep at least 80% of the fare
  CANCELLATION_FEE_CAP: { percent: 0.10, max: 100 },

  // ---------- requests from police / RTO / courts ----------
  LEA_EMAIL_DOMAINS: /[.@](gov\.in|nic\.in)$/i,   // only official government mailboxes
  LEA_AUTO_REPLY_DAYS: Number(process.env.OLUB_LEA_AUTO_DAYS ?? 3),
  LEA_PUBLIC_SLA_DAYS: 10,
  LEA_AGENCIES: { police: 'Police', rto: 'RTO / Transport Department', court: 'Court', other: 'Other government body' },

  // ---------- trip safety (ideas carried over from the Drive app) ----------
  OVERSPEED_KMPH: 80,
  HARSH_BRAKE_MS2: 3.5,
  // Off-route = further than this from the pickup→drop line for longer than the grace time.
  ROUTE_CORRIDOR_KM: 2, ROUTE_CORRIDOR_SHARE: 0.35, ROUTE_GRACE_MIN: 3,

  // Default rate card (₹). Benchmarked to typical Indian app-cab pricing;
  // admin can change any value from the app (Admin → Rates).
  VEHICLES: {
    bike:      { label: 'Bike',      base: 25, perKm: 8,  perWaitMin: 1,   minFare: 30 },
    auto:      { label: 'Auto',      base: 30, perKm: 15, perWaitMin: 1.5, minFare: 40 },
    hatchback: { label: 'Hatchback', base: 50, perKm: 13, perWaitMin: 1.5, minFare: 80 },
    sedan:     { label: 'Sedan',     base: 60, perKm: 16, perWaitMin: 2,   minFare: 100 },
    suv:       { label: 'SUV',       base: 80, perKm: 20, perWaitMin: 2.5, minFare: 150 },
  },
  CONDITION_MULTIPLIER: { excellent: 1.1, good: 1.0, average: 0.92, poor: 0.85 },
  FREE_WAIT_MINUTES: 3,
  // Experience on Olub = completed trips.
  EXPERIENCE_TIERS: [
    { minTrips: 200, multiplier: 1.05, label: 'Veteran' },
    { minTrips: 50,  multiplier: 1.03, label: 'Experienced' },
    { minTrips: 10,  multiplier: 1.0,  label: 'Regular' },
    { minTrips: 0,   multiplier: 0.95, label: 'New on Olub' },
  ],
  MAX_PET_CHARGE: 300,

  // ---------- traffic / routing ----------
  // With a key, distance + live-traffic delay come from Google Routes API.
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || '',
  // Fallback when no key: straight line × factor, and time-of-day traffic.
  ROAD_FACTOR: 1.3,
  FREE_FLOW_KMPH: 28,
  FALLBACK_DELAY_MIN_PER_KM: { peak: 1.0, shoulder: 0.4, off: 0 },

  // ---------- tolls ----------
  TOLL_CONFIRMATIONS_REQUIRED: 5,
  TOLL_ROUTE_CORRIDOR_KM: 1.5,
  DEFAULT_TOLL: 70,
  STATE_DEFAULT_TOLL: {
    DL: 70, HR: 75, UP: 65, MH: 80, KA: 75, TN: 70, TS: 70, AP: 70,
    GJ: 70, RJ: 65, MP: 65, WB: 60, KL: 70, PB: 70,
  },
  TOLL_EXEMPT_VEHICLES: ['bike', 'auto'],
  TOLL_MERGE_RADIUS_KM: 0.3,

  // ---------- safety ----------
  // Trusted contact is warned when the ride runs this late; escalates at ALERT.
  OVERDUE_WARN_MIN: 5,
  OVERDUE_ALERT_MIN: 10,
  MIN_AGE: 18,
  // Rules a driver can set for their cab (shown to riders before booking).
  DRIVER_RULES: {
    noSmoking: 'No smoking',
    noAlcohol: 'No alcohol',
    noTobacco: 'No tobacco / gutka',
    noFood: 'No eating in the cab',
  },

  // ---------- ratings ----------
  RATING_CRITERIA: {
    driver: { // rider rates driver
      safety: 'Safe driving',
      behaviour: 'Polite & respectful',
      cleanliness: 'Clean vehicle',
      punctuality: 'On time',
      honesty: 'Fair route & fare',
    },
    rider: { // driver rates rider
      behaviour: 'Polite & respectful',
      punctuality: 'Ready at pickup',
      rules: 'Followed cab rules',
      care: 'Took care of the vehicle',
      payment: 'Paid promptly',
    },
  },
  // Monthly comments are only shown once this many exist, so nobody can
  // work out who wrote what.
  FEEDBACK_MIN_FOR_ANON: 3,

  // ---------- privacy (DPDP / GDPR) ----------
  DSR_AUTO_PROCESS_AFTER_DAYS: Number(process.env.OLUB_DSR_AUTO_DAYS ?? 5),
  DSR_INTERNAL_SLA_DAYS: 7,
  DSR_PUBLIC_SLA_DAYS: 12,       // what the website promises ("10–12 days")
  DSR_TYPES: {
    access: 'Send me a copy of my data',
    correction: 'Correct my data',
    erasure: 'Delete my account and data',
    withdraw_consent: 'Withdraw my consent',
    grievance: 'Raise a privacy complaint',
  },

  // ---------- security ----------
  SESSION_TTL_MS: 30 * DAY,
  TRIP_OTP_MAX_ATTEMPTS: 5,
  LOGIN_OTP_TTL_MS: 5 * 60 * 1000,
  AUTH_RATE_LIMIT: { windowMs: 10 * 60 * 1000, max: 30 },
  DEV_OTP: process.env.OLUB_DEV_OTP !== '0',
  ADMIN_PHONES: (process.env.OLUB_ADMIN_PHONES || '9999999999').split(',').map((s) => s.trim()),
  // 32-byte key (hex) for encrypting KYC documents at rest.
  DATA_KEY: process.env.OLUB_DATA_KEY || '',
  ALLOWED_ORIGINS: (process.env.OLUB_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()),
};
