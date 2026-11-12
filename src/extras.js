'use strict';

// Wallet, GST invoices, insights, SOS, fare estimates, requests from
// police / RTO, vehicle flags and the admin compliance report.

const crypto = require('node:crypto');
const { calculateFare } = require('./fare');
const T = require('./tolls');
const { encrypt, decrypt, sha256 } = require('./crypto');

const { httpError } = T;

module.exports = function registerExtras(x) {
  const { app, admin, db, C, now, audit, auth, role, route, rateLimit, queue, emit, json, r2, text, firstName } = x;
  const day = (ts) => new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
  const sum = (list, f) => r2(list.reduce((s, v) => s + (f(v) || 0), 0));

  // ================= fare estimate before choosing a cab =================
  // Destination first: show what each vehicle type would cost, then scan the driver's QR for the exact fare.
  app.post('/api/trips/estimate', auth, role('rider'), route(async (req) => {
    const src = x.resolvePoint(req.body.src, 'Pickup');
    const dst = x.resolvePoint(req.body.dst, 'Drop');
    const r = await x.maps.getRoute(src, dst, { vehicleType: 'sedan', when: new Date(now()) });
    if (r.distanceKm < 0.005) throw httpError(400, 'Pickup and drop are the same spot');
    const tolls = T.tollsOnRoute(db, src, dst);
    const rates = x.getRates();
    const calamity = !!x.calamityFor(src.state);
    return {
      src, dst,
      route: { distanceKm: r2(r.distanceKm), etaMin: Math.round(r.etaMin), traffic: r.trafficLabel, source: r.source, polyline: r.polyline },
      options: Object.entries(rates).map(([type, rate]) => {
        const f = calculateFare({
          distanceKm: r.distanceKm, vehicleType: type, rates: rate, condition: 'good', completedTrips: 10,
          waitMinutes: r.delayMin, tolls: T.tollsForVehicle(tolls, type), calamity,
        });
        return { type, label: rate.label, perKm: rate.perKm, riderPays: f.riderPays, tollTotal: f.breakdown.tollTotal };
      }),
      note: 'Scan the driver\'s Olub QR for the exact fare — it depends on the vehicle, its condition and the driver\'s experience.',
    };
  }));

  // ================= driver wallet =================
  app.get('/api/driver/wallet', auth, role('driver'), route((req) => {
    const d = x.getDriver(req.user.id);
    return {
      balance: d.wallet_balance, min: C.WALLET_MIN_BALANCE, ok: d.wallet_balance >= C.WALLET_MIN_BALANCE,
      txns: db.prepare('SELECT id, ts, type, amount, balance_after AS balanceAfter, trip_id AS tripId, note FROM wallet_txns WHERE driver_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id),
    };
  }));

  app.post('/api/driver/wallet/topup', auth, role('driver'), route((req) => {
    const amount = Math.round(Number(req.body.amount));
    if (!(amount >= 10 && amount <= C.WALLET_MAX_TOPUP)) throw httpError(400, `Top up between ₹10 and ₹${C.WALLET_MAX_TOPUP}`);
    // TODO(prod): confirm the payment with the gateway (UPI) before crediting.
    x.walletTxn(req.user.id, 'topup', amount, { note: `Wallet top-up (${['upi', 'card'].includes(req.body.method) ? req.body.method : 'upi'})` });
    return { balance: x.getDriver(req.user.id).wallet_balance };
  }));

  // ================= GST invoice =================
  app.get('/api/trips/:id/invoice', auth, route((req) => {
    const trip = x.loadTripFor(req);
    if (trip.status !== 'completed') throw httpError(409, 'The invoice is ready when the trip ends');
    const f = json(trip.final); const b = f.breakdown;
    const rider = x.getUser(trip.rider_id); const d = x.getDriver(trip.driver_id); const du = x.getUser(trip.driver_id);
    const isRider = req.user.id === trip.rider_id;
    const half = (n) => r2(n / 2);
    const common = {
      invoiceNo: trip.invoice_no, date: trip.completed_at, tripId: trip.id, issuedBy: C.COMPANY,
      trip: { from: x.withPin({ name: trip.src_name, lat: trip.src_lat, lng: trip.src_lng }), to: x.withPin({ name: trip.dst_name, lat: trip.dst_lat, lng: trip.dst_lng }), distanceKm: trip.distance_km, startedAt: trip.started_at, endedAt: trip.completed_at },
      vehicle: { number: d.vehicle_number, type: d.vehicle_type, driverId: du.public_id, driverName: du.name },
      placeOfSupply: trip.state,
    };
    if (isRider) {
      const taxable = b.rideFare + b.waitCharge + b.petCharge;
      return {
        ...common, kind: 'ride', title: 'Tax invoice — ride', billedTo: { name: rider.name, id: rider.public_id },
        lines: [
          { label: `Ride fare (${f.distanceKm} km)`, sac: C.SAC_RIDE, amount: b.rideFare },
          ...(b.waitCharge ? [{ label: `Waiting / traffic (${b.waitMinutes} min)`, sac: C.SAC_RIDE, amount: b.waitCharge }] : []),
          ...(b.petCharge ? [{ label: 'Pet charge', sac: C.SAC_RIDE, amount: b.petCharge }] : []),
        ],
        taxable, taxes: [
          { label: `CGST ${f.taxes.rideGstRate * 50}%`, amount: half(f.taxes.rideGst) },
          { label: `SGST ${f.taxes.rideGstRate * 50}%`, amount: r2(f.taxes.rideGst - half(f.taxes.rideGst)) },
        ],
        other: [
          ...b.tolls.map((t) => ({ label: `Toll: ${t.name} (at cost)`, amount: t.amount })),
          { label: `Olub platform fee (incl. ₹${f.taxes.platformFeeGst} GST)`, amount: f.platformFee },
          ...(f.dues ? [{ label: 'Earlier cancellation fee', amount: f.dues }] : []),
          ...(f.discount ? [{ label: 'Driver verification reward', amount: -f.discount }] : []),
        ],
        total: f.riderPays, totalGst: f.taxes.totalGst,
        paid: trip.paid_at ? { at: trip.paid_at, method: trip.payment_method } : null,
        note: 'Ride provided by the driver named above. Olub connects customer and driver and collects GST on the ride under section 9(5) of the CGST Act.',
      };
    }
    return {
      ...common, kind: 'platform', title: 'Tax invoice — Olub platform fee', billedTo: { name: du.name, id: du.public_id, vehicle: d.vehicle_number },
      lines: [{ label: 'Olub platform fee for this trip', sac: C.SAC_PLATFORM, amount: f.taxes.platformFeeBase }],
      taxable: f.taxes.platformFeeBase, taxes: [
        { label: `CGST ${C.PLATFORM_FEE_GST_RATE * 50}%`, amount: half(f.taxes.platformFeeGst) },
        { label: `SGST ${C.PLATFORM_FEE_GST_RATE * 50}%`, amount: r2(f.taxes.platformFeeGst - half(f.taxes.platformFeeGst)) },
      ],
      other: [], total: f.platformFee, totalGst: f.taxes.platformFeeGst,
      summary: {
        collectedFromRider: f.riderPays, rideGstRemitted: f.taxes.rideGst, platformFee: f.platformFee, tolls: b.tollTotal,
        verificationReward: f.discount, youKeep: f.driverFare,
      },
      note: 'Deducted from your Olub wallet when the trip ended, together with the ride GST that Olub remits for you.',
    };
  }));

  // ================= insights: analyse my trips, earnings, GST =================
  app.get('/api/insights', auth, route((req) => {
    const me = req.user; const isDriver = me.role === 'driver';
    const trips = db.prepare(`SELECT * FROM trips WHERE ${isDriver ? 'driver_id' : 'rider_id'} = ? AND status = 'completed' ORDER BY completed_at`).all(me.id)
      .map((t) => ({ ...t, f: json(t.final), s: json(t.safety) }));
    const totals = (list) => ({
      trips: list.length, km: sum(list, (t) => t.distance_km),
      riderPaid: sum(list, (t) => t.f.riderPays), rideGst: sum(list, (t) => t.f.taxes?.rideGst),
      platformFees: sum(list, (t) => t.f.platformFee), platformFeeGst: sum(list, (t) => t.f.taxes?.platformFeeGst),
      tolls: sum(list, (t) => t.f.breakdown.tollTotal),
      // What the driver keeps: ride + waiting + pet + tolls (fee and GST already taken from the wallet).
      driverKeeps: sum(list, (t) => t.f.driverFare),
      totalGst: sum(list, (t) => t.f.taxes?.totalGst),
    });
    const since = (days) => trips.filter((t) => t.completed_at >= now() - days * C.DAY);
    const between = (a, b) => trips.filter((t) => t.completed_at >= now() - a * C.DAY && t.completed_at < now() - b * C.DAY);
    const byKey = (keyFn) => {
      const m = new Map();
      for (const t of trips) { const k = keyFn(t); m.set(k, [...(m.get(k) || []), t]); }
      return [...m.entries()].map(([key, list]) => ({ key, ...totals(list) }));
    };
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = day(now() - i * C.DAY);
      const list = trips.filter((t) => day(t.completed_at) === k);
      days.push({ date: k, trips: list.length, amount: sum(list, (t) => (isDriver ? t.f.driverFare : t.f.riderPays)) });
    }
    const hours = Array.from({ length: 24 }, () => 0);
    for (const t of trips) hours[new Date(t.started_at + 5.5 * 3600e3).getUTCHours()]++;
    const scored = trips.filter((t) => t.s && t.s.score != null);
    const places = new Map();
    for (const t of trips) places.set(t.dst_name, (places.get(t.dst_name) || 0) + 1);
    const all = totals(trips); const week = totals(since(7)); const lastWeek = totals(between(14, 7));
    return {
      role: isDriver ? 'driver' : 'rider',
      all, week, lastWeek, month: totals(since(30)),
      months: byKey((t) => day(t.completed_at).slice(0, 7)).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 12),
      days, hours,
      busiestHour: trips.length ? hours.indexOf(Math.max(...hours)) : null,
      averageFare: trips.length ? r2((isDriver ? all.driverKeeps : all.riderPaid) / trips.length) : 0,
      perKm: all.km ? r2((isDriver ? all.driverKeeps : all.riderPaid) / all.km) : 0,
      safety: {
        average: scored.length ? Math.round(scored.reduce((s, t) => s + t.s.score, 0) / scored.length) : null,
        overspeed: sum(scored, (t) => t.s.overspeed), harshBrakes: sum(scored, (t) => t.s.harshBrakes), trips: scored.length,
      },
      topPlaces: [...places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, visits]) => ({ name, visits })),
      ...(isDriver && {
        // Olub's cut as a share of what riders paid — the law caps platform commission at 20%.
        commissionPercent: all.riderPaid ? r2((all.platformFees / all.riderPaid) * 100) : 0,
        wallet: x.getDriver(me.id).wallet_balance, duty: x.dutyStatus(me.id),
        // What this month's charge would be if the month ended now, and past charges.
        monthly: C.MONTHLY_FEE_ENABLED ? {
          thisMonth: x.monthlyCharge(me.id, day(now()).slice(0, 7)), max: C.MONTHLY_FEE_MAX, sharePercent: C.MONTHLY_FEE_SHARE * 100,
          past: db.prepare('SELECT month, earned, amount FROM monthly_charges WHERE driver_id = ? AND amount > 0 ORDER BY month DESC LIMIT 12').all(me.id),
        } : null,
      }),
    };
  }));

  // ================= SOS =================
  app.post('/api/trips/:id/sos', auth, route((req) => {
    const trip = x.loadTripFor(req);
    if (!['accepted', 'started'].includes(trip.status)) throw httpError(409, 'SOS works during a ride');
    const lat = Number(req.body.lat) || trip.last_lat; const lng = Number(req.body.lng) || trip.last_lng;
    db.prepare('UPDATE trips SET sos_at = COALESCE(sos_at, ?) WHERE id = ?').run(now(), trip.id);
    db.prepare("INSERT INTO safety_events (trip_id, ts, type, by_user, lat, lng) VALUES (?, ?, 'sos', ?, ?, ?)").run(trip.id, now(), req.user.id, lat, lng);
    const rider = x.getUser(trip.rider_id); const d = x.getDriver(trip.driver_id);
    const pin = lat != null ? x.withPin({ lat, lng }).digipin : null;
    const who = req.user.id === trip.rider_id ? firstName(rider.name) : `The driver of ${firstName(rider.name)}'s ride`;
    queue('sms', rider.trusted_phone, 'ride_sos',
      `EMERGENCY: ${who} pressed SOS in an Olub ride (${d.vehicle_number}).${pin ? ` Location DIGIPIN ${pin} (${lat.toFixed(5)}, ${lng.toFixed(5)}).` : ''} Call them now, or call 112. Track: ${x.baseUrl(req)}/track/${trip.track_token}`,
      { tripId: trip.id, userId: rider.id });
    req.auditNote = 'SOS pressed';
    emit(trip.rider_id, 'safety', { tripId: trip.id, sos: true }); emit(trip.driver_id, 'safety', { tripId: trip.id, sos: true });
    x.notifyTrip(trip);
    return { ok: true, call: '112', trustedNotified: !!rider.trusted_phone };
  }));

  // ================= police / RTO / court requests =================
  const leaView = (r, { full = false } = {}) => ({
    ref: r.public_id, kind: r.kind, agency: r.agency, agencyLabel: C.LEA_AGENCIES[r.agency], officerName: r.officer_name,
    designation: r.designation, office: r.office, email: r.email, emailVerified: !!r.email_verified_at,
    caseRef: r.case_ref, legalBasis: r.legal_basis, details: r.details,
    vehicleNumber: r.vehicle_number, driverId: r.driver_public_id, tripId: r.trip_id, from: r.from_ts, to: r.to_ts,
    status: r.status, createdAt: r.created_at, answerBy: r.public_due_at, resolvedAt: r.resolved_at, response: r.response,
    ...(full && { id: r.id, autoReleaseAt: r.auto_release_at, handledBy: r.handled_by, hasProof: !!r.proof }),
  });

  // Step 1: the officer fills the form. Only official government mailboxes are accepted.
  app.post('/api/authority/requests', rateLimit, route((req) => {
    const b = req.body;
    const email = String(b.email || '').trim().toLowerCase();
    if (!x.isEmail(email) || !C.LEA_EMAIL_DOMAINS.test(email)) throw httpError(400, 'Use your official government email address (ending in .gov.in or .nic.in)');
    if (!C.LEA_AGENCIES[b.agency]) throw httpError(400, 'Choose your agency');
    const kind = b.kind === 'flag' ? 'flag' : 'data';
    const officer = text(b.officerName, 80); const caseRef = text(b.caseRef, 120);
    if (!officer || !text(b.designation, 80) || !text(b.office, 120)) throw httpError(400, 'Enter your name, designation and office / station');
    if (!caseRef) throw httpError(400, 'Enter the FIR / case / file reference');
    if (!b.proof || !/^data:(image\/|application\/pdf)/.test(b.proof)) throw httpError(400, 'Attach the signed request letter or authorisation (photo or PDF)');
    if (b.proof.length > 4_000_000) throw httpError(400, 'Attachment too large (max ~3MB)');
    const vehicle = x.normVehicle(b.vehicleNumber) || null;
    const driverId = text(b.driverId, 20)?.toUpperCase() || null;
    const tripId = Number(b.tripId) || null;
    if (!vehicle && !driverId && !tripId) throw httpError(400, 'Give a vehicle number, driver ID or trip ID');
    if (kind === 'flag' && !vehicle) throw httpError(400, 'Give the vehicle number to flag');
    if (!text(b.details, 1000)) throw httpError(400, kind === 'flag' ? 'Say why this vehicle is being flagged' : 'Say what information is needed and why');
    const toTs = Date.parse(b.to) || now();
    const fromTs = Math.max(Date.parse(b.from) || toTs - 30 * C.DAY, toTs - 90 * C.DAY);
    const code = String(crypto.randomInt(100000, 1000000));
    const r = db.prepare(`INSERT INTO lea_requests (public_id, kind, agency, officer_name, designation, office, email, email_code, case_ref, legal_basis,
      details, vehicle_number, driver_public_id, trip_id, from_ts, to_ts, proof, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(x.newPublicId('LEA', 'lea_requests'), kind, b.agency, officer, text(b.designation, 80), text(b.office, 120), email, code, caseRef,
        text(b.legalBasis, 200), text(b.details, 1000), vehicle, driverId, tripId, fromTs, toTs, encrypt(b.proof), now());
    const row = db.prepare('SELECT * FROM lea_requests WHERE id = ?').get(r.lastInsertRowid);
    queue('email', email, 'lea_email_code', `Olub: your verification code for request ${row.public_id} is ******.`);
    audit.log({ action: 'lea.submitted', entity: 'lea', entityId: row.public_id, req, details: { kind, agency: b.agency, email, caseRef, vehicle, driverId, tripId } });
    return { ref: row.public_id, ...(C.DEV_OTP && { devCode: code }) };
  }));

  // Step 2: confirm the government email. A flag takes effect now; data is released after review.
  app.post('/api/authority/requests/:ref/verify', rateLimit, route((req) => {
    const r = db.prepare("SELECT * FROM lea_requests WHERE public_id = ? AND status = 'email_pending'").get(req.params.ref);
    if (!r) throw httpError(404, 'Request not found or already verified');
    if (String(req.body.code) !== r.email_code) {
      audit.log({ action: 'lea.wrong_code', entity: 'lea', entityId: r.public_id, req });
      throw httpError(400, 'Wrong code');
    }
    const key = crypto.randomBytes(18).toString('hex');
    db.prepare(`UPDATE lea_requests SET status = 'under_review', email_verified_at = ?, email_code = NULL, access_key_hash = ?,
      auto_release_at = ?, public_due_at = ? WHERE id = ?`).run(now(), sha256(key), now() + C.LEA_AUTO_REPLY_DAYS * C.DAY, now() + C.LEA_PUBLIC_SLA_DAYS * C.DAY, r.id);
    if (r.kind === 'flag') {
      db.prepare('INSERT INTO vehicle_flags (vehicle_number, reason, lea_request_id, created_at) VALUES (?, ?, ?, ?)').run(r.vehicle_number, r.details, r.id, now());
      db.prepare("UPDATE lea_requests SET status = 'released', resolved_at = ?, handled_by = 'auto', response = 'Vehicle flagged. Olub administrators have been alerted.' WHERE id = ?").run(now(), r.id);
    }
    audit.log({ action: r.kind === 'flag' ? 'lea.vehicle_flagged' : 'lea.email_verified', entity: 'lea', entityId: r.public_id, req, details: { vehicle: r.vehicle_number } });
    queue('email', r.email, 'lea_received', `Olub received request ${r.public_id} (${r.case_ref}). ${r.kind === 'flag' ? 'The vehicle has been flagged.' : `You will get the information within ${C.LEA_PUBLIC_SLA_DAYS} days.`} Keep your access key safe.`);
    return { ref: r.public_id, accessKey: key, status: r.kind === 'flag' ? 'released' : 'under_review', answerWithinDays: C.LEA_PUBLIC_SLA_DAYS };
  }));

  // Step 3: the officer checks status and, once released, reads the information.
  app.get('/api/authority/requests/:ref', rateLimit, route((req) => {
    const r = db.prepare('SELECT * FROM lea_requests WHERE public_id = ?').get(req.params.ref);
    if (!r || !r.access_key_hash || sha256(String(req.query.key || '')) !== r.access_key_hash) throw httpError(404, 'Request not found. Check the reference and access key.');
    const out = leaView(r);
    if (r.status === 'released' && r.package) {
      out.data = JSON.parse(decrypt(r.package));
      audit.log({ action: 'lea.data_viewed', entity: 'lea', entityId: r.public_id, req });
    }
    return out;
  }));

  /** Records matching a request: the driver, vehicle, and trips in the period. */
  function buildPackage(r) {
    let d = null;
    if (r.vehicle_number) d = db.prepare('SELECT * FROM drivers WHERE vehicle_number = ?').get(r.vehicle_number);
    if (!d && r.driver_public_id) { const u = db.prepare('SELECT id FROM users WHERE public_id = ?').get(r.driver_public_id); d = u && x.getDriver(u.id); }
    let trips = [];
    if (r.trip_id) trips = db.prepare('SELECT * FROM trips WHERE id = ?').all(r.trip_id);
    else if (d) trips = db.prepare('SELECT * FROM trips WHERE driver_id = ? AND created_at BETWEEN ? AND ? ORDER BY id').all(d.user_id, r.from_ts, r.to_ts);
    if (!d && trips[0]) d = x.getDriver(trips[0].driver_id);
    const person = (id) => { const u = x.getUser(id); return u && { olubId: u.public_id, name: u.name, phone: u.phone, email: u.email }; };
    return {
      request: r.public_id, caseRef: r.case_ref, preparedAt: now(), period: { from: r.from_ts, to: r.to_ts },
      driver: d ? {
        ...person(d.user_id), vehicleNumber: d.vehicle_number, vehicleType: d.vehicle_type, vehicleModel: d.vehicle_model,
        licenceNo: d.license_no, rcNo: d.rc_no, permitNo: d.permit_no, insuranceValidTill: d.insurance_valid_till, status: d.status,
      } : null,
      trips: trips.map((t) => ({
        tripId: t.id, status: t.status, customer: person(t.rider_id), bookedAt: t.created_at, startedAt: t.started_at, endedAt: t.completed_at,
        from: x.withPin({ name: t.src_name, lat: t.src_lat, lng: t.src_lng }), to: x.withPin({ name: t.dst_name, lat: t.dst_lat, lng: t.dst_lng }),
        fare: json(t.final)?.riderPays ?? null, fitDeclarationAt: t.fit_declared_at,
        safetyEvents: db.prepare('SELECT ts, type, lat, lng FROM safety_events WHERE trip_id = ?').all(t.id),
        gpsTrail: db.prepare('SELECT ts, lat, lng, kmph FROM trip_points WHERE trip_id = ? ORDER BY id LIMIT 2000').all(t.id),
      })),
      note: trips.length || d ? null : 'No matching Olub records were found.',
    };
  }

  function releaseLea(r, handledBy, note) {
    const pkg = buildPackage(r);
    db.prepare("UPDATE lea_requests SET status = 'released', resolved_at = ?, handled_by = ?, response = ?, package = ? WHERE id = ?")
      .run(now(), handledBy, note || 'The information is available with your reference and access key.', encrypt(JSON.stringify(pkg)), r.id);
    queue('email', r.email, 'lea_released', `Olub: the information for request ${r.public_id} (${r.case_ref}) is ready. Open the Olub authority page and enter your reference and access key.`);
    audit.log({ action: 'lea.released', entity: 'lea', entityId: r.public_id, details: { handledBy, trips: pkg.trips.length, driver: pkg.driver?.olubId ?? null } });
  }

  admin.get('/lea', route(() => db.prepare("SELECT * FROM lea_requests ORDER BY status = 'under_review' DESC, id DESC LIMIT 200").all().map((r) => leaView(r, { full: true }))));
  admin.get('/lea/:id/proof', route((req) => {
    const r = db.prepare('SELECT proof FROM lea_requests WHERE id = ?').get(Number(req.params.id));
    if (!r?.proof) throw httpError(404, 'No attachment');
    return { proof: decrypt(r.proof) };
  }));
  admin.post('/lea/:id/resolve', route((req) => {
    const r = db.prepare("SELECT * FROM lea_requests WHERE id = ? AND status = 'under_review'").get(Number(req.params.id));
    if (!r) throw httpError(404, 'Open request not found');
    const note = text(req.body.response, 1000);
    if (req.body.action === 'reject') {
      if (!note) throw httpError(400, 'Give the reason for refusing');
      db.prepare("UPDATE lea_requests SET status = 'rejected', resolved_at = ?, handled_by = ?, response = ? WHERE id = ?").run(now(), `admin:${req.user.id}`, note, r.id);
      queue('email', r.email, 'lea_rejected', `Olub: request ${r.public_id} could not be fulfilled. ${note}`);
    } else releaseLea(r, `admin:${req.user.id}`, note);
    return leaView(db.prepare('SELECT * FROM lea_requests WHERE id = ?').get(r.id), { full: true });
  }));

  // Requests nobody has refused are answered automatically after the review window.
  x.ticks.push(() => {
    for (const r of db.prepare("SELECT * FROM lea_requests WHERE status = 'under_review' AND kind = 'data' AND auto_release_at <= ?").all(now())) releaseLea(r, 'auto');
  });

  // ---------- vehicle flags & suspension ----------
  admin.get('/flags', route(() => db.prepare(`SELECT f.*, l.public_id AS ref, l.agency, l.officer_name AS officer, l.case_ref AS caseRef
    FROM vehicle_flags f LEFT JOIN lea_requests l ON l.id = f.lea_request_id ORDER BY f.status = 'active' DESC, f.id DESC`).all().map((f) => {
    const d = db.prepare('SELECT * FROM drivers WHERE vehicle_number = ?').get(f.vehicle_number);
    return { id: f.id, vehicleNumber: f.vehicle_number, reason: f.reason, status: f.status, createdAt: f.created_at, ref: f.ref, agency: f.agency, officer: f.officer, caseRef: f.caseRef,
      driver: d ? { id: d.user_id, name: x.getUser(d.user_id).name, suspended: d.suspended_reason } : null };
  })));
  admin.post('/flags/:id/clear', route((req) => {
    db.prepare("UPDATE vehicle_flags SET status = 'cleared', cleared_at = ?, cleared_by = ? WHERE id = ?").run(now(), req.user.id, Number(req.params.id));
    return { ok: true };
  }));
  admin.post('/drivers/:id/suspend', route((req) => {
    const d = x.getDriver(Number(req.params.id));
    if (!d) throw httpError(404, 'Driver not found');
    const reason = req.body.suspend ? (text(req.body.reason, 200) || 'Under review') : null;
    db.prepare('UPDATE drivers SET suspended_reason = ? WHERE user_id = ?').run(reason, d.user_id);
    if (reason) x.forceOffline(d.user_id, 'suspended');
    return { id: d.user_id, suspended: reason };
  }));

  // ================= compliance report =================
  admin.get('/compliance', route(() => {
    const today = day(now());
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const drivers = db.prepare('SELECT * FROM drivers').all();
    const completed = db.prepare("SELECT final FROM trips WHERE status = 'completed'").all().map((t) => json(t.final));
    const riderPaid = sum(completed, (f) => f.riderPays); const fees = sum(completed, (f) => f.platformFee);
    const soon = day(now() + 30 * C.DAY);
    return {
      generatedAt: now(),
      rules: {
        dutyLimit: `${C.DUTY_MAX_HOURS} h on duty, then ${C.DUTY_REST_HOURS} h rest — enforced by the app`,
        commissionCap: `Law: at most ${C.COMMISSION_CAP * 100}% of fare. Olub: ₹${C.PLATFORM_FEE} up to ${C.PLATFORM_FEE_LONG_KM} km, ₹${C.PLATFORM_FEE_LONG} beyond${C.MONTHLY_FEE_ENABLED ? `, plus a monthly charge of ₹${C.MONTHLY_FEE_MAX} or ${C.MONTHLY_FEE_SHARE * 100}% of earnings (lower)` : ''}`,
        fitDeclaration: 'Driver must declare fit-to-drive before every ride',
        cancellationFeeCap: `₹${C.PLATFORM_FEE} / ₹${C.PLATFORM_FEE_LONG} to the side at fault; customer never pays more than ${C.CANCEL_CUSTOMER_CAP.percent * 100}% of the fare; free for ${C.CANCEL_FREE_WINDOW_MIN} min after booking`,
        grievanceOfficer: C.COMPANY.grievanceOfficer,
      },
      drivers: {
        total: drivers.length, verified: drivers.filter((d) => d.status === 'verified').length,
        awaitingVerification: drivers.filter((d) => d.status === 'submitted').length,
        online: drivers.filter((d) => d.online).length, suspended: drivers.filter((d) => d.suspended_reason).length,
        insuranceExpired: drivers.filter((d) => d.insurance_valid_till && d.insurance_valid_till < today).length,
        insuranceExpiringSoon: drivers.filter((d) => d.insurance_valid_till && d.insurance_valid_till >= today && d.insurance_valid_till <= soon)
          .map((d) => ({ name: x.getUser(d.user_id).name, vehicle: d.vehicle_number, validTill: d.insurance_valid_till })),
        walletBelowMinimum: drivers.filter((d) => d.status !== 'incomplete' && d.wallet_balance < C.WALLET_MIN_BALANCE).length,
      },
      dutyHours: drivers.filter((d) => d.status !== 'incomplete').map((d) => {
        const u = x.getUser(d.user_id); const s = x.dutyStatus(d.user_id);
        return { driverId: u.public_id, name: u.name, vehicle: d.vehicle_number, online: !!d.online, workedMin: s.workedMin, remainingMin: s.remainingMin, locked: s.locked, restUntil: s.restUntil };
      }).sort((a, b) => b.workedMin - a.workedMin),
      dutyLockouts30d: count("SELECT COUNT(*) AS n FROM duty_sessions WHERE end_reason = 'duty_limit' AND ended_at > ?", now() - 30 * C.DAY),
      trips: {
        completed: completed.length, riderPaid, platformFees: fees,
        commissionPercent: riderPaid ? r2((fees / riderPaid) * 100) : 0,
        rideGst: sum(completed, (f) => f.taxes?.rideGst), platformFeeGst: sum(completed, (f) => f.taxes?.platformFeeGst),
        withoutFitDeclaration: count("SELECT COUNT(*) AS n FROM trips WHERE status IN ('started','completed') AND fit_declared_at IS NULL"),
      },
      safety: Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM safety_events GROUP BY type').all().map((r) => [r.type, r.n])),
      lateAlerts: count("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('safety.running_late','safety.overdue_alert')"),
      privacyRequests: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM dsr_requests GROUP BY status').all().map((r) => [r.status, r.n])),
      authorityRequests: Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM lea_requests GROUP BY status').all().map((r) => [r.status, r.n])),
      activeVehicleFlags: count("SELECT COUNT(*) AS n FROM vehicle_flags WHERE status = 'active'"),
      auditLog: audit.verify(),
    };
  }));

  // Trip register for a period — the file to hand to a transport authority when asked.
  admin.get('/compliance/trip-register', route((req) => {
    const to = Date.parse(req.query.to) ? Date.parse(req.query.to) + C.DAY : now();
    const from = Date.parse(req.query.from) || to - 30 * C.DAY;
    return db.prepare('SELECT * FROM trips WHERE created_at BETWEEN ? AND ? ORDER BY id').all(from, to).map((t) => {
      const f = json(t.final); const d = x.getDriver(t.driver_id);
      return {
        tripId: t.id, invoiceNo: t.invoice_no, status: t.status, bookedAt: new Date(t.created_at).toISOString(),
        startedAt: t.started_at && new Date(t.started_at).toISOString(), endedAt: t.completed_at && new Date(t.completed_at).toISOString(),
        driverId: x.getUser(t.driver_id).public_id, vehicle: d.vehicle_number, vehicleType: d.vehicle_type, customerId: x.getUser(t.rider_id).public_id,
        from: t.src_name, fromDigipin: x.withPin({ lat: t.src_lat, lng: t.src_lng }).digipin, to: t.dst_name, toDigipin: x.withPin({ lat: t.dst_lat, lng: t.dst_lng }).digipin,
        km: t.distance_km, fare: f?.riderPays ?? null, driverKeeps: f?.driverFare ?? null, platformFee: f?.platformFee ?? null, gst: f?.taxes?.totalGst ?? null,
        fitDeclared: !!t.fit_declared_at, safetyScore: json(t.safety)?.score ?? null, state: t.state,
      };
    });
  }));

  admin.get('/safety-events', route(() => db.prepare('SELECT * FROM safety_events ORDER BY id DESC LIMIT 200').all()));
};
