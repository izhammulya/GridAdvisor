/* utilitas umum: angka, RNG ber-seed, statistik, format */

export const $ = (id) => document.getElementById(id);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
export const mean = (a) => (a.length ? sum(a) / a.length : null);

// ---------- RNG (mulberry32 bila ada seed, Math.random bila kosong) ----------
let _rand = Math.random;
let spare = null;
export const rand = () => _rand();

export function setSeed(seedStr) {
  spare = null;
  const s = String(seedStr || '').trim();
  if (!s) { _rand = Math.random; return; }
  let a = 0;
  for (let i = 0; i < s.length; i++) a = (Math.imul(a, 31) + s.charCodeAt(i)) | 0;
  _rand = () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// normal standar (Marsaglia polar)
export function gauss() {
  if (spare !== null) { const v = spare; spare = null; return v; }
  let u, v, s;
  do { u = _rand() * 2 - 1; v = _rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  spare = v * m;
  return u * m;
}

// ---------- statistik pada array TERURUT naik ----------
export const quantile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : null;

// kuantil dengan interpolasi linear (lebih halus untuk sampel kecil)
export function quantileLin(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const x = clamp(p, 0, 1) * (n - 1), i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

// expected shortfall: rata-rata a% terburuk
export function esOf(sorted, a) {
  if (!sorted.length) return null;
  const k = Math.max(1, Math.ceil(a * sorted.length));
  let s = 0; for (let i = 0; i < k; i++) s += sorted[i];
  return s / k;
}

export const sortedCopy = (arr) => Float64Array.from(arr).sort();

// jumlah elemen ≤ t pada array terurut (binary search)
export function countLE(sorted, t) {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] <= t) a = m + 1; else b = m; }
  return a;
}

// ---------- format ----------
export const fmt = (x, d = 4) => (x == null || !isFinite(x) ? '—'
  : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
export const fmtPx = (x) => (x == null || !isFinite(x) ? '—' : fmt(x, x >= 1000 ? 2 : x >= 10 ? 3 : 4));
export const pctTxt = (x, d = 2) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%');
export const pct1 = (p) => (p == null || !isFinite(p) ? '—' : (p * 100).toFixed(1) + '%');
export const pct0 = (p) => (p == null || !isFinite(p) ? '—' : Math.round(p * 100) + '%');
export const signCls = (x) => (x >= 0 ? 'pos' : 'neg');

export function fmtDur(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1) return '< 1 menit';
  if (m < 60) return Math.round(m) + ' menit';
  if (m < 48 * 60) {
    const h = Math.floor(m / 60), mm = Math.round((m - h * 60) / 5) * 5;
    if (mm >= 60) return (h + 1) + ' jam';
    return mm ? `${h} jam ${mm} mnt` : `${h} jam`;
  }
  return (m / 1440).toFixed(1) + ' hari';
}
export const fmtDurShort = (m) => (m < 60 ? Math.round(m) + 'm' : m < 1440 ? +(m / 60).toFixed(1) + 'j' : +(m / 1440).toFixed(1) + 'h');

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
