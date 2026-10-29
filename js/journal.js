/* Jurnal trade nyata + kalibrasi estimasi waktu
   ------------------------------------------------------------------
   Data Anda (114 bot) menunjukkan "ETA dasar" v6 bukan median: median waktu nyata ≈ 0.17×ETA,
   tapi ekornya panjang (10% bot butuh > 3.5×ETA). Satu angka tunggal pasti meleset,
   jadi estimasi di v7 berbentuk distribusi: "50% dalam ≤ X, 80% dalam ≤ Y".

   Model kalibrasi (log-regresi + efek koin/arah yang di-shrink):
     ln(aktual) = a + b·ln(ETA) + δ[koin|arah] + residual
   - b di-shrink ke 1 (prior), δ di-shrink ke 0 bila datanya sedikit
   - kuantil residual diambil empiris (tanpa asumsi normal) → ekor panjang tetap terwakili
   - akurasi dicek jujur dengan leave-one-out. */
import { clamp, quantileLin } from './util.js';

const KEY = 'gridfish.journal.v7';
const COIN = { I: 'INJ', E: 'ETH', S: 'SOL', K: 'LINK' };
const DIR = { L: 'long', S: 'short', N: 'neutral' };
// jurnal bawaan: koin,arah,prediksi,aktual,profit,modal  ('-' = belum selesai)
const SEED = 'I,L,80,67,0.309,50;I,L,75,3,0.308,50;I,S,75,4,0.317,50;I,L,80,37,0.528,100;I,S,80,5,0.415,100;I,L,80,42,0.502,100;I,S,85,23,0.322,50;I,L,85,53,0.424,100;I,S,85,570,0.321,50;I,S,55,9,0.273,50;I,S,65,20,0.452,100;I,S,65,1,0.425,100;E,S,255,107,0.359,100;S,S,225,51,0.414,100;K,S,200,23,0.399,100;S,S,220,21,0.422,100;I,L,70,3,0.48,100;I,S,70,17,0.323,50;I,L,65,0,0.418,100;K,S,225,12,0.418,100;S,S,220,10,0.43,100;I,L,65,368,0.479,100;I,S,65,9,0.313,50;K,S,185,62,0.423,100;S,S,225,4,0.411,100;I,S,65,3,0.377,50;S,S,220,15,0.512,100;I,S,65,20,0.327,50;E,S,310,7,0.413,100;K,S,240,241,0.427,100;E,S,320,242,0.406,100;I,S,65,115,0.387,50;I,L,65,37,0.329,50;I,L,65,73,0.311,50;K,S,185,753,0.447,100;E,S,305,317,0.497,100;I,L,70,3,0.296,50;I,S,70,1249,0.278,50;I,L,55,4,0.434,100;S,S,300,246,0.404,100;S,S,220,1,0.417,100;S,S,215,124,0.439,100;E,S,260,106,0.43,100;K,S,215,27,0.421,100;S,S,275,24,0.465,100;E,S,280,22,0.427,100;K,S,240,23,0.421,100;S,S,270,21,0.408,100;E,S,360,52,0.414,100;K,S,225,29,0.47,100;S,S,230,276,0.413,100;K,S,200,641,0.44,100;I,L,75,7,0.357,100;E,S,335,105,0.431,100;I,L,65,88,0.42,100;E,S,345,209,0.314,50;S,S,230,211,0.465,100;I,L,65,17,0.411,100;I,L,75,6,0.405,100;I,L,75,401,0.382,100;E,S,345,30,0.424,100;S,S,235,175,0.378,100;E,S,330,173,0.391,100;K,S,195,15,0.485,100;K,S,265,89,0.438,100;S,S,230,7,0.36,100;E,S,310,23,0.416,100;I,S,70,12,0.437,100;S,S,225,7,0.413,100;I,S,70,2,0.426,100;E,S,255,1453,0.574,100;K,S,205,24,0.402,100;S,S,225,14,0.476,100;I,S,70,10,0.438,100;I,S,75,4,0.424,100;K,S,270,990,0.445,100;S,S,370,967,0.428,100;I,S,75,57,0.433,100;I,S,75,4,0.516,100;I,S,75,261,0.428,100;I,S,75,355,0.431,100;K,S,280,23,0.22,100;I,L,80,30,0.412,100;K,S,255,105,0.407,100;I,L,85,386,0.381,100;K,S,220,21,0.502,100;K,S,175,19,0.448,100;S,S,160,2,0.432,100;E,S,220,687,0.402,100;K,S,95,5,0.411,100;S,S,160,675,0.195,100;K,S,110,114,0.41,100;I,S,55,39,0.37,100;K,S,105,250,0.401,100;I,L,55,1,0.404,100;I,S,65,249,0.485,100;S,S,210,215,0.394,100;K,S,135,1,0.516,100;I,L,40,5,0.525,100;K,S,85,5,0.422,100;E,S,200,5,0.416,100;E,S,320,2,0.431,100;I,L,70,-,-,100;S,S,250,0,0.474,100;E,S,330,6,0.444,100;K,S,110,19,0.456,100;S,S,235,24,0.434,100;K,S,100,14,0.405,100;E,S,280,12,0.476,100;S,S,190,-,-,100;E,S,190,-,-,100;K,S,65,-,-,100;S,L,225,107,0.455,100;E,S,285,77,0.419,100';

const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : null; };
const uid = () => Math.random().toString(36).slice(2, 10);

function seedRows() {
  return SEED.split(';').map((s, i) => {
    const [c, d, pred, act, profit, modal] = s.split(',');
    return { id: 'seed' + i, ts: null, coin: COIN[c], dir: DIR[d], pred: num(pred), actual: num(act), profit: num(profit), modal: num(modal), source: 'seed' };
  });
}

// ---------- penyimpanan ----------
export function loadJournal() {
  try {
    const s = localStorage.getItem(KEY);
    if (s) { const rows = JSON.parse(s); if (Array.isArray(rows)) return rows; }
  } catch (_) { /* storage tidak tersedia */ }
  return seedRows();
}
export function saveJournal(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows)); return true; } catch (_) { return false; }
}
export const resetJournal = () => { try { localStorage.removeItem(KEY); } catch (_) {} return seedRows(); };

export function newEntry(fields) {
  return { id: uid(), ts: new Date().toISOString(), actual: null, source: 'app', ...fields };
}

// ---------- impor / ekspor (format spreadsheet Anda) ----------
const normDir = (s) => { const v = String(s || '').toLowerCase(); return v.startsWith('l') ? 'long' : v.startsWith('s') ? 'short' : v.startsWith('n') ? 'neutral' : v || 'short'; };

export function parseJournal(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => l.split(/\t|;|,(?=\S)/).map((x) => x.trim());
  // posisi default = urutan kolom spreadsheet Anda
  let col = { coin: 0, dir: 1, pred: 2, actual: 3, profit: 4, hit: 6, modal: 7 };
  let start = 0;
  const head = split(lines[0]).map((h) => h.toLowerCase());
  if (num(head[2]) == null) {
    start = 1;
    const find = (re, not) => head.findIndex((h) => re.test(h) && !(not && not.test(h)));
    col = {
      coin: find(/jenis|coin|koin|symbol/), dir: find(/model|arah|dir/),
      pred: find(/prediksi|pred/, /mc/), actual: find(/actual|aktual/),
      profit: find(/profit/), hit: find(/^hit$/), modal: find(/modal|invest/),
    };
  }
  const out = [];
  for (const l of lines.slice(start)) {
    const c = split(l);
    const get = (k) => (col[k] >= 0 ? c[col[k]] : undefined);
    const coin = String(get('coin') || '').toUpperCase();
    const pred = num(get('pred'));
    if (!coin || pred == null) continue;
    let actual = num(get('actual'));
    if (num(get('hit')) === -1) actual = null;
    out.push({ id: uid(), ts: null, coin, dir: normDir(get('dir')), pred, actual, profit: num(get('profit')), modal: num(get('modal')), source: 'import' });
  }
  return out;
}

export function toTSV(rows) {
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const h = ['Jenis Bot', 'Model', 'Prediksi Durasi Hit (menit)', 'Actual Durasi Hit', 'Profit', 'Modal', 'MC P50 (menit)', 'MC P80 (menit)', 'Waktu'];
  const v = (x) => (x == null ? '' : x);
  return [h.join('\t'), ...rows.map((r) => [r.coin, cap(r.dir), v(r.pred), v(r.actual), v(r.profit), v(r.modal),
    r.mc50 != null ? Math.round(r.mc50) : '', r.mc80 != null ? Math.round(r.mc80) : '', v(r.ts)].join('\t'))].join('\n');
}

// ---------- kalibrasi ----------
const K_SLOPE = 20, K_GROUP = 8, MIN_ROWS = 12;
const gkey = (coin, dir) => coin + '|' + dir;
const usable = (rows) => rows.filter((r) => r.pred > 0 && r.actual != null && r.actual >= 0);

export function fitCalibration(rows) {
  const d = usable(rows);
  const n = d.length;
  if (n < MIN_ROWS) return null;
  const x = d.map((r) => Math.log(r.pred)), y = d.map((r) => Math.log(Math.max(r.actual, 0.5)));
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const bOls = sxx > 1e-9 ? sxy / sxx : 1;
  const b = clamp((n * bOls + K_SLOPE) / (n + K_SLOPE), 0.3, 1.2);
  const a = my - b * mx;

  const e = y.map((yi, i) => yi - a - b * x[i]);
  const acc = {};
  d.forEach((r, i) => { const k = gkey(r.coin, r.dir); (acc[k] ||= { n: 0, s: 0 }); acc[k].n++; acc[k].s += e[i]; });
  const groups = {};
  for (const [k, g] of Object.entries(acc)) groups[k] = { n: g.n, delta: g.s / (g.n + K_GROUP) };
  const resid = d.map((r, i) => e[i] - groups[gkey(r.coin, r.dir)].delta).sort((p, q) => p - q);
  const legacyCover = d.filter((r) => r.actual <= r.pred).length / n;
  return { a, b, groups, resid, n, legacyCover, medRatio: Math.exp(quantileLin(y.map((yi, i) => yi - x[i]).sort((p, q) => p - q), 0.5)) };
}

// distribusi waktu (menit) untuk ETA dasar tertentu
export function predictTime(cal, eta, coin, dir) {
  if (!cal || !(eta > 0)) return null;
  const g = cal.groups[gkey(coin, dir)];
  const mu = cal.a + cal.b * Math.log(eta) + (g ? g.delta : 0);
  const r = cal.resid, n = r.length;
  return {
    n: cal.n, nGroup: g ? g.n : 0, mu,
    q: (p) => Math.exp(mu + quantileLin(r, p)),
    cdf: (t) => {   // proporsi residual ≤ ln t − μ, diinterpolasi
      if (!(t > 0)) return 0;
      const z = Math.log(t) - mu;
      if (z < r[0]) return 0;
      if (z >= r[n - 1]) return 1;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m] <= z) lo = m; else hi = m; }
      const f = r[hi] > r[lo] ? (z - r[lo]) / (r[hi] - r[lo]) : 0;
      return (lo + f) / (n - 1);
    },
  };
}

// uji jujur: setiap trade diprediksi dari model yang dilatih TANPA trade itu
export function looCoverage(rows) {
  const d = usable(rows);
  if (d.length < MIN_ROWS + 1) return null;
  let c50 = 0, c80 = 0, absLog = 0;
  for (let i = 0; i < d.length; i++) {
    const cal = fitCalibration(d.filter((_, j) => j !== i));
    const p = predictTime(cal, d[i].pred, d[i].coin, d[i].dir);
    if (!p) return null;
    if (d[i].actual <= p.q(0.5)) c50++;
    if (d[i].actual <= p.q(0.8)) c80++;
    absLog += Math.abs(Math.log(Math.max(d[i].actual, 0.5) / p.q(0.5)));
  }
  const n = d.length;
  return { n, c50: c50 / n, c80: c80 / n, mdlFactor: Math.exp(absLog / n) };
}

// seberapa jujur prediksi MC (untuk entri yang dicatat dari aplikasi)
export function mcCoverage(rows) {
  const d = rows.filter((r) => r.actual != null && r.mc50 != null);
  if (d.length < 3) return null;
  return {
    n: d.length,
    c50: d.filter((r) => r.actual <= r.mc50).length / d.length,
    c80: d.filter((r) => r.mc80 != null && r.actual <= r.mc80).length / d.length,
  };
}
