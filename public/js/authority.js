'use strict';
/* Public page for police, RTO and courts: request information or flag a vehicle. */
window.openTodo = function () {};

(async function () {
  const cfg = await api('GET', '/api/config');
  const app = $('#app');
  let kind = 'data';

  function form() {
    app.innerHTML = `
      <div class="card hero"><h1>Information requests & vehicle flags</h1>
        <p class="muted">For police, transport departments (RTO) and courts. Every request is logged. You must confirm a government email, attach a signed letter and declare that the request is genuine. We answer within ${cfg.lea.publicDays}.</p></div>
      <div class="card">
        <div class="seg" id="kind"><button data-k="data" class="on">Request information</button><button data-k="flag">Flag a vehicle</button></div>
        <label class="f">Agency</label><select id="agency">${Object.entries(cfg.lea.agencies).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
        <label class="f">Your name</label><input id="officer">
        <div class="grid2"><div><label class="f">Designation</label><input id="desig"></div><div><label class="f">Station / office</label><input id="office"></div></div>
        <label class="f">Official government email (.gov.in / .nic.in)</label><input id="email" type="email" autocapitalize="off">
        <label class="f">FIR / case / file reference</label><input id="case">
        <label class="f">Legal provision (optional)</label><input id="basis" placeholder="e.g. BNSS s.94">
        <h3>About</h3>
        <label class="f">Vehicle number</label><input id="veh" placeholder="KA01AB1234" autocapitalize="characters">
        <div class="grid2"><div><label class="f">or Olub driver ID</label><input id="drv" placeholder="OLB-D-…" autocapitalize="characters"></div>
          <div><label class="f">or trip number</label><input id="trip" inputmode="numeric"></div></div>
        <div class="grid2" id="dates"><div><label class="f">From</label><input id="from" type="date"></div><div><label class="f">To</label><input id="to" type="date"></div></div>
        <label class="f" id="dl">What information is needed, and why?</label><textarea id="details" maxlength="1000"></textarea>
        <label class="f">Signed request letter / authorisation (photo or PDF)</label><input id="proof" type="file" accept="image/*,application/pdf">
        <label class="check"><input type="checkbox" id="declared"><span>I declare that this information is required for my official work and that this request is genuine. I understand it is kept on record.</span></label>
        <button id="go" class="btn block">Send verification code to my email</button>
      </div>
      <div class="card"><h2>Already applied?</h2>
        <div class="grid2"><input id="ref" placeholder="LEA-XXXXXX" autocapitalize="characters"><input id="key" placeholder="Access key" autocapitalize="off"></div>
        <button id="check" class="btn ghost block">Check status / open information</button></div>`;
    $$('#kind button').forEach((b) => {
      b.onclick = () => {
        kind = b.dataset.k;
        $$('#kind button').forEach((x) => x.classList.toggle('on', x === b));
        $('#dates').hidden = kind === 'flag';
        $('#dl').textContent = kind === 'flag' ? 'Why is this vehicle being flagged?' : 'What information is needed, and why?';
      };
    });
    $('#go').onclick = run(async () => {
      const f = $('#proof').files[0];
      const proof = f ? await readImage(f, 1600) : null;
      verify(await api('POST', '/api/authority/requests', {
        kind, agency: $('#agency').value, officerName: $('#officer').value, designation: $('#desig').value, office: $('#office').value,
        email: $('#email').value, caseRef: $('#case').value, legalBasis: $('#basis').value, vehicleNumber: $('#veh').value, driverId: $('#drv').value,
        tripId: $('#trip').value, from: $('#from').value, to: $('#to').value, details: $('#details').value, proof, declared: $('#declared').checked,
      }));
    });
    $('#check').onclick = run(() => show($('#ref').value.trim().toUpperCase(), $('#key').value.trim()));
  }

  function verify(r) {
    app.innerHTML = `<div class="card"><h2>Check your government email</h2><p class="muted">We sent a 6-digit code for request <b>${esc(r.ref)}</b>.</p>
      <input id="code" class="otp-in" inputmode="numeric" maxlength="6"><p class="muted small">${r.devCode ? `Test mode code: ${r.devCode}` : ''}</p>
      <button id="v" class="btn block">Verify</button></div>`;
    $('#v').onclick = run(async () => {
      const v = await api('POST', `/api/authority/requests/${r.ref}/verify`, { code: $('#code').value });
      app.innerHTML = `<div class="card center"><div class="success"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h2>Request ${esc(v.ref)} received</h2>
        <p class="muted">${v.status === 'released' ? 'The vehicle has been flagged and Olub administrators have been alerted.' : `You will get the information within ${v.answerWithinDays} days.`}</p>
        <h3>Your access key — save it now</h3><p class="digipin" style="font-size:15px;display:inline-block;padding:8px 12px" id="ak">${esc(v.accessKey)}</p>
        <p class="muted small">You need the reference and this key to open the information. It is shown only once.</p>
        <button id="st" class="btn block">Check status</button></div>`;
      $('#st').onclick = run(() => show(v.ref, v.accessKey));
    });
  }

  async function show(ref, key) {
    const r = await api('GET', `/api/authority/requests/${encodeURIComponent(ref)}?key=${encodeURIComponent(key)}`);
    const d = r.data;
    app.innerHTML = `<div class="card"><div class="between"><h2 style="margin:0">${esc(r.ref)}</h2><span class="chip ${r.status === 'released' ? '' : 'warn'}">${esc(r.status.replace('_', ' '))}</span></div>
        <p class="muted small">${esc(r.caseRef)} · applied ${when(r.createdAt)}${r.status === 'under_review' ? ` · answer by ${when(r.answerBy)}` : ''}</p>${r.response ? `<p>${esc(r.response)}</p>` : ''}</div>
      ${d ? `${d.note ? `<div class="card warn">${esc(d.note)}</div>` : ''}
        ${d.driver ? `<div class="card"><h2>Driver & vehicle</h2><dl class="kv">${Object.entries(d.driver).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}
        <div class="card"><h2>Trips (${d.trips.length})</h2><div class="list">${d.trips.map((t) => `<div class="small"><b>#${t.tripId} · ${esc(t.status)}</b> · ${when(t.startedAt || t.bookedAt)}<br>
          ${esc(t.from.name)} <span class="digipin">${esc(t.from.digipin)}</span> → ${esc(t.to.name)} <span class="digipin">${esc(t.to.digipin)}</span><br>
          Customer: ${esc(t.customer.name)} · ${esc(t.customer.phone)} · ${esc(t.customer.olubId)}<br>GPS points: ${t.gpsTrail.length} · safety events: ${t.safetyEvents.length}</div>`).join('')}</div>
          <button id="dlj" class="btn ghost block">${ic('download')}Download full record (JSON)</button></div>` : ''}
      <button class="btn ghost block" id="back">Back</button>`;
    $('#back').onclick = form;
    if (d) {
      $('#dlj').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
        a.download = `${r.ref}.json`; a.click();
      };
    }
  }

  form();
}());
