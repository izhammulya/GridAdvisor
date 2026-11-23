/* Jurnal trade nyata (Google Sheet "Evaluasi agent") + model estimasi waktu
   ------------------------------------------------------------------
   v8 — hasil evaluasi pada 902 trade Anda (28 Okt – 23 Nov 2026), uji maju (tiap trade
   ditebak hanya dari trade-trade sebelumnya):
     • Angka "Prediksi Durasi Hit" tidak punya daya pilah: korelasi peringkat prediksi↔aktual
       di dalam satu koin|arah ≈ 0 (−0,02 … +0,09). Yang membedakan hanyalah koin & arah.
     • Meleset tipikal tetap ≈ ×4,7 apa pun modelnya → waktu hit pada dasarnya acak;
       yang bisa diramal dengan jujur adalah RENTANG-nya, bukan satu angka.
     • Model paling sederhana yang sama akuratnya dengan regresi v7 dan cakupannya pas
       (50% → 50%, 80% → 81%):  ln(aktual) = median global + efek koin|arah (di-shrink) + residual empiris.
   Karena itu model v8 tidak lagi bergantung pada kolom prediksi (yang maknanya berubah
   dari "ETA v6" ke "median v7" di tengah jalan), dan jurnal bisa diambil apa adanya dari sheet.

   Catatan penting: sheet hanya memuat bot yang SUDAH kena target (survivorship). Bot yang macet
   tidak tercatat, jadi ekor lambat sebenarnya lebih tebal — bagian itu ditutup oleh Monte Carlo. */
import { JOURNAL } from './config.js';
import { quantileLin } from './util.js';
import { SEED, SEED_YEAR } from './journal-seed.js';

const K_SHEET = 'gridfish.sheet.v8', K_PEND = 'gridfish.pending.v8', K_V7 = 'gridfish.journal.v7';
const COIN = { I: 'INJ', E: 'ETH', S: 'SOL', K: 'LINK' };
const DIR = { L: 'long', S: 'short', N: 'neutral' };

const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : null; };
const uid = () => Math.random().toString(36).slice(2, 10);
const normDir = (s) => { const v = String(s || '').toLowerCase(); return v.startsWith('l') ? 'long' : v.startsWith('s') ? 'short' : v.startsWith('n') ? 'neutral' : v; };
const dayOf = (s) => { const t = Date.parse(s); return isFinite(t) ? t : null; };   // "23 Nov 2026" → ms

function seedRows() {
  return SEED.split(';').map((s) => {
    const [c, d, pred, act, profit, modal, date] = s.split(',');
    return { coin: COIN[c], dir: DIR[d], pred: num(pred), actual: num(act), profit: num(profit), modal: num(modal), date: `${date} ${SEED_YEAR}` };
  });
}

// ---------- CSV / tabel → baris jurnal ----------
export function parseCSV(text) {
  const out = []; let row = [], cur = '', inQ = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = ''; out.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim() !== ''));
}

// baris pertama boleh header (dicocokkan lewat nama kolom) atau langsung data (urutan kolom sheet Anda)
export function rowsFromTable(table) {
  if (!table.length) return [];
  let col = { coin: 0, dir: 1, pred: 2, actual: 3, profit: 4, hit: 6, modal: 7, date: 9 };
  let start = 0;
  const head = table[0].map((h) => String(h).trim().toLowerCase());
  if (num(head[3]) == null && /[a-z]/.test(head[2] || '')) {
    start = 1;
    const find = (re, not) => head.findIndex((h) => re.test(h) && !(not && not.test(h)));
    col = {
      coin: find(/jenis|coin|koin|symbol/), dir: find(/model|arah|dir/),
      pred: find(/prediksi|pred/, /mc/), actual: find(/actual|aktual/),
      profit: find(/profit/), hit: find(/^hit$/), modal: find(/modal|invest/), date: find(/^date$|tanggal|waktu/),
    };
  }
  const out = [];
  for (const c of table.slice(start)) {
    const get = (k) => (col[k] >= 0 && c[col[k]] != null ? String(c[col[k]]).trim() : '');
    const coin = get('coin').toUpperCase();
    if (!coin) continue;
    let actual = num(get('actual'));
    if (num(get('hit')) === -1 || (actual != null && actual < 0)) actual = null;
    out.push({ coin, dir: normDir(get('dir')), pred: num(get('pred')), actual, profit: num(get('profit')), modal: num(get('modal')), date: get('date') || null });
  }
  return out;
}

// tempel manual dari spreadsheet (tab / titik koma / koma)
export function parsePaste(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const table = lines[0].includes('\t') ? lines.map((l) => l.split('\t')) : lines[0].includes(';') ? lines.map((l) => l.split(';')) : parseCSV(lines.join('\n'));
  return rowsFromTable(table);
}

// ---------- sinkron dari Google Sheet ----------
async function getText(url, ms) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}

/* 1) /api/journal (proxy Vercel, di-cache 60 detik)  2) langsung ke Google (endpoint gviz, mendukung CORS)
   Keduanya butuh sheet dibagikan "siapa saja yang memiliki link → pelihat". */
export async function fetchSheet() {
  const direct = `https://docs.google.com/spreadsheets/d/${JOURNAL.SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(JOURNAL.TAB)}`;
  const errs = [];
  for (const [src, url] of [['proxy', '/api/journal'], ['langsung', direct]]) {
    try {
      const text = await getText(url, 9000);
      if (/^\s*</.test(text)) throw new Error('bukan CSV (sheet belum dibagikan lewat link?)');
      const rows = rowsFromTable(parseCSV(text));
      if (rows.length < 5) throw new Error('tab kosong / format tidak dikenali');
      const pack = { rows, at: Date.now(), src: 'sheet' };
      try { localStorage.setItem(K_SHEET, JSON.stringify(pack)); } catch (_) { /* storage penuh/tidak ada */ }
      return pack;
    } catch (e) { errs.push(`${src}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
  }
  throw new Error(errs.join(' · '));
}

// data terakhir yang tersimpan; kalau belum pernah sinkron → salinan bawaan
export function loadSheetCache() {
  try {
    const p = JSON.parse(localStorage.getItem(K_SHEET) || 'null');
    if (p && Array.isArray(p.rows) && p.rows.length) return p;
  } catch (_) { /* abaikan */ }
  return { rows: seedRows(), at: null, src: 'bawaan' };
}
export function savePasted(rows) {
  const pack = { rows, at: Date.now(), src: 'tempel' };
  try { localStorage.setItem(K_SHEET, JSON.stringify(pack)); } catch (_) { /* abaikan */ }
  return pack;
}

/* ---------- setup yang dicatat dari aplikasi (menunggu bot ditutup) ----------
   Disimpan lokal bersama prediksi Monte Carlo-nya. Saat sheet tersinkron, tiap entri dicocokkan
   otomatis dengan baris baru ber-koin, arah, dan angka prediksi yang sama (angka di nama bot,
   mis. INJ_Short_31) → durasi aktual terisi sendiri, dan akurasi MC bisa dipantau. */
export function loadPending() {
  try {
    const p = JSON.parse(localStorage.getItem(K_PEND) || 'null');
    if (Array.isArray(p)) return p;
    // migrasi entri aplikasi dari v7 (yang punya prediksi MC)
    const old = JSON.parse(localStorage.getItem(K_V7) || 'null');
    if (Array.isArray(old)) return old.filter((r) => r.source === 'app' && r.mc50 != null)
      .map((r) => ({ id: r.id || uid(), ts: r.ts, coin: r.coin, dir: r.dir, pred: null, mc50: r.mc50, mc80: r.mc80, modal: r.modal, target: r.target, sheetN: 0, actual: r.actual ?? null, manual: r.actual != null }));
  } catch (_) { /* abaikan */ }
  return [];
}
export function savePending(list) {
  try { localStorage.setItem(K_PEND, JSON.stringify(list.slice(-400))); return true; } catch (_) { return false; }
}
export const newPending = (fields) => ({ id: uid(), ts: new Date().toISOString(), actual: null, row: null, ...fields });

// kembalikan jumlah entri yang baru terisi
export function matchPending(pending, rows) {
  const claimed = new Set(pending.filter((e) => e.row != null).map((e) => e.row));
  let filled = 0;
  for (const e of pending) {
    if (e.row != null || e.manual || e.pred == null) continue;
    const day0 = e.ts ? new Date(e.ts).setHours(0, 0, 0, 0) - 86400000 : 0;   // toleransi zona waktu
    for (let i = Math.max(0, e.sheetN || 0); i < rows.length; i++) {
      const r = rows[i];
      if (claimed.has(i) || r.actual == null || r.coin !== e.coin || r.dir !== e.dir || r.pred == null) continue;
      if (Math.abs(r.pred - e.pred) > 0.5) continue;
      const d = dayOf(r.date);
      if (d != null && d < day0) continue;
      e.row = i; e.actual = r.actual; e.profit = r.profit; claimed.add(i); filled++;
      break;
    }
  }
  return filled;
}

// ---------- model waktu ----------
const gkey = (coin, dir) => coin + '|' + dir;
const usable = (rows) => rows.filter((r) => r.actual != null && r.actual >= 0 && r.coin && r.dir);
const logT = (r) => Math.log(Math.max(r.actual, 0.5));

function fitOn(d) {
  const n = d.length;
  const y = d.map(logT);
  const gm = quantileLin([...y].sort((a, b) => a - b), 0.5);
  const acc = {};
  d.forEach((r, i) => { const k = gkey(r.coin, r.dir); (acc[k] ||= { n: 0, s: 0 }); acc[k].n++; acc[k].s += y[i] - gm; });
  const groups = {};
  for (const [k, g] of Object.entries(acc)) groups[k] = { n: g.n, delta: g.s / (g.n + JOURNAL.K_GROUP) };
  const resid = d.map((r, i) => y[i] - gm - groups[gkey(r.coin, r.dir)].delta).sort((a, b) => a - b);
  return { gm, groups, resid, n };
}

export function fitTimeModel(rows) {
  const d = usable(rows);
  if (d.length < JOURNAL.MIN_ROWS) return null;
  const m = fitOn(d);
  // kebiasaan target Anda: median profit ÷ modal (untuk mendeteksi setup yang "di luar jurnal")
  const g = d.filter((r) => r.profit > 0 && r.modal > 0).map((r) => r.profit / r.modal).sort((a, b) => a - b);
  m.typTarget = g.length ? quantileLin(g, 0.5) : null;
  return m;
}

// distribusi waktu hit (menit) untuk koin|arah tertentu
export function predictTime(model, coin, dir) {
  if (!model) return null;
  const g = model.groups[gkey(coin, dir)];
  const mu = model.gm + (g ? g.delta : 0);
  const r = model.resid, n = r.length;
  const q = (p) => Math.exp(mu + quantileLin(r, p));
  const cdf = (t) => {   // proporsi residual ≤ ln t − μ, diinterpolasi
    if (!(t > 0)) return 0;
    const z = Math.log(t) - mu;
    if (z < r[0]) return 0;
    if (z >= r[n - 1]) return 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m] <= z) lo = m; else hi = m; }
    const f = r[hi] > r[lo] ? (z - r[lo]) / (r[hi] - r[lo]) : 0;
    return (lo + f) / (n - 1);
  };
  return { n: model.n, nGroup: g ? g.n : 0, mu, q, cdf };
}

/* "Kalau sudah menunggu s menit dan belum kena": peluang kena dalam 30 menit berikutnya
   dan median sisa tunggu. Dari jurnal Anda hazard-nya MENURUN: makin lama menunggu,
   makin lama lagi sisa tunggunya (bot sudah masuk "jalur lambat"). */
export function waitTable(pt, marks = [15, 30, 60, 120, 240, 480]) {
  return marks.map((s) => {
    const F = pt.cdf(s);
    if (F > 0.985) return null;
    return { s, left: 1 - F, pNext30: (pt.cdf(s + 30) - F) / (1 - F), medRemain: pt.q(0.5 + 0.5 * F) - s };
  }).filter(Boolean);
}

/* uji maju (jujur): trade ke-i ditebak dari model yang hanya melihat trade 1..i−1.
   Sekalian dihitung akurasi angka "Prediksi" yang tercatat di sheet pada trade yang sama. */
export function forwardTest(rows) {
  const d = usable(rows);
  const start = Math.min(JOURNAL.TEST_START, Math.floor(d.length / 2));
  if (d.length - start < 30 || start < JOURNAL.MIN_ROWS) return null;
  let c50 = 0, c80 = 0, abs = 0, n = 0, pc = 0, pabs = 0, pn = 0;
  for (let i = start; i < d.length; i++) {
    const p = predictTime(fitOn(d.slice(0, i)), d[i].coin, d[i].dir);
    const a = Math.max(d[i].actual, 0.5), m = p.q(0.5);
    if (a <= m) c50++;
    if (a <= p.q(0.8)) c80++;
    abs += Math.abs(Math.log(a / m)); n++;
    if (d[i].pred > 0) { pn++; if (a <= d[i].pred) pc++; pabs += Math.abs(Math.log(a / d[i].pred)); }
  }
  return { n, c50: c50 / n, c80: c80 / n, factor: Math.exp(abs / n), predN: pn, predCover: pn ? pc / pn : null, predFactor: pn ? Math.exp(pabs / pn) : null };
}

// seberapa jujur prediksi Monte Carlo pada setup yang dicatat dari aplikasi lalu selesai
export function mcCoverage(pending) {
  const d = pending.filter((r) => r.actual != null && r.mc50 != null);
  if (d.length < 5) return null;
  const ratio = d.map((r) => Math.log(Math.max(r.actual, 0.5) / Math.max(r.mc50, 0.5))).sort((a, b) => a - b);
  return {
    n: d.length,
    c50: d.filter((r) => r.actual <= r.mc50).length / d.length,
    c80: d.filter((r) => r.mc80 != null && r.actual <= r.mc80).length / d.length,
    medRatio: Math.exp(quantileLin(ratio, 0.5)),
  };
}

// ringkasan per koin|arah untuk tab Jurnal
export function groupStats(rows) {
  const acc = {};
  for (const r of usable(rows)) (acc[gkey(r.coin, r.dir)] ||= []).push(r.actual);
  return Object.entries(acc).map(([k, a]) => {
    a.sort((x, y) => x - y);
    const [coin, dir] = k.split('|');
    return { coin, dir, n: a.length, q25: quantileLin(a, 0.25), q50: quantileLin(a, 0.5), q80: quantileLin(a, 0.8), q90: quantileLin(a, 0.9) };
  }).sort((a, b) => b.n - a.n);
}
