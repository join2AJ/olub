// Walks every screen of the app with the demo data and reports problems:
// script errors, failed requests, sideways overflow, clipped text in buttons, and that key features work.
const { chromium } = require('playwright');
const fs = require('fs');
const B = process.env.OLUB_URL || 'http://localhost:3000', D = process.env.AUDIT_OUT || `${__dirname}/../audit-out`;
fs.mkdirSync(D, { recursive: true });
const issues = []; const notes = [];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const mk = async (name, geo, scheme = 'light') => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, geolocation: geo, permissions: geo ? ['geolocation', 'microphone'] : ['microphone'], colorScheme: scheme, acceptDownloads: true });
    const p = await c.newPage();
    p.on('pageerror', (e) => issues.push(`[${name}] script error: ${e.message}`));
    p.on('response', (r) => { if (r.status() >= 500) issues.push(`[${name}] server error ${r.status()} ${r.url().replace(B, '')}`); });
    p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|tile/.test(m.text())) issues.push(`[${name}] console: ${m.text().slice(0, 140)}`); });
    return p;
  };
  const check = async (p, label, { shot = true, full = true } = {}) => {
    await p.waitForTimeout(450);
    const r = await p.evaluate(() => {
      const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, clipped: [], tiny: [] };
      for (const el of document.querySelectorAll('button, .chip, .btn, h1, h2, .stat .v, .bignum, td')) {
        const b = el.getBoundingClientRect(); if (!b.width || b.bottom < 0) continue;
        if (b.right > window.innerWidth + 1 && !el.closest('.filters, .subtabs, .quick, .chart, .leaflet-container, .tabs')) out.clipped.push((el.textContent || '').trim().slice(0, 30));
        if (el.matches('button, .btn') && (b.height < 30 || b.width < 30) && !el.closest('.leaflet-container, .rate-stars')) out.tiny.push((el.textContent || el.id || '').trim().slice(0, 20) + ` ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      return out;
    });
    if (r.overflow > 1) issues.push(`[${label}] page scrolls sideways by ${r.overflow}px`);
    if (r.clipped.length) issues.push(`[${label}] runs off the right edge: ${[...new Set(r.clipped)].slice(0, 4).join(' | ')}`);
    if (r.tiny.length) issues.push(`[${label}] small tap targets: ${[...new Set(r.tiny)].slice(0, 4).join(' | ')}`);
    if (shot) await p.screenshot({ path: `${D}/${label}.png`, fullPage: full });
  };
  const demo = async (p, role) => { await p.goto(B); await p.click(`[data-demo=${role}]`); await p.waitForSelector('#nav button'); };
  const tab = async (p, t) => { await p.click(`#nav [data-tab=${t}]`); await p.waitForTimeout(700); };

  // ---------- sign-in ----------
  const lp = await mk('login'); await lp.goto(B); await lp.waitForSelector('[data-demo]'); await check(lp, '01-login');

  // ---------- passenger ----------
  const HZ = { latitude: 26.85, longitude: 80.946 };
  const rid = await mk('passenger', HZ); await demo(rid, 'rider');
  await rid.waitForSelector('#hmap .cabtop'); await check(rid, '02-home-empty');
  await rid.click('#pick-dst'); await rid.waitForSelector('#plist button'); await check(rid, '03-place-picker', { full: false });
  const recent = await rid.locator('#precent button').count(); notes.push(`recent destinations offered: ${recent}`);
  await rid.fill('#pq', 'lulu'); await rid.click('#plist button:has-text("Lulu Mall")');
  await rid.waitForSelector('#book', { timeout: 20000 }); await rid.waitForTimeout(1500); await check(rid, '04-home-rides');
  await rid.click('#prefs'); await rid.waitForSelector('#pf-save'); await check(rid, '05-prefs', { full: false }); await rid.click('[data-close]');
  await tab(rid, 'activity'); await rid.waitForSelector('.dash'); await rid.click('[data-p=all]'); await rid.waitForSelector('.dash'); await rid.waitForTimeout(600); await check(rid, '06-activity-all');
  for (const g of ['month', 'weekday', 'hour']) { await rid.click(`#groupby [data-g=${g}]`); await rid.waitForTimeout(150); }
  await check(rid, '07-activity-hour', { full: false });
  await rid.click('[data-p=custom]'); await rid.waitForSelector('#pfrom'); await check(rid, '08-activity-custom', { full: false, shot: false }); await rid.click('[data-p=all]'); await rid.waitForSelector('.dash');
  // downloads
  for (const [btn, ext] of [['#dl-xls', '.xlsx'], ['#dl-jpg', '.jpg']]) {
    const [dl] = await Promise.all([rid.waitForEvent('download', { timeout: 8000 }).catch(() => null), rid.click(btn)]);
    if (!dl || !dl.suggestedFilename().endsWith(ext)) issues.push(`[activity] ${ext} download did not start`);
    else { const f = `${D}/${dl.suggestedFilename()}`; await dl.saveAs(f); notes.push(`downloaded ${dl.suggestedFilename()} (${fs.statSync(f).size} bytes)`); }
  }
  await rid.click('.trow.completed'); await rid.waitForSelector('#ts-inv'); await check(rid, '09-trip-sheet', { full: false });
  await rid.click('#ts-inv'); await rid.waitForSelector('#inv-jpg'); await check(rid, '10-invoice', { full: false });
  for (const [btn, ext] of [['#inv-jpg', '.jpg'], ['#inv-xls', '.xlsx']]) {
    const [dl] = await Promise.all([rid.waitForEvent('download', { timeout: 8000 }).catch(() => null), rid.click(btn)]);
    if (!dl) issues.push(`[invoice] ${ext} download did not start`); else { const f = `${D}/${dl.suggestedFilename()}`; await dl.saveAs(f); notes.push(`downloaded ${dl.suggestedFilename()} (${fs.statSync(f).size} bytes)`); }
  }
  await rid.click('[data-close]');
  // scroll memory: scroll down in Activity, leave, come back
  await rid.evaluate(() => window.scrollTo(0, 700)); await rid.waitForTimeout(200); await tab(rid, 'safety'); await check(rid, '11-safety');
  await tab(rid, 'activity'); await rid.waitForSelector('.dash'); await rid.waitForTimeout(700);
  const y = await rid.evaluate(() => window.scrollY); if (Math.abs(y - 700) > 60) issues.push(`[scroll memory] Activity reopened at ${y}px, expected about 700`); else notes.push(`scroll memory ok (${y}px)`);
  await tab(rid, 'feedback'); await check(rid, '12-ratings');
  await tab(rid, 'profile'); await rid.waitForSelector('.idcard'); await check(rid, '13-profile');
  await rid.click('[data-open=personal]'); await rid.waitForSelector('#pgo'); await check(rid, '14-personal', { full: false }); await rid.click('[data-close]');
  await rid.click('#m-privacy'); await rid.waitForSelector('#dgo'); await rid.selectOption('#dt', 'correction'); await check(rid, '15-privacy', { full: false }); await rid.click('[data-close]');
  await rid.click('#m-legal'); await rid.waitForSelector('.legal'); await check(rid, '16-legal', { full: false, shot: false }); await rid.click('[data-close]');

  // ---------- booking + driver + chat + call ----------
  await tab(rid, 'home'); await rid.waitForSelector('#book', { timeout: 20000 }); await rid.click('#book'); await rid.waitForSelector('text=Finding your cab'); await check(rid, '17-finding');
  const drv = await mk('driver', HZ); await demo(drv, 'driver'); await drv.waitForSelector('[data-acc]'); await check(drv, '18-driver-request');
  await drv.click('[data-acc]'); await drv.waitForSelector('#otp'); await rid.waitForSelector('text=Driver accepted'); await check(drv, '19-driver-pickup'); await check(rid, '20-rider-accepted');
  await rid.click('.quick button >> nth=0'); await drv.waitForSelector('.msg time'); notes.push('quick reply delivered with time');
  // in-app voice call (fake microphone): ring, answer, connect, hang up
  await rid.click('#callbtn'); await drv.waitForSelector('#call:not([hidden]) #call-accept:not([hidden])', { timeout: 10000 }); await check(drv, '21-incoming-call', { full: false });
  await drv.click('#call-accept');
  const connected = await Promise.all([rid, drv].map((p) => p.waitForFunction(() => document.querySelector('#call-state').textContent === 'Connected', null, { timeout: 15000 }).then(() => true).catch(() => false)));
  if (connected.every(Boolean)) notes.push('voice call connected on both sides'); else issues.push(`[call] did not connect: passenger=${connected[0]} driver=${connected[1]}`);
  const audio = await drv.evaluate(() => { const a = document.querySelector('#call-audio'); return !!(a.srcObject && a.srcObject.getAudioTracks().length); });
  if (!audio) issues.push('[call] driver has no incoming audio track'); else notes.push('audio track received');
  await rid.click('#call-end'); await drv.waitForSelector('#call', { state: 'hidden', timeout: 8000 }).catch(() => issues.push('[call] hang-up did not close the other side'));
  const otp = await rid.$$eval('.otp span', (s) => s.map((x) => x.textContent).join(''));
  await drv.fill('#otp', otp); await drv.check('#fit'); await drv.click('#start'); await drv.waitForSelector('#complete'); await check(drv, '22-driver-ride'); await rid.waitForSelector('#sos'); await check(rid, '23-rider-ride');
  await drv.click('#complete'); await drv.waitForSelector('#gotpaid'); await rid.waitForSelector('#paycash'); await check(rid, '24-rider-bill');
  await rid.click('#paycash'); await rid.waitForSelector('.rate-stars'); await check(rid, '25-rating', { full: false });
  for (const row of await rid.$$('.rate-stars')) await (await row.$('button[data-n="5"]')).click(); await rid.click('#r-go'); await rid.waitForSelector('#r-go', { state: 'detached' });
  await drv.waitForSelector('#done'); await drv.click('.sheet [data-close]').catch(() => {}); await drv.click('#done'); await drv.waitForSelector('#online');
  await check(drv, '26-driver-home');
  await tab(drv, 'money'); await drv.waitForSelector('text=Your time on the road'); await drv.click('[data-p=all]'); await drv.waitForSelector('text=Your time on the road'); await drv.waitForTimeout(600); await check(drv, '27-driver-earnings');
  await tab(drv, 'trips'); await drv.waitForSelector('.trow'); await check(drv, '28-driver-trips');
  await tab(drv, 'feedback'); await check(drv, '29-driver-ratings');
  await tab(drv, 'profile'); await drv.waitForSelector('.idcard'); await check(drv, '30-driver-profile');
  await drv.click('#m-vehicle'); await drv.waitForSelector('#v-save'); await check(drv, '31-vehicle'); await drv.click('#back');
  await drv.click('#m-qr'); await drv.waitForSelector('.qrbox svg'); await check(drv, '32-qr', { full: false }); await drv.click('[data-close]');

  // ---------- admin ----------
  const adm = await mk('admin'); await demo(adm, 'admin'); await adm.waitForSelector('text=Rules the app enforces');
  for (const k of ['compliance', 'demo', 'drivers', 'authority', 'privacy', 'feedback', 'users', 'rates', 'calamity', 'tolls', 'outbox']) {
    await adm.click(`[data-sub=${k}]`); await adm.waitForTimeout(900); await check(adm, `40-admin-${k}`);
  }
  await adm.click('[data-sub=users]'); await adm.waitForSelector('#ulist button'); await adm.evaluate(() => window.scrollTo(0, 500)); await adm.waitForTimeout(150);
  await adm.click('[data-sub=compliance]'); await adm.waitForTimeout(700); await adm.click('[data-sub=users]'); await adm.waitForTimeout(900);
  const ay = await adm.evaluate(() => window.scrollY); if (Math.abs(ay - 500) > 60) issues.push(`[scroll memory] admin People reopened at ${ay}px, expected about 500`); else notes.push(`admin scroll memory ok (${ay}px)`);

  // ---------- public pages ----------
  const pub = await mk('public'); for (const [u, n] of [['/legal', '50-legal'], ['/authority', '51-authority']]) { await pub.goto(B + u); await pub.waitForTimeout(900); await check(pub, n); }
  const w = await pub.evaluate(() => fetch('/api/where').then((r) => r.json())); notes.push(`/api/where for a local address → ${w.name} (${w.source})`);

  // ---------- dark mode ----------
  const dk = await mk('dark', HZ, 'dark'); await demo(dk, 'rider'); await dk.waitForSelector('#hmap .cabtop'); await dk.waitForTimeout(1200); await check(dk, '60-dark-home');
  await tab(dk, 'activity'); await dk.waitForSelector('.dash'); await check(dk, '61-dark-activity'); await tab(dk, 'profile'); await check(dk, '62-dark-profile');
  await dk.click('#m-logout'); await dk.waitForSelector('[data-demo]'); await check(dk, '63-dark-login');

  console.log(JSON.stringify({ issues: [...new Set(issues)], notes }, null, 1));
  await browser.close();
})().catch((e) => { console.error('AUDIT STOPPED:', e.message.split('\n').slice(0, 6).join('\n')); console.log(JSON.stringify({ issues, notes }, null, 1)); process.exit(1); });
