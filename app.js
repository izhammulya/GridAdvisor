/* GRIDFISH v6 — Pionex Grid Advisor (LINK/SOL/ETH/INJ)
   ================================================================
   PERUBAHAN v6
   A. MODEL (akurasi & reliabilitas)
   1. FAT TAIL DIPERBAIKI. v5 menaruh "jump" per sub-step 5–10 menit. Karena 6–12 sub-step
      dijumlahkan menjadi 1 jam, excess kurtosis ikut terbagi 6–12× → return per jam praktis
      normal (ekor hilang, P(liq)/P(SL) terlalu kecil). v6 memakai pengali volatilitas PER JAM
      (mixture normal) yang dikalibrasi ke kurtosis residual GARCH dari data asli.
   2. VOLATILITAS: ensemble GK+CC EWMA (v5) ⊕ GARCH(1,1) dengan term structure sesuai horizon
      (σ tinggi saat ini meluruh ke rata-rata jangka panjang sesuai persistensi α+β hasil fit).
   3. KETIDAKPASTIAN PARAMETER: σ tiap path dikali faktor lognormal (sd 10%, E[σ²] tetap).
      σ dari ~40 hari data tidak pasti; tanpa ini risiko ekor cenderung diremehkan.
   4. HMM multi-start (3 inisialisasi, ambil log-likelihood terbaik), fit pada 720 jam terakhir.
   5. Data 1000 candle 1 jam (≈41 hari) → GARCH & backtest lebih stabil.
   6. UJI SILANG otomatis: model alternatif (HMM↔GBM), stress (σ×1.35 + drift melawan arah),
      dan BACKTEST historis (setting yang sama dijalankan di jalur harga asli, O→L→H→C / O→H→L→C).
   7. Bug kecil: fee 0% tidak bisa diinput (0 || 0.05); perubahan 30D memakai 720 jam.
   B. KEPUTUSAN
   8. Mesin keputusan GO / HOLD / NO-GO + ukuran posisi (GO 100% / GO 50%). Skor 0–100 dari
      kriteria: peluang target gabungan, risiko likuidasi (normal & stress), bot mati (SL+liq),
      kerugian ekor ES5, expected value, arah vs regime/trend/VR, konsistensi antar-model.
      Gerbang keamanan: liq-sebelum-SL & profit/grid ≤ 0 → NO-GO; data non-live & spike 1 jam → maks HOLD.
   9. Pencari setting lebih aman: screening arah × leverage × lebar range (common random numbers)
      + tombol "Terapkan".
   10. Validitas keputusan: 60 menit / selama harga di dalam band ±0.2σ harian.
   11. Repair bot: keputusan ADD / HOLD / CUT berbasis expected value vs cut loss sekarang.

   TARGET:
   - Grid Spot   : 0.30% investasi (50 USDT → 0.15 USDT)
   - Futures Grid: 1 USDT per 100 USDT margin (500 USDT → 5 USDT)
   - Repair (futures): default auto 1% × (investasi + add), minimal 1 USDT.

   Model tetap aproksimasi — bukan jaminan. */

'use strict';

// ---------- konstanta & state ----------
const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm', rpDir: 'short' };
const N_SIM = 5000;               // simulasi utama
const N_X = 1500;                 // uji silang: model alternatif & stress
const N_OPT = 400, N_OPT_S = 240; // screening setting alternatif
const N_SIM_REPAIR = 1500;
const SUB_REPAIR = 4;             // 15 menit per sub-step utk repair
const FINE_HOURS = 24;            // 24 jam pertama: resolusi halus
const SUB_FINE = 12;              // 5 menit per sub-step
const SLIP = 0.0005;              // slippage eksekusi stop loss
const TARGET_SPOT = 0.003;        // 0.30% investasi
const TARGET_FUT = 0.01;          // 1 USDT per 100 USDT margin
const MMR = 0.005;                // maintenance margin rate (aproksimasi Pionex)
const TAIL_K = 3;                 // jam "stres": σ × 3
const PARAM_SD = 0.10;            // ketidakpastian σ per path
const DRIFT_SHRINK = 0.25;        // simpan 25% drift hasil estimasi
const KL_LIMIT = 1000;
const STRESS_VOL = 1.35, STRESS_VOL_NEUTRAL = 1.5, STRESS_DRIFT = 0.15;
const DEC_NOGO = 45, DEC_GO = 65, DEC_FULL = 80;
const VALID_MIN = 60;
let RUN_ID = '';
let LAST_OPT = null;

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const subFor = (days) => (days <= 7 ? 6 : days <= 14 ? 4 : 2);   // sub-step per jam setelah 24 jam pertama
const readDays = () => clamp(Math.round(+$('inDays').value || 7), 1, 30);
const numOr = (id, d) => { const el = $(id); if (!el) return d; const v = parseFloat(el.value); return isFinite(v) ? v : d; };

const DEMO = {
  LINK: { price: 7.83,   change_1h: -0.3, change_24h: -2.1, change_7d: -5.4, change_30d: 4.2 },
  SOL:  { price: 145.2,  change_1h: 0.2,  change_24h: 1.8,  change_7d: -3.9, change_30d: 9.5 },
  ETH:  { price: 3412.5, change_1h: 0.1,  change_24h: 0.9,  change_7d: 2.7,  change_30d: 6.1 },
  INJ:  { price: 5.355,  change_1h: 0.4,  change_24h: -1.2, change_7d: 3.8,  change_30d: -6.5 },
};

// ---------- segmented controls ----------
function selectSeg(el, b, key) {
  [...el.querySelectorAll('button')].forEach((x) => x.classList.remove('on', 'long', 'short'));
  b.classList.add('on');
  if (b.dataset.v === 'long') b.classList.add('long');
  if (b.dataset.v === 'short') b.classList.add('short');
  S[key] = b.dataset.v;
}
function seg(id, key, onChange) {
  const el = $(id); if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    selectSeg(el, b, key);
    if (onChange) onChange();
  });
}
function setSeg(id, key, v) {
  const el = $(id); if (!el) return;
  const b = [...el.querySelectorAll('button')].find((x) => x.dataset.v === v);
  if (b) selectSeg(el, b, key);
}
seg('segCoin', 'coin');
seg('segProd', 'prod', () => {
  const fut = S.prod === 'fut';
  ['fldDir', 'fldLev', 'fldFund'].forEach((id) => $(id) && $(id).classList.toggle('hide', !fut));
});
seg('segDir', 'dir');
seg('segModel', 'model');
seg('segRpDir', 'rpDir');

setInterval(() => { $('clock').textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }, 1000);

// ---------- data pasar ----------
async function getQuote(sym) {
  try {
    const r = await fetch('/api/quotes?symbol=' + sym);
    const j = await r.json();
    if (j && typeof j.price === 'number') return { ...j, demo: false, src: 'CMC' };
    return { ...DEMO[sym], symbol: sym, demo: true, reason: (j && j.error) || 'API tidak tersedia' };
  } catch (e) {
    return { ...DEMO[sym], symbol: sym, demo: true, reason: 'Tidak bisa mengakses /api/quotes' };
  }
}

const KL_CACHE = {};
async function getKlines(sym) {
  const c = KL_CACHE[sym];
  if (c && Date.now() - c.at < 60000) return c.data;
  const url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + sym + 'USDT&interval=1h&limit=' + KL_LIMIT;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
    if (to) clearTimeout(to);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j) || j.length < 200) throw new Error('data kurang');
    const data = j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }))
      .filter((k) => k.c > 0 && k.o > 0 && k.h > 0 && k.l > 0);
    KL_CACHE[sym] = { at: Date.now(), data };
    return data;
  } catch (e) { return null; }
}

async function loadMarket(sym) {
  const [q0, kl] = await Promise.all([getQuote(sym), getKlines(sym)]);
  let q = q0;
  if (kl && q0.demo) {
    const last = kl[kl.length - 1].c;
    const chg = (h) => { const i = kl.length - 1 - h; return i >= 0 ? (last / kl[i].c - 1) * 100 : 0; };
    q = {
      symbol: sym, price: last, demo: false, src: 'BINANCE',
      change_1h: chg(1), change_24h: chg(24), change_7d: chg(168), change_30d: chg(Math.min(720, kl.length - 1)),
      last_updated: new Date().toISOString(),
    };
  }
  return { q, kl };
}

function logReturns(kl) {
  const r = [];
  for (let i = 1; i < kl.length; i++) {
    const x = Math.log(kl[i].c / kl[i - 1].c);
    if (isFinite(x)) r.push(x);
  }
  return r;
}

// ---------- variance ratio (Lo–MacKinlay, overlapping) ----------
// VR < 1 → mean-reverting (menguntungkan grid; model random-walk jadi konservatif)
// VR > 1 → trending (model random-walk cenderung OPTIMISTIS untuk grid)
function varianceRatio(r, qn) {
  const T = r.length;
  if (T < qn * 20) return null;
  let m = 0; for (const x of r) m += x; m /= T;
  let v1 = 0; for (const x of r) v1 += (x - m) * (x - m); v1 /= T;
  if (v1 <= 0) return null;
  let s = 0; for (let i = 0; i < qn; i++) s += r[i];
  let vq = 0, cnt = 0;
  for (let i = qn; ; i++) {
    vq += (s - qn * m) * (s - qn * m); cnt++;
    if (i >= T) break;
    s += r[i] - r[i - qn];
  }
  vq /= cnt;
  const se = Math.sqrt((2 * (2 * qn - 1) * (qn - 1)) / (3 * qn * T));
  return { q: qn, vr: vq / (qn * v1), se };
}

// ---------- GARCH(1,1) dengan variance targeting (grid search QML) ----------
function fitGARCH(r) {
  const T = r.length;
  if (T < 200) return null;
  let m = 0; for (const x of r) m += x; m /= T;
  const e = new Float64Array(T); let v = 0;
  for (let t = 0; t < T; t++) { e[t] = r[t] - m; v += e[t] * e[t]; }
  v /= T;
  if (!(v > 0)) return null;
  let best = null;
  for (const per of [0.80, 0.88, 0.93, 0.96, 0.98, 0.99, 0.995]) {
    for (let ai = 1; ai <= 12; ai++) {
      const a = ai * 0.02;
      if (a >= per) continue;
      const b = per - a, w = v * (1 - per);
      let h = v, ll = 0;
      for (let t = 0; t < T; t++) { ll -= 0.5 * (Math.log(h) + (e[t] * e[t]) / h); h = w + a * e[t] * e[t] + b * h; }
      if (!best || ll > best.ll) best = { a, b, w, ll };
    }
  }
  const { a, b, w } = best;
  let h = v; const z = new Float64Array(T);
  for (let t = 0; t < T; t++) { z[t] = e[t] / Math.sqrt(h); h = w + a * e[t] * e[t] + b * h; }
  return { a, b, per: a + b, lr: v, hNext: h, z };
}
// rata-rata varians per jam selama H jam ke depan
const garchAvgVar = (g, H) => {
  const phi = g.per;
  if (phi >= 0.9999) return g.hNext;
  return g.lr + (g.hNext - g.lr) * (1 - Math.pow(phi, H)) / ((1 - phi) * H);
};
// kurtosis mixture normal: dengan prob p σ×K, varians dinormalisasi = 1
const tailKurt = (p) => { const k2 = TAIL_K * TAIL_K; return 3 * (1 - p + p * k2 * k2) / Math.pow(1 - p + p * k2, 2); };
function calibrateTail(kurt) {
  if (!isFinite(kurt) || kurt <= 3.05) return 0;
  const tgt = Math.min(kurt, tailKurt(0.1) - 1e-6);
  let a = 0, b = 0.1;
  for (let i = 0; i < 40; i++) { const m = 0.5 * (a + b); if (tailKurt(m) < tgt) a = m; else b = m; }
  return 0.5 * (a + b);
}

// ---------- volatilitas harian ----------
function dailyVol(q, kl, days) {
  if (kl) {
    const r = [], gk = [];
    const c2 = 2 * Math.LN2 - 1;
    for (let i = 1; i < kl.length; i++) {
      const x = Math.log(kl[i].c / kl[i - 1].c);
      if (!isFinite(x)) continue;
      const k = kl[i];
      const hl = Math.log(k.h / k.l), co = Math.log(k.c / k.o);
      const g = 0.5 * hl * hl - c2 * co * co;              // Garman–Klass per bar
      r.push(x); gk.push(isFinite(g) && g > 0 ? g : x * x);
    }
    const T = r.length;
    let cc = 0, gkm = 0;
    for (let t = 0; t < T; t++) { cc += r[t] * r[t]; gkm += gk[t]; }
    cc /= T; gkm /= T;
    const longRun = 0.5 * cc + 0.5 * gkm;
    let ew = longRun; const lam = 0.985;                  // half-life ≈ 46 jam
    for (let t = 0; t < T; t++) ew = lam * ew + (1 - lam) * (0.5 * r[t] * r[t] + 0.5 * gk[t]);
    const wS = days <= 3 ? 0.7 : days <= 10 ? 0.5 : 0.3;
    const vEw = wS * ew + (1 - wS) * longRun;

    const g = fitGARCH(r);
    let vG = vEw, kurt = null, tailP = 0.02, garch = null;
    if (g) {
      // GARCH dari close-to-close; level disamakan ke estimator GK+CC
      vG = garchAvgVar(g, Math.max(24, days * 24)) * clamp(longRun / g.lr, 0.7, 1.3);
      let m2 = 0, m4 = 0;
      for (let t = 0; t < T; t++) { const z2 = g.z[t] * g.z[t]; m2 += z2; m4 += z2 * z2; }
      m2 /= T; m4 /= T;
      kurt = m4 / (m2 * m2);
      tailP = calibrateTail(kurt);
      garch = {
        a: g.a, b: g.b, per: g.per,
        hl: g.per < 1 ? Math.log(0.5) / Math.log(g.per) : Infinity,
        nowD: Math.sqrt(g.hNext * 24), lrD: Math.sqrt(g.lr * 24),
      };
    }
    const vH = 0.5 * vEw + 0.5 * vG;
    return {
      vol: clamp(Math.sqrt(vH * 24), 0.01, 0.15),
      src: `GK+CC EWMA ⊕ GARCH · ${T}×1J`,
      vr6: varianceRatio(r, 6), vr24: varianceRatio(r, 24),
      tailP, kurt, garch, live: true,
    };
  }
  // proxy: 1 sampel |return| per horizon. E|X| = σ√(2/π) → σ̂ = |X|·√(π/2)
  const c = [
    Math.abs(q.change_24h || 0),
    Math.abs(q.change_7d || 0) / Math.sqrt(7),
    Math.abs(q.change_30d || 0) / Math.sqrt(30),
    Math.abs(q.change_1h || 0) * Math.sqrt(24),
  ].map((x) => x / 100);
  const ms = c.reduce((a, b) => a + b * b, 0) / c.length;
  return {
    vol: clamp(Math.sqrt(ms) * Math.sqrt(Math.PI / 2), 0.02, 0.12), src: 'PROXY 4 TITIK (KASAR)',
    vr6: null, vr24: null, tailP: 0.02, kurt: null, garch: null, live: false,
  };
}

// ---------- aturan grid custom ----------
function pointScale(P) {
  const exp = Math.max(0, Math.floor(Math.log10(P)) - 1);
  const scale = Math.pow(10, exp);
  return { scale, point: 0.01 * scale };
}
function gridDivisor(P) {
  const { scale } = pointScale(P);
  return Math.max(2, Math.floor(P / scale / 10) + 2);
}

// ---------- regresi trend ----------
function buildTrend(q, vol, kl) {
  const P = q.price;
  let pts;
  if (kl && kl.length >= 24 * 30 - 24) {
    pts = [];
    for (let d = 30; d >= 0; d--) {
      const idx = kl.length - 1 - 24 * d;
      if (idx < 0) continue;
      const lab = d === 30 ? '-30D' : d === 7 ? '-7D' : d === 1 ? '-24H' : d === 0 ? 'NOW' : '';
      pts.push({ t: -d, lab, p: kl[idx].c });
    }
  } else {
    pts = [
      { t: -30,     lab: '-30D', p: P / (1 + (q.change_30d || 0) / 100) },
      { t: -7,      lab: '-7D',  p: P / (1 + (q.change_7d  || 0) / 100) },
      { t: -1,      lab: '-24H', p: P / (1 + (q.change_24h || 0) / 100) },
      { t: -1 / 24, lab: '-1H',  p: P / (1 + (q.change_1h  || 0) / 100) },
      { t: 0,       lab: 'NOW',  p: P },
    ];
  }
  const n = pts.length;
  const xs = pts.map((o) => o.t), ys = pts.map((o) => Math.log(o.p));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = syy > 0 && sxx > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const muSim = clamp(slope * 0.5 * r2, -0.2 * vol, 0.2 * vol);
  let label = 'SIDEWAYS', cls = '';
  if (slope > 0.3 * vol && r2 > 0.3) { label = 'UPTREND'; cls = 'up'; }
  else if (slope < -0.3 * vol && r2 > 0.3) { label = 'DOWNTREND'; cls = 'dn'; }
  return { pts, slope, r2, muSim, label, cls, daily: n > 6 };
}

// ---------- HMM 3-regime: Baum-Welch pada return 1 jam ----------
function fitHMM(r, iters, sgInit) {
  const T = r.length, K = 3;
  let s2 = 0; for (let t = 0; t < T; t++) s2 += r[t] * r[t];
  const sd = Math.sqrt(s2 / T) || 1e-4;
  const mu = [0.15 * sd, 0, -0.15 * sd];
  const sg = sgInit.map((x) => x * sd);
  const A = [[0.96, 0.03, 0.01], [0.02, 0.96, 0.02], [0.01, 0.03, 0.96]];
  const pi = [1 / 3, 1 / 3, 1 / 3];
  const al = new Float64Array(T * K), be = new Float64Array(T * K);
  const B = new Float64Array(T * K), sc = new Float64Array(T);
  const sgFloor = 0.12 * sd;
  let prevLL = -Infinity, ll = 0;

  for (let it = 0; it < iters; it++) {
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) {
      const z = (r[t] - mu[k]) / sg[k];
      B[t * K + k] = Math.exp(-0.5 * z * z) / (sg[k] * 2.5066282746310002) + 1e-300;
    }
    let s = 0;
    for (let k = 0; k < K; k++) { al[k] = pi[k] * B[k]; s += al[k]; }
    sc[0] = s; for (let k = 0; k < K; k++) al[k] /= s;
    for (let t = 1; t < T; t++) {
      s = 0;
      for (let j = 0; j < K; j++) {
        let v = 0;
        for (let i = 0; i < K; i++) v += al[(t - 1) * K + i] * A[i][j];
        v *= B[t * K + j]; al[t * K + j] = v; s += v;
      }
      sc[t] = s; for (let j = 0; j < K; j++) al[t * K + j] /= s;
    }
    for (let k = 0; k < K; k++) be[(T - 1) * K + k] = 1;
    for (let t = T - 2; t >= 0; t--) for (let i = 0; i < K; i++) {
      let v = 0;
      for (let j = 0; j < K; j++) v += A[i][j] * B[(t + 1) * K + j] * be[(t + 1) * K + j];
      be[t * K + i] = v / sc[t + 1];
    }
    ll = 0; for (let t = 0; t < T; t++) ll += Math.log(sc[t]);

    const gS = [0, 0, 0], gR = [0, 0, 0], xi = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) {
      const g = al[t * K + k] * be[t * K + k];
      gS[k] += g; gR[k] += g * r[t];
    }
    for (let t = 0; t < T - 1; t++) {
      const inv = 1 / sc[t + 1];
      for (let i = 0; i < K; i++) for (let j = 0; j < K; j++)
        xi[i][j] += al[t * K + i] * A[i][j] * B[(t + 1) * K + j] * be[(t + 1) * K + j] * inv;
    }
    for (let k = 0; k < K; k++) pi[k] = al[k] * be[k];
    for (let i = 0; i < K; i++) {
      const row = xi[i][0] + xi[i][1] + xi[i][2] + 3e-3;
      for (let j = 0; j < K; j++) A[i][j] = (xi[i][j] + 1e-3) / row;
    }
    for (let k = 0; k < K; k++) mu[k] = gR[k] / Math.max(gS[k], 1e-9);
    const gV = [0, 0, 0];
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) {
      const d = r[t] - mu[k];
      gV[k] += al[t * K + k] * be[t * K + k] * d * d;
    }
    for (let k = 0; k < K; k++) sg[k] = Math.max(sgFloor, Math.sqrt(gV[k] / Math.max(gS[k], 1e-9)));

    if (Math.abs(ll - prevLL) < 1e-7 * Math.abs(ll)) break;
    prevLL = ll;
  }
  const L = (T - 1) * K;
  return { mu, sg, A, alpha: [al[L], al[L + 1], al[L + 2]], ll };
}
// multi-start: Baum-Welch hanya menjamin optimum lokal
function fitHMMBest(r) {
  const inits = [[0.9, 0.55, 1.7], [1.0, 0.7, 1.4], [0.8, 0.45, 2.2]];
  let best = null;
  for (const s of inits) {
    const f = fitHMM(r, 60, s);
    if (isFinite(f.ll) && (!best || f.ll > best.ll)) best = f;
  }
  return best;
}

function buildHMM(q, vol, kl, days) {
  let muH, sgH, Ah, alpha, fitted = false, nObs = 0, volScale = 1;
  const r = kl ? logReturns(kl) : null;
  const f = r && r.length >= 200 ? fitHMMBest(r.slice(-720)) : null;

  if (f) {
    const ord = [0, 1, 2].sort((a, b) => f.mu[b] - f.mu[a]);   // BULL, SIDE, BEAR
    sgH = ord.map((k) => f.sg[k]);
    Ah = ord.map((i) => ord.map((j) => f.A[i][j]));
    alpha = ord.map((k) => f.alpha[k]);

    // kalibrasi level σ ke estimator volatilitas (dibatasi 0.8–1.25 agar info regime tetap)
    const steps = Math.max(24, Math.round((days || 7) * 24));
    let pi = alpha.slice(), acc = 0;
    for (let t = 0; t < steps; t++) {
      acc += pi[0] * sgH[0] * sgH[0] + pi[1] * sgH[1] * sgH[1] + pi[2] * sgH[2] * sgH[2];
      pi = [0, 1, 2].map((j) => pi[0] * Ah[0][j] + pi[1] * Ah[1][j] + pi[2] * Ah[2][j]);
    }
    volScale = clamp(Math.sqrt((vol * vol / 24) / (acc / steps)), 0.8, 1.25);
    sgH = sgH.map((s) => s * volScale);
    muH = ord.map((k, i) => clamp(f.mu[k] * DRIFT_SHRINK, -0.1 * sgH[i], 0.1 * sgH[i]));
    fitted = true; nObs = Math.min(720, r.length);
  } else {
    const muD = [0.3 * vol, 0, -0.3 * vol];
    const sgD = [1.0 * vol, 0.75 * vol, 1.3 * vol];
    const A = [[0.88, 0.10, 0.02], [0.08, 0.84, 0.08], [0.02, 0.10, 0.88]];
    const P = q.price;
    const p30 = P / (1 + (q.change_30d || 0) / 100), p7 = P / (1 + (q.change_7d || 0) / 100);
    const p1 = P / (1 + (q.change_24h || 0) / 100), ph = P / (1 + (q.change_1h || 0) / 100);
    const obs = [
      { r: Math.log(p7 / p30), L: 23 }, { r: Math.log(p1 / p7), L: 6 },
      { r: Math.log(ph / p1), L: 23 / 24 }, { r: Math.log(P / ph), L: 1 / 24 },
    ];
    const matMul = (X, Y) => X.map((row) => Y[0].map((_, j) => row.reduce((s, v, k) => s + v * Y[k][j], 0)));
    const matPow = (L) => {
      let M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const w = Math.floor(L);
      for (let i = 0; i < w; i++) M = matMul(M, A);
      const fr = L - w;
      if (fr > 1e-9) M = matMul(M, A.map((row, i) => row.map((v, j) => (i === j ? 1 + fr * (v - 1) : fr * v))));
      return M;
    };
    const emis = (x, L, k) => {
      const v = sgD[k] * sgD[k] * L;
      return Math.exp(-((x - muD[k] * L) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
    };
    alpha = [1 / 3, 1 / 3, 1 / 3];
    for (const o of obs) {
      const Tm = matPow(o.L);
      const pred = [0, 1, 2].map((j) => alpha[0] * Tm[0][j] + alpha[1] * Tm[1][j] + alpha[2] * Tm[2][j]);
      const upd = pred.map((p, k) => p * emis(o.r, o.L, k));
      const Z = upd[0] + upd[1] + upd[2];
      alpha = Z > 0 ? upd.map((x) => x / Z) : [1 / 3, 1 / 3, 1 / 3];
    }
    muH = muD.map((m) => m / 24);
    sgH = sgD.map((s) => s / Math.sqrt(24));
    Ah = A.map((row, i) => row.map((v, j) => (i === j ? 1 + (v - 1) / 24 : v / 24)));
  }

  const AhCum = Ah.map((row) => { const s = row[0] + row[1] + row[2]; return [row[0] / s, (row[0] + row[1]) / s, 1]; });
  const piCum = [alpha[0], alpha[0] + alpha[1], 1];
  const muExpD = 24 * (alpha[0] * muH[0] + alpha[1] * muH[1] + alpha[2] * muH[2]);
  return {
    fitted, nObs, volScale, muH, sgH, Ah, AhCum, piCum, alpha,
    muEff: clamp(muExpD, -0.2 * vol, 0.2 * vol),
    sgD: sgH.map((s) => s * Math.sqrt(24)), muD: muH.map((m) => m * 24),
  };
}

function modelParams(R, H) {
  if (R.useHMM) return H;
  return { muH: [R.mu / 24], sgH: [R.vol / Math.sqrt(24)], AhCum: [[1, 1, 1]], piCum: [1, 1, 1] };
}
const pickCum = (cum, u) => (u < cum[0] ? 0 : u < cum[1] ? 1 : 2);

// ---------- buku order grid (state order ala Pionex, dengan histeresis) ----------
// Garis k = low + k·step. Order beli menunggu di garis nb, order jual di garis ns.
// Sell terisi di k → nb = k−1, ns = k+1. Buy terisi di k → ns = k+1, nb = k−1.
class GridBook {
  constructor(R) {
    this.R = R; this.cap = (R.invest * R.lev) / R.grids;
    this.mode = !R.fut || R.dir === 'long' ? 0 : R.dir === 'short' ? 1 : 2;   // 0 long/spot, 1 short, 2 neutral
    this.L = []; this.Sh = []; this.sIL = 0; this.sIS = 0;
    this.realized = 0; this.nb = 0; this.ns = 1; this.cycles = 0;
  }
  line(k) { return this.R.low + k * this.R.step; }
  reset(p) {
    const R = this.R;
    this.L.length = 0; this.Sh.length = 0; this.sIL = 0; this.sIS = 0; this.realized = 0; this.cycles = 0;
    const lvl = Math.min(R.grids, Math.max(0, Math.floor((p - R.low) / R.step)));
    this.nb = lvl; this.ns = lvl + 1;
    if (this.mode === 0) { for (let k = 0; k < R.grids - lvl; k++) this.openL(p); }
    else if (this.mode === 1) { for (let k = 0; k < lvl; k++) this.openS(p); }
  }
  openL(e) { this.L.push(e); this.sIL += 1 / e; }
  openS(e) { this.Sh.push(e); this.sIS += 1 / e; }
  closeL(px) {
    const e = this.L.pop(); this.sIL = this.L.length ? this.sIL - 1 / e : 0;
    this.realized += this.cap * ((px - e) / e - 2 * this.R.fee); this.cycles++;
  }
  closeS(px) {
    const e = this.Sh.pop(); this.sIS = this.Sh.length ? this.sIS - 1 / e : 0;
    this.realized += this.cap * ((e - px) / e - 2 * this.R.fee); this.cycles++;
  }
  fillSell(px) {
    if (this.mode === 1) this.openS(px);
    else if (this.L.length) this.closeL(px);
    else if (this.mode === 2) this.openS(px);
  }
  fillBuy(px) {
    if (this.mode === 0) this.openL(px);
    else if (this.Sh.length) this.closeS(px);
    else if (this.mode === 2) this.openL(px);
  }
  move(p) {
    const g = this.R.grids;
    while (this.ns <= g && p >= this.line(this.ns)) {
      this.fillSell(this.line(this.ns)); this.nb = this.ns - 1; this.ns++;
    }
    while (this.nb >= 0 && p <= this.line(this.nb)) {
      this.fillBuy(this.line(this.nb)); this.ns = this.nb + 1; this.nb--;
    }
  }
  fl(p) { return this.cap * (p * this.sIL - this.L.length) + this.cap * (this.Sh.length - p * this.sIS); }
  notional(p) { return this.cap * p * (this.sIL + this.sIS); }
  closeAll(p) {
    this.realized += this.fl(p) - this.R.fee * this.notional(p);
    this.L.length = 0; this.Sh.length = 0; this.sIL = 0; this.sIS = 0;
  }
}

// ---------- runner: grid + SL/TP + likuidasi + funding (dipakai MC, backtest, optimizer) ----------
class Runner {
  constructor(R) {
    this.R = R; this.b = new GridBook(R);
    this.slLow = R.slLow ?? -Infinity; this.slHigh = R.slHigh ?? Infinity;
    this.tpLow = R.tpLow ?? -Infinity; this.tpHigh = R.tpHigh ?? Infinity;
    this.fundH = R.fut ? R.funding / 8 : 0;
    this.fund = 0; this.exitPx = R.P;
  }
  reset(p) { this.b.reset(p); this.fund = 0; this.exitPx = p; }
  liqAt(q) {
    const b = this.b, R = this.R;
    return R.fut && R.invest + b.realized + b.fl(q) + this.fund <= MMR * b.notional(q);
  }
  // 0 = lanjut, 1 = likuidasi, 2 = SL, 3 = TP
  visit(q) {
    const b = this.b;
    if (q <= this.slLow) {
      b.move(this.slLow); this.exitPx = this.slLow;
      if (this.liqAt(this.slLow)) return 1;
      b.closeAll(this.slLow * (1 - SLIP)); return 2;
    }
    if (q >= this.slHigh) {
      b.move(this.slHigh); this.exitPx = this.slHigh;
      if (this.liqAt(this.slHigh)) return 1;
      b.closeAll(this.slHigh * (1 + SLIP)); return 2;
    }
    if (q >= this.tpHigh) { b.move(this.tpHigh); b.closeAll(this.tpHigh); this.exitPx = this.tpHigh; return 3; }
    if (q <= this.tpLow) { b.move(this.tpLow); b.closeAll(this.tpLow); this.exitPx = this.tpLow; return 3; }
    b.move(q);
    if (this.liqAt(q)) { this.exitPx = q; return 1; }
    return 0;
  }
  net(q) { const b = this.b; return b.realized + b.fl(q) + this.fund - this.R.fee * b.notional(q); }
  eq(p) { const b = this.b; return Math.max(-this.R.invest, b.realized + b.fl(p) + this.fund); }
  accrue(p) { if (this.fundH) { const b = this.b; this.fund += this.fundH * b.cap * p * (b.sIS - b.sIL); } }   // long bayar, short terima (funding +)
  final(st, p) {
    if (st === 1) return -this.R.invest;
    if (st >= 2) return Math.max(-this.R.invest, this.b.realized + this.fund);
    return this.eq(p);
  }
}

// harga likuidasi bila harga bergerak monoton (grid ikut terisi di jalan)
function liqScan(R, dirSign) {
  if (!R.fut) return null;
  const b = new GridBook(R); b.reset(R.P);
  for (let k = 1; k <= 4000; k++) {
    const p = R.P * (1 + dirSign * k * 0.0005);
    if (p <= 0) return null;
    b.move(p);
    if (R.invest + b.realized + b.fl(p) <= MMR * b.notional(p)) return p;
  }
  return null;
}

// ---------- mesin rekomendasi ----------
function readCfg() {
  const fut = S.prod === 'fut';
  return {
    days: readDays(),
    fee: Math.max(0, numOr('inFee', 0.05)) / 100,
    invest: Math.max(10, numOr('inInvest', 50)),
    fut,
    dir: fut ? S.dir : 'neutral',
    lev: fut ? clamp(Math.round(numOr('inLev', 3)), 1, 10) : 1,
    funding: fut ? numOr('inFunding', 0) / 100 : 0,
    useHMM: S.model === 'hmm',
    width: clamp(numOr('inWidth', 1), 0.5, 2.5),
  };
}

function buildReco(q, T, H, V, cfg) {
  const P = q.price, vol = V.vol;
  const { days, fee, invest, fut, dir, lev, funding, useHMM, width } = cfg;
  const targetRate = fut ? TARGET_FUT : TARGET_SPOT;

  const horizonVol = vol * Math.sqrt(days) * width;
  const z = 1.28;
  const mu = useHMM ? H.muEff : T.muSim;
  const centerShift = Math.exp(mu * days * 0.5);

  let lowM = z, highM = z;
  if (dir === 'long') { lowM = 1.25 * z; highM = 0.85 * z; }
  if (dir === 'short') { lowM = 0.85 * z; highM = 1.25 * z; }
  let low = P * centerShift * (1 - lowM * horizonVol);
  let high = P * centerShift * (1 + highM * horizonVol);
  low = Math.max(low, P * 0.3);

  const { point } = pointScale(P);
  const divisor = gridDivisor(P);
  let grids, points = null, feeAdjusted = false;

  low = Math.round(low / point) * point;
  high = Math.round(high / point) * point;

  if (!fut) {
    points = Math.round((high - low) / point);
    grids = Math.round(points / divisor) + 1;
    const minStepPct = 2 * fee + 0.0005;
    const maxGrids = Math.max(2, Math.floor((high - low) / (P * minStepPct)));
    if (grids > maxGrids) { grids = maxGrids; feeAdjusted = true; }
    grids = clamp(grids, 2, 200);
  } else {
    const netPerGrid = 0.0035;
    grids = clamp(Math.round((high - low) / (P * (netPerGrid + 2 * fee))), 6, 200);
  }

  const step = (high - low) / grids;
  const profitPerGridNet = step / P - 2 * fee;
  const targetUsd = invest * targetRate;
  const trigger = dir === 'long' ? P * 0.998 : dir === 'short' ? P * 1.002 : null;

  let slLow = null, slHigh = null, tpLow = null, tpHigh = null;
  if (!fut || dir === 'long') { slLow = low * 0.98; tpHigh = high; }
  else if (dir === 'short') { slHigh = high * 1.02; tpLow = low; }
  else { slLow = low * 0.98; slHigh = high * 1.02; }

  const R = {
    P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step, funding, width,
    profitPerGridNet, trigger, slLow, slHigh, tpLow, tpHigh,
    point, divisor, points, feeAdjusted, targetUsd, targetRate, mu, useHMM, tailP: V.tailP,
  };
  R.liqLow = fut ? liqScan(R, -1) : null;
  R.liqHigh = fut ? liqScan(R, +1) : null;
  R.liqBeforeSL = !!((R.liqLow && slLow && R.liqLow >= slLow) || (R.liqHigh && slHigh && R.liqHigh <= slHigh));
  return R;
}

// ---------- estimasi analitik waktu-ke-target (cek silang MC) ----------
// Setelah fill di garis k, order terdekat di k±1. Waktu keluar Brownian dari (−δ, +δ):
// ½σ²u'' = −1, u(±δ) = 0 → E[τ] = δ²/σ². Kira-kira separuh fill menutup posisi → 2δ²/σ² per siklus.
function etaAnalytic(R, sgHourly) {
  const delta = Math.log(1 + R.step / R.P);
  const tau = (delta * delta) / (sgHourly * sgHourly);
  const cap = (R.invest * R.lev) / R.grids;
  const perCycle = cap * R.profitPerGridNet;
  if (!(perCycle > 0) || !(tau > 0)) return null;
  const cycles = Math.ceil(R.targetUsd / perCycle);
  return { tauMin: tau * 60, cycles, perCycle, minutes: 2 * cycles * tau * 60 };
}

// ---------- RNG (bisa di-seed) ----------
let _rand = Math.random;
let gaussSpare = null;
function setSeed(seedStr) {
  gaussSpare = null;
  const s = (seedStr || '').trim();
  if (!s) { _rand = Math.random; return; }
  let a = 0;
  for (let i = 0; i < s.length; i++) a = (Math.imul(a, 31) + s.charCodeAt(i)) | 0;
  a |= 0;
  _rand = function mulberry32() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedVal = () => ($('inSeed') ? $('inSeed').value : '');
// seed turunan: kalau user tidak mengisi seed, tetap deterministik per klik (common random numbers)
const seedTag = (t) => (seedVal().trim() || 'auto-' + RUN_ID) + '|' + t;
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = _rand() * 2 - 1; v = _rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  gaussSpare = v * m; return u * m;
}
const quantile = (sortedArr, p) =>
  sortedArr.length ? sortedArr[Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length))] : null;
// expected shortfall: rata-rata a% terburuk (array terurut naik)
const esOf = (sortedArr, a) => {
  if (!sortedArr.length) return null;
  const k = Math.max(1, Math.ceil(a * sortedArr.length));
  let s = 0; for (let i = 0; i < k; i++) s += sortedArr[i];
  return s / k;
};

// high/low Brownian bridge di dalam satu langkah (log harga x0 → x1, varians v)
const bridgeHi = (x0, x1, v2) => 0.5 * (x0 + x1 + Math.sqrt((x1 - x0) * (x1 - x0) - v2 * Math.log(1 - _rand())));
const bridgeLo = (x0, x1, v2) => 0.5 * (x0 + x1 - Math.sqrt((x1 - x0) * (x1 - x0) - v2 * Math.log(1 - _rand())));

// ---------- Monte Carlo ----------
// opsi: n, light (hanya statistik inti), coarse (tanpa resolusi 5 menit), volMult, driftD (log/hari), seed
function simulate(R, H, o = {}) {
  const N = o.n || N_SIM, light = !!o.light;
  setSeed(o.seed != null ? o.seed : seedVal());
  const M = modelParams(R, H);
  const volMult = o.volMult || 1, driftH = (o.driftD || 0) / 24;
  const SUB = o.coarse ? 4 : subFor(R.days);
  const SF = o.coarse ? SUB : Math.max(SUB_FINE, SUB);
  const FH = o.coarse ? 0 : FINE_HOURS;
  const nH = Math.round(R.days * 24);
  const off = new Int32Array(nH + 1);
  for (let h = 0; h < nH; h++) off[h + 1] = off[h] + (h < FH ? SF : SUB);
  const n = off[nH];
  const sgB = M.sgH.map((s) => s * volMult), muB = M.muH.map((m) => m + driftH);
  const isF = 1 / Math.sqrt(SF), isS = 1 / Math.sqrt(SUB);
  const tailP = R.tailP == null ? 0.02 : R.tailP;
  const tailN = 1 / Math.sqrt(1 - tailP + tailP * TAIL_K * TAIL_K);
  const run = new Runner(R), tgt = R.targetUsd;

  const pnl = new Float64Array(N), endPx = new Float64Array(N);
  const maxDD = new Float64Array(N), sharpe = new Float64Array(N), cyc = new Float64Array(N);
  const hitMin = [];
  let liqCount = 0, slCount = 0, tpCount = 0;
  const samplePaths = [], sampleEq = [];

  const ckIdx = [];
  let ckPx = null, ckEq = null, ckFilled = null, ckAt = null;
  if (!light) {
    const ckEvery = Math.max(1, Math.round(nH / 28));
    for (let h = ckEvery; h <= nH; h += ckEvery) ckIdx.push(h);
    if (ckIdx[ckIdx.length - 1] !== nH) ckIdx.push(nH);
    ckPx = ckIdx.map(() => new Float64Array(N));
    ckEq = ckIdx.map(() => new Float32Array(N));
    ckFilled = ckIdx.map(() => new Uint8Array(N));
    ckAt = new Int32Array(nH + 2).fill(-1);
    ckIdx.forEach((h, c) => { ckAt[h] = c; });
  }

  const gBuf = new Float64Array(n), rgBuf = new Int8Array(nH), mBuf = new Float64Array(nH);
  let uPath = 1;

  for (let i = 0; i < N; i++) {
    const anti = (i & 1) === 1;
    if (!anti) {                                   // pasangan antithetic berbagi regime, tail & σ-unc
      let rg = pickCum(M.piCum, _rand());
      for (let h = 0; h < nH; h++) {
        rg = pickCum(M.AhCum[rg], _rand()); rgBuf[h] = rg;
        mBuf[h] = (_rand() < tailP ? TAIL_K : 1) * tailN;
      }
      for (let t = 0; t < n; t++) gBuf[t] = gauss();
      uPath = Math.exp(PARAM_SD * gauss() - PARAM_SD * PARAM_SD);
    }
    const sgn = anti ? -1 : 1;
    let p = R.P, lx = Math.log(R.P);
    run.reset(p);

    let eq = 0, peak = 0, minDd = 0, prevDayEq = 0, sumR = 0, sumR2 = 0, nD = 0;
    let status = 0, hit = -1, tEnd = nH * 60;
    const keep = !light && i < 60;
    const kp = keep ? [p] : null, ke = keep ? [0] : null;

    outer:
    for (let h = 0; h < nH; h++) {
      const rg = rgBuf[h], fine = h < FH, Sx = fine ? SF : SUB;
      const s = sgB[rg] * uPath * mBuf[h] * (fine ? isF : isS);
      const d = muB[rg] / Sx - 0.5 * s * s, v2 = 2 * s * s, base = off[h];
      for (let j = 0; j < Sx; j++) {
        const x1 = lx + d + s * sgn * gBuf[base + j];
        const up = x1 >= lx;
        const hi = bridgeHi(lx, x1, v2), lo = bridgeLo(lx, x1, v2);
        const tMin = (h + (j + 1) / Sx) * 60;
        for (let w = 0; w < 3; w++) {
          const q = Math.exp(w === 2 ? x1 : (w === 0) === up ? lo : hi);   // naik: O→L→H→C, turun: O→H→L→C
          const st = run.visit(q);
          if (st) { status = st; tEnd = tMin; p = run.exitPx; break outer; }
          if (hit < 0 && run.net(q) >= tgt) hit = tMin;
        }
        lx = x1;
      }
      p = Math.exp(lx);
      run.accrue(p);

      eq = run.eq(p);
      if (eq > peak) peak = eq;
      if (eq - peak < minDd) minDd = eq - peak;
      if ((h + 1) % 24 === 0) {
        const rD = (eq - prevDayEq) / R.invest;
        sumR += rD; sumR2 += rD * rD; nD++; prevDayEq = eq;
      }
      if (kp) { kp.push(p); ke.push(eq / R.invest * 100); }
      if (ckAt) {
        const ci = ckAt[h + 1];
        if (ci >= 0) { ckPx[ci][i] = p; ckEq[ci][i] = eq / R.invest * 100; ckFilled[ci][i] = 1; }
      }
    }

    if (status) {
      eq = run.final(status, p);
      if (status === 1) liqCount++; else if (status === 2) slCount++; else tpCount++;
      if (eq > peak) peak = eq;
      if (eq - peak < minDd) minDd = eq - peak;
      if (hit < 0 && eq >= tgt) hit = tEnd;
      if (kp) { kp.push(p); ke.push(eq / R.invest * 100); }
    }
    if (ckAt) {
      for (let c = 0; c < ckIdx.length; c++) {
        if (!ckFilled[c][i]) { ckPx[c][i] = p; ckEq[c][i] = eq / R.invest * 100; }
        ckFilled[c][i] = 0;
      }
    }
    if (hit > 0) hitMin.push(hit);

    pnl[i] = eq; endPx[i] = p; cyc[i] = run.b.cycles;
    maxDD[i] = (minDd / R.invest) * 100;
    if (nD >= 2) {
      const m = sumR / nD, sd = Math.sqrt(Math.max(0, sumR2 / nD - m * m));
      sharpe[i] = sd > 1e-9 ? clamp((m / sd) * Math.sqrt(365), -10, 10) : 0;
    } else sharpe[i] = 0;
    if (kp) { samplePaths.push(kp); sampleEq.push(ke); }
  }

  const pct = Array.from(pnl, (x) => (x / R.invest) * 100).sort((a, b) => a - b);
  const prob = (f) => { let c = 0; for (const x of pct) if (f(x)) c++; return c / N; };
  const targetPct = R.targetRate * 100;
  const mean = pct.reduce((a, b) => a + b, 0) / N;
  const cyArr = Array.from(cyc).sort((a, b) => a - b);
  hitMin.sort((a, b) => a - b);
  const pTarget = prob((x) => x >= targetPct - 1e-9);
  const pTouch = hitMin.length / N;
  const seOf = (p) => Math.sqrt(Math.max(1e-9, p * (1 - p) / N)) * 100;

  const common = {
    N, targetPct, mean,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05), p95: quantile(pct, 0.95), es5: esOf(pct, 0.05),
    pWin: prob((x) => x > 0),
    pTarget, se: seOf(pTarget), pTouch, seTouch: seOf(pTouch),
    pLiq: liqCount / N, pSL: slCount / N, pTP: tpCount / N,
    cyP50: quantile(cyArr, 0.5),
  };
  if (light) return common;

  const px = Array.from(endPx).sort((a, b) => a - b);
  const ddArr = Array.from(maxDD).sort((a, b) => a - b);
  const shArr = Array.from(sharpe).sort((a, b) => a - b);
  const fanOf = (arrs) => ckIdx.map((t, c) => {
    const arr = Array.from(arrs[c]).sort((a, b) => a - b);
    return { t, p5: quantile(arr, 0.05), p50: quantile(arr, 0.5), p95: quantile(arr, 0.95) };
  });

  // ---- distribusi waktu ke target ----
  const horizonMin = nH * 60;
  const cdfAt = (t) => {
    let a = 0, b = hitMin.length;
    while (a < b) { const m = (a + b) >> 1; if (hitMin[m] <= t) a = m + 1; else b = m; }
    return a / N;
  };
  const uq = (p) => { const k = Math.ceil(p * N) - 1; return k < hitMin.length ? hitMin[Math.max(0, k)] : null; };
  const bucketMins = [15, 30, 60, 180, 360, 720, 1440, 4320, 10080, 20160].filter((t) => t < horizonMin).concat([horizonMin]);
  const ttt = {
    hitMin, horizonMin,
    buckets: bucketMins.map((t) => ({ t, p: cdfAt(t) })),
    t25: uq(0.25), t50: uq(0.5), t80: uq(0.8),
    condMed: hitMin.length ? quantile(hitMin, 0.5) : null,
    resFine: 60 / SF, resLate: 60 / SUB,
    eta: etaAnalytic(R, Math.sqrt(M.sgH.reduce((a, s) => a + s * s, 0) / M.sgH.length)),
  };

  return {
    ...common, pct, samplePaths, sampleEq, nH, SUB, SF, ttt,
    fan: fanOf(ckPx), eqFan: fanOf(ckEq),
    ddArr, shArr,
    ddP5: quantile(ddArr, 0.05), ddP50: quantile(ddArr, 0.5), ddP95: quantile(ddArr, 0.95),
    shP5: quantile(shArr, 0.05), shP50: quantile(shArr, 0.5), shP95: quantile(shArr, 0.95),
    cyP5: quantile(cyArr, 0.05), cyP95: quantile(cyArr, 0.95),
    pxP5: quantile(px, 0.05), pxP50: quantile(px, 0.5), pxP95: quantile(px, 0.95),
    p1: prob((x) => x >= 1),
  };
}

function stressOpts(R) {
  const sgn = !R.fut || R.dir === 'long' ? -1 : R.dir === 'short' ? 1 : 0;
  return sgn ? { volMult: STRESS_VOL, driftD: sgn * STRESS_DRIFT * R.vol } : { volMult: STRESS_VOL_NEUTRAL, driftD: 0 };
}

// ---------- backtest historis: setting yang sama di jalur harga asli ----------
function backtest(R, kl) {
  if (!kl) return null;
  const nH = Math.round(R.days * 24);
  const indep = kl.length / nH;                         // jumlah periode tidak tumpang-tindih
  if (kl.length < nH + 24) return { n: 0, indep };
  const stepH = Math.max(3, Math.round(nH / 24));
  const run = new Runner(R);
  const pct = [];
  let liq = 0, sl = 0, tp = 0, touch = 0, tgtEnd = 0;
  for (let s = 0; s + nH <= kl.length; s += stepH) {
    const f = R.P / kl[s].o;
    run.reset(R.P);
    let st = 0, hit = false, last = R.P;
    outer:
    for (let h = 0; h < nH; h++) {
      const k = kl[s + h], o = k.o * f, hi = k.h * f, lo = k.l * f, c = k.c * f;
      const seq = c >= o ? [o, lo, hi, c] : [o, hi, lo, c];
      for (const qx of seq) {
        const r = run.visit(qx);
        if (r) { st = r; last = run.exitPx; break outer; }
        last = qx;
        if (!hit && run.net(qx) >= R.targetUsd) hit = true;
      }
      run.accrue(c);
    }
    const eq = run.final(st, last);
    if (st === 1) liq++; else if (st === 2) sl++; else if (st === 3) tp++;
    if (eq >= R.targetUsd) { tgtEnd++; hit = true; }
    if (hit) touch++;
    pct.push((eq / R.invest) * 100);
  }
  pct.sort((a, b) => a - b);
  const n = pct.length;
  return {
    n, indep, stepH,
    pTarget: tgtEnd / n, pTouch: touch / n, pLiq: liq / n, pSL: sl / n, pTP: tp / n,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05),
    mean: pct.reduce((a, b) => a + b, 0) / n, es5: esOf(pct, 0.05),
  };
}

// ================================================================
// MESIN KEPUTUSAN — GO / HOLD / NO-GO
// ================================================================
const pct1 = (p) => (p == null || !isFinite(p) ? '—' : (p * 100).toFixed(1) + '%');

function decide(x) {
  const { R, base, alt, stress, bt, T, H, V, q } = x;
  const fut = R.fut, tp = R.targetRate * 100;
  const W = fut ? { tgt: 25, liq: 25, sl: 15, tail: 15, ev: 10, reg: 10 }
                : { tgt: 30, liq: 0,  sl: 20, tail: 20, ev: 15, reg: 15 };
  const checks = [], caps = [], fixes = [];
  let score = 0, hard = false;
  const push = (c) => { checks.push(c); score += c.pts; if (c.hard) hard = true; };

  // peluang target gabungan (ensemble): utama 50%, alternatif 20%, stress 20%, backtest ≤10%
  const btOk = !!(bt && bt.n >= 8 && bt.indep >= 2);
  let ws = 0.5, ps = 0.5 * base.pTarget;
  if (alt) { ws += 0.2; ps += 0.2 * alt.pTarget; }
  if (stress) { ws += 0.2; ps += 0.2 * stress.pTarget; }
  if (btOk) { const wb = 0.1 * Math.min(1, bt.indep / 4); ws += wb; ps += wb * bt.pTarget; }
  const pCons = ps / ws;

  { // 1. peluang target
    const st = pCons >= 0.55 ? 'ok' : pCons >= 0.35 ? 'warn' : 'fail';
    push({ key: 'tgt', name: 'Peluang capai target', val: `${pct1(pCons)} gabungan · utama ${pct1(base.pTarget)}`,
      st, pts: W.tgt * clamp((pCons - 0.25) / 0.35, 0, 1), max: W.tgt });
    if (st !== 'ok') fixes.push('Peluang target belum cukup: perpanjang horizon atau coba range lebih sempit (lebih banyak siklus) — cek tabel setting alternatif.');
  }

  if (fut) { // 2. likuidasi
    const bL = base.pLiq, sL = stress ? stress.pLiq : bL;
    const hardL = R.liqBeforeSL || bL > 0.05;
    let st, pts;
    if (hardL) { st = 'fail'; pts = 0; }
    else if (bL <= 0.01 && sL <= 0.05) { st = 'ok'; pts = W.liq; }
    else if (bL <= 0.03 && sL <= 0.12) { st = 'warn'; pts = W.liq * 0.45; }
    else { st = 'fail'; pts = 0; }
    push({ key: 'liq', name: 'Risiko likuidasi', val: `${pct1(bL)} normal · ${pct1(sL)} stress${R.liqBeforeSL ? ' · liq sebelum SL' : ''}`,
      st, pts, max: W.liq, hard: hardL });
    if (st !== 'ok') fixes.push(`Turunkan leverage (sekarang ${R.lev}x)${R.liqBeforeSL ? ' — harga likuidasi saat ini tersentuh sebelum Stop Loss, jadi SL tidak melindungi' : ''}.`);
  }

  { // 3. bot mati karena SL / liq
    const x2 = base.pSL + base.pLiq;
    const st = x2 <= 0.10 ? 'ok' : x2 <= 0.25 ? 'warn' : 'fail';
    push({ key: 'sl', name: fut ? 'Bot mati (SL + liq)' : 'Kena stop loss',
      val: pct1(x2) + (stress ? ` · stress ${pct1(stress.pSL + stress.pLiq)}` : ''),
      st, pts: st === 'ok' ? W.sl : st === 'warn' ? W.sl * 0.5 : 0, max: W.sl, hard: x2 > 0.40 });
    if (st !== 'ok') fixes.push('Banyak path kena SL: perlebar range (Lebar range ×) atau pilih arah yang searah trend.');
  }

  { // 4. kerugian ekor (ES5)
    const okT = fut ? -12 : -8, warnT = fut ? -30 : -15, hardT = fut ? -60 : -35;
    const e = base.es5, es = stress ? stress.es5 : e;
    const st = e >= okT ? 'ok' : e >= warnT ? 'warn' : 'fail';
    push({ key: 'tail', name: 'Rata-rata 5% skenario terburuk', val: `${pctTxt(e)} (${fmt(e * R.invest / 100, 2)} USDT) · stress ${pctTxt(es)}`,
      st, pts: st === 'ok' ? W.tail : st === 'warn' ? W.tail * 0.5 : 0, max: W.tail, hard: es <= hardT });
    if (st !== 'ok') fixes.push(`Kerugian di skenario buruk besar: kecilkan investasi${fut ? ' atau leverage' : ''}, atau gunakan GO 50%.`);
  }

  { // 5. expected value
    const m = base.mean;
    const st = m >= 0 ? 'ok' : m >= -tp ? 'warn' : 'fail';
    push({ key: 'ev', name: 'Expected value', val: `${pctTxt(m)} (${fmt(m * R.invest / 100, 2)} USDT)${stress ? ` · stress ${pctTxt(stress.mean)}` : ''}`,
      st, pts: st === 'ok' ? W.ev : st === 'warn' ? W.ev * 0.4 : 0, max: W.ev });
  }

  { // 6. arah vs regime / trend / variance ratio
    const dirSign = !fut || R.dir === 'long' ? 1 : R.dir === 'short' ? -1 : 0;
    let pAg, trendAg;
    if (dirSign > 0) { pAg = H.alpha[2]; trendAg = T.label === 'DOWNTREND'; }
    else if (dirSign < 0) { pAg = H.alpha[0]; trendAg = T.label === 'UPTREND'; }
    else { pAg = 0; trendAg = T.label !== 'SIDEWAYS'; }
    const z6 = V.vr6 ? (V.vr6.vr - 1) / V.vr6.se : 0, z24 = V.vr24 ? (V.vr24.vr - 1) / V.vr24.se : 0;
    const vrTr = z6 >= 2 || z24 >= 2;
    const nb = (pAg > 0.5 ? 1 : 0) + (trendAg ? 1 : 0) + (vrTr ? 1 : 0);
    const st = nb === 0 ? 'ok' : nb === 1 ? 'warn' : 'fail';
    const parts = [];
    if (dirSign) parts.push(`regime lawan ${(pAg * 100).toFixed(0)}%`);
    parts.push('trend ' + T.label.toLowerCase());
    parts.push(vrTr ? 'VR trending' : 'VR netral');
    push({ key: 'reg', name: fut ? 'Arah vs regime & trend' : 'Kondisi pasar utk grid', val: parts.join(' · '),
      st, pts: st === 'ok' ? W.reg : st === 'warn' ? W.reg * 0.5 : 0, max: W.reg });
    if (nb > 0) {
      if (fut && dirSign > 0) fixes.push('Long melawan regime/trend — pertimbangkan Neutral/Short, atau tunggu regime SIDE/BULL.');
      else if (fut && dirSign < 0) fixes.push('Short melawan regime/trend — pertimbangkan Neutral/Long, atau tunggu.');
      else if (fut) fixes.push('Neutral grid dirugikan pasar trending — pertimbangkan arah searah trend, atau tunggu sideways.');
      else fixes.push('Grid spot rawan saat trend turun/trending kuat — tunggu sideways atau kecilkan investasi.');
    }
  }

  { // 7. konsistensi antar-model (penalti)
    const why = [];
    if (alt && Math.abs(base.pTarget - alt.pTarget) > 0.2) why.push(`model alternatif ${pct1(alt.pTarget)}`);
    if (btOk && bt.pTarget < base.pTarget - 0.25) why.push(`backtest ${pct1(bt.pTarget)}`);
    if (fut && btOk && bt.pLiq > base.pLiq + 0.05) why.push(`liq backtest ${pct1(bt.pLiq)}`);
    if (alt || btOk) {
      push({ key: 'agree', name: 'Konsistensi antar-model', val: why.length ? 'berbeda: ' + why.join(', ') : 'model utama, alternatif & backtest selaras',
        st: why.length ? 'warn' : 'ok', pts: why.length ? -8 : 0, max: 0 });
      if (why.length) fixes.push('Model tidak sepakat → ketidakpastian tinggi. Pakai ukuran kecil atau tunggu.');
    }
  }

  { // gerbang: profit/grid
    const ok = R.profitPerGridNet > 0.0005;
    push({ key: 'ppg', name: 'Profit per grid bersih', val: (R.profitPerGridNet * 100).toFixed(3) + '%',
      st: ok ? 'ok' : 'fail', pts: 0, max: 0, hard: !ok });
    if (!ok) fixes.push('Profit per grid hampir habis dimakan fee — kurangi jumlah grid / perlebar range.');
  }

  // gerbang yang membatasi keputusan maksimal HOLD
  if (q.demo || !V.live) caps.push('Data harga/candle live tidak tersedia — angka berbasis proxy kasar.');
  const z1 = V.vol > 0 ? Math.abs((q.change_1h || 0) / 100) / (V.vol / Math.sqrt(24)) : 0;
  if (z1 > 2.5) caps.push(`Harga baru bergerak ${pctTxt(q.change_1h)} dalam 1 jam (${z1.toFixed(1)}σ) — tunggu 1–2 candle sampai tenang, jangan kejar spike.`);

  // futures: kegagalan di risiko likuidasi atau kerugian ekor tidak boleh ditutup oleh skor tinggi
  if (fut && checks.some((c) => (c.key === 'liq' || c.key === 'tail') && c.st === 'fail'))
    caps.push('Futures: risiko likuidasi/kerugian ekor gagal — maksimal HOLD sampai leverage atau ukuran diturunkan.');

  score = clamp(Math.round(score), 0, 100);
  const anyFail = checks.some((c) => c.st === 'fail');
  let verdict, size;
  if (hard || score < DEC_NOGO) { verdict = 'NO-GO'; size = 0; }
  else if (caps.length || score < DEC_GO) { verdict = 'HOLD'; size = 0; }
  else {
    verdict = 'GO';
    const liqOk = !fut || checks.find((c) => c.key === 'liq').st === 'ok';
    size = score >= DEC_FULL && !anyFail && liqOk ? 1 : 0.5;
  }
  return { verdict, size, score, checks, caps, fixes: [...new Set(fixes)], pCons, btOk };
}

const verdictLabel = (d) => (d.verdict === 'GO' ? `GO ${d.size * 100}%` : d.verdict);
const verdictCls = (v) => (v === 'GO' ? 'go' : v === 'HOLD' ? 'hold' : 'nogo');
const sameCfg = (a, b) => a.dir === b.dir && a.lev === b.lev && Math.abs(a.width - b.width) < 1e-6;

// ---------- pencari setting lebih aman ----------
async function optimize(q, T, H, V, cfg, prog) {
  const cands = [];
  if (cfg.fut) {
    const levs = [...new Set([1, 2, 3, cfg.lev])].filter((l) => l <= cfg.lev).sort((a, b) => a - b);
    for (const dir of ['long', 'short', 'neutral'])
      for (const lev of levs)
        for (const width of [1, 1.4]) cands.push({ ...cfg, dir, lev, width });
  } else {
    for (const width of [0.7, 1, 1.4, 1.9]) cands.push({ ...cfg, width });
  }
  if (!cands.some((c) => sameCfg(c, cfg))) cands.push({ ...cfg });

  const out = [];
  for (let i = 0; i < cands.length; i++) {
    if (prog) prog(i + 1, cands.length);
    await new Promise((r) => setTimeout(r, 0));
    const c = cands[i];
    const R = buildReco(q, T, H, V, c);
    // seed sama utk semua kandidat → perbedaan skor berasal dari setting, bukan noise
    const base = simulate(R, H, { n: N_OPT, coarse: true, light: true, seed: seedTag('opt') });
    const stress = simulate(R, H, { n: N_OPT_S, coarse: true, light: true, seed: seedTag('opt-s'), ...stressOpts(R) });
    const d = decide({ R, base, stress, alt: null, bt: null, T, H, V, q });
    out.push({ cfg: c, R, base, stress, d, cur: sameCfg(c, cfg) });
  }
  const rank = { 'GO': 2, 'HOLD': 1, 'NO-GO': 0 };
  out.sort((a, b) => (rank[b.d.verdict] - rank[a.d.verdict]) || (b.d.size - a.d.size) || (b.d.score - a.d.score));
  return out;
}

function applyCfg(c) {
  if (c.fut) {
    setSeg('segDir', 'dir', c.dir);
    $('inLev').value = c.lev;
  }
  $('inWidth').value = c.width.toFixed(2);
  $('btnGo').click();
  const top = $('cardDecision');
  if (top && top.scrollIntoView) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ================================================================
// REPAIR BOT — futures grid yang sedang rugi
// ================================================================
function readRepairCfg(q) {
  const num = (id, d) => { const el = $(id); if (!el || el.value.trim() === '') return d; const v = +el.value; return isFinite(v) ? v : d; };
  const dir = S.rpDir;
  const Q0 = Math.abs(num('rpQty', 234));
  const avg = num('rpAvg', 5.245);
  const P0 = num('rpPrice', 0) > 0 ? num('rpPrice', 0) : q.price;
  const low = num('rpLow', 4.9);
  const high = num('rpHigh', 5.75);
  const grids = Math.max(2, Math.round(num('rpGrids', 85)));
  const qty = Math.max(1e-9, num('rpQtyGrid', 3.6));
  const fee = Math.max(0, num('rpFee', 0.05)) / 100;
  const funding = num('rpFund', 0.01) / 100;
  const pnlNow = num('rpPnl', -55.83);
  const gridNow = num('rpGridProfit', 11.86);
  const invest = Math.max(1, num('rpInvest', 335.59));
  const avail = Math.max(0, num('rpAvail', 278.11));
  const liq0 = num('rpLiq', 6.16);
  const tRaw = $('rpTarget') ? $('rpTarget').value.trim() : '';
  const targetManual = tRaw === '' || !isFinite(+tRaw) ? null : Math.max(1, +tRaw);
  const days = clamp(Math.round(num('rpDays', 30)), 3, 60);
  const nUnits = Math.max(1, Math.round(Q0 / qty));
  const Qs = nUnits * qty;
  const fl0 = dir === 'short' ? Qs * (avg - P0) : Qs * (P0 - avg);
  const offset = pnlNow - gridNow - fl0;               // funding historis & selisih akuntansi Pionex
  const E0 = liq0 > 0
    ? (dir === 'short' ? Q0 * (liq0 - P0) + MMR * Q0 * liq0 : Q0 * (P0 - liq0) - MMR * Q0 * liq0)
    : invest + pnlNow;
  return { dir, Q0, avg, P0, low, high, grids, qty, fee, funding, pnlNow, gridNow, invest, avail, liq0,
           targetManual, days, nUnits, Qs, fl0, offset, E0 };
}

const repairTarget = (c, add) => (c.targetManual != null ? c.targetManual : Math.max(1, (c.invest + add) * TARGET_FUT));

function liqAfterAdd(c, add) {
  if (c.Q0 <= 0) return c.liq0;
  return c.dir === 'short' ? c.liq0 + add / (c.Q0 * (1 + MMR)) : c.liq0 - add / (c.Q0 * (1 - MMR));
}

function simRepairScenario(c, H, add, tailP) {
  const nH = c.days * 24, SUB = SUB_REPAIR;
  const step = (c.high - c.low) / c.grids;
  const short = c.dir === 'short';
  const target = repairTarget(c, add);
  const sgSub = H.sgH.map((s) => s / Math.sqrt(SUB));
  const muSub = H.muH.map((m) => m / SUB);
  const tp = tailP == null ? 0.02 : tailP;
  const tailN = 1 / Math.sqrt(1 - tp + tp * TAIL_K * TAIL_K);
  const fundH = c.funding / 8;
  const line = (k) => c.low + k * step;
  const stack = new Float64Array(Math.max(c.grids, c.nUnits) + 4);

  const recHours = [], endTotals = [], outcomes = [];
  let liqN = 0;

  for (let i = 0; i < N_SIM_REPAIR; i++) {
    let p = c.P0, lx = Math.log(c.P0);
    let rg = pickCum(H.piCum, _rand());
    const u = Math.exp(PARAM_SD * gauss() - PARAM_SD * PARAM_SD);
    let n = c.nUnits, sumE = c.nUnits * c.avg;
    for (let k = 0; k < n; k++) stack[k] = c.avg;
    const lvl = clamp(Math.floor((p - c.low) / step), 0, c.grids);
    let nb = lvl, ns = lvl + 1, gridCum = 0, fund = 0, fl = c.fl0, liq = false, rec = false;

    path:
    for (let h = 0; h < nH; h++) {
      rg = pickCum(H.AhCum[rg], _rand());
      const m = (_rand() < tp ? TAIL_K : 1) * tailN;
      const s = sgSub[rg] * u * m, d = muSub[rg] - 0.5 * s * s, v2 = 2 * s * s;
      for (let j = 0; j < SUB; j++) {
        const x1 = lx + d + s * gauss();
        const up = x1 >= lx;
        const hi = bridgeHi(lx, x1, v2), lo = bridgeLo(lx, x1, v2);
        for (let w = 0; w < 3; w++) {
          const q = Math.exp(w === 2 ? x1 : (w === 0) === up ? lo : hi);
          while (ns <= c.grids && q >= line(ns)) {            // sell terisi
            const px = line(ns);
            if (short) { if (n < c.grids) { stack[n++] = px; sumE += px; } }
            else if (n) { const e = stack[--n]; sumE -= e; gridCum += c.qty * (px - e) - c.fee * c.qty * (px + e); }
            nb = ns - 1; ns++;
          }
          while (nb >= 0 && q <= line(nb)) {                  // buy terisi
            const px = line(nb);
            if (short) { if (n) { const e = stack[--n]; sumE -= e; gridCum += c.qty * (e - px) - c.fee * c.qty * (px + e); } }
            else if (n < c.grids) { stack[n++] = px; sumE += px; }
            ns = nb + 1; nb--;
          }
          if (!n) sumE = 0;
          fl = short ? c.qty * (sumE - n * q) : c.qty * (n * q - sumE);
          if (c.E0 + add + gridCum + fund + (fl - c.fl0) <= MMR * c.qty * n * q) { liq = true; break path; }
        }
        lx = x1;
      }
      p = Math.exp(lx);
      fl = short ? c.qty * (sumE - n * p) : c.qty * (n * p - sumE);
      fund += (short ? 1 : -1) * fundH * c.qty * n * p;
      const net = c.gridNow + gridCum + fund + fl + c.offset - c.fee * c.qty * n * p;   // fee penutupan saat exit
      if (net >= target) { recHours.push(h + 1); outcomes.push(net); rec = true; break; }
    }
    if (liq) { liqN++; outcomes.push(-(c.invest + add)); }          // likuidasi: seluruh margin hilang
    else if (!rec) {
      const e = c.gridNow + gridCum + fund + fl + c.offset - c.fee * c.qty * n * p;
      endTotals.push(e); outcomes.push(e);
    }
  }

  recHours.sort((a, b) => a - b);
  endTotals.sort((a, b) => a - b);
  outcomes.sort((a, b) => a - b);
  const qd = (p) => (recHours.length ? quantile(recHours, p) / 24 : null);
  return {
    add, target, liqP: liqAfterAdd(c, add),
    pRec: recHours.length / N_SIM_REPAIR,
    pLiq: liqN / N_SIM_REPAIR,
    pRec7: recHours.filter((h) => h <= 7 * 24).length / N_SIM_REPAIR,
    d25: qd(0.25), d50: qd(0.5), d75: qd(0.75),
    endMed: quantile(endTotals, 0.5),
    ev: outcomes.reduce((a, b) => a + b, 0) / outcomes.length,
    es5: esOf(outcomes, 0.05),
  };
}

async function runRepair() {
  const btn = $('btnRepair');
  btn.disabled = true; btn.textContent = 'MENGAMBIL DATA…';
  const { q, kl } = await loadMarket(S.coin);
  const c = readRepairCfg(q);
  btn.textContent = `SIMULASI 4 SKENARIO × ${N_SIM_REPAIR.toLocaleString()}…`;
  await new Promise((r) => setTimeout(r, 30));

  setSeed(seedVal());
  const V = dailyVol(q, kl, c.days);
  const H = buildHMM(q, V.vol, kl, c.days);

  const adds = [...new Set([0, 0.25, 0.5, 1].map((f) => Math.round(c.avail * f)))];
  const rows = adds.map((a) => simRepairScenario(c, H, a, V.tailP));

  renderRepair(c, rows, q, H);
  btn.disabled = false; btn.textContent = 'Analisa Repair';
}

// keputusan repair: bandingkan nilai harapan menahan/menambah vs cut loss sekarang
function repairDecision(c, rows) {
  const cutNow = c.pnlNow - c.fee * c.Q0 * c.P0;
  const margin = Math.max(0.5, 0.005 * c.invest);
  const safe = rows.filter((r) => r.pLiq <= 0.05);
  if (!safe.length) return { v: 'CUT', rec: rows.reduce((a, b) => (b.pLiq < a.pLiq ? b : a)), cutNow, margin, why: 'liq' };
  const bestEV = Math.max(...safe.map((r) => r.ev));
  // di antara yang EV-nya hampir sama, pilih add terkecil (modal berisiko lebih sedikit)
  const rec = safe.filter((r) => r.ev >= bestEV - margin).reduce((a, b) => (b.add < a.add ? b : a));
  if (rec.ev > cutNow + margin) return { v: rec.add > 0 ? 'ADD' : 'HOLD', rec, cutNow, margin };
  return { v: 'CUT', rec, cutNow, margin, why: 'ev' };
}

function renderRepair(c, rows, q, H) {
  const D = repairDecision(c, rows), rec = D.rec;
  const dirLab = c.dir === 'short' ? 'Short' : 'Long';
  const fD = (d) => (d == null ? '>' + c.days : d.toFixed(1));
  const tgtMode = c.targetManual != null ? `manual ${fmt(c.targetManual, 2)} USDT` : 'auto 1% × (investasi + add), min 1 USDT';

  let verdict;
  if (D.v === 'ADD' || D.v === 'HOLD') {
    verdict = `${D.v === 'ADD' ? `<b>Tambah ${fmt(rec.add, 0)} USDT ke bot.</b>` : '<b>Pertahankan bot tanpa menambah dana.</b>'}
      Nilai harapan Total Profit ${fmt(rec.ev, 2)} USDT, lebih baik daripada cut loss sekarang (${fmt(D.cutNow, 2)} USDT).
      Liq awal ${fmt(rec.liqP, 4)} (${(Math.abs(rec.liqP / c.P0 - 1) * 100).toFixed(1)}% dari harga), P(likuidasi ${c.days} hari) ${pct1(rec.pLiq)},
      ${(rec.pRec * 100).toFixed(0)}% path mencapai exit +${fmt(rec.target, 2)} USDT — median <b>${fD(rec.d50)} hari</b>.
      Rata-rata 5% skenario terburuk: ${fmt(rec.es5, 2)} USDT.`;
  } else if (D.why === 'liq') {
    verdict = `<b>Cut loss / tutup bot.</b> Tidak ada skenario add yang menekan P(likuidasi) ≤ 5% (teraman ${pct1(rec.pLiq)}).
      Menambah dana di sini berarti menambah uang ke posisi yang terancam likuidasi. Cut sekarang ≈ ${fmt(D.cutNow, 2)} USDT.`;
  } else {
    verdict = `<b>Cut loss / tutup bot.</b> Menahan posisi memberi nilai harapan ${fmt(rec.ev, 2)} USDT,
      tidak lebih baik daripada mengunci kerugian sekarang (${fmt(D.cutNow, 2)} USDT). Kalau tetap ingin menahan,
      pakai target manual lebih kecil atau horizon lebih panjang lalu analisa ulang.`;
  }

  let h = `<div class="verdict">
      <div class="vpill ${verdictCls(D.v === 'CUT' ? 'NO-GO' : D.v === 'HOLD' ? 'HOLD' : 'GO')}">${D.v}<small>${D.v === 'ADD' ? '+' + fmt(rec.add, 0) + ' USDT' : D.v === 'HOLD' ? 'TANPA ADD' : 'TUTUP BOT'}</small></div>
      <div class="vtext">${verdict}</div>
    </div>
    <div class="bd" style="padding-top:0; font-size:12px">
      ${S.coin} futures ${dirLab.toLowerCase()}${q.demo ? ' (harga demo)' : ''}: ${c.Q0} koin @ avg ${fmt(c.avg, 4)}, harga ${fmt(c.P0, 4)},
      Total PnL <b class="${pctCls(c.pnlNow)}">${fmt(c.pnlNow, 2)} USDT</b>, floating model ${fmt(c.fl0, 2)}, offset kalibrasi ${fmt(c.offset, 2)} USDT,
      target exit ${tgtMode}.
      ${Math.abs(c.Qs - c.Q0) > c.qty * 0.01 ? `<br><span class="dn">Catatan: posisi ${c.Q0} bukan kelipatan qty/grid ${c.qty} — model memakai ${c.nUnits} unit (${fmt(c.Qs, 4)} koin).</span>` : ''}
    </div>
  <div style="overflow-x:auto"><table class="rpt">
    <tr><th>Add (USDT)</th><th>Target exit</th><th>Liq awal</th><th>P(liq)</th><th>P(recover ≤${c.days}h)</th><th>P(≤7 hari)</th><th>Median hari</th><th>EV total profit</th><th>ES5</th></tr>`;
  for (const r of rows) {
    const isRec = r === rec;
    h += `<tr class="${isRec ? 'rec' : ''}">
      <td><b>${fmt(r.add, 0)}</b>${isRec ? ' ★' : ''}</td>
      <td>+${fmt(r.target, 2)}</td>
      <td>${fmt(r.liqP, 4)}</td>
      <td class="${r.pLiq > 0.05 ? 'dn' : 'up'}">${pct1(r.pLiq)}</td>
      <td class="${r.pRec >= 0.5 ? 'up' : ''}">${pct1(r.pRec)}</td>
      <td>${pct1(r.pRec7)}</td>
      <td><b>${fD(r.d50)}</b> <span class="mut">${fD(r.d25)}–${fD(r.d75)}</span></td>
      <td class="${r.ev > D.cutNow ? 'up' : 'dn'}">${fmt(r.ev, 2)}</td>
      <td class="dn">${fmt(r.es5, 2)}</td>
    </tr>`;
  }
  h += `<tr><td colspan="7" class="mut">Cut loss sekarang (Total PnL − fee penutupan)</td><td><b>${fmt(D.cutNow, 2)}</b></td><td></td></tr>`;
  h += `</table></div>
  <div class="bd" style="font-size:11px; color:var(--muted)">
    Cara membaca: EV = rata-rata Total Profit akhir dari semua path (path yang recover dihitung saat exit di target,
    path yang terlikuidasi dihitung kehilangan seluruh margin ${fmt(c.invest, 2)} + add, sisanya dinilai di akhir horizon).
    Keputusan ADD/HOLD hanya bila P(liq) ≤ 5% <i>dan</i> EV lebih baik dari cut loss sekarang dengan selisih ≥ ${fmt(D.margin, 2)} USDT;
    di antara skenario yang EV-nya setara dipilih add terkecil.
    Asumsi: likuidasi dinamis terkalibrasi dari liq Pionex (dicek tiap 15 menit di open/high/low/close intrabar), grid dengan histeresis ala Pionex,
    funding ${(c.funding * 100).toFixed(3)}%/8 jam konstan, fat tail per jam &amp; ketidakpastian σ ikut disimulasikan,
    volatilitas &amp; regime ${H.fitted ? `HMM hasil fit ${H.nObs} candle 1 jam` : 'HMM heuristik (candle tidak tersedia)'}.
    ${N_SIM_REPAIR.toLocaleString()} path/skenario — estimasi, bukan jaminan.
  </div>`;
  $('repairBody').innerHTML = h;
  $('repairBadge').textContent = D.v === 'ADD' ? `★ ADD ${fmt(rec.add, 0)} USDT` : D.v === 'HOLD' ? '★ HOLD' : '✗ CUT';
  $('repairBadge').className = 'badge ' + (D.v === 'CUT' ? 'bad' : D.v === 'HOLD' ? 'demo' : 'live');
}

// ---------- render umum ----------
const fmt = (x, d = 4) => x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const pctCls = (x) => (x >= 0 ? 'up' : 'dn');
const pctTxt = (x) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');
const fmtDur = (m) => {
  if (m == null || !isFinite(m)) return '—';
  if (m < 60) return Math.max(1, Math.round(m)) + ' menit';
  if (m < 48 * 60) {
    const h = Math.floor(m / 60), mm = Math.round((m - h * 60) / 5) * 5;
    if (mm >= 60) return (h + 1) + ' jam';
    return mm ? `${h} jam ${mm} menit` : `${h} jam`;
  }
  return (m / 1440).toFixed(1) + ' hari';
};
const fmtDurS = (m) => (m < 60 ? m + 'm' : m < 1440 ? (m / 60) + 'j' : (m / 1440) + 'h');
const dirName = (c) => (c.fut ? { long: 'Long', short: 'Short', neutral: 'Neutral' }[c.dir] : 'Spot');

function renderMarket(q, V) {
  $('mktPrice').innerHTML = '$' + fmt(q.price) + ' <small>' + S.coin + '/USDT · ' +
    (q.demo ? 'DEMO' : new Date(q.last_updated || Date.now()).toLocaleTimeString()) + '</small>';
  [['ch1', q.change_1h], ['ch24', q.change_24h], ['ch7', q.change_7d], ['ch30', q.change_30d]]
    .forEach(([id, v]) => { $(id).textContent = pctTxt(v); $(id).className = 'v ' + pctCls(v || 0); });
  $('volD').textContent = (V.vol * 100).toFixed(2) + '%';
  const srcTxt = q.demo ? 'MODE DEMO' : q.src === 'BINANCE' ? 'HARGA BINANCE' : 'HARGA CMC';
  $('mktSrc').textContent = srcTxt + ' · VOL ' + V.src;
  const b = $('modeBadge');
  b.className = 'badge ' + (q.demo ? 'demo' : 'live');
  b.textContent = q.demo ? '● DEMO' : '● LIVE';
}

function vrText(V) {
  if (!V || !V.vr6) return 'Variance ratio: butuh candle 1 jam (tidak tersedia).';
  const one = (o) => {
    if (!o) return '';
    const z = (o.vr - 1) / o.se;
    const tag = z <= -2 ? 'mean-reverting (signifikan)' : z >= 2 ? 'trending (signifikan)' : 'mendekati random walk';
    return `VR(${o.q}j) ${o.vr.toFixed(2)} ±${o.se.toFixed(2)} → ${tag}`;
  };
  const z6 = (V.vr6.vr - 1) / V.vr6.se;
  const imp = z6 <= -2
    ? 'Harga cenderung balik arah dalam hitungan jam — grid nyata kemungkinan mendapat LEBIH banyak siklus daripada simulasi (hasil model konservatif).'
    : z6 >= 2
      ? 'Harga cenderung melanjutkan arah — simulasi random-walk kemungkinan TERLALU OPTIMIS untuk grid; perlakukan confidence sebagai batas atas.'
      : 'Tidak ada bukti kuat mean-reversion/trend intraday — asumsi random walk model wajar.';
  let g = '';
  if (V.garch) {
    const G = V.garch;
    g = ` GARCH(1,1): α ${G.a.toFixed(2)}, β ${G.b.toFixed(2)}, half-life guncangan ${isFinite(G.hl) ? G.hl.toFixed(0) + ' jam' : '∞'};
      σ saat ini ${(G.nowD * 100).toFixed(2)}%/hari vs jangka panjang ${(G.lrD * 100).toFixed(2)}%/hari.
      Kurtosis residual ${V.kurt.toFixed(1)} → ${(V.tailP * 100).toFixed(1)}% jam "stres" (σ×${TAIL_K}) di simulasi.`;
  }
  return `${one(V.vr6)} · ${one(V.vr24)}. ${imp}${g}`;
}

function renderTrend(T, H, R, sim, V) {
  const lb = $('trLabel');
  lb.textContent = T.label;
  lb.className = 'v ' + T.cls;
  $('trDrift').textContent = pctTxt(T.slope * 100) + '/hari';
  $('trDrift').className = 'v ' + pctCls(T.slope);
  $('trR2').textContent = (T.r2 * 100).toFixed(0) + '%';

  const names = ['BULL', 'SIDE', 'BEAR'], clss = ['up', '', 'dn'];
  $('hmmRow').innerHTML = H.alpha.map((p, k) =>
    `<div><div class="k">P(${names[k]})</div><div class="v ${clss[k]}">${(p * 100).toFixed(0)}%</div>
     <div class="bar"><i style="width:${Math.min(100, p * 100)}%"></i></div></div>`).join('');
  const dom = H.alpha.indexOf(Math.max(...H.alpha));
  const regTxt = names.map((nm, k) => `${nm} σ ${(H.sgD[k] * 100).toFixed(1)}%/hari, drift ${pctTxt(H.muD[k] * 100)}`).join(' · ');
  $('hmmNote').textContent = !R.useHMM
    ? 'Mode GBM klasik aktif — posterior regime hanya referensi, simulasi memakai drift regresi trend (sudah di-shrink).'
    : H.fitted
      ? `HMM di-fit (Baum-Welch, 3 inisialisasi) pada ${H.nObs} return 1 jam. Regime dominan: ${names[dom]} (${(H.alpha[dom] * 100).toFixed(0)}%). ${regTxt}. Level σ dikalibrasi ×${H.volScale.toFixed(2)}; drift di-shrink 75%.`
      : `Candle 1 jam tidak tersedia → HMM heuristik dari 4 titik CMC (kurang andal). Regime dominan: ${names[dom]} (${(H.alpha[dom] * 100).toFixed(0)}%).`;
  if ($('vrNote')) $('vrNote').textContent = vrText(V);

  $('trPred').innerHTML =
    `Prediksi H+${R.days} (${R.useHMM ? 'HMM regime-switching' : 'GBM'}, ${N_SIM.toLocaleString()} simulasi): ` +
    `<b>P50 $${fmt(sim.pxP50)}</b> · band 90% $${fmt(sim.pxP5)} – $${fmt(sim.pxP95)}`;

  let note;
  if (T.label === 'SIDEWAYS') note = '✓ Kondisi ideal untuk grid — harga bolak-balik di dalam range menghasilkan siklus profit.';
  else if (T.label === 'UPTREND') note = 'Trend naik: grid spot/long tetap oke, sebagian profit dari apresiasi harga. Range digeser sedikit mengikuti drift.';
  else note = '⚠ Trend turun: grid spot/long rawan floating loss. Pertimbangkan tunggu sideways, kecilkan investasi, atau disiplinkan stop loss.';
  $('trNote').textContent = note + (T.daily ? ' (Regresi dari 31 close harian.)' : ' (Regresi dari 5 titik CMC — kasar.)');

  drawSpark(T);
}

function frow(label, sub, value, copyVal) {
  const cp = copyVal == null ? '' : `<button class="cp" data-cp="${copyVal}">salin</button>`;
  return `<div class="frow"><div class="fk">${label}<s>${sub || ''}</s></div>
          <div class="fv"><b>${value}</b>${cp}</div></div>`;
}

function renderReco(R, sim) {
  const dirLabel = R.fut ? { long: 'Long', short: 'Short', neutral: 'Neutral' }[R.dir] : 'Spot (Neutral)';
  $('recoTitle').textContent = `Rekomendasi ${S.coin}/USDT — ${R.fut ? 'Futures Grid' : 'Grid Trading'} · ${dirLabel}`;

  const conf = sim.pTarget * 100;
  $('recoBadge').textContent = `CONFIDENCE ${conf.toFixed(0)}% ±${sim.se.toFixed(1)}`;
  $('recoBadge').className = 'badge ' + (conf >= 55 && !R.liqBeforeSL ? 'live' : 'demo');

  let h = '';
  if (R.liqBeforeSL) {
    h += `<div class="bd dn" style="font-size:12px"><b>⚠ Likuidasi tercapai sebelum Stop Loss.</b> Dengan leverage ${R.lev}x, harga menyentuh liq lebih dulu daripada SL — turunkan leverage atau persempit SL.</div>`;
  }
  if (R.fut) h += frow('Arah', 'pilih tab di Pionex', dirLabel);
  h += frow('1. Price Range', 'Lowest price USDT', fmt(R.low), fmt(R.low));
  h += frow('', 'Highest Price USDT', fmt(R.high), fmt(R.high));
  if (!R.fut && R.points != null) {
    h += frow('2. Quantity of Grids',
      `${R.points} point ÷ ${R.divisor} + 1${R.feeAdjusted ? ' · dikurangi agar profit/grid > fee' : ''}`, R.grids, R.grids);
  } else {
    h += frow('2. Quantity of Grids', 'Profit/grid net ≈ ' + (R.profitPerGridNet * 100).toFixed(2) + '%', R.grids, R.grids);
  }
  h += frow('Profit / grid (net)', 'setelah fee 2 sisi', (R.profitPerGridNet * 100).toFixed(3) + '%');
  h += frow('Lebar range', '× rentang standar (±1.28σ√hari)', '×' + R.width.toFixed(2));
  h += frow('3. Investment', R.fut ? 'margin USDT' : 'total USDT', fmt(R.invest, 2), fmt(R.invest, 2));
  h += frow('Target profit', R.fut ? '1 USDT per 100 USDT margin' : '0.30% dari investasi', fmt(R.targetUsd, 2) + ' USDT');
  if (R.fut) h += frow('Leverage', 'dropdown ' + R.lev + 'x', R.lev + 'x');
  h += frow('Trigger price', 'opsional', R.trigger ? fmt(R.trigger) : '— (kosongkan)', R.trigger ? fmt(R.trigger) : null);
  const tp = R.tpHigh ?? R.tpLow;
  h += frow('Take Profit', 'stop by price', tp != null ? fmt(tp) : '— (kosongkan)', tp != null ? fmt(tp) : null);
  if (R.slLow != null && R.slHigh != null) {
    h += frow('Stop Loss', 'bawah / atas', fmt(R.slLow) + ' / ' + fmt(R.slHigh));
  } else {
    const sl = R.slLow ?? R.slHigh;
    h += frow('Stop Loss', 'stop by price', fmt(sl), fmt(sl));
  }
  h += frow('Grid mode', 'pilih', 'Arithmetic');
  if (R.fut) {
    const lq = [R.liqLow != null ? '↓ ' + fmt(R.liqLow) : null, R.liqHigh != null ? '↑ ' + fmt(R.liqHigh) : null].filter(Boolean).join(' · ') || '—';
    h += frow('Est. liq price', 'dinamis: grid terisi saat harga bergerak', lq);
    h += frow('Funding', 'asumsi per 8 jam', (R.funding * 100).toFixed(3) + '%');
  }
  h += frow('Confidence', `% path dgn PnL ≥ ${fmt(R.targetUsd, 2)} USDT di akhir H+${R.days}`,
    conf.toFixed(1) + '% ± ' + sim.se.toFixed(1) + '%');
  const T = sim.ttt;
  h += frow('Waktu capai target', 'kalau bot ditutup begitu target tersentuh (bersih fee)',
    (sim.pTouch * 100).toFixed(1) + '%' + (T.t50 != null ? ` · 50% dlm ≤ ${fmtDur(T.t50)}` : T.condMed ? ` · median sukses ${fmtDur(T.condMed)}` : ''));
  $('recoBody').innerHTML = h;

  $('recoBody').querySelectorAll('.cp').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.cp.replace(/,/g, ''));
      b.textContent = '✓'; setTimeout(() => (b.textContent = 'salin'), 900);
    }));
}

// ---------- kartu keputusan ----------
function renderDecision(R, d, X, q, V) {
  const { base, alt, stress, bt } = X;
  const cls = verdictCls(d.verdict);
  const sub = d.verdict === 'GO' ? `SIZE ${d.size * 100}%` : d.verdict === 'HOLD' ? 'TUNGGU' : 'JANGAN BUKA';
  const warnN = d.checks.filter((c) => c.st !== 'ok').map((c) => c.name.toLowerCase());
  const failN = d.checks.filter((c) => c.st === 'fail').map((c) => c.name.toLowerCase());
  const lev = R.fut ? ` @ ${R.lev}x ${dirName(R).toLowerCase()}` : '';

  let head;
  if (d.verdict === 'GO' && d.size === 1) {
    head = `<b>Buka bot.</b> Semua kriteria utama lolos — pakai investasi penuh <b>${fmt(R.invest, 2)} USDT</b>${lev} sesuai setting di kartu Rekomendasi.`;
  } else if (d.verdict === 'GO') {
    head = `<b>Buka bot dengan ukuran setengah: ${fmt(R.invest * 0.5, 2)} USDT</b> (50% dari rencana${lev}).
      Ada edge, tapi ${warnN.join(', ') || 'beberapa kriteria'} belum ideal — ukuran kecil membatasi kerugian kalau model meleset.
      Target ikut menjadi ${fmt(R.targetUsd * 0.5, 2)} USDT; range &amp; jumlah grid tetap.`;
  } else if (d.verdict === 'HOLD') {
    head = `<b>Jangan buka sekarang — tunggu.</b> ${d.caps.length ? d.caps.join(' ') : `Skor ${d.score} berada di zona abu-abu (${DEC_NOGO}–${DEC_GO - 1}): peluang dan risikonya seimbang, belum ada edge yang jelas.`}
      Jalankan ulang nanti, atau pakai setting alternatif di bawah yang lolos GO.`;
  } else {
    head = `<b>Jangan buka bot dengan setting ini.</b> ${failN.length ? `Gagal di: ${failN.join(', ')}.` : `Skor ${d.score} di bawah ${DEC_NOGO}.`}
      Kalau tetap ingin masuk, ubah setting dulu — lihat saran dan tabel alternatif.`;
  }

  const icon = { ok: '✓', warn: '!', fail: '✗' };
  let ck = '<div style="overflow-x:auto"><table class="rpt ck"><tr><th>Kriteria</th><th>Nilai</th><th>Status</th><th>Poin</th></tr>';
  for (const c of d.checks) {
    const pts = c.max ? `${Math.round(c.pts)}/${c.max}` : c.pts ? Math.round(c.pts) : '—';
    ck += `<tr><td>${c.name}${c.hard ? ' <span class="dn">(gerbang)</span>' : ''}</td><td class="wrap">${c.val}</td>
      <td><span class="st st-${c.st}">${icon[c.st]}</span></td><td>${pts}</td></tr>`;
  }
  ck += '</table></div>';

  const xrow = (name, note, r) => `<tr><td>${name}<br><span class="mut">${note}</span></td>
      <td>${pct1(r.pTarget)}</td><td>${pct1(r.pTouch)}</td>${R.fut ? `<td class="${r.pLiq > 0.03 ? 'dn' : ''}">${pct1(r.pLiq)}</td>` : ''}
      <td>${pct1(r.pSL)}</td><td class="${pctCls(r.median)}">${pctTxt(r.median)}</td><td class="dn">${pctTxt(r.es5)}</td></tr>`;
  let xt = `<div style="overflow-x:auto"><table class="rpt"><tr><th>Uji silang</th><th>P(target akhir)</th><th>P(sentuh)</th>${R.fut ? '<th>P(liq)</th>' : ''}<th>P(SL)</th><th>Median</th><th>ES5</th></tr>`;
  xt += xrow('Model utama', `${R.useHMM ? 'HMM' : 'GBM'} · ${base.N.toLocaleString()} path`, base);
  if (alt) xt += xrow('Model alternatif', `${R.useHMM ? 'GBM' : 'HMM'} · ${alt.N.toLocaleString()} path`, alt);
  if (stress) {
    const so = stressOpts(R);
    xt += xrow('Stress', `σ×${so.volMult}${so.driftD ? ' + drift melawan arah' : ''}`, stress);
  }
  if (bt && bt.n > 0) {
    xt += xrow('Backtest historis', `${bt.n} jendela · ≈${bt.indep.toFixed(1)} periode independen${d.btOk ? '' : ' · terlalu sedikit, hanya info'}`, bt);
  } else {
    xt += `<tr><td>Backtest historis<br><span class="mut">data candle kurang untuk horizon ini</span></td><td colspan="${R.fut ? 6 : 5}" class="mut">—</td></tr>`;
  }
  xt += '</table></div>';

  const until = new Date(Date.now() + VALID_MIN * 60000);
  const band = 0.2 * V.vol;
  const valid = `Berlaku sampai <b>${until.toISOString().slice(11, 16)} UTC</b> selama harga di <b>${fmt(R.P * (1 - band))} – ${fmt(R.P * (1 + band))}</b>. Di luar itu, jalankan ulang sebelum menekan tombol di Pionex.`;

  const todo = [...d.caps, ...d.fixes];
  const todoHtml = todo.length && d.verdict !== 'GO' || (d.verdict === 'GO' && d.size < 1 && todo.length)
    ? `<div class="bd todo"><div class="sub">${d.verdict === 'GO' ? 'Untuk naik ke GO 100%' : 'Supaya bisa GO'}</div><ul>${todo.map((t) => `<li>${t}</li>`).join('')}</ul></div>`
    : '';

  $('decBody').innerHTML = `
    <div class="verdict">
      <div class="vpill ${cls}">${d.verdict}<small>${sub}</small></div>
      <div class="vtext">
        ${head}
        <div class="gauge" aria-label="Skor ${d.score} dari 100"><i style="left:calc(${d.score}% - 1.5px)"></i></div>
        <div class="gauge-lab"><span style="left:0">NO-GO</span><span style="left:${DEC_NOGO}%">HOLD</span><span style="left:${DEC_GO}%">GO 50%</span><span style="left:${DEC_FULL}%">GO 100%</span></div>
        <div class="kpis">
          <div><div class="k">Skor</div><div class="v">${d.score}/100</div></div>
          <div><div class="k">P(target) gabungan</div><div class="v">${pct1(d.pCons)}</div></div>
          <div><div class="k">${R.fut ? 'P(liq) normal → stress' : 'P(SL) normal → stress'}</div>
            <div class="v ${R.fut ? (base.pLiq > 0.01 ? 'dn' : 'up') : (base.pSL > 0.1 ? 'dn' : 'up')}">${R.fut ? pct1(base.pLiq) + ' → ' + pct1(stress ? stress.pLiq : null) : pct1(base.pSL) + ' → ' + pct1(stress ? stress.pSL : null)}</div></div>
          <div><div class="k">5% terburuk (rata-rata)</div><div class="v dn">${fmt(base.es5 * R.invest / 100, 2)} USDT</div></div>
        </div>
      </div>
    </div>
    ${todoHtml}
    <div class="bd" style="padding-top:0">${ck}</div>
    <div class="bd" style="padding-top:0">${xt}</div>
    <div class="bd valid">${valid}</div>
    <div class="bd" id="decAlt" style="padding-top:0; color:var(--muted); font-size:11px">Mencari setting yang lebih aman…</div>
    <div class="bd" style="padding-top:0; font-size:11px; color:var(--muted)">
      Aturan: gerbang gagal (liq sebelum SL, P(liq) &gt; 5%, bot mati &gt; 40%, kerugian ekor stress ekstrem, profit/grid ≤ 0) atau skor &lt; ${DEC_NOGO} → NO-GO.
      Skor ${DEC_NOGO}–${DEC_GO - 1}, data tidak live, atau spike 1 jam → HOLD. Skor ≥ ${DEC_GO} → GO; GO 100% hanya bila skor ≥ ${DEC_FULL}, tidak ada kriteria gagal${R.fut ? ', dan risiko likuidasi lolos penuh' : ''}.
      P(target) gabungan = 50% model utama + 20% model alternatif + 20% stress + ≤10% backtest (sesuai jumlah data).
    </div>`;
  $('decBadge').textContent = `${verdictLabel(d)} · SKOR ${d.score}`;
  $('decBadge').className = 'badge ' + (d.verdict === 'GO' ? 'live' : d.verdict === 'HOLD' ? 'demo' : 'bad');
}

function renderOptimizer(opt, cfg) {
  LAST_OPT = opt;
  const el = $('decAlt'); if (!el) return;
  const cur = opt.find((o) => o.cur);
  const top = opt.slice(0, 6);
  if (cur && !top.includes(cur)) top.push(cur);
  const best = opt[0];
  const rank = { 'GO': 2, 'HOLD': 1, 'NO-GO': 0 };
  const desc = (o) => (o.cfg.fut ? `${dirName(o.cfg)} ${o.cfg.lev}x, range ×${o.cfg.width.toFixed(2)}` : `range ×${o.cfg.width.toFixed(2)}`);

  let summary;
  if (!cur || best === cur) summary = 'Setting Anda sudah yang terbaik di antara kombinasi yang diuji.';
  else if (rank[best.d.verdict] > rank[cur.d.verdict] || best.d.size > cur.d.size || best.d.score >= cur.d.score + 5)
    summary = `<b>Lebih aman/lebih baik: ${desc(best)}</b> — ${verdictLabel(best.d)}, skor screening ${best.d.score} vs ${cur.d.score} untuk setting sekarang.`;
  else summary = 'Tidak ada alternatif yang jelas lebih baik — perbedaannya masih dalam noise screening.';

  let h = `<div class="sub" style="color:var(--ink)">Setting alternatif</div>
    <div style="font-size:12px; color:var(--ink); margin:4px 0 8px">${summary}</div>
    <div style="overflow-x:auto"><table class="rpt"><tr>
      ${cfg.fut ? '<th>Arah</th><th>Lev</th>' : ''}<th>Lebar</th><th>Range</th><th>Grid</th><th>P(target)</th>${cfg.fut ? '<th>P(liq) / stress</th>' : ''}<th>P(SL)</th><th>ES5</th><th>Skor</th><th>Keputusan</th><th></th></tr>`;
  for (const o of top) {
    const R = o.R, i = opt.indexOf(o);
    h += `<tr class="${o.cur ? 'cur' : ''}">
      ${cfg.fut ? `<td>${dirName(o.cfg)}</td><td>${o.cfg.lev}x</td>` : ''}
      <td>×${o.cfg.width.toFixed(2)}</td>
      <td>${fmt(R.low)} – ${fmt(R.high)}</td>
      <td>${R.grids}</td>
      <td>${pct1(o.base.pTarget)}</td>
      ${cfg.fut ? `<td class="${o.base.pLiq > 0.01 ? 'dn' : ''}">${pct1(o.base.pLiq)} / ${pct1(o.stress.pLiq)}</td>` : ''}
      <td>${pct1(o.base.pSL)}</td>
      <td class="dn">${pctTxt(o.base.es5)}</td>
      <td><b>${o.d.score}</b></td>
      <td><span class="vchip ${verdictCls(o.d.verdict)}">${verdictLabel(o.d)}</span></td>
      <td>${o.cur ? '<span class="mut">sekarang</span>' : `<button class="cp" data-i="${i}">Terapkan</button>`}</td>
    </tr>`;
  }
  h += `</table></div>
    <div style="margin-top:6px">Screening ${opt.length} kombinasi × ${N_OPT} path (+${N_OPT_S} stress), resolusi 15 menit, seed yang sama untuk semua kombinasi.
    Skornya sedikit berbeda dari keputusan utama (tanpa backtest & model alternatif). "Terapkan" mengisi form lalu menjalankan analisa lengkap.</div>`;
  el.innerHTML = h;
  el.style.color = 'var(--muted)';
  el.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => applyCfg(LAST_OPT[+b.dataset.i].cfg)));
}

function renderTTT(R, sim) {
  const T = sim.ttt, tUsd = fmt(R.targetUsd, 2);
  let head;
  if (T.t50 != null) {
    head = `<b>50%</b> path mencapai +${tUsd} USDT dalam ≤ <b>${fmtDur(T.t50)}</b>` +
      (T.t80 != null ? `; 80% dalam ≤ <b>${fmtDur(T.t80)}</b>` : `; 80% tidak tercapai dalam ${R.days} hari`) +
      `. 25% tercepat: ≤ ${fmtDur(T.t25)}.`;
  } else if (T.hitMin.length) {
    head = `Kurang dari separuh path mencapai +${tUsd} USDT dalam ${R.days} hari (P = ${(sim.pTouch * 100).toFixed(1)}%). ` +
      `Dari path yang berhasil, median waktunya ${fmtDur(T.condMed)} — tapi jangan diartikan "pasti tercapai dalam waktu itu".`;
  } else {
    head = `Tidak ada path yang mencapai +${tUsd} USDT dalam ${R.days} hari.`;
  }

  let tbl = '<div style="overflow-x:auto"><table class="rpt"><tr><th>Dalam ≤</th>';
  T.buckets.forEach((b) => { tbl += `<th>${fmtDur(b.t)}</th>`; });
  tbl += '</tr><tr><td>P(tercapai)</td>';
  T.buckets.forEach((b) => { tbl += `<td class="${b.p >= 0.5 ? 'up' : ''}">${(b.p * 100).toFixed(1)}%</td>`; });
  tbl += '</tr></table></div>';

  const e = T.eta;
  const etaTxt = e
    ? `Cek silang analitik (ODE first-exit, hanya grid profit): 1 fill ≈ ${fmtDur(e.tauMin)}, 1 siklus profit ≈ ${fmt(e.perCycle, 4)} USDT,
       butuh ${e.cycles} siklus → ≈ <b>${fmtDur(e.minutes)}</b>.
       ${T.t50 != null && T.t50 < 0.5 * e.minutes ? 'MC jauh lebih cepat → target banyak dicapai lewat floating profit (arah harga), bukan siklus grid — lebih bergantung keberuntungan arah.' : ''}
       ${T.t50 != null && T.t50 > 2 * e.minutes ? 'MC jauh lebih lambat → floating loss/fee/SL sering menahan total profit di bawah target walau grid berputar.' : ''}`
    : 'Cek silang analitik tidak tersedia (profit/grid ≤ 0).';

  $('tttBody').innerHTML = `<div class="bd" style="font-size:12px">${head}</div>
    <div class="bd" style="padding-top:0">${tbl}</div>
    <div class="bd" style="padding-top:0; font-size:11.5px">${etaTxt}</div>
    <div class="bd" style="padding-top:0; font-size:11px; color:var(--muted)">
      Waktu = saat PERTAMA KALI Total Profit dikurangi fee penutupan ≥ target (cek di open/high/low/close tiap langkah).
      Resolusi ${T.resFine} menit untuk 24 jam pertama, lalu ${T.resLate} menit. Persentase dihitung terhadap SEMUA ${sim.N.toLocaleString()} path
      (path yang tidak pernah mencapai target ikut dihitung sebagai "belum"). Angka &lt; 1 jam paling sensitif terhadap spread, wick &amp; latensi bot
      yang tidak dimodelkan penuh — perlakukan sebagai urutan besaran.
    </div>`;
  $('tttBadge').textContent = T.t50 != null ? `50% ≤ ${fmtDur(T.t50)}` : `P ${(sim.pTouch * 100).toFixed(0)}%`;
  $('tttBadge').className = 'badge ' + (T.t50 != null ? 'live' : 'demo');
  drawTTT(R, sim);
}

function renderStats(R, sim) {
  const tUsd = fmt(R.targetUsd, 2);
  const cell = (k, v, cls = '', barPct = null) =>
    `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div>${
      barPct == null ? '' : `<div class="bar"><i style="width:${Math.min(100, barPct)}%"></i></div>`}</div>`;
  const exitTxt = (R.fut ? `${(sim.pLiq * 100).toFixed(1)}% / ` : '') + `${(sim.pSL * 100).toFixed(1)}% / ${(sim.pTP * 100).toFixed(1)}%`;
  $('simStats').innerHTML =
    cell(`P(≥ ${tUsd} USDT di akhir)`, (sim.pTarget * 100).toFixed(1) + '% ±' + sim.se.toFixed(1), sim.pTarget >= 0.55 ? 'up' : '', sim.pTarget * 100) +
    cell(`P(sentuh ${tUsd} USDT)`, (sim.pTouch * 100).toFixed(1) + '%' + (sim.ttt.t50 != null ? ` · ${fmtDur(sim.ttt.t50)}` : ''), sim.pTouch >= 0.55 ? 'up' : '', sim.pTouch * 100) +
    cell('P(PnL > 0)', (sim.pWin * 100).toFixed(1) + '%', sim.pWin >= 0.5 ? 'up' : 'dn', sim.pWin * 100) +
    cell('Median PnL', pctTxt(sim.median) + ' (' + fmt(sim.median * R.invest / 100, 2) + ' USDT)', pctCls(sim.median)) +
    cell('Rata-rata / P5 / P95', pctTxt(sim.mean) + ' · ' + pctTxt(sim.p5) + ' / ' + pctTxt(sim.p95)) +
    cell(R.fut ? 'P(liq) / P(SL) / P(TP)' : 'P(SL) / P(TP)', exitTxt, (sim.pLiq + sim.pSL) > 0.2 ? 'dn' : '');
  $('simMeta').textContent =
    `${R.useHMM ? 'HMM 3-REGIME' : 'GBM'} · ${sim.N.toLocaleString()} PATH · STEP ${60 / sim.SF}→${60 / sim.SUB} MENIT · BRIDGE INTRABAR · ANTITHETIC · ` +
    `FAT-TAIL/JAM ${((R.tailP || 0) * 100).toFixed(1)}% · σ-UNC ${PARAM_SD * 100}% · ${R.days} HARI · σ ${(R.vol * 100).toFixed(2)}%/HARI`;
}

function renderMcSummary(R, sim) {
  const row = (m, p5, p50, p95, fmtFn) =>
    `<tr><td>${m}</td><td class="${pctCls(p5)}">${fmtFn(p5)}</td><td class="${pctCls(p50)}">${fmtFn(p50)}</td><td class="${pctCls(p95)}">${fmtFn(p95)}</td></tr>`;
  $('mcSummary').innerHTML =
    `<table class="rpt">
      <tr><th>Metric</th><th>P5 (buruk)</th><th>P50 (median)</th><th>P95 (bagus)</th></tr>
      ${row('Total Return', sim.p5, sim.median, sim.p95, pctTxt)}
      ${row('Max Drawdown', sim.ddP5, sim.ddP50, sim.ddP95, pctTxt)}
      ${row('Sharpe Ratio', sim.shP5, sim.shP50, sim.shP95, (x) => x.toFixed(2))}
      ${row('Siklus grid (close)', sim.cyP5, sim.cyP50, sim.cyP95, (x) => x.toFixed(0))}
    </table>`;

  const usd = (p) => fmt(p * R.invest / 100, 2);
  const shTxt = sim.shP50 >= 2 ? 'sangat baik (return jauh melebihi guncangannya)'
    : sim.shP50 >= 1 ? 'baik (return sepadan dengan risikonya)'
    : sim.shP50 >= 0 ? 'lemah (return kecil dibanding naik-turunnya equity)'
    : 'negatif (di median justru rugi terhadap risikonya)';
  const skew = sim.mean < sim.median
    ? 'Rata-rata < median → ada ekor kiri: sebagian kecil skenario rugi besar menyeret rata-rata turun. Jangan hanya lihat median.'
    : 'Rata-rata ≥ median → tidak ada ekor rugi ekstrem yang dominan pada horizon ini.';
  const dead = sim.pLiq + sim.pSL;
  const riskTail = dead > 0.2
    ? `⚠ ${(dead * 100).toFixed(0)}% path berakhir kena SL/likuidasi — range/SL terlalu sempit atau leverage terlalu besar untuk volatilitas saat ini.`
    : `Path yang mati karena SL/likuidasi hanya ${(dead * 100).toFixed(1)}% — setting cukup lega untuk σ ${(R.vol * 100).toFixed(1)}%/hari.`;

  $('mcInterp').innerHTML =
    `<b>Cara membaca hasil di atas.</b>
     Dari ${sim.N.toLocaleString()} kemungkinan jalan harga selama ${R.days} hari:
     skenario tengah (P50) menghasilkan <b>${pctTxt(sim.median)}</b> (≈ ${usd(sim.median)} USDT dari modal ${fmt(R.invest, 2)}),
     5% skenario terburuk berakhir ≤ <b>${pctTxt(sim.p5)}</b> (≈ ${usd(sim.p5)} USDT; rata-rata kelompok itu ${pctTxt(sim.es5)}), dan 5% terbaik ≥ <b>${pctTxt(sim.p95)}</b>.
     Max drawdown median <b>${pctTxt(sim.ddP50)}</b>: di tengah perjalanan equity biasanya sempat turun sedalam itu dari puncaknya.
     Di 5% skenario terburuk drawdown mencapai ${pctTxt(sim.ddP5)}.
     Sharpe median ${sim.shP50.toFixed(2)} = ${shTxt}. ${skew} ${riskTail}
     Target ${fmt(R.targetUsd, 2)} USDT: <b>${(sim.pTarget * 100).toFixed(1)}% ± ${sim.se.toFixed(1)}%</b> masih di atas target pada akhir horizon,
     dan <b>${(sim.pTouch * 100).toFixed(1)}%</b> sempat menyentuhnya di tengah jalan${sim.ttt.t50 != null ? ` (separuh path sudah menyentuh dalam ${fmtDur(sim.ttt.t50)})` : ''} — angka kedua relevan kalau Anda menutup bot begitu target tercapai.
     Angka ± adalah noise simulasi; dua run yang berbeda dalam rentang itu sama saja.`;
}

// ---------- charts ----------
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function drawSpark(T) {
  const cv = $('cvSpark'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 14, padR = 70, padT = 14, padB = 22;
  const ps = T.pts.map((o) => o.p), ts = T.pts.map((o) => o.t);
  const mn = Math.min(...ps), mx = Math.max(...ps), span = (mx - mn) || 1;
  const t0 = ts[0], tSpan = (ts[ts.length - 1] - t0) || 1;
  const X = (t) => padL + ((t - t0) / tSpan) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / span) * (H - padT - padB);

  ctx.strokeStyle = css(T.cls === 'dn' ? '--red' : T.cls === 'up' ? '--green' : '--ink');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  T.pts.forEach((o, i) => (i ? ctx.lineTo(X(o.t), Y(o.p)) : ctx.moveTo(X(o.t), Y(o.p))));
  ctx.stroke();

  ctx.font = '9px ui-monospace';
  const r = T.pts.length > 10 ? 1.6 : 3;
  T.pts.forEach((o) => {
    ctx.beginPath(); ctx.arc(X(o.t), Y(o.p), o.lab ? r + 1 : r, 0, Math.PI * 2);
    ctx.fillStyle = css('--ink'); ctx.fill();
    if (o.lab) { ctx.fillStyle = css('--muted'); ctx.fillText(o.lab, X(o.t) - 10, H - 6); }
  });
  ctx.fillStyle = css('--ink');
  ctx.fillText('$' + fmt(ps[ps.length - 1]), W - padR + 6, Y(ps[ps.length - 1]) + 3);
}

function drawPaths(R, sim) {
  const cv = $('cvPaths'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 56, padR = 10, padT = 10, padB = 18;
  const paths = sim.samplePaths;
  let mn = R.low * 0.97, mx = R.high * 1.03;
  paths.forEach((p) => p.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v; }));
  const X = (h) => padL + (h / sim.nH) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);

  ctx.fillStyle = css('--green-soft');
  ctx.fillRect(padL, Y(R.high), W - padL - padR, Y(R.low) - Y(R.high));
  [R.low, R.high, R.P].forEach((v, i) => {
    ctx.strokeStyle = i === 2 ? css('--ink') : css('--green');
    ctx.setLineDash(i === 2 ? [2, 3] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
    ctx.fillText((i === 0 ? 'LOW ' : i === 1 ? 'HIGH ' : 'ENTRY ') + fmt(v), 4, Y(v) + 3);
  });
  [R.liqLow, R.liqHigh].forEach((lq) => {
    if (lq == null || lq < mn || lq > mx) return;
    ctx.strokeStyle = css('--red'); ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(padL, Y(lq)); ctx.lineTo(W - padR, Y(lq)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css('--red');
    ctx.fillText('LIQ ' + fmt(lq), 4, Y(lq) + 3);
  });

  ctx.globalAlpha = 0.18; ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1;
  paths.forEach((p) => {
    ctx.beginPath(); p.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v))));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  const amber = css('--amber');
  const fanLine = (key, dash, lab) => {
    ctx.strokeStyle = amber; ctx.lineWidth = 1.4; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(X(0), Y(R.P));
    sim.fan.forEach((f) => ctx.lineTo(X(f.t), Y(f[key])));
    ctx.stroke(); ctx.setLineDash([]);
    const last = sim.fan[sim.fan.length - 1];
    ctx.fillStyle = amber; ctx.font = '9px ui-monospace';
    ctx.fillText(lab, W - padR - 30, Y(last[key]) - 4);
  };
  fanLine('p50', [6, 3], 'P50');
  fanLine('p95', [2, 3], 'P95');
  fanLine('p5', [2, 3], 'P5');

  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText('HARGA — 60 SAMPLE DARI ' + sim.N.toLocaleString() + ' · HIJAU = RANGE GRID · ORANYE = FAN P5/P50/P95', padL, H - 5);
}

function drawEquityFan(R, sim) {
  const cv = $('cvEquity'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 56, padR = 86, padT = 12, padB = 20;
  let mn = 0, mx = 0;
  sim.eqFan.forEach((f) => { mn = Math.min(mn, f.p5); mx = Math.max(mx, f.p95); });
  sim.sampleEq.forEach((p) => p.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v; }));
  mx = Math.max(mx, sim.targetPct);
  const span = (mx - mn) || 1; mn -= span * 0.06; mx += span * 0.06;
  const X = (h) => padL + (h / sim.nH) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);

  [[0, css('--line'), '0%'], [sim.targetPct, css('--green'), 'TARGET']].forEach(([v, col, lab]) => {
    if (v < mn || v > mx) return;
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--muted'); ctx.font = '9px ui-monospace';
    ctx.fillText(lab, 6, Y(v) + 3);
  });

  ctx.globalAlpha = 0.16; ctx.lineWidth = 1; ctx.strokeStyle = css('--ink');
  sim.sampleEq.forEach((p) => {
    ctx.beginPath();
    p.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v))));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  const perc = [['p95', css('--green'), 'P95'], ['p50', css('--ink'), 'P50'], ['p5', css('--red'), 'P5']];
  ctx.font = '10px ui-monospace';
  perc.forEach(([key, col, lab]) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    sim.eqFan.forEach((f) => ctx.lineTo(X(f.t), Y(f[key])));
    ctx.stroke();
    const last = sim.eqFan[sim.eqFan.length - 1];
    ctx.fillStyle = col;
    ctx.fillText(`${lab} (${pctTxt(last[key])})`, W - padR + 6, Y(last[key]) + 3);
  });

  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  for (let d = 0; d <= R.days; d += Math.max(1, Math.round(R.days / 6))) ctx.fillText('H' + d, X(d * 24) - 6, H - 6);
  ctx.fillText('EQUITY % MODAL — DISTRIBUSI ' + sim.N.toLocaleString() + ' PATH', padL, padT - 2);
}

function drawHist3(sim) {
  const cv = $('cvHist3'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, gap = 22;
  const pw = (W - 2 * gap) / 3;

  const panel = (x0, dataSorted, color, title, fmtFn) => {
    const padL = 6, padR = 6, padT = 16, padB = 26;
    const lo = quantile(dataSorted, 0.005), hi = quantile(dataSorted, 0.995);
    const span = (hi - lo) || 1;
    const bins = 31, bw = span / bins, cnt = new Array(bins).fill(0);
    dataSorted.forEach((v) => { cnt[clamp(Math.floor((v - lo) / bw), 0, bins - 1)]++; });
    const mxC = Math.max(...cnt) || 1;
    const X = (v) => x0 + padL + ((v - lo) / span) * (pw - padL - padR);
    ctx.globalAlpha = 0.85; ctx.fillStyle = color;
    for (let i = 0; i < bins; i++) {
      const h = (cnt[i] / mxC) * (H - padT - padB);
      ctx.fillRect(x0 + padL + (i / bins) * (pw - padL - padR) + 1, H - padB - h, (pw - padL - padR) / bins - 2, h);
    }
    ctx.globalAlpha = 1;
    [0.05, 0.5, 0.95].forEach((p) => {
      const v = quantile(dataSorted, p);
      if (v < lo || v > hi) return;
      ctx.strokeStyle = css('--ink'); ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(v), padT); ctx.lineTo(X(v), H - padB); ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.fillStyle = css('--ink'); ctx.font = '10px ui-monospace';
    ctx.fillText(title, x0 + padL, 11);
    ctx.fillStyle = css('--muted'); ctx.font = '9px ui-monospace';
    ctx.fillText(fmtFn(lo), x0 + padL, H - 12);
    const hiTxt = fmtFn(hi);
    ctx.fillText(hiTxt, x0 + pw - padR - ctx.measureText(hiTxt).width, H - 12);
    const med = 'med ' + fmtFn(quantile(dataSorted, 0.5));
    ctx.fillText(med, x0 + pw / 2 - ctx.measureText(med).width / 2, H - 2);
  };

  panel(0,              sim.pct,   css('--green'), 'TOTAL RETURN %', (v) => v.toFixed(1) + '%');
  panel(pw + gap,       sim.ddArr, '#3D6ECC',      'MAX DRAWDOWN %', (v) => v.toFixed(1) + '%');
  panel(2 * (pw + gap), sim.shArr, '#7A4FA3',      'SHARPE RATIO',   (v) => v.toFixed(2));
}

// kurva CDF waktu-ke-target, sumbu waktu logaritmik
function drawTTT(R, sim) {
  const cv = $('cvTTT'); if (!cv) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 44, padR = 16, padT = 14, padB = 26;
  const T = sim.ttt, t0 = 5, t1 = Math.max(T.horizonMin, 10), N = sim.N;
  const X = (t) => padL + (Math.log(Math.max(t, t0) / t0) / Math.log(t1 / t0)) * (W - padL - padR);
  const Y = (p) => padT + (1 - p) * (H - padT - padB);

  ctx.font = '9px ui-monospace';
  [0, 0.25, 0.5, 0.75, 1].forEach((p) => {
    ctx.strokeStyle = css(p === 0.5 ? '--green' : '--line-soft'); ctx.setLineDash(p === 0.5 ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(padL, Y(p)); ctx.lineTo(W - padR, Y(p)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = css('--muted'); ctx.fillText((p * 100).toFixed(0) + '%', 6, Y(p) + 3);
  });
  [15, 60, 180, 720, 1440, 4320, 10080, 43200].filter((t) => t <= t1).forEach((t) => {
    ctx.strokeStyle = css('--line-soft');
    ctx.beginPath(); ctx.moveTo(X(t), padT); ctx.lineTo(X(t), H - padB); ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.fillText(fmtDurS(t), X(t) - 8, H - 10);
  });

  if (T.eta && T.eta.minutes <= t1) {
    ctx.strokeStyle = css('--amber'); ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(X(T.eta.minutes), padT); ctx.lineTo(X(T.eta.minutes), H - padB); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css('--amber');
    ctx.fillText('analitik', X(T.eta.minutes) + 4, padT + 10);
  }

  ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(X(t0), Y(0));
  let c = 0;
  for (const t of T.hitMin) { ctx.lineTo(X(t), Y(c / N)); c++; ctx.lineTo(X(t), Y(c / N)); }
  ctx.lineTo(X(t1), Y(c / N));
  ctx.stroke(); ctx.lineWidth = 1;

  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText(`P(TARGET +${fmt(R.targetUsd, 2)} USDT TERCAPAI ≤ t) — SUMBU WAKTU LOG`, padL, padT - 3);
}

// ---------- main ----------
$('btnGo').addEventListener('click', async () => {
  const btn = $('btnGo');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = 'MENGAMBIL DATA…';
  RUN_ID = Math.random().toString(36).slice(2, 10);
  const step = async (t) => { btn.textContent = t; await new Promise((r) => setTimeout(r, 20)); };
  try {
    const { q, kl } = await loadMarket(S.coin);
    const cfg = readCfg();
    const V = dailyVol(q, kl, cfg.days);
    const T = buildTrend(q, V.vol, kl);
    const H = buildHMM(q, V.vol, kl, cfg.days);
    const R = buildReco(q, T, H, V, cfg);
    renderMarket(q, V);

    await step(`SIMULASI UTAMA ${N_SIM.toLocaleString()} PATH (${S.model.toUpperCase()})…`);
    const sim = simulate(R, H);

    await step('UJI SILANG: MODEL ALTERNATIF, STRESS, BACKTEST…');
    const Ralt = { ...R, useHMM: !R.useHMM, mu: R.useHMM ? T.muSim : H.muEff };
    const alt = simulate(Ralt, H, { n: N_X, coarse: true, light: true, seed: seedTag('alt') });
    const stress = simulate(R, H, { n: N_X, coarse: true, light: true, seed: seedTag('stress'), ...stressOpts(R) });
    const bt = backtest(R, kl);
    const dec = decide({ R, base: sim, alt, stress, bt, T, H, V, q });

    renderTrend(T, H, R, sim, V);
    renderReco(R, sim);
    renderTTT(R, sim);
    renderStats(R, sim);
    drawPaths(R, sim);
    drawEquityFan(R, sim);
    drawHist3(sim);
    renderMcSummary(R, sim);
    renderDecision(R, dec, { base: sim, alt, stress, bt }, q, V);

    try {
      const opt = await optimize(q, T, H, V, cfg, (i, n) => { btn.textContent = `SCREENING SETTING ALTERNATIF ${i}/${n}…`; });
      renderOptimizer(opt, cfg);
    } catch (e) {
      console.error(e);
      if ($('decAlt')) $('decAlt').textContent = 'Screening setting alternatif gagal: ' + e.message;
    }
  } catch (e) {
    console.error(e);
    $('recoBody').innerHTML = `<div class="bd dn">Simulasi gagal: ${e.message}. Cek input lalu coba lagi.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Minta Rekomendasi';
  }
});

$('btnRepair').addEventListener('click', async () => {
  try { await runRepair(); }
  catch (e) {
    console.error(e);
    $('repairBody').innerHTML = `<div class="bd dn">Analisa gagal: ${e.message}. Cek angka input posisi.</div>`;
    $('btnRepair').disabled = false; $('btnRepair').textContent = 'Analisa Repair';
  }
});
