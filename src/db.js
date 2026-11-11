'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'rider',          -- rider | driver | admin
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  vehicle_number TEXT UNIQUE,
  vehicle_type TEXT,
  vehicle_model TEXT,
  vehicle_condition TEXT,
  state TEXT,
  license_no TEXT,
  rc_no TEXT,
  kyc_id_no TEXT,
  docs TEXT,                                    -- JSON {license, rc, kyc, vehicle} data URLs
  status TEXT NOT NULL DEFAULT 'incomplete',    -- incomplete | submitted | verified | rejected
  verified_via TEXT,                            -- customer | admin
  verified_by INTEGER,
  online INTEGER NOT NULL DEFAULT 0,
  completed_trips INTEGER NOT NULL DEFAULT 0,
  subscription_until INTEGER
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  rider_id INTEGER NOT NULL REFERENCES users(id),
  driver_id INTEGER NOT NULL REFERENCES users(id),
  src_name TEXT, src_lat REAL, src_lng REAL,
  dst_name TEXT, dst_lat REAL, dst_lng REAL,
  state TEXT,
  distance_km REAL,
  road TEXT, traffic TEXT,
  quote TEXT,                                   -- JSON fare at booking
  final TEXT,                                   -- JSON fare at completion
  status TEXT NOT NULL,                         -- requested | accepted | started | completed | rejected | cancelled
  otp TEXT,
  otp_attempts INTEGER NOT NULL DEFAULT 0,
  wait_minutes REAL,
  verify_discount INTEGER NOT NULL DEFAULT 0,   -- rider verified this driver on this trip
  payment_method TEXT,
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER, started_at INTEGER, completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS trip_tolls (
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  toll_id INTEGER NOT NULL REFERENCES tolls(id),
  PRIMARY KEY (trip_id, toll_id)
);
CREATE TABLE IF NOT EXISTS tolls (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | verified
  verified_amount REAL,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS toll_reports (
  id INTEGER PRIMARY KEY,
  toll_id INTEGER NOT NULL REFERENCES tolls(id),
  driver_id INTEGER NOT NULL REFERENCES users(id),
  vehicle_type TEXT,
  amount REAL NOT NULL,
  photo TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (toll_id, driver_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS calamity (
  state TEXT PRIMARY KEY,                       -- '*' = all states
  reason TEXT,
  since INTEGER NOT NULL
);
`;

// Demo places so the app works without a maps API.
const SEED_PLACES = [
  ['MG Road Metro, Bengaluru', 'KA', 12.9756, 77.6066],
  ['Electronic City Phase 1, Bengaluru', 'KA', 12.8452, 77.6602],
  ['Whitefield, Bengaluru', 'KA', 12.9698, 77.7500],
  ['Kempegowda Airport, Bengaluru', 'KA', 13.1986, 77.7066],
  ['Hebbal, Bengaluru', 'KA', 13.0358, 77.5970],
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
