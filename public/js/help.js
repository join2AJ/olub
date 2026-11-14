'use strict';
/* Help: Olub Cha (the help assistant), common issues, issues raised with Olub, and the page for government officials. */

async function renderHelp(app) {
  app.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  const h = await api('GET', '/api/help');
  if (S.tab !== 'help') return;
  S.helpChat = S.helpChat || [{ bot: true, title: `Namaste ${esc((S.me.name || '').split(' ')[0])}`, text: 'I am Olub Cha. Ask me about fares, cancellations, safety, payments or your account — or tap a topic below. I can show your own records and Olub\'s policies, never another person\'s details.' }];
  const open = h.tickets.filter((t) => t.status === 'open').length;
  app.innerHTML = `
    <div class="cha">
      <div class="cha-head"><div class="cha-face">${ic('chat')}</div><div><b>Olub Cha</b><span>Help assistant · answers from Olub's policies and your own records</span></div></div>
      <div class="cha-log" id="cha-log"></div>
      <div class="cha-in"><input id="cha-q" placeholder="Type your question…" maxlength="300" aria-label="Your question"><button id="cha-send" class="btn small" aria-label="Ask">${ic('nav')}</button></div>
    </div>
    <div class="card" data-fold="hp-topics" data-open data-sum="${h.topics.length} topics"><h2>Common issues</h2>
      <div class="topics">${h.topics.map((t) => `<button data-topic="${t.id}">${esc(t.title)}${ic('right')}</button>`).join('')}</div></div>
    <div class="card" data-fold="hp-mine" ${h.tickets.length ? 'data-open' : ''} data-sum="${h.tickets.length ? `${h.tickets.length} raised · ${open} waiting for a reply` : 'Nothing raised yet'}"><h2>My issues with Olub</h2>
      ${h.tickets.map((t) => `<div class="ticket"><div class="between"><b>${esc(t.ref)}</b><span class="chip ${t.status === 'open' ? 'warn' : ''}">${t.status === 'open' ? 'Waiting for Olub' : 'Answered'}</span></div>
        <p class="small" style="margin:6px 0">${esc(t.text)}</p><div class="muted small">${when(t.createdAt)}${t.tripId ? ` · ride #${t.tripId}` : ''}</div>
        ${t.reply ? `<div class="reply"><b>Olub</b> · ${when(t.repliedAt)}<br>${esc(t.reply)}</div>` : ''}</div>`).join('') || '<p class="muted small" style="margin:0">If Olub Cha cannot solve it, raise an issue and an Olub officer replies here.</p>'}
      <button id="hp-raise" class="btn block" style="margin-top:12px">${ic('plus')}Raise an issue</button></div>
    <a class="btn danger block" href="tel:112">${ic('phone')}Emergency? Call 112</a>
    <p class="center muted small">${esc(S.cfg.company.grievanceOfficer)}</p>`;
  const log = $('#cha-log');
  const draw = () => {
    log.innerHTML = S.helpChat.map((m) => (m.bot
      ? `<div class="cm bot">${m.title ? `<b>${esc(m.title)}</b>` : ''}${esc(m.text).replace(/\n/g, '<br>')}${m.ticket ? '<button class="btn small ghost" data-raise="1" style="margin-top:8px">Raise an issue about this</button>' : ''}</div>`
      : `<div class="cm me">${esc(m.text)}</div>`)).join('');
    log.scrollTop = log.scrollHeight;
    $$('[data-raise]', log).forEach((b) => { b.onclick = () => raiseIssue(S.helpTopic); });
  };
  const ask = async (body, shown) => {
    S.helpChat.push({ text: shown }); draw();
    try {
      const a = await api('POST', '/api/help/ask', body);
      S.helpTopic = a.topic; S.helpChat.push({ bot: true, title: a.title, text: a.text, ticket: true });
    } catch (e) { S.helpChat.push({ bot: true, text: e.message }); }
    if ($('#cha-log')) draw();
  };
  const send = () => { const q = $('#cha-q').value.trim(); if (!q) return; $('#cha-q').value = ''; ask({ text: q }, q); };
  $('#cha-send').onclick = send; $('#cha-q').onkeydown = (e) => { if (e.key === 'Enter') send(); };
  $$('[data-topic]').forEach((b) => { b.onclick = () => { ask({ topic: b.dataset.topic }, b.textContent.trim()); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
  $('#hp-raise').onclick = () => raiseIssue(S.helpTopic);
  draw(); applyScroll();
}

async function raiseIssue(topic) {
  const trips = await api('GET', '/api/trips').catch(() => []);
  const h = await api('GET', '/api/help');
  const sh = sheet('Raise an issue', `<p class="muted small">An Olub officer reads this and replies in the app. For an emergency call 112.</p>
    <label class="f">What is it about?</label><select id="ri-topic">${h.topics.map((t) => `<option value="${t.id}" ${t.id === topic ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select>
    <label class="f">Which ride? (optional)</label><select id="ri-trip"><option value="">Not about a ride</option>${trips.slice(0, 15).map((t) => `<option value="${t.id}">#${t.id} · ${esc(t.dst.name)} · ${when(t.createdAt)}</option>`).join('')}</select>
    <label class="f">What happened?</label><textarea id="ri-text" maxlength="1000" placeholder="Write what happened, in your own words"></textarea>
    <button id="ri-go" class="btn block">Send to Olub</button>`);
  $('#ri-go', sh.el).onclick = run(async () => {
    const t = await api('POST', '/api/help/tickets', { topic: $('#ri-topic').value, tripId: $('#ri-trip').value, text: $('#ri-text').value });
    sh.close(); toast(`Issue ${t.ref} sent to Olub`); if (S.tab === 'help') render();
  });
}

/** How police, RTO and courts ask Olub for information. */
function officialSheet() {
  const url = `${S.base || location.origin}/authority`;
  const sh = sheet('Government officials', `
    <p class="muted">For police, transport departments (RTO), courts and other government bodies that need ride records or want to flag a vehicle.</p>
    <div class="steps-list">
      <div><i>1</i><span><b>Verify your government ID</b><br>Confirm an official government email (gov.in / nic.in) with a code, and attach a signed request letter.</span></div>
      <div><i>2</i><span><b>Say what is needed and declare it is genuine</b><br>Give the vehicle, driver or ride, the dates, the case reference, and declare that the data is required for official work.</span></div>
      <div><i>3</i><span><b>Receive the information</b><br>Olub answers within ${esc(S.cfg.lea.publicDays)}. You open it with your reference and access key.</span></div>
    </div>
    <p class="muted small">${ic('lock')} Every request, who made it and what was shared is kept on record. Only the records the request covers are shared.</p>
    <button id="of-open" class="btn block">Open the request form</button>
    <button id="of-copy" class="btn ghost block">Share the link</button>`);
  $('#of-open', sh.el).onclick = () => { window.open(url, '_blank'); };
  $('#of-copy', sh.el).onclick = run(() => shareText(`Olub — requests from government officials: ${url}`));
}

// ---------------- admin: issues raised from Help ----------------
if (typeof ADMIN !== 'undefined') ADMIN.help = async (pane) => {
  const list = await api('GET', '/api/admin/help');
  pane.innerHTML = list.map((t) => `<div class="card"><div class="between"><b>${esc(t.ref)}</b><span class="chip ${t.status === 'open' ? 'warn' : ''}">${t.status === 'open' ? 'Open' : 'Answered'}</span></div>
      <div class="muted small">${esc(t.name)} · ${esc(t.userId)} · ${esc(t.role === 'rider' ? 'customer' : t.role)} · ${when(t.createdAt)}${t.tripId ? ` · ride #${t.tripId}` : ''}${t.topic ? ` · ${esc(t.topic)}` : ''}</div>
      <p style="margin:8px 0">${esc(t.text)}</p>
      ${t.reply ? `<div class="reply"><b>${esc(t.handledBy || 'Olub')}</b> · ${when(t.repliedAt)}<br>${esc(t.reply)}</div>` : `<textarea data-reply="${esc(t.ref)}" placeholder="Reply to ${esc(t.name)}" maxlength="1000"></textarea><button class="btn small" data-send="${esc(t.ref)}" style="margin-top:8px">Send reply</button>`}</div>`).join('')
    || `<div class="card"><div class="empty">${ic('chat')}<div>No issues raised yet.</div></div></div>`;
  $$('[data-send]', pane).forEach((b) => { b.onclick = run(async () => { await api('POST', `/api/admin/help/${b.dataset.send}/reply`, { reply: $(`[data-reply="${b.dataset.send}"]`).value }); toast('Reply sent'); render(); }); });
};
