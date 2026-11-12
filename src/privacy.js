'use strict';

// Data-subject requests (India DPDP Act / EU GDPR): export and erasure.

const all = (db, sql, ...a) => db.prepare(sql).all(...a);

/** Everything Olub holds about a user, as one JSON document. */
function exportUserData(db, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const driver = db.prepare(`SELECT user_id, vehicle_number, vehicle_type, vehicle_model, vehicle_condition, state, license_no,
    license_issued_on, rc_no, kyc_id_no, insurance_valid_till, prefs, status, completed_trips FROM drivers WHERE user_id = ?`).get(userId);
  return {
    generatedFor: user.public_id,
    profile: user,
    driver: driver ? { ...driver, documents: 'Uploaded documents are held encrypted; ask support for copies.' } : null,
    consents: all(db, 'SELECT doc, version, accepted_at, withdrawn_at FROM consents WHERE user_id = ?', userId),
    guests: all(db, 'SELECT public_id, name, phone, created_at FROM guests WHERE owner_id = ?', userId),
    trips: all(db, `SELECT id, status, src_name, dst_name, distance_km, quote, final, pet, payment_method, created_at, started_at, completed_at
      FROM trips WHERE rider_id = ? OR driver_id = ?`, userId, userId),
    messagesSent: all(db, 'SELECT trip_id, body, created_at FROM messages WHERE sender_id = ?', userId),
    ratingsGiven: all(db, 'SELECT trip_id, scores, overall, good, bad, improve, created_at FROM ratings WHERE from_id = ?', userId),
    // Received feedback is given without the author's identity.
    ratingsReceived: all(db, 'SELECT scores, overall, good, bad, improve FROM ratings WHERE to_id = ?', userId),
    tollReports: all(db, 'SELECT toll_id, amount, created_at FROM toll_reports WHERE driver_id = ?', userId),
    privacyRequests: all(db, 'SELECT public_id, type, status, created_at, completed_at FROM dsr_requests WHERE user_id = ?', userId),
    activityLog: all(db, 'SELECT ts, action, entity, entity_id, ip FROM audit_log WHERE actor_id = ? ORDER BY id', userId),
  };
}

/**
 * Erase a user: personal data is removed; trip, payment and audit records are
 * kept without identity because the law requires them.
 * Returns a reason string if erasure cannot happen yet.
 */
function eraseUser(db, userId) {
  const active = db.prepare(`SELECT 1 FROM trips WHERE (rider_id = ? OR driver_id = ?)
    AND (status IN ('requested','accepted','started') OR (status = 'completed' AND paid_at IS NULL))`).get(userId, userId);
  if (active) return 'You have a trip in progress or awaiting payment. We will retry automatically.';
  db.prepare(`UPDATE users SET name = 'Deleted user', phone = ?, email = NULL, email_verified_at = NULL, phone_verified_at = NULL,
    dob = NULL, gender = NULL, photo = NULL, trusted_name = NULL, trusted_phone = NULL, trusted_relation = NULL, status = 'erased' WHERE id = ?`)
    .run(`erased:${userId}`, userId);
  db.prepare(`UPDATE drivers SET vehicle_number = NULL, vehicle_model = NULL, license_no = NULL, license_issued_on = NULL, rc_no = NULL,
    kyc_id_no = NULL, insurance_valid_till = NULL, docs = NULL, prefs = NULL, status = 'incomplete', online = 0 WHERE user_id = ?`).run(userId);
  db.prepare("UPDATE guests SET name = 'Deleted guest', phone = NULL WHERE owner_id = ?").run(userId);
  db.prepare("UPDATE messages SET body = '[deleted]' WHERE sender_id = ?").run(userId);
  db.prepare('UPDATE toll_reports SET photo = NULL WHERE driver_id = ?').run(userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM email_otps WHERE user_id = ?').run(userId);
  db.prepare('UPDATE consents SET withdrawn_at = COALESCE(withdrawn_at, ?) WHERE user_id = ?').run(Date.now(), userId);
  return null;
}

module.exports = { exportUserData, eraseUser };
