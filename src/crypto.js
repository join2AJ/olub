'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./config');

// Key for encrypting sensitive documents (KYC, licence, RC) at rest.
let key;
if (/^[0-9a-f]{64}$/i.test(C.DATA_KEY)) {
  key = Buffer.from(C.DATA_KEY, 'hex');
} else if (C.DATA_KEY.length >= 32) {
  key = crypto.createHash('sha256').update(C.DATA_KEY).digest(); // any long random secret works
} else if (process.env.NODE_ENV === 'production') {
  // No key configured: create one and keep it next to the database, so the server still starts.
  // Setting OLUB_DATA_KEY yourself is safer (the key then lives apart from the data).
  const file = path.join(path.dirname(process.env.OLUB_DB || path.join(__dirname, '..', 'data', 'olub-v2.db')), 'olub.key');
  try {
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error('bad key file');
  } catch {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  }
  console.warn(`[olub] OLUB_DATA_KEY is not set. Using the key stored in ${file}.`);
} else {
  key = crypto.createHash('sha256').update('olub-dev-only-key').digest();
}

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') return blob;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Short human-friendly IDs without confusing characters (no 0/O, 1/I).
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function publicId(prefix, len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}

module.exports = { encrypt, decrypt, sha256, publicId };
