'use strict';
/* Role screens: customer booking and ride, driver home and ride, admin console. */

const VEH_ICON = { bike: 'bolt', auto: 'car', hatchback: 'car', sedan: 'car', suv: 'car' };

// ======================= CUSTOMER =======================
function renderRider(app) {
  if (S.trip) return renderRiderTrip(app, S.trip);
  const b = S.booking;
  app.innerHTML = `
    <div id="hmap" class="map hero-map"></div>
    <div class="card sheet-card">
      <h2>Where to?</h2>
      <div class="route">
        <button id="pick-src"><span class="dotp"></span><span class="t ${b.src ? '' : 'ph'}">${esc(b.src ? b.src.name : 'Finding your location…')}</span>${pinTag(b.src)}</button>
        <button id="pick-dst"><span class="dotd"></span><span class="t ${b.dst ? '' : 'ph'}">${esc(b.dst ? b.dst.name : 'Choose destination')}</span>${pinTag(b.dst)}</button>
      </div>
      <div class="optchips"><button id="for-guest" class="${b.forGuest ? 'on' : ''}">${ic('users')}For someone else</button><button id="pet" class="${b.pet ? 'on' : ''}">${ic('paw')}With a pet</button></div>
      <div id="guest-box" ${b.forGuest ? '' : 'hidden'} style="margin-top:10px">
        <select id="g-sel"><option value="">New person…</option></select>
        <div id="g-new" class="grid2" style="margin-top:8px"><input id="g-name" placeholder="Their name" value="${esc((b.guest && b.guest.name) || '')}"><input id="g-phone" placeholder="Their mobile (optional)" inputmode="numeric" value="${esc((b.guest && b.guest.phone) || '')}"></div>
        <p class="muted small" style="margin:6px 0 0">Set the pickup to where they are.</p>
      </div>
      <button id="see-fares" class="btn block" ${b.src && b.dst ? '' : 'disabled'}>See cabs and fares</button>
    </div>
    ${todoCard()}
    ${S.me.cancelDues ? `<div class="card warn">${ic('wallet')} ${rs(S.me.cancelDues)} cancellation fee from an earlier booking will be added to your next ride.</div>` : ''}
    <div id="est"></div><div id="quote"></div>`;
  S.map = makeMap($('#hmap'), { src: b.src, dst: b.dst, polyline: S.estimate && S.estimate.route.polyline });
  if (b.src) S.lastSeen = b.src;
  if (S.nearby) { S.map.setHexes(S.nearby.hexes); S.map.setCabs(S.nearby.cabs); }
  else if (b.src) api('GET', `/api/drivers/nearby?lat=${b.src.lat}&lng=${b.src.lng}`).then((cabs) => { if (S.map && !S.nearby) S.map.setCabs(cabs); }).catch(() => {});
  bindTodos(app);
  const setPoint = (k) => (p) => { b[k] = p; b.autoFailed = false; S.estimate = null; S.nearby = null; S.quote = null; render(); };
  $('#pick-src').onclick = () => placePicker('Pickup point', setPoint('src'));
  $('#pick-dst').onclick = () => placePicker('Destination', setPoint('dst'));
  $('#pet').onclick = () => { b.pet = !b.pet; S.quote = null; S.nearby = null; S.estimate = null; b.autoFailed = false; render(); };
  $('#for-guest').onclick = () => { b.forGuest = !b.forGuest; $('#for-guest').classList.toggle('on', b.forGuest); $('#guest-box').hidden = !b.forGuest; if (b.forGuest) loadGuests(); };
  if (b.forGuest) loadGuests();
  // Pickup is picked automatically from GPS (shown with its DIGIPIN).
  if (!b.src && !b.gpsTried) { b.gpsTried = true; myLocation().then(setPoint('src')).catch(() => { const t = $('#pick-src .t'); if (t) t.textContent = 'Choose pickup point'; }); }
  const loadFares = async (scroll) => {
    const body = { src: pointBody(b.src), dst: pointBody(b.dst), pet: b.pet };
    [S.estimate, S.nearby] = await Promise.all([api('POST', '/api/trips/estimate', body), api('POST', '/api/trips/nearby', body).catch(() => ({ options: [], hexes: [], cabs: [], searchedRings: 0 }))]);
    if (S.map) { S.map.setHexes(S.nearby.hexes); S.map.setRoute(b.src, b.dst, S.estimate.route.polyline); S.map.setCabs(S.nearby.cabs); }
    showEstimate(); if (scroll) $('#est').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#see-fares').onclick = run(() => loadFares(true));
  // As soon as both ends are known, fetch the road route, nearby cabs and fares without waiting for a tap.
  if (b.src && b.dst && !S.estimate && !b.loading && !b.autoFailed) { b.loading = true; loadFares(false).catch((e) => { b.autoFailed = true; toast(e.message, true); }).finally(() => { b.loading = false; }); }
  if (S.estimate) showEstimate();
  if (S.quote) showQuote();
}

function guestBody() {
  const b = S.booking;
  if (!b.forGuest) return undefined;
  return $('#g-sel').value ? { id: Number($('#g-sel').value) } : { name: $('#g-name').value, phone: $('#g-phone').value };
}

// Olub finds the cab: confirm the vehicle type, then the nearest driver is asked.
function matchSheet(o) {
  const b = S.booking; b.payTiming = b.payTiming || 'end';
  const sh = sheet(`Request ${/^[aeiou]/i.test(o.label) ? 'an' : 'a'} ${o.label}`, `
    <div class="between"><div><div class="bignum">${rs(o.riderPays)}</div><div class="muted small">incl. GST and ${rs(o.platformFee)} Olub fee</div></div>
      <div class="vi" style="width:56px;height:56px;border-radius:18px;background:var(--soft);color:var(--brand);display:grid;place-items:center">${ic(VEH_ICON[o.type])}</div></div>
    <table class="fare" style="margin-top:10px"><tr><td>${ic('car')} Cab comes to you</td><td>${o.pickupKm} km · ${o.awayMin} min</td></tr>
      <tr><td>${ic('nav')} Your trip</td><td>${o.tripKm} km</td></tr>
      <tr class="sub"><td colspan="2">You pay for both distances at the ${esc(o.label)} rate. The Olub fee is ${rs(S.cfg.platformFee)} up to ${S.cfg.platformFeeLongKm} km in total, ${rs(S.cfg.platformFeeLong)} beyond.</td></tr></table>
    <p class="muted small" style="margin-top:8px">${ic('target')} We ask the nearest free ${esc(o.label.toLowerCase())} first. If they do not accept in ${S.cfg.matchOfferSeconds} seconds, the next nearest is asked. The fare is updated for that cab's distance.</p>
    <h3>When will you pay?</h3>
    <div class="seg" id="mpay"><button data-p="start" class="${b.payTiming === 'start' ? 'on' : ''}">At the start</button><button data-p="end" class="${b.payTiming === 'end' ? 'on' : ''}">At the end</button></div>
    <button id="mgo" class="btn block">Find my cab</button>`);
  $$('#mpay button', sh.el).forEach((x) => { x.onclick = () => { b.payTiming = x.dataset.p; $$('#mpay button').forEach((y) => y.classList.toggle('on', y === x)); }; });
  $('#mgo', sh.el).onclick = run(async () => {
    await api('POST', '/api/trips', { src: pointBody(b.src), dst: pointBody(b.dst), pet: b.pet, guest: guestBody(), payTiming: b.payTiming, match: { vehicleType: o.type } });
    sh.close(); S.quote = null; S.estimate = null; S.nearby = null; S.booking = { mode: 'plate', driver: '', src: b.src, dst: null, pet: false };
    await refreshTrip(); render(); window.scrollTo(0, 0);
  });
}

function showEstimate() {
  const e = S.estimate; const b = S.booking; const n = S.nearby || { options: [] };
  const byType = Object.fromEntries(e.options.map((o) => [o.type, o]));
  $('#est').innerHTML = `
    <div class="card"><div class="between"><h2 style="margin:0">Cabs near you</h2><span class="chip ${e.route.traffic === 'Light' ? '' : 'warn'}">${ic('clock')}${e.route.etaMin} min · ${esc(e.route.traffic)}</span></div>
      <p class="muted small" style="margin:4px 0 6px">${e.route.distanceKm} km ${e.route.source === 'estimate' ? '(estimated)' : 'by road'} · fares include the cab coming to you, GST and the Olub fee</p>
      ${n.options.map((o) => `<div class="opt"><div class="vi">${ic(VEH_ICON[o.type])}</div><div class="grow"><b>${esc(o.label)}</b> ${o.rating.count ? `<span class="stars small">${ic('star', 'fill')}${o.rating.average.toFixed(1)}</span>` : ''}
        <div class="away">${o.awayKm} km away · ${o.awayMin} min${o.count > 1 ? ` · ${o.count} nearby` : ''}</div></div>
        <div style="text-align:right"><b class="p">${rs(o.riderPays)}</b><br><button class="btn req" data-match="${o.type}">Request</button></div></div>`).join('')
      || `<div class="empty" style="padding:16px 6px">${ic('search')}<div>No free cab within about ${S.cfg.platformFeeLongKm + 2} km right now${b.pet ? ' that takes pets' : ''}.<br>You can still book a cab standing in front of you.</div></div>`}
    </div>
    <div class="card"><h2>Cab right in front of you?</h2>
      <p class="muted small" style="margin:0 0 4px">No waiting and no charge for coming to you. Typical fares for this trip:</p>
      <div class="chips" style="margin:8px 0">${e.options.map((o) => `<span class="chip grey">${esc(o.label)} ≈ ${rs(o.riderPays)}</span>`).join('')}</div>
      <button id="scan" class="btn accent block">${ic('camera')}Scan driver's QR</button>
      <div class="seg" style="margin-top:14px" id="mode"><button data-m="plate" class="${b.mode === 'plate' ? 'on' : ''}">Type number plate</button><button data-m="phone" class="${b.mode === 'phone' ? 'on' : ''}">Driver's mobile / Olub ID</button></div>
      <div class="row" style="margin-top:10px"><div class="plate-in grow ${b.mode === 'phone' ? 'phone' : ''}" id="plate-wrap"><span class="ind">IND</span>
        <input id="drv" value="${esc(b.driver)}" placeholder="${b.mode === 'plate' ? 'KA01AB1234' : '98765 43210'}" autocapitalize="characters" autocomplete="off"></div>
        <button id="find" class="btn">${ic('search')}</button></div></div>`;
  void byType;
  $$('[data-match]').forEach((x) => { x.onclick = () => matchSheet(n.options.find((o) => o.type === x.dataset.match)); });
  $$('#mode button').forEach((x) => { x.onclick = () => { b.mode = x.dataset.m; b.driver = ''; showEstimate(); }; });
  $('#scan').onclick = () => scanSheet((code) => { b.driver = code; getQuote(); });
  const go = run(async () => { b.driver = $('#drv').value; await getQuote(true); });
  $('#find').onclick = go;
  $('#drv').onkeydown = (ev) => { if (ev.key === 'Enter') go(ev); };
}

async function loadGuests() {
  const sel = $('#g-sel'); if (!sel || sel.dataset.loaded) return;
  sel.dataset.loaded = 1;
  const gs = await api('GET', '/api/guests').catch(() => []);
  sel.innerHTML = `<option value="">New person…</option>${gs.map((g) => `<option value="${g.id}">${esc(g.name)} · ${esc(g.publicId)}</option>`).join('')}`;
  sel.onchange = () => { $('#g-new').hidden = !!sel.value; };
}

async function getQuote(rethrow) {
  const b = S.booking;
  try {
    S.quote = await api('POST', '/api/trips/quote', { driver: b.driver, src: pointBody(b.src), dst: pointBody(b.dst), pet: b.pet });
    showQuote(); $('#quote').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { if (rethrow) throw e; toast(e.message, true); }
}

function showQuote() {
  const q = S.quote; const b = S.booking;
  b.payTiming = b.payTiming || 'end';
  $('#quote').innerHTML = `<div class="card">
    ${driverCard(q.driver)}
    ${q.calamity ? `<p class="chip warn" style="margin-top:10px">${ic('cloud')}${esc(q.calamity.reason)} — Olub fee is halved</p>` : ''}
    <h3>Exact fare for this cab</h3>${fareTable(q.quote)}
    ${q.tolls.some((t) => t.status !== 'verified') ? '<p class="muted small" style="margin-top:6px">Tolls not yet confirmed by drivers use the state default.</p>' : ''}
    ${q.verifyOffer ? `<p class="chip" style="margin-top:8px;white-space:normal">${ic('shield')}Get ${rs(q.verifyOffer)} off: this driver is new — check their documents during the ride.</p>` : ''}
    <h3>When will you pay?</h3>
    <div class="seg" id="payt"><button data-p="start" class="${b.payTiming === 'start' ? 'on' : ''}">At the start</button><button data-p="end" class="${b.payTiming === 'end' ? 'on' : ''}">At the end</button></div>
    <p class="muted small" style="margin-top:6px">You pay the driver directly — cash or UPI.</p>
    <button id="request" class="btn block">Request this cab · ${rs(q.quote.riderPays)}</button>
  </div>`;
  $$('#payt button').forEach((x) => { x.onclick = () => { b.payTiming = x.dataset.p; $$('#payt button').forEach((y) => y.classList.toggle('on', y === x)); }; });
  $('#request').onclick = run(async () => {
    await api('POST', '/api/trips', { driver: b.driver, src: pointBody(b.src), dst: pointBody(b.dst), pet: b.pet, guest: guestBody(), payTiming: b.payTiming });
    S.quote = null; S.estimate = null; S.nearby = null; S.booking = { mode: 'plate', driver: '', src: b.src, dst: null, pet: false };
    await refreshTrip(); render(); window.scrollTo(0, 0);
  });
}

function payBlock(t, forDriver) {
  if (t.paidAt) return `<p class="chip">${ic('check')}Paid by ${esc(t.paymentMethod || 'cash')}</p>`;
  const pre = t.prepaid ? `<p class="chip">${ic('check')}${rs(t.prepaid.amount)} paid at start (${esc(t.prepaid.method)})</p>` : '';
  if (forDriver) {
    if (t.status === 'completed') return `${pre}<button id="gotpaid" class="btn block">${ic('wallet')}Received ${rs(t.balanceDue)}</button>`;
    return pre || (t.payTiming === 'start' ? `<p class="chip warn">${ic('wallet')}Customer chose to pay at the start</p><button id="gotpaid" class="btn ghost block">Received ${rs(t.balanceDue)} now</button>` : '<p class="muted small">Customer pays at the end.</p>');
  }
  const canPay = t.status === 'completed' || (['accepted', 'started'].includes(t.status) && t.payTiming === 'start' && !t.prepaid);
  if (!canPay) return pre || '<p class="muted small">You pay the driver at the end of the ride.</p>';
  return `${pre}<p class="muted small" style="margin-top:8px">Pay the driver ${rs(t.balanceDue)} directly, then confirm:</p>
    <div class="grid2"><button id="paycash" class="btn">Paid cash</button><button id="payupi" class="btn accent">Paid by UPI</button></div>`;
}

function renderRiderTrip(app, t) {
  const f = t.final || t.quote;
  const head = {
    requested: t.matched ? ['Finding your cab…', `Asking the nearest driver, ${t.pickupKm} km away. If there is no answer in ${S.cfg.matchOfferSeconds} seconds we ask the next one.`] : ['Waiting for the driver to accept…', `Asking ${esc(t.driver.name)} (${esc(t.driver.vehicleNumber)})`],
    accepted: ['Driver accepted', 'Get in, then tell the driver this code.'],
    started: ['On the way', t.lateMin ? `Running ${t.lateMin} min late` : `Reaching in about ${Math.max(1, Math.round((t.expectedEndAt - Date.now()) / 60000))} min`],
    completed: [t.paidAt ? 'You have arrived' : 'You have arrived — please pay', `${esc(t.dst.name)}`],
  }[t.status];
  app.innerHTML = `
    ${t.status === 'completed' ? '' : tripMapHtml(t)}
    <div class="card">${steps(t.status)}
      ${t.status === 'requested' ? `<div class="radar">${ic('car')}</div>` : ''}
      ${t.status === 'completed' ? '<div class="success"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.500 4.500L19 7.500"/></svg></div>' : ''}
      <h2 class="center">${head[0]}</h2><p class="muted center">${head[1]}</p>
      ${t.guest ? `<p class="center"><span class="chip">${ic('users')}For ${esc(t.guest.name)} · ${esc(t.guest.publicId)}</span></p>` : ''}
      ${t.otp ? `<div class="otp">${t.otp.split('').map((c) => `<span>${c}</span>`).join('')}</div><p class="muted small center">Share only after you are inside the cab.</p>` : ''}
      ${t.overdueLevel && t.status === 'started' ? `<div class="card alert"><b>${ic('alert')} Running ${t.lateMin} min late.</b> ${esc((t.trusted && t.trusted.name) || 'Your contact')} has been told.<button id="im-safe" class="btn block">I'm safe</button></div>` : ''}
      ${['requested', 'accepted'].includes(t.status) ? '<button id="cancel" class="btn ghost block">Cancel ride</button>' : ''}
    </div>
    <div class="card">${driverCard(t.driver)}</div>
    ${safetyRow(t)}
    ${t.canVerifyDriver ? `<div class="card soft"><h2>${ic('shield')} Verify your driver, get ${rs(S.cfg.verifyDiscount)} off</h2>
      <p class="muted">This driver is new on Olub. Please check in person:</p>
      ${t.driver.photos.vehicle ? `<img src="${t.driver.photos.vehicle}" alt="Vehicle" style="width:100%;border-radius:14px">` : ''}
      <label class="check"><input type="checkbox" id="c1"><span>The driver's face matches the photo</span></label>
      <label class="check"><input type="checkbox" id="c2"><span>The number plate reads <b>${esc(t.driver.vehicleNumber)}</b></span></label>
      <label class="check"><input type="checkbox" id="c3"><span>The vehicle is a ${esc(t.driver.vehicleLabel)} ${esc(t.driver.vehicleModel || '')}</span></label>
      <button id="verify" class="btn block">Confirm and verify</button></div>` : ''}
    <div class="card"><h3 style="margin-top:0">${t.final ? 'Your bill' : 'Fare'}</h3>${fareTable(f, { final: !!t.final })}
      <div style="margin-top:10px">${payBlock(t, false)}</div>
      ${t.status === 'completed' ? `<div class="row" style="margin-top:10px"><button id="inv" class="btn ghost grow">${ic('file')}Invoice</button>${t.rated ? '' : `<button id="rate" class="btn ghost grow">${ic('star')}Rate driver</button>`}</div>` : ''}
      ${t.safety && t.safety.score != null ? `<p class="muted small" style="margin-top:8px">${ic('shield')} Driving safety score for this ride: <b>${t.safety.score}</b>/100</p>` : ''}
      ${t.paidAt ? '<button id="done" class="btn block">Done</button>' : ''}</div>
    ${commsBlock(t)}`;
  mountTripMap(t);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = run(fn); };
  if ($('#cancel')) $('#cancel').onclick = () => cancelSheet(t);
  on('#im-safe', async () => { S.trip = await api('POST', `/api/trips/${t.id}/safe`); toast('Your contact has been told you are safe'); render(); });
  on('#verify', async () => {
    S.trip = await api('POST', `/api/trips/${t.id}/verify-driver`, { checks: { face: $('#c1').checked, vehicleNumber: $('#c2').checked, vehicleMatches: $('#c3').checked } });
    toast(`Thank you! ${rs(S.cfg.verifyDiscount)} off applied.`); render();
  });
  const pay = (method) => async () => { S.trip = await api('POST', `/api/trips/${t.id}/pay`, { method }); render(); if (S.trip.paidAt && !S.trip.rated) ratingSheet(S.trip); };
  on('#paycash', pay('cash')); on('#payupi', pay('upi'));
  on('#inv', () => invoiceSheet(t.id));
  if ($('#rate')) $('#rate').onclick = () => ratingSheet(t);
  if ($('#done')) $('#done').onclick = () => { S.trip = null; render(); };
  bindSafety(t); bindComms(t);
}

// ======================= DRIVER =======================
function dutyCard(d) {
  const u = d.duty; const used = Math.min(100, Math.round(u.workedMin / (u.limitHours * 60) * 100));
  const h = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  const cls = u.locked ? 'bad' : u.remainingMin <= 120 ? 'warn' : '';
  return `<div class="card"><div class="row"><div class="ring ${cls}" style="--p:${used}"><div>${Math.floor(u.workedMin / 60)}h</div></div>
    <div class="grow"><h2 style="margin:0">Driving hours</h2>
    <p class="muted small" style="margin:2px 0 0">${u.locked ? `Limit reached. Rest ${u.restHours} hours${u.restUntil ? ` — back after ${when(u.restUntil)}` : ' after this ride'}.`
    : `${h(u.remainingMin)} left today. After ${u.limitHours} hours you must rest ${u.restHours} hours.`}</p>
    ${!u.locked && u.remainingMin <= 120 ? `<p class="chip warn" style="margin-top:6px">${ic('clock')}${u.remainingMin <= 30 ? 'Less than 30 min left' : u.remainingMin <= 60 ? 'Less than 1 hour left' : 'Less than 2 hours left'}</p>` : ''}</div></div></div>`;
}

function renderDriver(app) {
  const d = S.me.driver;
  if (S.trip && S.trip.status !== 'requested') return renderDriverTrip(app, S.trip);
  const ready = !S.me.todo.length;
  app.innerHTML = `
    <div class="card hero"><div class="between"><div><h1 style="margin:0">${d.online ? 'You are online' : 'You are offline'}</h1>
        <p class="muted" style="margin:4px 0 0">${d.online ? 'Customers can scan your QR and book you.' : 'Go online to get customers.'}</p></div>
        <label class="switch" style="position:relative;z-index:1"><input type="checkbox" id="online" ${d.online ? 'checked' : ''}><i></i></label></div>
      <div class="chips" style="margin-top:12px;position:relative;z-index:1"><span class="chip">${ic('wallet')}${rs(d.wallet.balance)}</span>
        ${d.vehicleNumber ? `<span class="plate">${esc(d.vehicleNumber)}</span>` : ''}<span class="chip">${ic('star')}${S.me.rating.count ? `${S.me.rating.average.toFixed(1)} · ${S.me.rating.count} ratings` : 'No ratings yet'}</span></div></div>
    ${d.suspended ? `<div class="card alert"><b>${ic('alert')} Account on hold.</b> ${esc(d.suspended)}</div>` : ''}
    ${todoCard()}
    ${ready && !d.wallet.ok ? `<div class="card warn"><b>${ic('wallet')} Wallet below ${rs(d.wallet.min)}.</b> Top up to get customers. <button id="topup2" class="btn small" style="margin-top:8px">Top up</button></div>` : ''}
    ${d.status === 'submitted' ? `<div class="card soft">${ic('shield')} <b>Awaiting verification.</b> Your first customer can verify you in person (they get ${rs(S.cfg.verifyDiscount)} off, paid by Olub).</div>` : ''}
    ${d.status === 'rejected' ? `<div class="card alert">${ic('alert')} Documents were rejected. Please upload them again.</div>` : ''}
    <div class="card"><div class="between"><h2 style="margin:0">Ride requests</h2><button id="myqr" class="btn small ghost">${ic('target')}My QR</button></div>
      ${S.requests.map((t) => `<div class="card flat" style="margin:12px 0 0">
        <div class="between"><b>${esc(t.guest ? `${t.guest.name} (guest of ${t.rider.name})` : t.rider.name)}</b>${starsHtml(t.rider.rating)}</div>
        <div class="route" style="pointer-events:none"><button><span class="dotp"></span><span class="t">${esc(t.src.name)}</span>${pinTag(t.src)}</button><button><span class="dotd"></span><span class="t">${esc(t.dst.name)}</span>${pinTag(t.dst)}</button></div>
        <div class="chips"><span class="chip grey">${t.distanceKm} km · ${t.etaMin} min</span>${t.matched ? `<span class="chip warn">${ic('target')}Pickup is ${t.pickupKm} km away — paid for</span>` : ''}${t.pet ? `<span class="chip warn">${ic('paw')}With a pet</span>` : ''}<span class="chip grey">Pays at the ${esc(t.payTiming)}</span></div>
        <div class="between" style="margin-top:10px"><div><div class="muted small">You keep</div><div class="bignum" style="font-size:26px">${rs(t.quote.driverFare)}</div></div>
          <div class="row"><button class="btn ghost" data-rej="${t.id}">Decline</button><button class="btn" data-acc="${t.id}">Accept</button></div></div></div>`).join('')
      || `<div class="empty">${d.online ? `<div class="radar" style="width:60px;height:60px">${ic('car')}</div><div>Waiting for customers…</div>` : `${ic('car')}<div>You are offline.</div>`}</div>`}</div>
    ${ready ? dutyCard(d) : ''}`;
  bindTodos(app);
  if ($('#topup2')) $('#topup2').onclick = topupSheet;
  $('#myqr').onclick = () => (d.vehicleNumber ? qrSheet() : toast('Add your vehicle first', true));
  $('#online').onchange = (e) => {
    const want = e.target.checked;
    const go = run(async (otherAppHours) => { await api('POST', '/api/driver/online', { online: want, otherAppHours }); S.me = await api('GET', '/api/me'); render(); });
    if (!want) return go().then(() => render());
    e.target.checked = false;
    // Hours on other apps count towards the same daily limit.
    const sh = sheet('Before you go online', `<p>The law allows ${S.cfg.duty.maxHours} hours of driving a day across <b>all</b> apps, then ${S.cfg.duty.restHours} hours of rest.</p>
      <label class="f">Hours you already drove on other apps since your last long rest</label><input id="oh" type="number" inputmode="decimal" min="0" max="12" value="0">
      <button id="ohgo" class="btn block">Go online</button>`);
    $('#ohgo', sh.el).onclick = async (ev) => { ev.currentTarget.classList.add('loading'); const h = Number($('#oh').value) || 0; sh.close(); await go(h); };
  };
  $$('[data-acc]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/trips/${b.dataset.acc}/accept`); await refreshTrip(); render(); window.scrollTo(0, 0); }); });
  $$('[data-rej]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/trips/${b.dataset.rej}/reject`); await refreshTrip(); render(); }); });
}

function renderVehicle(app) {
  const d = S.me.driver; const docs = d.docs || {}; const prefs = d.prefs || {}; const pending = {};
  const docLabel = { selfie: 'Your photo', vehicle: 'Vehicle with number plate', license: 'Driving licence', rc: 'Registration (RC)', kyc: 'Aadhaar / ID' };
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <button class="btn small ghost" id="back" style="margin-bottom:10px">‹ Back</button>
    <div class="card"><h2>Your vehicle</h2><p class="muted small">Status: <b>${esc(d.status)}</b></p>
      <label class="f">Vehicle number</label><div class="plate-in"><span class="ind">IND</span><input id="v-num" value="${esc(d.vehicleNumber || '')}" placeholder="KA01AB1234" autocapitalize="characters"></div>
      <div class="grid2"><div><label class="f">Type</label><select id="v-type">${Object.entries(S.cfg.vehicles).map(([k, v]) => `<option value="${k}" ${d.vehicleType === k ? 'selected' : ''}>${v.label} · ${rs(v.perKm)}/km</option>`).join('')}</select></div>
        <div><label class="f">Condition</label><select id="v-cond">${S.cfg.conditions.map((c) => `<option ${(d.condition || 'good') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
      <div class="grid2"><div><label class="f">Model</label><input id="v-model" value="${esc(d.vehicleModel || '')}" placeholder="Swift Dzire"></div>
        <div><label class="f">State code</label><input id="v-state" value="${esc(d.state || '')}" placeholder="KA" maxlength="4" autocapitalize="characters"></div></div>
      <label class="f">Commercial permit / badge number</label><input id="v-permit" value="${esc(d.permitNo || '')}" autocapitalize="characters">
      <label class="f">Vehicle insurance valid till</label><input id="v-ins" type="date" min="${today}" value="${esc(d.insuranceValidTill || '')}">
    </div>
    <div class="card"><h2>Licence & KYC</h2>
      <label class="f">Driving licence number</label><input id="v-dl" value="${esc(d.licenseNo || '')}" autocapitalize="characters">
      <label class="f">Licence first issued on <span class="muted">(shows your driving experience)</span></label><input id="v-dli" type="date" max="${today}" value="${esc(d.licenseIssuedOn || '')}">
      <label class="f">RC number</label><input id="v-rc" value="${esc(d.rcNo || '')}" autocapitalize="characters">
      <label class="f">Aadhaar / ID number <span class="muted">(only Olub sees this)</span></label><input id="v-kyc" value="${esc(d.kycIdNo || '')}">
      <h3>Photos</h3><div class="docgrid">${Object.entries(docLabel).map(([k, l]) => `<label class="${docs[k] ? 'done' : ''}" id="l-${k}">${ic(docs[k] ? 'check' : 'camera')}<span>${l}</span><input type="file" accept="image/*,application/pdf" data-doc="${k}"></label>`).join('')}</div>
      <p class="muted small" style="margin-top:8px">${ic('lock')} Stored encrypted. Customers see only your photo and the vehicle photo.</p>
    </div>
    <div class="card"><h2>My cab rules</h2><p class="muted small">Customers see these before booking.</p>
      ${Object.entries(S.cfg.driverRules).map(([k, l]) => `<div class="toggle"><span>${ic('ban')} ${esc(l)}</span><label class="switch"><input type="checkbox" data-rule="${k}" ${prefs[k] ? 'checked' : ''}><i></i></label></div>`).join('')}
      <div class="toggle"><span>${ic('paw')} I am OK to travel with pets</span><label class="switch"><input type="checkbox" id="v-pets" ${prefs.petsOk ? 'checked' : ''}><i></i></label></div>
      <div id="petbox" ${prefs.petsOk ? '' : 'hidden'}><label class="f">Extra charge for a pet (₹0–${S.cfg.maxPetCharge})</label><input id="v-petc" type="number" inputmode="numeric" value="${prefs.petCharge || 0}"></div>
    </div>
    <div class="card soft legal"><h3 style="margin-top:0">My safety pledge</h3>${S.legal.docs.driver_conduct.body.map((p) => `<p>${esc(p)}</p>`).join('')}
      <h3>Liability</h3>${S.legal.docs.driver_terms.body.slice(4, 6).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    <button id="v-save" class="btn block">Save and submit</button>`;
  $('#back').onclick = () => { S.sub = null; render(); };
  $('#v-pets').onchange = (e) => { $('#petbox').hidden = !e.target.checked; };
  $$('[data-doc]').forEach((inp) => {
    inp.onchange = run(async () => {
      if (!inp.files[0]) return;
      pending[inp.dataset.doc] = await readImage(inp.files[0]);
      const l = $(`#l-${inp.dataset.doc}`); l.classList.add('done'); l.querySelector('svg').outerHTML = ic('check');
    });
  });
  $('#v-save').onclick = run(async () => {
    const p = { petsOk: $('#v-pets').checked, petCharge: Number($('#v-petc').value) || 0 };
    $$('[data-rule]').forEach((c) => { p[c.dataset.rule] = c.checked; });
    const r = await api('PUT', '/api/driver/profile', {
      vehicleNumber: $('#v-num').value, vehicleType: $('#v-type').value, condition: $('#v-cond').value, vehicleModel: $('#v-model').value, state: $('#v-state').value,
      permitNo: $('#v-permit').value, insuranceValidTill: $('#v-ins').value, licenseNo: $('#v-dl').value, licenseIssuedOn: $('#v-dli').value,
      rcNo: $('#v-rc').value, kycIdNo: $('#v-kyc').value, docs: pending, prefs: p,
    });
    S.me = r.me;
    if (r.missing.length) return toast(`Saved. Still needed: ${r.missing.map((m) => docLabel[m] || m.replace(/_/g, ' ')).join(', ')}`, true);
    toast('Submitted'); S.sub = null; S.tab = 'home'; render(); window.scrollTo(0, 0);
  });
}

function renderDriverTrip(app, t) {
  const f = t.final || t.quote;
  const who = t.guest ? `${esc(t.guest.name)} <span class="muted small">guest of ${esc(t.rider.name)}</span>` : esc(t.rider.name);
  app.innerHTML = `
    ${t.status === 'completed' ? '' : tripMapHtml(t)}
    <div class="card">${steps(t.status)}
      <div class="between"><h2 style="margin:0">${{ accepted: 'Pick up your customer', started: 'Ride in progress', completed: t.paidAt ? 'Ride complete' : 'Collect payment' }[t.status]}</h2>${starsHtml(t.rider.rating)}</div>
      <p style="margin:6px 0">${t.rider.photo ? `<img src="${t.rider.photo}" alt="" class="avatar" style="width:40px;height:40px;border-radius:12px;vertical-align:middle;margin-right:8px">` : ''}<b>${who}</b> · <span class="chip grey">${esc((t.guest || t.rider).publicId)}</span> ${t.pet ? `<span class="chip warn">${ic('paw')}Pet</span>` : ''}</p>
      ${t.status === 'accepted' ? `
        <label class="f">Customer's 4-digit code</label><input id="otp" inputmode="numeric" maxlength="4" class="otp-in" placeholder="••••">
        <label class="check"><input type="checkbox" id="fit"><span><b>I am healthy, fit and fine to drive.</b> I have not had alcohol, tobacco or drugs, and I am not sleepy or unwell.</span></label>
        <button id="start" class="btn block" disabled>Start ride</button><button id="cancel" class="btn ghost block">Cancel</button>` : ''}
      ${t.status === 'started' ? `<p class="muted">${t.lateMin ? `<b style="color:var(--danger)">Running ${t.lateMin} min late.</b>` : `Expected to reach by ${new Date(t.expectedEndAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.`} Waiting time is measured automatically.</p>
        <button id="complete" class="btn block">${ic('pin')}End ride</button>` : ''}
    </div>
    ${safetyRow(t)}
    ${t.status === 'started' ? `<div class="card"><h2>Tolls</h2>
      ${t.tolls.map((x) => `<div class="between" style="padding:6px 0"><span>${esc(x.name)} · <b>${rs(x.amount)}</b> <span class="muted small">${esc(x.amountSource)}</span></span><button class="btn small ghost" data-rmtoll="${x.id}">Not crossed</button></div>
        ${x.status !== 'verified' && !x.reportedByMe ? `<div class="card soft" style="margin:6px 0"><b>Help confirm this toll</b> <span class="muted small">${x.reports}/${x.reportsNeeded} drivers</span>
          <div class="row" style="margin-top:8px"><div class="grow"><input type="number" inputmode="numeric" placeholder="Amount you paid ₹" data-tamt="${x.id}"></div>
          <label class="btn small ghost">${ic('camera')}<input type="file" accept="image/*" capture="environment" data-tphoto="${x.id}" hidden></label><button class="btn small" data-tsend="${x.id}">Send</button></div></div>` : ''}`).join('') || '<p class="muted small">No tolls on this route.</p>'}
      <h3>Crossed a toll that is not listed?</h3>
      <input id="tname" placeholder="Toll plaza name">
      <div class="row" style="margin-top:8px"><div class="grow"><input id="tamt" type="number" inputmode="numeric" placeholder="Amount paid ₹"></div><label class="btn small ghost">${ic('camera')}Receipt<input id="tphoto" type="file" accept="image/*" capture="environment" hidden></label></div>
      <button id="addtoll" class="btn ghost block">Add toll here</button>
      <p class="muted small" style="margin-top:8px">New tolls are charged at the state default (${rs(S.cfg.stateDefaultToll[t.state] || S.cfg.defaultToll)}) until ${S.cfg.tollConfirmationsRequired} more drivers confirm the amount.</p></div>` : ''}
    <div class="card"><h3 style="margin-top:0">${t.final ? 'Final bill' : 'Fare'}</h3>${fareTable(f, { final: !!t.final, forDriver: true })}
      <div style="margin-top:10px">${payBlock(t, true)}</div>
      ${t.status === 'completed' ? `<div class="row" style="margin-top:10px"><button id="inv" class="btn ghost grow">${ic('file')}Invoice</button>${t.rated ? '' : `<button id="rate" class="btn ghost grow">${ic('star')}Rate customer</button>`}</div>` : ''}
      ${t.safety && t.safety.score != null ? `<p class="muted small" style="margin-top:8px">${ic('shield')} Your safety score for this ride: <b>${t.safety.score}</b>/100${t.safety.overspeed ? ` · ${t.safety.overspeed} overspeed` : ''}${t.safety.harshBrakes ? ` · ${t.safety.harshBrakes} harsh braking` : ''}</p>` : ''}
      ${t.paidAt ? '<button id="done" class="btn block">Back to home</button>' : ''}</div>
    ${commsBlock(t)}`;
  mountTripMap(t);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = run(fn); };
  if ($('#fit')) {
    const sync = () => { $('#start').disabled = !($('#fit').checked && $('#otp').value.trim().length === 4); };
    $('#fit').onchange = sync; $('#otp').oninput = sync;
  }
  on('#start', async () => { S.trip = await api('POST', `/api/trips/${t.id}/start`, { otp: $('#otp').value, fitDeclaration: $('#fit').checked }); syncTracking(); render(); });
  if ($('#cancel')) $('#cancel').onclick = () => cancelSheet(t);
  on('#complete', async () => { S.trip = await api('POST', `/api/trips/${t.id}/complete`, {}); S.me = await api('GET', '/api/me'); syncTracking(); render(); window.scrollTo(0, 0); });
  on('#gotpaid', async () => { S.trip = await api('POST', `/api/trips/${t.id}/pay`, { method: 'cash' }); render(); if (S.trip.paidAt && !S.trip.rated) ratingSheet(S.trip); });
  on('#inv', () => invoiceSheet(t.id));
  if ($('#rate')) $('#rate').onclick = () => ratingSheet(t);
  on('#done', async () => { S.trip = null; await refreshTrip(); render(); });

  const photos = {};
  $$('[data-tphoto]').forEach((i) => { i.onchange = run(async () => { photos[i.dataset.tphoto] = await readImage(i.files[0], 900); toast('Photo attached'); }); });
  $$('[data-tsend]').forEach((b) => { b.onclick = run(async () => {
    const id = b.dataset.tsend;
    await api('POST', `/api/trips/${t.id}/tolls`, { tollId: Number(id), amount: Number($(`[data-tamt="${id}"]`).value), photo: photos[id] });
    toast('Thanks! Toll report sent.'); await refreshTrip(); render();
  }); });
  $$('[data-rmtoll]').forEach((b) => { b.onclick = run(async () => { await api('DELETE', `/api/trips/${t.id}/tolls/${b.dataset.rmtoll}`); await refreshTrip(); render(); }); });
  let newPhoto = null;
  if ($('#tphoto')) $('#tphoto').onchange = run(async () => { newPhoto = await readImage($('#tphoto').files[0], 900); toast('Photo attached'); });
  on('#addtoll', async () => {
    const pos = await here().catch(() => t.last || { lat: (t.src.lat + t.dst.lat) / 2, lng: (t.src.lng + t.dst.lng) / 2 });
    await api('POST', `/api/trips/${t.id}/tolls`, { name: $('#tname').value, amount: Number($('#tamt').value), photo: newPhoto, lat: pos.lat, lng: pos.lng });
    toast('Toll added to this ride'); await refreshTrip(); render();
  });
  bindSafety(t); bindComms(t);
}

// ======================= ADMIN =======================
const ADMIN_TABS = [['compliance', 'Compliance'], ['demo', 'Demo data'], ['drivers', 'Driver KYC'], ['authority', 'Police / RTO'], ['privacy', 'Privacy requests'], ['feedback', 'Feedback'], ['users', 'People & audit'], ['rates', 'Rates'], ['calamity', 'Rain / calamity'], ['tolls', 'Tolls'], ['outbox', 'Messages']];

async function renderAdmin(app) {
  if (!ADMIN_TABS.some((t) => t[0] === S.sub)) S.sub = 'compliance';
  app.innerHTML = `<div class="subtabs">${ADMIN_TABS.map(([k, l]) => `<button data-sub="${k}" class="${S.sub === k ? 'on' : ''}">${l}</button>`).join('')}</div><div id="pane"><div class="skel"></div><div class="skel"></div></div>`;
  $$('[data-sub]').forEach((b) => { b.onclick = () => { S.sub = b.dataset.sub; render(); }; });
  const pane = $('#pane'); const sub = S.sub;
  try { await ADMIN[sub](pane); } catch (e) { if (S.sub === sub) pane.innerHTML = `<div class="card alert">${esc(e.message)}</div>`; }
}
const download = (name, text) => {
  if (Native && Native.saveText) return Native.saveText(name, text);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = name; a.click();
};
const kv = (o) => `<dl class="kv">${Object.entries(o).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const hm = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

const ADMIN = {
  async demo(pane) {
    const d = await api('GET', '/api/admin/demo');
    const note = { 9000000101: 'on a ride right now', 9000000102: 'has a ride request waiting', 9000000103: 'new, awaiting verification', 9000000104: 'wallet below ₹100',
      9000000201: 'most trips; open privacy complaint', 9000000202: 'waiting for a driver to accept', 9000000203: 'in a ride right now', 9000000204: 'had a cancellation fee' };
    pane.innerHTML = `<div class="card"><h2>Demo data</h2>
      <p class="muted">Loads 4 drivers, 4 customers and 15 trips around Lucknow: completed, cancelled by either side, declined, one waiting for a driver and one in progress — with ratings, wallet history, invoices, a toll and a guest booking.</p>
      ${d.loaded ? `<p class="chip">${ic('check')}Demo data is loaded</p>` : `<button id="dload" class="btn block">${ic('download')}Load demo data</button>`}</div>
      ${d.loaded ? `<div class="card"><h2>Log in as…</h2><p class="muted small">Log out, enter one of these numbers, and use the code shown on screen.</p>
        <table class="logins">${d.logins.map((u) => `<tr><td>${ic(u.role === 'driver' ? 'car' : 'user')}</td><td><b>${esc(u.name)}</b><div class="muted small">${esc(note[u.phone] || '')}</div></td><td style="text-align:right;font-family:ui-monospace,monospace"><b>${esc(u.phone)}</b><div class="muted small">${esc(u.publicId)}</div></td></tr>`).join('')}</table></div>` : ''}`;
    if ($('#dload')) $('#dload').onclick = run(async () => { const r = await api('POST', '/api/admin/demo'); toast(r.message); render(); });
  },

  async compliance(pane) {
    const c = await api('GET', '/api/admin/compliance');
    pane.innerHTML = `
      <div class="grid2" style="margin-bottom:12px">
        <div class="stat good"><div class="v">${c.trips.commissionPercent}%</div><div class="l">Olub share of fares (law: max 20%)</div></div>
        <div class="stat"><div class="v">${c.trips.completed}</div><div class="l">Completed trips</div></div>
        <div class="stat"><div class="v">${rs(c.trips.rideGst + c.trips.platformFeeGst)}</div><div class="l">GST to remit</div></div>
        <div class="stat ${c.trips.withoutFitDeclaration ? '' : 'good'}"><div class="v">${c.trips.withoutFitDeclaration}</div><div class="l">Rides without fit-to-drive tick</div></div>
        <div class="stat"><div class="v">${c.activeVehicleFlags}</div><div class="l">Vehicles flagged by police / RTO</div></div>
        <div class="stat ${c.auditLog.ok ? 'good' : ''}"><div class="v">${c.auditLog.ok ? 'Intact' : 'BROKEN'}</div><div class="l">Audit log${c.auditLog.ok ? ` · ${c.auditLog.entries} entries` : ` at #${c.auditLog.brokenAt}`}</div></div>
      </div>
      <div class="card"><h2>Rules the app enforces</h2>${kv({ 'Driving hours': c.rules.dutyLimit, 'Platform fee': c.rules.commissionCap, 'Health check': c.rules.fitDeclaration, 'Cancellation fee': c.rules.cancellationFeeCap, Grievance: c.rules.grievanceOfficer })}</div>
      <div class="card"><h2>Drivers</h2>${kv({ Total: c.drivers.total, Verified: c.drivers.verified, 'Awaiting verification': c.drivers.awaitingVerification, 'Online now': c.drivers.online, 'On hold': c.drivers.suspended, 'Insurance expired': c.drivers.insuranceExpired, 'Wallet below minimum': c.drivers.walletBelowMinimum, 'Forced rests (30 days)': c.dutyLockouts30d })}
        ${c.drivers.insuranceExpiringSoon.length ? `<h3>Insurance expiring in 30 days</h3>${c.drivers.insuranceExpiringSoon.map((d) => `<div class="between small"><span>${esc(d.name)} · ${esc(d.vehicle)}</span><b>${esc(d.validTill)}</b></div>`).join('')}` : ''}</div>
      <div class="card"><h2>Driving hours today</h2><div class="list">${c.dutyHours.map((d) => `<div class="between"><div><b>${esc(d.name)}</b> <span class="plate">${esc(d.vehicle || '')}</span><div class="muted small">${esc(d.driverId)} · ${d.online ? 'online' : 'offline'}${d.restUntil ? ` · resting till ${when(d.restUntil)}` : ''}</div></div>
        <span class="chip ${d.locked ? 'danger' : d.remainingMin < 120 ? 'warn' : ''}">${hm(d.workedMin)} / 12h</span></div>`).join('') || '<p class="muted">No drivers yet.</p>'}</div></div>
      <div class="card"><h2>Safety & requests</h2>${kv({ 'SOS pressed': c.safety.sos || 0, 'Route deviations': c.safety.route_deviation || 0, 'Late-ride alerts': c.lateAlerts, 'Privacy requests': JSON.stringify(c.privacyRequests), 'Police / RTO requests': JSON.stringify(c.authorityRequests) })}</div>
      <div class="card"><h2>Trip register for authorities</h2><p class="muted small">Every trip with driver, vehicle, DIGIPINs, fare, GST and the fit-to-drive record. Hand this over when a transport authority asks.</p>
        <div class="grid2"><div><label class="f">From</label><input id="r-from" type="date"></div><div><label class="f">To</label><input id="r-to" type="date"></div></div>
        <button id="r-dl" class="btn block">${ic('download')}Download CSV</button></div>`;
    $('#r-dl').onclick = run(async () => {
      const rows = await api('GET', `/api/admin/compliance/trip-register?from=${$('#r-from').value}&to=${$('#r-to').value}`);
      if (!rows.length) return toast('No trips in that period', true);
      const cols = Object.keys(rows[0]);
      download('olub-trip-register.csv', [cols.join(','), ...rows.map((r) => cols.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'));
    });
  },

  async drivers(pane) {
    const list = await api('GET', '/api/admin/drivers?status=submitted');
    pane.innerHTML = `<div class="card"><h2>Awaiting verification</h2><p class="muted small">Customers can also verify a driver in person.</p></div>${list.map((d) => `<div class="card">${driverCard(d)}
      <div style="margin-top:10px">${kv({ Mobile: d.phone, Email: d.email || '—', Licence: `${d.licenseNo} (since ${d.licenseIssuedOn})`, RC: d.rcNo, Permit: d.permitNo, 'ID number': d.kycIdNo, 'Insurance till': d.insuranceValidTill })}</div>
      <div class="chips" style="margin-top:10px">${Object.entries(d.docs).map(([k, v]) => `<a class="chip" href="${v}" target="_blank" rel="noopener">${ic('eye')}${esc(k)}</a>`).join('')}</div>
      <div class="grid2" style="margin-top:12px"><button class="btn danger" data-no="${d.id}">Reject</button><button class="btn" data-ok="${d.id}">Approve</button></div></div>`).join('') || `<div class="card empty">${ic('check')}<div>Nothing pending.</div></div>`}`;
    const review = (id, approve) => run(async () => { await api('POST', `/api/admin/drivers/${id}/review`, { approve }); render(); });
    $$('[data-ok]').forEach((b) => { b.onclick = review(b.dataset.ok, true); });
    $$('[data-no]').forEach((b) => { b.onclick = review(b.dataset.no, false); });
  },

  async authority(pane) {
    const [reqs, flags] = await Promise.all([api('GET', '/api/admin/lea'), api('GET', '/api/admin/flags')]);
    pane.innerHTML = `
      <div class="card soft small">Officers apply at <b>${esc(S.base || location.origin)}/authority</b> with a government email and a signed letter. Data requests are answered automatically ${S.cfg.lea.publicDays > 3 ? 'after the 3-day review window' : ''} unless you refuse them here. Every step is in the audit log.</div>
      <div class="card"><h2>Flagged vehicles</h2><div class="list">${flags.map((f) => `<div><div class="between"><span><span class="plate">${esc(f.vehicleNumber)}</span> ${f.driver ? esc(f.driver.name) : '<span class="muted">not on Olub</span>'}</span><span class="chip ${f.status === 'active' ? 'danger' : 'grey'}">${esc(f.status)}</span></div>
        <div class="muted small">${esc(S.cfg.lea.agencies[f.agency] || '')} · ${esc(f.officer || '')} · ${esc(f.caseRef || '')} · ${when(f.createdAt)}</div><p class="small" style="margin:4px 0">${esc(f.reason)}</p>
        ${f.status === 'active' ? `<div class="row">${f.driver ? `<button class="btn small ${f.driver.suspended ? 'ghost' : 'danger'}" data-susp="${f.driver.id}" data-on="${f.driver.suspended ? '' : '1'}">${f.driver.suspended ? 'Lift hold' : 'Put driver on hold'}</button>` : ''}<button class="btn small ghost" data-clear="${f.id}">Clear flag</button></div>` : ''}</div>`).join('') || '<p class="muted">No flags.</p>'}</div></div>
      <div class="card"><h2>Requests</h2><div class="list">${reqs.map((r) => `<div><div class="between"><b>${esc(r.ref)} · ${r.kind === 'flag' ? 'Vehicle flag' : 'Data request'}</b><span class="chip ${r.status === 'under_review' ? 'warn' : r.status === 'released' ? '' : 'grey'}">${esc(r.status.replace('_', ' '))}</span></div>
        <div class="muted small">${esc(r.agencyLabel)} · ${esc(r.officerName)}, ${esc(r.designation || '')}, ${esc(r.office || '')}<br>${esc(r.email)} ${r.emailVerified ? '✓ verified' : '(not verified)'} · ${esc(r.caseRef)}${r.legalBasis ? ` · ${esc(r.legalBasis)}` : ''}</div>
        <p class="small" style="margin:4px 0">${esc(r.details || '')} ${r.vehicleNumber ? `<span class="plate">${esc(r.vehicleNumber)}</span>` : ''} ${r.driverId ? esc(r.driverId) : ''} ${r.tripId ? `trip #${r.tripId}` : ''}</p>
        ${r.status === 'under_review' ? `<p class="small muted">Auto-answer on ${when(r.autoReleaseAt)} · promised by ${when(r.answerBy)}</p>
          <div class="row wrap"><button class="btn small ghost" data-proof="${r.id}">${ic('eye')}Letter</button><button class="btn small" data-rel="${r.id}">Release now</button><button class="btn small danger" data-ref="${r.id}">Refuse</button></div>` : `<p class="small muted">${esc(r.response || '')}</p>`}</div>`).join('') || '<p class="muted">No requests.</p>'}</div></div>`;
    $$('[data-proof]').forEach((b) => { b.onclick = run(async () => { const p = await api('GET', `/api/admin/lea/${b.dataset.proof}/proof`); sheet('Authorisation letter', p.proof.startsWith('data:image') ? `<img src="${p.proof}" style="width:100%;border-radius:12px">` : `<a class="btn block" href="${p.proof}" target="_blank" rel="noopener">Open PDF</a>`); }); });
    $$('[data-rel]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/admin/lea/${b.dataset.rel}/resolve`, { action: 'release' }); render(); }); });
    $$('[data-ref]').forEach((b) => { b.onclick = run(async () => { const why = prompt('Reason for refusing (sent to the officer):'); if (!why) return; await api('POST', `/api/admin/lea/${b.dataset.ref}/resolve`, { action: 'reject', response: why }); render(); }); });
    $$('[data-clear]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/admin/flags/${b.dataset.clear}/clear`); render(); }); });
    $$('[data-susp]').forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/admin/drivers/${b.dataset.susp}/suspend`, { suspend: !!b.dataset.on, reason: 'Flagged by a government authority' }); render(); }); });
  },

  async privacy(pane) {
    const list = await api('GET', '/api/admin/dsr');
    pane.innerHTML = `<div class="card soft small">Copies, deletions and consent withdrawals are answered automatically ${S.cfg.dsrPublicDays ? 'on day 5' : ''} (internal target 7 days; website promise ${S.cfg.dsrPublicDays - 2}–${S.cfg.dsrPublicDays} days). Corrections and complaints need your answer.</div>
      <div class="card"><div class="list">${list.map((r) => `<div><div class="between"><b>${esc(r.publicId)} · ${esc(r.typeLabel)}</b><span class="chip ${r.status === 'received' ? (r.overdueInternally ? 'danger' : 'warn') : 'grey'}">${esc(r.status)}${r.overdueInternally ? ' · late' : ''}</span></div>
        <div class="muted small">${esc(r.user.name)} (${esc(r.user.publicId)}) · ${when(r.createdAt)} · due ${when(r.internalDueAt)}${r.handledBy ? ` · by ${esc(r.handledBy)}` : ''}</div>
        ${r.details ? `<p class="small" style="margin:4px 0">${esc(r.details)}</p>` : ''}${r.response ? `<p class="small muted" style="margin:4px 0">${esc(r.response)}</p>` : ''}
        ${r.status === 'received' ? `<div class="row"><button class="btn small" data-done="${r.id}" data-type="${r.type}">Answer now</button><button class="btn small ghost" data-rej="${r.id}">Reject</button></div>` : ''}</div>`).join('') || '<p class="muted">No privacy requests.</p>'}</div></div>`;
    $$('[data-done]').forEach((b) => { b.onclick = run(async () => {
      const needs = ['correction', 'grievance'].includes(b.dataset.type);
      const response = needs ? prompt('Your answer to the person:') : undefined;
      if (needs && !response) return;
      await api('POST', `/api/admin/dsr/${b.dataset.done}/resolve`, { action: 'complete', response }); render();
    }); });
    $$('[data-rej]').forEach((b) => { b.onclick = run(async () => { const why = prompt('Reason for rejecting:'); if (!why) return; await api('POST', `/api/admin/dsr/${b.dataset.rej}/resolve`, { action: 'reject', response: why }); render(); }); });
  },

  async feedback(pane) {
    const list = await api('GET', '/api/admin/feedback');
    pane.innerHTML = `<div class="card soft small">${ic('eye')} Only admins see who wrote each rating. Customers and drivers see them monthly without names.</div>
      <div class="card"><div class="list">${list.map((r) => `<div><div class="between"><b>${esc(r.from)}</b><span class="stars">${ic('star', 'fill')} ${r.overall}</span></div>
        <div class="muted small">rated ${esc(r.to)} · trip #${r.tripId} · ${when(r.createdAt)}</div>
        <div class="chips" style="margin:6px 0">${Object.entries(r.scores).map(([k, v]) => `<span class="chip grey">${esc(k)} ${v}</span>`).join('')}</div>
        ${r.good ? `<div class="quote-note good">${esc(r.good)}</div>` : ''}${r.bad ? `<div class="quote-note bad">${esc(r.bad)}</div>` : ''}${r.improve ? `<div class="quote-note improve">${esc(r.improve)}</div>` : ''}</div>`).join('') || '<p class="muted">No ratings yet.</p>'}</div></div>`;
  },

  async users(pane) {
    pane.innerHTML = `<div class="card"><div class="row"><div class="grow"><input id="uq" placeholder="Name, mobile, email or Olub ID"></div><button id="ugo" class="btn">${ic('search')}</button></div><div id="ulist" class="menu" style="margin-top:8px"></div></div>
      <div id="trail"></div><div class="card"><div class="between"><h2 style="margin:0">Latest activity</h2><button id="averify" class="btn small ghost">Check log integrity</button></div><div id="alog" class="list" style="margin-top:10px"></div></div>`;
    const line = (a) => `<div class="audit"><b>${esc(a.action)}</b> ${a.entityId ? `#${esc(a.entityId)}` : ''} <span class="muted">· ${when(a.ts)} · ${esc(a.actorName || a.actorRole || 'system')} ${esc(a.actorPublicId || '')} · ${esc(a.ip || '')}</span>
      <div class="muted">${esc(JSON.stringify(a.details || {}).slice(0, 260))}</div></div>`;
    $('#alog').innerHTML = (await api('GET', '/api/admin/audit?limit=60')).map(line).join('');
    $('#averify').onclick = run(async () => { const v = await api('GET', '/api/admin/audit/verify'); toast(v.ok ? `Audit log intact — ${v.entries} entries` : `Audit log was changed at entry #${v.brokenAt}`, !v.ok); });
    const search = run(async () => {
      const us = await api('GET', `/api/admin/users?q=${encodeURIComponent($('#uq').value)}`);
      $('#ulist').innerHTML = us.map((u) => `<button data-u="${u.id}">${ic(u.role === 'driver' ? 'car' : 'user')}<span class="grow"><b>${esc(u.name)}</b><div class="muted small">${esc(u.publicId)} · ${esc(u.phone)} · ${esc(u.status)}</div></span>${ic('right')}</button>`).join('') || '<p class="muted">No one found.</p>';
      $$('[data-u]').forEach((b) => { b.onclick = run(async () => {
        const t = await api('GET', `/api/admin/users/${b.dataset.u}/trail`);
        $('#trail').innerHTML = `<div class="card"><h2>${esc(t.user.name)} · ${esc(t.user.publicId)}</h2>
          ${kv({ Mobile: t.user.phone, Email: `${t.user.email || '—'}${t.user.emailVerified ? ' ✓' : ''}`, 'Age / sex': `${t.user.age ?? '—'} / ${t.user.gender || '—'}`, Rating: t.user.rating.average ?? '—', 'Trusted contact': t.user.trusted ? `${t.user.trusted.name} ${t.user.trusted.phone}` : '—' })}
          <h3>Consents</h3>${t.consents.map((c) => `<div class="small">${esc(c.doc)} v${esc(c.version)} · ${when(c.acceptedAt)}${c.withdrawnAt ? ' · withdrawn' : ''}</div>`).join('')}
          <h3>Trips (${t.trips.length})</h3>${t.trips.map((x) => `<div class="small">#${x.id} ${esc(x.status)} · ${esc(x.from)} → ${esc(x.to)} · ${x.amount != null ? rs(x.amount) : ''} · ${x.fitDeclaredAt ? 'fit ✓' : ''} · ${when(x.createdAt)}<br><span class="muted">${esc(x.rider)} ↔ ${esc(x.driver)}</span></div>`).join('') || '<p class="muted small">None</p>'}
          <h3>Ratings received (${t.ratingsReceived.length})</h3>${t.ratingsReceived.map((r) => `<div class="small">★ ${r.overall} from ${esc(r.from)} — ${esc([r.good, r.bad, r.improve].filter(Boolean).join(' / '))}</div>`).join('') || '<p class="muted small">None</p>'}
          <h3>Ratings given (${t.ratingsGiven.length})</h3>${t.ratingsGiven.map((r) => `<div class="small">★ ${r.overall} to ${esc(r.to)} — ${esc([r.good, r.bad, r.improve].filter(Boolean).join(' / '))}</div>`).join('') || '<p class="muted small">None</p>'}
          <h3>Full audit trail (${t.audit.length})</h3><div class="list">${t.audit.map((a) => line({ ...a, actorName: a.actorRole })).join('')}</div></div>`;
        $('#trail').scrollIntoView({ behavior: 'smooth' });
      }); });
    });
    $('#ugo').onclick = search; search();
  },

  async rates(pane) {
    const r = await api('GET', '/api/admin/rates');
    pane.innerHTML = `<div class="card"><h2>Rate card</h2><p class="muted small">Per-km prices for each vehicle type. Defaults follow typical app-cab pricing. Changes apply to new bookings.</p>
      <table class="rates"><tr><th></th><th>Base ₹</th><th>₹ / km</th><th>₹ / wait min</th><th>Min ₹</th></tr>
      ${Object.entries(r).map(([k, v]) => `<tr><td><b>${esc(v.label)}</b></td>${['base', 'perKm', 'perWaitMin', 'minFare'].map((f) => `<td><input type="number" step="0.5" data-r="${k}.${f}" value="${v[f]}"></td>`).join('')}</tr>`).join('')}</table>
      <button id="rsave" class="btn block">Save rates</button>
      <p class="muted small" style="margin-top:8px">Traffic waiting comes from ${S.cfg.liveTraffic ? 'Google Maps live traffic' : 'a time-of-day estimate (add a Google Maps key for live traffic)'}. GST: ${S.cfg.gst.ride * 100}% on rides; the ${rs(S.cfg.platformFee)} fee includes ${S.cfg.gst.platformFee * 100}% GST.</p></div>`;
    $('#rsave').onclick = run(async () => {
      const body = {};
      $$('[data-r]').forEach((i) => { const [k, f] = i.dataset.r.split('.'); (body[k] = body[k] || {})[f] = Number(i.value); });
      await api('PUT', '/api/admin/rates', body); S.cfg = await api('GET', '/api/config'); toast('Rates saved');
    });
  },

  async calamity(pane) {
    const cfg = await api('GET', '/api/config');
    pane.innerHTML = `<div class="card"><h2>${ic('cloud')} Rain / calamity mode</h2><p class="muted small">While on, Olub's fee is halved in that state (${rs(cfg.platformFee / 2)} instead of ${rs(cfg.platformFee)}, ${rs(cfg.platformFeeLong / 2)} instead of ${rs(cfg.platformFeeLong)}).</p>
      <div class="list">${cfg.calamity.map((c) => `<div class="between"><span><b>${esc(c.state === '*' ? 'All India' : c.state)}</b> — ${esc(c.reason)}</span><button class="btn small ghost" data-off="${esc(c.state)}">Turn off</button></div>`).join('') || '<p class="muted">Normal everywhere.</p>'}</div>
      <div class="grid2" style="margin-top:10px"><input id="cs" placeholder="State (KA) or * for all" maxlength="4" autocapitalize="characters"><input id="cr" placeholder="Reason (Heavy rain)"></div>
      <button id="con" class="btn block">Turn on</button></div>`;
    $('#con').onclick = run(async () => { await api('POST', '/api/admin/calamity', { state: $('#cs').value || '*', reason: $('#cr').value, on: true }); render(); });
    $$('[data-off]').forEach((b) => { b.onclick = run(async () => { await api('POST', '/api/admin/calamity', { state: b.dataset.off, on: false }); render(); }); });
  },

  async tolls(pane) {
    const tolls = await api('GET', '/api/tolls');
    pane.innerHTML = `<div class="card"><h2>Tolls reported by drivers</h2><div class="list">${tolls.map((t) => `<div><div class="between"><b>${esc(t.name)} (${esc(t.state)})</b><span class="chip ${t.status === 'verified' ? '' : 'warn'}">${esc(t.status)}</span></div>
      <div class="muted small">${rs(t.amount)} · ${esc(t.amountSource)} · ${t.reports}/${t.reportsNeeded} reports · <span class="digipin">${esc(Digipin.encode(t.lat, t.lng) || '')}</span></div></div>`).join('') || '<p class="muted">No tolls reported yet.</p>'}</div></div>`;
  },

  async outbox(pane) {
    const list = await api('GET', '/api/admin/outbox');
    pane.innerHTML = `<div class="card soft small">SMS and emails Olub has queued (trusted-contact alerts, privacy and authority replies). Connect an SMS / email provider to deliver them.</div>
      <div class="card"><div class="list">${list.map((m) => `<div class="small"><div class="between"><b>${esc(m.template)}</b><span class="chip grey">${esc(m.channel)} · ${esc(m.status)}</span></div><div class="muted">${esc(m.to_addr)} · ${when(m.ts)}</div><div>${esc(m.body)}</div></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div></div>`;
  },
};
