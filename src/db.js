'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,               -- OLB-C-xxxxxx (customer) / OLB-D- (driver) / OLB-A- (admin)
  phone TEXT UNIQUE NOT NULL,
  phone_verified_at INTEGER,
  email TEXT,
  email_verified_at INTEGER,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'rider',           -- rider | driver | admin
  dob TEXT,                                     -- YYYY-MM-DD
  gender TEXT,                                  -- male | female | other
  trusted_name TEXT, trusted_phone TEXT, trusted_relation TEXT,
  status TEXT NOT NULL DEFAULT 'active',        -- active | erased
  cancel_dues REAL NOT NULL DEFAULT 0,
  photo TEXT,                                   -- small profile photo (data URL)          -- unpaid cancellation fees, added to the next ride
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monthly_charges (
  id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL,   -- YYYY-MM
  earned REAL NOT NULL, trip_fees REAL NOT NULL, amount REAL NOT NULL, charged_at INTEGER NOT NULL,
  UNIQUE (driver_id, month)
);
CREATE TABLE IF NOT EXISTS login_otps (
  phone TEXT PRIMARY KEY, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS email_otps (
  user_id INTEGER PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                  -- only a hash of the token is stored
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  doc TEXT NOT NULL, version TEXT NOT NULL, accepted_at INTEGER NOT NULL, ip TEXT, withdrawn_at INTEGER
);
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,               -- OLB-G-xxxxxx
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, phone TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  vehicle_number TEXT UNIQUE,
  vehicle_type TEXT, vehicle_model TEXT, vehicle_condition TEXT,
  state TEXT,
  license_no TEXT, license_issued_on TEXT,      -- driving experience is counted from this date
  rc_no TEXT, kyc_id_no TEXT,
  insurance_valid_till TEXT,
  docs TEXT,                                    -- encrypted JSON {license, rc, kyc, vehicle, selfie}
  prefs TEXT,                                   -- JSON {noSmoking, noAlcohol, …, petsOk, petCharge}
  status TEXT NOT NULL DEFAULT 'incomplete',    -- incomplete | submitted | verified | rejected
  verified_via TEXT, verified_by INTEGER,
  online INTEGER NOT NULL DEFAULT 0,
  completed_trips INTEGER NOT NULL DEFAULT 0,
  subscription_until INTEGER,
  permit_no TEXT,                               -- commercial permit / badge number
  wallet_balance REAL NOT NULL DEFAULT 0,
  last_lat REAL, last_lng REAL, last_loc_at INTEGER,   -- where the cab is waiting (shown roughly on the customer's map)
  suspended_reason TEXT
);
CREATE TABLE IF NOT EXISTS wallet_txns (
  id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id), ts INTEGER NOT NULL,
  type TEXT NOT NULL,                           -- topup | platform_fee | ride_gst | verify_reward | adjustment
  amount REAL NOT NULL,                         -- + credit, − debit
  balance_after REAL NOT NULL, trip_id INTEGER, note TEXT
);
-- Time a driver spends online / on trips, for the 12-hour duty limit.
CREATE TABLE IF NOT EXISTS duty_sessions (
  id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL, ended_at INTEGER, declared_other_min INTEGER NOT NULL DEFAULT 0, end_reason TEXT
);
CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id), ts INTEGER NOT NULL,
  type TEXT NOT NULL,                           -- sos | route_deviation | overspeed | harsh_brake | running_late | overdue
  by_user INTEGER, lat REAL, lng REAL, details TEXT
);
-- Data requests and vehicle flags from police / RTO / courts.
CREATE TABLE IF NOT EXISTS lea_requests (
  id INTEGER PRIMARY KEY, public_id TEXT UNIQUE NOT NULL,   -- LEA-xxxxxx
  kind TEXT NOT NULL,                           -- data | flag
  agency TEXT NOT NULL, officer_name TEXT NOT NULL, designation TEXT, office TEXT,
  email TEXT NOT NULL, email_code TEXT, email_verified_at INTEGER,
  case_ref TEXT NOT NULL, legal_basis TEXT, details TEXT,
  vehicle_number TEXT, driver_public_id TEXT, trip_id INTEGER, from_ts INTEGER, to_ts INTEGER,
  proof TEXT,                                   -- encrypted authorisation letter
  status TEXT NOT NULL DEFAULT 'email_pending', -- email_pending | under_review | released | rejected
  access_key_hash TEXT,
  created_at INTEGER NOT NULL, auto_release_at INTEGER, public_due_at INTEGER,
  resolved_at INTEGER, handled_by TEXT, response TEXT, package TEXT
);
CREATE TABLE IF NOT EXISTS vehicle_flags (
  id INTEGER PRIMARY KEY, vehicle_number TEXT NOT NULL, reason TEXT NOT NULL, lea_request_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',        -- active | cleared
  created_at INTEGER NOT NULL, cleared_at INTEGER, cleared_by INTEGER
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER NOT NULL REFERENCES users(id),
  guest_id INTEGER REFERENCES guests(id),
  src_name TEXT, src_lat REAL, src_lng REAL,
  dst_name TEXT, dst_lat REAL, dst_lng REAL,
  state TEXT,
  distance_km REAL,
  eta_min REAL, free_flow_min REAL, traffic_source TEXT, traffic_label TEXT,
  pet INTEGER NOT NULL DEFAULT 0,
  quote TEXT, final TEXT,
  status TEXT NOT NULL,                         -- requested | accepted | started | completed | rejected | cancelled
  otp TEXT, otp_attempts INTEGER NOT NULL DEFAULT 0,
  fit_declared_at INTEGER,                      -- driver's "healthy and fit" declaration
  wait_minutes REAL,
  verify_discount INTEGER NOT NULL DEFAULT 0,
  track_token TEXT UNIQUE,
  expected_end_at INTEGER,
  overdue_level INTEGER NOT NULL DEFAULT 0,     -- 0 ok | 1 warned | 2 alerted
  safe_confirmed_at INTEGER,
  last_lat REAL, last_lng REAL, last_loc_at INTEGER,
  payment_method TEXT, paid_at INTEGER,
  pay_timing TEXT NOT NULL DEFAULT 'end',       -- start | end
  prepaid_amount REAL, prepaid_method TEXT, prepaid_at INTEGER,
  invoice_no TEXT,
  safety TEXT,                                  -- JSON {score, overspeed, harshBrakes, maxKmph}
  off_route_since INTEGER, off_route_alerted INTEGER NOT NULL DEFAULT 0,
  sos_at INTEGER,
  route_poly TEXT,                              -- road path (encoded polyline)
  match_mode INTEGER NOT NULL DEFAULT 0,        -- 1 = Olub found the cab (nearest first)
  tried TEXT, pickup_km REAL NOT NULL DEFAULT 0, offered_at INTEGER,
  pickup_dist_start REAL, pickup_dist_last REAL,   -- driver's distance to the pickup: at accept / latest
  cancel_by TEXT, cancel_reason TEXT, cancel_fee REAL, cancel_charged TEXT,   -- who cancelled, why, fee, who paid
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, started_at INTEGER, completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS trip_points (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id), lat REAL NOT NULL, lng REAL NOT NULL, ts INTEGER NOT NULL, kmph REAL
);
CREATE TABLE IF NOT EXISTS trip_tolls (
  trip_id INTEGER NOT NULL REFERENCES trips(id), toll_id INTEGER NOT NULL REFERENCES tolls(id), PRIMARY KEY (trip_id, toll_id)
);
CREATE TABLE IF NOT EXISTS tolls (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', verified_amount REAL, created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS toll_reports (
  id INTEGER PRIMARY KEY, toll_id INTEGER NOT NULL REFERENCES tolls(id), driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_type TEXT, amount REAL NOT NULL, photo TEXT, created_at INTEGER NOT NULL, UNIQUE (toll_id, driver_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL REFERENCES trips(id), sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  to_role TEXT NOT NULL,                        -- driver | rider
  scores TEXT NOT NULL,                         -- JSON {criterion: 1..5}
  overall REAL NOT NULL,
  good TEXT, bad TEXT, improve TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (trip_id, from_id)
);
CREATE TABLE IF NOT EXISTS calamity (state TEXT PRIMARY KEY, reason TEXT, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id INTEGER, actor_role TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  ip TEXT, ua TEXT, details TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log(actor_id, id);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity, entity_id);
CREATE TABLE IF NOT EXISTS dsr_requests (
  id INTEGER PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,               -- DSR-xxxxxx
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, details TEXT,
  status TEXT NOT NULL DEFAULT 'received',      -- received | completed | rejected | withdrawn
  created_at INTEGER NOT NULL,
  process_after INTEGER NOT NULL, internal_due_at INTEGER NOT NULL, public_due_at INTEGER NOT NULL,
  completed_at INTEGER, handled_by TEXT, response TEXT, export TEXT, field TEXT
);
-- Every SMS / email Olub should send. A gateway worker delivers these in production.
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, channel TEXT NOT NULL, to_addr TEXT NOT NULL,
  template TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', trip_id INTEGER, user_id INTEGER
);
`;

// Demo places so the app works without a maps key (riders can also drop a pin).
const SEED_PLACES = [
  ['MG Road Metro, Bengaluru', 'KA', 12.9756, 77.6066],
  ['Electronic City Phase 1, Bengaluru', 'KA', 12.8452, 77.6602],
  ['Whitefield, Bengaluru', 'KA', 12.9698, 77.7500],
  ['Kempegowda Airport, Bengaluru', 'KA', 13.1986, 77.7066],
  ['Hebbal, Bengaluru', 'KA', 13.0358, 77.5970],
  ['Charbagh Railway Station, Lucknow', 'UP', 26.8320, 80.9230],
  ['Hazratganj, Lucknow', 'UP', 26.8500, 80.9460],
  ['Lulu Mall, Shaheed Path, Lucknow', 'UP', 26.7877, 80.9919],
  ['Patrakarpuram, Gomti Nagar, Lucknow', 'UP', 26.8530, 80.9990],
  ['Chaudhary Charan Singh Airport, Lucknow', 'UP', 26.7606, 80.8893],
  ['Alambagh Bus Station, Lucknow', 'UP', 26.8170, 80.9070],
  ['Munshi Pulia, Indira Nagar, Lucknow', 'UP', 26.8880, 80.9980],
  ['KGMU, Chowk, Lucknow', 'UP', 26.8690, 80.9150],
  ['Connaught Place, Delhi', 'DL', 28.6315, 77.2167],
  ['Cyber City, Gurugram', 'HR', 28.4950, 77.0895],
  ['Andheri Station, Mumbai', 'MH', 19.1197, 72.8464],
  ['Bandra Kurla Complex, Mumbai', 'MH', 19.0607, 72.8636],
];

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM places').get();
  if (n === 0) {
    const ins = db.prepare('INSERT INTO places (name, state, lat, lng) VALUES (?, ?, ?, ?)');
    for (const p of SEED_PLACES) ins.run(...p);
  }
  return db;
}

module.exports = { openDb };
