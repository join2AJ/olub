'use strict';
/* Downloads: Excel workbooks (.xlsx) and pictures (.jpg), made on the phone with no extra libraries. */

// ---------- saving ----------
function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(blob); });
}
/** Save a file: to Downloads in the Android app, as a normal download in a browser. */
async function saveFile(name, blob) {
  if (Native && Native.saveFile) { Native.saveFile(name, blob.type, await blobToBase64(blob)); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Saved ${name}`, false, 'download');
}

// ---------- Excel (.xlsx) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A zip archive (stored, not compressed) from [{name, text}]. */
function zipStore(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  const u16 = (n) => [n & 255, (n >> 8) & 255]; const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name); const data = enc.encode(f.text); const crc = crc32(data);
    const head = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(new Uint8Array(head), name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += head.length + name.length + data.length;
  }
  let csize = 0;
  for (const c of central) {
    const rec = [0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c.crc), ...u32(c.size), ...u32(c.size), ...u16(c.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)];
    parts.push(new Uint8Array(rec), c.name); csize += rec.length + c.name.length;
  }
  parts.push(new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(csize), ...u32(offset), ...u16(0)]));
  return parts;
}

/** Workbook from [{name, rows: [[cell, …], …]}]. Numbers stay numbers; the first row of each sheet is bold. */
function makeXlsx(sheets) {
  const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const col = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const sheetXml = (rows) => {
    const widths = []; rows.forEach((r) => r.forEach((v, i) => { widths[i] = Math.min(48, Math.max(widths[i] || 8, String(v ?? '').length + 2)); }));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${
      rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
        const ref = `${col(ci)}${ri + 1}`; const st = ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
        if (v == null || v === '') return '';
        return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
      }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  };
  const names = sheets.map((s, i) => x(String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  const files = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) })),
  ];
  return new Blob(zipStore(files), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- picture (.jpg) ----------
/**
 * A clean Olub-branded card as a JPG.
 * @param {{title:string, subtitle?:string, big?:string, bigLabel?:string, rows:Array<[string,string,('bold'|'muted'|'line')?]>, footer?:string}} d
 */
function cardImage(d) {
  const W = 1080, PAD = 64, LH = 58;
  const c = document.createElement('canvas'); const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const wrap = (text, px, w, max) => { // split into lines that fit
    g.font = font(w, px); const out = []; let line = '';
    for (const word of String(text).split(/\s+/)) { const t = line ? `${line} ${word}` : word; if (g.measureText(t).width > max && line) { out.push(line); line = word; } else line = t; }
    if (line) out.push(line); return out;
  };
  const footer = d.footer ? wrap(d.footer, 28, 400, W - PAD * 2) : [];
  // Each row: label lines on the left, value on the right.
  const rows = d.rows.map(([label, value, kind]) => ({ kind, value: String(value ?? ''), lines: kind === 'line' ? [] : wrap(label, 34, kind === 'bold' ? 700 : 400, W - PAD * 2 - 300) }));
  const rowsH = rows.reduce((s, r) => s + (r.kind === 'line' ? 28 : Math.max(1, r.lines.length) * 46 + 12), 0);
  const H = 250 + (d.big ? 190 : 30) + rowsH + footer.length * 40 + 110;
  c.width = W; c.height = H;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  // header band
  const grad = g.createLinearGradient(0, 0, W, 0); grad.addColorStop(0, '#0c6b41'); grad.addColorStop(1, '#063d26');
  g.fillStyle = grad; g.fillRect(0, 0, W, 210);
  g.fillStyle = '#c7a14a'; g.fillRect(0, 210, W, 4);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(PAD + 44, 105, 44, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0c6b41'; g.font = font(800, 58); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('O', PAD + 44, 108);
  g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = font(800, 50); g.fillText(d.title, PAD + 112, 88);
  if (d.subtitle) { g.fillStyle = '#e9d08a'; g.font = font(500, 30); g.fillText(d.subtitle, PAD + 112, 142); }
  let y = 250;
  g.textBaseline = 'alphabetic';
  if (d.big) {
    g.fillStyle = '#5f6f68'; g.font = font(500, 32); g.fillText(d.bigLabel || '', PAD, y + 30);
    g.fillStyle = '#10201a'; g.font = font(800, 96); g.fillText(d.big, PAD, y + 132);
    y += 190;
  } else y += 30;
  for (const r of rows) {
    if (r.kind === 'line') { g.strokeStyle = '#e1e8e4'; g.lineWidth = 2; g.beginPath(); g.moveTo(PAD, y + 8); g.lineTo(W - PAD, y + 8); g.stroke(); y += 28; continue; }
    const bold = r.kind === 'bold';
    g.fillStyle = r.kind === 'muted' ? '#5f6f68' : '#10201a'; g.font = font(bold ? 700 : 400, 34); g.textAlign = 'left';
    r.lines.forEach((ln, i) => g.fillText(ln, PAD, y + 36 + i * 46));
    g.textAlign = 'right'; g.font = font(bold ? 800 : 600, bold ? 40 : 34); g.fillText(r.value, W - PAD, y + 36);
    y += Math.max(1, r.lines.length) * 46 + 12;
  }
  g.textAlign = 'left'; g.fillStyle = '#5f6f68'; g.font = font(400, 28);
  footer.forEach((ln, i) => g.fillText(ln, PAD, y + 50 + i * 40));
  g.fillStyle = '#9aa8a1'; g.font = font(500, 24); g.fillText('Olub · Ride with pride', PAD, H - 40);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.92));
}
