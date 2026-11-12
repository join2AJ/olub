'use strict';

const { sha256 } = require('./crypto');

const REDACT = /^(photo|docs|otp|code|token|license|rc|kyc|selfie|vehicle|data)$/i;

/** Strip secrets and bulky files from anything that goes into the audit log. */
function sanitize(v, depth = 0) {
  if (v == null || depth > 4) return v;
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 60)}…[${v.length} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = REDACT.test(k) ? '[redacted]' : sanitize(val, depth + 1);
    return out;
  }
  return v;
}

/**
 * Append-only, hash-chained audit log: each row's hash covers the previous
 * row's hash, so any edit or deletion breaks the chain and is detectable.
 */
function createAudit(db, clock) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const ins = db.prepare(`INSERT INTO audit_log (ts, actor_id, actor_role, action, entity, entity_id, ip, ua, details, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function log({ actor, action, entity = null, entityId = null, req = null, details = null }) {
    const ts = clock();
    const prev = last.get()?.hash || 'GENESIS';
    const d = details == null ? null : JSON.stringify(sanitize(details));
    const row = [ts, actor?.id ?? null, actor?.role ?? (actor ? null : 'system'), action, entity, entityId == null ? null : String(entityId),
      req?.ip ?? null, req ? String(req.get?.('user-agent') || '').slice(0, 200) : null, d];
    const hash = sha256([prev, ...row].join('|'));
    ins.run(...row, prev, hash);
  }

  function verify() {
    let prev = 'GENESIS';
    for (const r of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
      const expect = sha256([prev, r.ts, r.actor_id, r.actor_role, r.action, r.entity, r.entity_id, r.ip, r.ua, r.details].join('|'));
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, entries: db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n };
  }

  return { log, verify };
}

module.exports = { createAudit, sanitize };
