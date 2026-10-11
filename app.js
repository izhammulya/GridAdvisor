/* GRIDFISH v5 — Pionex Grid Advisor (LINK/SOL/ETH/INJ)
   ================================================================
   PERUBAHAN v5 (akurasi & reliabilitas):
   1. BUG KRITIS — model pengisian order grid.
      v4 memakai level "floor" tanpa histeresis: saat harga turun melewati garis X,
      order beli dicatat terisi di garis X−1 padahal harga belum menyentuhnya. Goyangan
      kecil di sekitar SATU garis menghasilkan profit 1 step per goyangan → grid profit,
      confidence & waktu-ke-target terlalu optimistis. v5 memakai state order yang benar:
      buy menunggu di garis nb, sell di garis ns; setelah fill di garis k → nb=k−1, ns=k+1
      (cara Pionex menaruh ulang order). Berlaku di simulasi utama, scan liq, dan repair.
   2. INTRABAR (Brownian bridge): tiap sub-step disampel high & low di dalam langkah
      (rumus maksimum Brownian bridge) dan dilalui O→L→H→C atau O→H→L→C. Fill grid, SL,
      TP, likuidasi & target yang terjadi di antara titik sampel tidak lagi terlewat.
   3. WAKTU KE TARGET: 24 jam pertama disimulasikan per 5 menit; target dicek tiap
      sub-step & di high/low intrabar, BERSIH fee penutupan. Output: P(tercapai ≤ 15 mnt,
      30 mnt, 1 j, 3 j, …), waktu 25/50/80%, kurva CDF, + cek silang analitik (ODE first-exit).
   4. VOLATILITAS: Garman–Klass (OHLC) + close-to-close, EWMA, bobot tergantung horizon.
      Level σ HMM dikalibrasi (maks ±25%) ke estimator ini; struktur regime tetap.
   5. DIAGNOSTIK variance ratio VR(6j), VR(24j): mendeteksi mean-reversion / trending
      yang tidak dimodelkan HMM/GBM.
   6. SL/TP dieksekusi di harga barrier (+ slippage SL), bukan di harga sampel yang sudah lewat.
   7. Jumlah siklus grid (close) per path ikut dilaporkan.

   TARGET:
   - Grid Spot   : 0.30% investasi (50 USDT → 0.15 USDT)
   - Futures Grid: 1 USDT per 100 USDT margin (500 USDT → 5 USDT)
   - Repair (futures): default auto 1% × (investasi + add), minimal 1 USDT.

   Model tetap aproksimasi — bukan jaminan. */

'use strict';

// ---------- konstanta & state ----------
const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm', rpDir: 'short' };
const N_SIM = 5000;
const N_SIM_REPAIR = 1500;
const SUB_REPAIR = 4;             // 15 menit per sub-step utk repair
const FINE_HOURS = 24;            // 24 jam pertama: resolusi halus
const SUB_FINE = 12;              // 5 menit per sub-step
const SLIP = 0.0005;              // slippage eksekusi stop loss
const TARGET_SPOT = 0.003;        // 0.30% investasi
const TARGET_FUT = 0.01;          // 1 USDT per 100 USDT margin
const MMR = 0.005;                // maintenance margin rate (aproksimasi Pionex)
const JUMP_P = 0.04, JUMP_K = 2.5;
const JUMP_NORM = 1 / Math.sqrt(1 - JUMP_P + JUMP_P * JUMP_K * JUMP_K);
const DRIFT_SHRINK = 0.25;        // simpan 25% drift hasil estimasi
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const subFor = (days) => (days <= 7 ? 6 : days <= 14 ? 4 : 2);   // sub-step per jam setelah 24 jam pertama
const readDays = () => clamp(Math.round(+$('inDays').value || 7), 1, 30);

const DEMO = {
  LINK: { price: 7.83,   change_1h: -0.3, change_24h: -2.1, change_7d: -5.4, change_30d: 4.2 },
  SOL:  { price: 145.2,  change_1h: 0.2,  change_24h: 1.8,  change_7d: -3.9, change_30d: 9.5 },
  ETH:  { price: 3412.5, change_1h: 0.1,  change_24h: 0.9,  change_7d: 2.7,  change_30d: 6.1 },
  INJ:  { price: 5.355,  change_1h: 0.4,  change_24h: -1.2, change_7d: 3.8,  change_30d: -6.5 },
};

// ---------- segmented controls ----------
function seg(id, key, onChange) {
  const el = $(id); if (!el) return;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...el.querySelectorAll('button')].forEach((x) => x.classList.remove('on', 'long', 'short'));
    b.classList.add('on');
    if (b.dataset.v === 'long') b.classList.add('long');
    if (b.dataset.v === 'short') b.classList.add('short');
    S[key] = b.dataset.v;
    if (onChange) onChange();
  });
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
  const url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + sym + 'USDT&interval=1h&limit=720';
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
      change_1h: chg(1), change_24h: chg(24), change_7d: chg(168), change_30d: chg(kl.length - 1),
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
  const se = Math.sqrt((2 * (2 * qn - 1) * (qn - 1)) / (3 * qn * T));   // SE di bawah random walk
  return { q: qn, vr: vq / (qn * v1), se };
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
    const wS = days <= 3 ? 0.7 : days <= 10 ? 0.5 : 0.3;  // horizon pendek → lebih percaya kondisi terkini
    const sH = Math.sqrt(wS * ew + (1 - wS) * longRun);
    return {
      vol: clamp(sH * Math.sqrt(24), 0.01, 0.15),
      src: `OHLC GK+CC 1J × ${T}`,
      vr6: varianceRatio(r, 6), vr24: varianceRatio(r, 24),
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
  return { vol: clamp(Math.sqrt(ms) * Math.sqrt(Math.PI / 2), 0.02, 0.12), src: 'PROXY 4 TITIK (KASAR)', vr6: null, vr24: null };
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
function fitHMM(r, iters = 60) {
  const T = r.length, K = 3;
  let s2 = 0; for (let t = 0; t < T; t++) s2 += r[t] * r[t];
  const sd = Math.sqrt(s2 / T) || 1e-4;
  const mu = [0.15 * sd, 0, -0.15 * sd];
  const sg = [0.9 * sd, 0.55 * sd, 1.7 * sd];
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

function buildHMM(q, vol, kl, days) {
  let muH, sgH, Ah, alpha, fitted = false, nObs = 0, volScale = 1;
  const r = kl ? logReturns(kl) : null;

  if (r && r.length >= 200) {
    const f = fitHMM(r);
    const ord = [0, 1, 2].sort((a, b) => f.mu[b] - f.mu[a]);   // BULL, SIDE, BEAR
    sgH = ord.map((k) => f.sg[k]);
    Ah = ord.map((i) => ord.map((j) => f.A[i][j]));
    alpha = ord.map((k) => f.alpha[k]);

    // kalibrasi level σ: rata-rata varians HMM sepanjang horizon (posterior dipropagasi)
    // disamakan dengan estimator OHLC; dibatasi 0.8–1.25 agar info regime tidak hilang
    const steps = Math.max(24, Math.round((days || 7) * 24));
    let pi = alpha.slice(), acc = 0;
    for (let t = 0; t < steps; t++) {
      acc += pi[0] * sgH[0] * sgH[0] + pi[1] * sgH[1] * sgH[1] + pi[2] * sgH[2] * sgH[2];
      pi = [0, 1, 2].map((j) => pi[0] * Ah[0][j] + pi[1] * Ah[1][j] + pi[2] * Ah[2][j]);
    }
    volScale = clamp(Math.sqrt((vol * vol / 24) / (acc / steps)), 0.8, 1.25);
    sgH = sgH.map((s) => s * volScale);
    muH = ord.map((k, i) => clamp(f.mu[k] * DRIFT_SHRINK, -0.1 * sgH[i], 0.1 * sgH[i]));
    fitted = true; nObs = r.length;
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
function buildReco(q, T, H, vol) {
  const P = q.price;
  const days = readDays();
  const fee = Math.max(0, +$('inFee').value || 0.05) / 100;
  const invest = Math.max(10, +$('inInvest').value || 50);
  const fut = S.prod === 'fut';
  const dir = fut ? S.dir : 'neutral';
  const lev = fut ? clamp(Math.round(+$('inLev').value || 3), 1, 10) : 1;
  const funding = fut && $('inFunding') ? (+$('inFunding').value || 0) / 100 : 0;
  const useHMM = S.model === 'hmm';
  const targetRate = fut ? TARGET_FUT : TARGET_SPOT;

  const horizonVol = vol * Math.sqrt(days);
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
    P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step, funding,
    profitPerGridNet, trigger, slLow, slHigh, tpLow, tpHigh,
    point, divisor, points, feeAdjusted, targetUsd, targetRate, mu, useHMM,
  };
  R.liqLow = fut ? liqScan(R, -1) : null;
  R.liqHigh = fut ? liqScan(R, +1) : null;
  R.liqBeforeSL = !!((R.liqLow && slLow && R.liqLow >= slLow) || (R.liqHigh && slHigh && R.liqHigh <= slHigh));
  return R;
}

// ---------- estimasi analitik waktu-ke-target (cek silang MC) ----------
// Setelah fill di garis k, harga berada tepat di k dan order terdekat di k±1.
// Waktu keluar Brownian dari (−δ, +δ): ODE ½σ²u'' = −1, u(±δ) = 0 → E[τ] = δ²/σ².
// Kira-kira separuh fill menutup posisi (= 1 siklus profit), jadi waktu per siklus ≈ 2δ²/σ².
// HANYA grid profit — floating PnL, fat tail & regime diabaikan.
function etaAnalytic(R, sgHourly) {
  const delta = Math.log(1 + R.step / R.P);
  const tau = (delta * delta) / (sgHourly * sgHourly);          // jam per fill
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
  a |= 0;                                  // tetap int32 → tidak deopt di V8
  _rand = function mulberry32() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedVal = () => ($('inSeed') ? $('inSeed').value : '');
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = _rand() * 2 - 1; v = _rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  gaussSpare = v * m; return u * m;
}
function shock() {                         // fat tail, varians = 1
  let g = gauss();
  if (_rand() < JUMP_P) g *= JUMP_K;
  return g * JUMP_NORM;
}
const quantile = (sortedArr, p) =>
  sortedArr.length ? sortedArr[Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length))] : null;

// high/low Brownian bridge di dalam satu langkah (log harga x0 → x1, varians v)
// M = (x0+x1+√((x1−x0)² − 2v·ln U))/2   ;   m = (x0+x1−√(…))/2
const bridgeHi = (x0, x1, v2) => 0.5 * (x0 + x1 + Math.sqrt((x1 - x0) * (x1 - x0) - v2 * Math.log(1 - _rand())));
const bridgeLo = (x0, x1, v2) => 0.5 * (x0 + x1 - Math.sqrt((x1 - x0) * (x1 - x0) - v2 * Math.log(1 - _rand())));

// ---------- Monte Carlo utama ----------
function simulate(R, H) {
  setSeed(seedVal());
  const M = modelParams(R, H);
  const SUB = subFor(R.days), SF = Math.max(SUB_FINE, SUB);
  const nH = Math.round(R.days * 24);
  const off = new Int32Array(nH + 1);
  for (let h = 0; h < nH; h++) off[h + 1] = off[h] + (h < FINE_HOURS ? SF : SUB);
  const n = off[nH];
  const mk = (Sx) => {
    const sg = M.sgH.map((s) => s / Math.sqrt(Sx));
    return { sg, dr: M.muH.map((m, k) => m / Sx - 0.5 * sg[k] * sg[k]) };
  };
  const PF = mk(SF), PB = mk(SUB);
  const fundH = R.fut ? R.funding / 8 : 0;
  const slLow = R.slLow ?? -Infinity, slHigh = R.slHigh ?? Infinity;
  const tpLow = R.tpLow ?? -Infinity, tpHigh = R.tpHigh ?? Infinity;
  const book = new GridBook(R);

  const pnl = new Float64Array(N_SIM), endPx = new Float64Array(N_SIM);
  const maxDD = new Float64Array(N_SIM), sharpe = new Float64Array(N_SIM), cyc = new Float64Array(N_SIM);
  const hitMin = [];
  let liqCount = 0, slCount = 0, tpCount = 0;
  const samplePaths = [], sampleEq = [];

  const ckEvery = Math.max(1, Math.round(nH / 28));
  const ckIdx = [];
  for (let h = ckEvery; h <= nH; h += ckEvery) ckIdx.push(h);
  if (ckIdx[ckIdx.length - 1] !== nH) ckIdx.push(nH);
  const ckPx = ckIdx.map(() => new Float64Array(N_SIM));
  const ckEq = ckIdx.map(() => new Float32Array(N_SIM));
  const ckFilled = ckIdx.map(() => new Uint8Array(N_SIM));
  const ckAt = new Int32Array(nH + 2).fill(-1);
  ckIdx.forEach((h, c) => { ckAt[h] = c; });

  const gBuf = new Float64Array(n), rgBuf = new Int8Array(nH);

  let fund = 0, exitPx = 0;
  const liqAt = (q) => R.fut && R.invest + book.realized + book.fl(q) + fund <= MMR * book.notional(q);
  // 0 = lanjut, 1 = likuidasi, 2 = SL, 3 = TP
  const visit = (q) => {
    if (q <= slLow) {
      book.move(slLow); exitPx = slLow;
      if (liqAt(slLow)) return 1;
      book.closeAll(slLow * (1 - SLIP)); return 2;
    }
    if (q >= slHigh) {
      book.move(slHigh); exitPx = slHigh;
      if (liqAt(slHigh)) return 1;
      book.closeAll(slHigh * (1 + SLIP)); return 2;
    }
    if (q >= tpHigh) { book.move(tpHigh); book.closeAll(tpHigh); exitPx = tpHigh; return 3; }
    if (q <= tpLow) { book.move(tpLow); book.closeAll(tpLow); exitPx = tpLow; return 3; }
    book.move(q);
    if (liqAt(q)) { exitPx = q; return 1; }
    return 0;
  };

  for (let i = 0; i < N_SIM; i++) {
    const anti = (i & 1) === 1;
    if (!anti) {                                   // pre-generate → pasangan antithetic selalu lengkap
      let rg = pickCum(M.piCum, _rand());
      for (let h = 0; h < nH; h++) { rg = pickCum(M.AhCum[rg], _rand()); rgBuf[h] = rg; }
      for (let t = 0; t < n; t++) gBuf[t] = shock();
    }
    const sgn = anti ? -1 : 1;
    let p = R.P, lx = Math.log(R.P);
    book.reset(p); fund = 0;

    let eq = 0, peak = 0, minDd = 0, prevDayEq = 0, sumR = 0, sumR2 = 0, nD = 0;
    let status = 0, hit = -1, tEnd = nH * 60;
    const kp = i < 60 ? [p] : null, ke = i < 60 ? [0] : null;

    outer:
    for (let h = 0; h < nH; h++) {
      const rg = rgBuf[h], fine = h < FINE_HOURS;
      const Sx = fine ? SF : SUB, Pm = fine ? PF : PB;
      const s = Pm.sg[rg], d = Pm.dr[rg], v2 = 2 * s * s, base = off[h];
      for (let j = 0; j < Sx; j++) {
        const x1 = lx + d + s * sgn * gBuf[base + j];
        const up = x1 >= lx;
        const hi = bridgeHi(lx, x1, v2), lo = bridgeLo(lx, x1, v2);
        const tMin = (h + (j + 1) / Sx) * 60;
        for (let w = 0; w < 3; w++) {
          const q = Math.exp(w === 2 ? x1 : (w === 0) === up ? lo : hi);   // naik: O→L→H→C, turun: O→H→L→C
          const st = visit(q);
          if (st) { status = st; tEnd = tMin; p = exitPx; break outer; }
          if (hit < 0 && book.realized + book.fl(q) + fund - R.fee * book.notional(q) >= R.targetUsd) hit = tMin;
        }
        lx = x1;
      }
      p = Math.exp(lx);
      if (fundH) fund += fundH * book.cap * p * (book.sIS - book.sIL);   // long bayar, short terima (funding +)

      eq = Math.max(-R.invest, book.realized + book.fl(p) + fund);
      if (eq > peak) peak = eq;
      if (eq - peak < minDd) minDd = eq - peak;
      if ((h + 1) % 24 === 0) {
        const rD = (eq - prevDayEq) / R.invest;
        sumR += rD; sumR2 += rD * rD; nD++; prevDayEq = eq;
      }
      if (kp) { kp.push(p); ke.push(eq / R.invest * 100); }
      const ci = ckAt[h + 1];
      if (ci >= 0) { ckPx[ci][i] = p; ckEq[ci][i] = eq / R.invest * 100; ckFilled[ci][i] = 1; }
    }

    if (status === 1) { eq = -R.invest; liqCount++; }
    else if (status >= 2) { eq = Math.max(-R.invest, book.realized + fund); if (status === 2) slCount++; else tpCount++; }
    if (status) {
      if (eq > peak) peak = eq;
      if (eq - peak < minDd) minDd = eq - peak;
      if (hit < 0 && eq >= R.targetUsd) hit = tEnd;
      if (kp) { kp.push(p); ke.push(eq / R.invest * 100); }
    }
    for (let c = 0; c < ckIdx.length; c++) {
      if (!ckFilled[c][i]) { ckPx[c][i] = p; ckEq[c][i] = eq / R.invest * 100; }
      ckFilled[c][i] = 0;
    }
    if (hit > 0) hitMin.push(hit);

    pnl[i] = eq; endPx[i] = p; cyc[i] = book.cycles;
    maxDD[i] = (minDd / R.invest) * 100;
    if (nD >= 2) {
      const m = sumR / nD, sd = Math.sqrt(Math.max(0, sumR2 / nD - m * m));
      sharpe[i] = sd > 1e-9 ? clamp((m / sd) * Math.sqrt(365), -10, 10) : 0;
    } else sharpe[i] = 0;
    if (kp) { samplePaths.push(kp); sampleEq.push(ke); }
  }

  const pct = Array.from(pnl, (x) => (x / R.invest) * 100).sort((a, b) => a - b);
  const px = Array.from(endPx).sort((a, b) => a - b);
  const ddArr = Array.from(maxDD).sort((a, b) => a - b);
  const shArr = Array.from(sharpe).sort((a, b) => a - b);
  const cyArr = Array.from(cyc).sort((a, b) => a - b);
  const prob = (f) => pct.filter(f).length / pct.length;
  const targetPct = R.targetRate * 100;
  const mean = pct.reduce((a, b) => a + b, 0) / pct.length;
  hitMin.sort((a, b) => a - b);

  const fanOf = (arrs) => ckIdx.map((t, c) => {
    const arr = Array.from(arrs[c]).sort((a, b) => a - b);
    return { t, p5: quantile(arr, 0.05), p50: quantile(arr, 0.5), p95: quantile(arr, 0.95) };
  });

  const pTarget = prob((x) => x >= targetPct - 1e-9);
  const pTouch = hitMin.length / N_SIM;
  const seOf = (p) => Math.sqrt(Math.max(1e-9, p * (1 - p) / N_SIM)) * 100;

  // ---- distribusi waktu ke target ----
  const horizonMin = nH * 60;
  const cdfAt = (t) => {                                  // # hit ≤ t (binary search)
    let a = 0, b = hitMin.length;
    while (a < b) { const m = (a + b) >> 1; if (hitMin[m] <= t) a = m + 1; else b = m; }
    return a / N_SIM;
  };
  const uq = (p) => { const k = Math.ceil(p * N_SIM) - 1; return k < hitMin.length ? hitMin[Math.max(0, k)] : null; };
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
    pct, samplePaths, sampleEq, mean, targetPct, nH, SUB, SF, ttt,
    fan: fanOf(ckPx), eqFan: fanOf(ckEq),
    ddArr, shArr,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05), p95: quantile(pct, 0.95),
    ddP5: quantile(ddArr, 0.05), ddP50: quantile(ddArr, 0.5), ddP95: quantile(ddArr, 0.95),
    shP5: quantile(shArr, 0.05), shP50: quantile(shArr, 0.5), shP95: quantile(shArr, 0.95),
    cyP5: quantile(cyArr, 0.05), cyP50: quantile(cyArr, 0.5), cyP95: quantile(cyArr, 0.95),
    pxP5: quantile(px, 0.05), pxP50: quantile(px, 0.5), pxP95: quantile(px, 0.95),
    pWin: prob((x) => x > 0),
    pTarget, se: seOf(pTarget),
    pTouch, seTouch: seOf(pTouch),
    p1: prob((x) => x >= 1),
    pLiq: liqCount / N_SIM, pSL: slCount / N_SIM, pTP: tpCount / N_SIM,
  };
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

function simRepairScenario(c, H, add) {
  const nH = c.days * 24, SUB = SUB_REPAIR;
  const step = (c.high - c.low) / c.grids;
  const short = c.dir === 'short';
  const target = repairTarget(c, add);
  const sgSub = H.sgH.map((s) => s / Math.sqrt(SUB));
  const drSub = H.muH.map((m, k) => m / SUB - 0.5 * sgSub[k] * sgSub[k]);
  const fundH = c.funding / 8;
  const line = (k) => c.low + k * step;
  const stack = new Float64Array(Math.max(c.grids, c.nUnits) + 4);

  const recHours = [], endTotals = [];
  let liqN = 0;

  for (let i = 0; i < N_SIM_REPAIR; i++) {
    let p = c.P0, lx = Math.log(c.P0);
    let rg = pickCum(H.piCum, _rand());
    let n = c.nUnits, sumE = c.nUnits * c.avg;
    for (let k = 0; k < n; k++) stack[k] = c.avg;
    const lvl = clamp(Math.floor((p - c.low) / step), 0, c.grids);
    let nb = lvl, ns = lvl + 1, gridCum = 0, fund = 0, fl = c.fl0, liq = false, rec = false;

    path:
    for (let h = 0; h < nH; h++) {
      rg = pickCum(H.AhCum[rg], _rand());
      const s = sgSub[rg], d = drSub[rg], v2 = 2 * s * s;
      for (let j = 0; j < SUB; j++) {
        const x1 = lx + d + s * shock();
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
      if (net >= target) { recHours.push(h + 1); rec = true; break; }
    }
    if (liq) liqN++;
    else if (!rec) endTotals.push(c.gridNow + gridCum + fund + fl + c.offset - c.fee * c.qty * n * p);
  }

  recHours.sort((a, b) => a - b);
  endTotals.sort((a, b) => a - b);
  const qd = (p) => (recHours.length ? quantile(recHours, p) / 24 : null);
  return {
    add, target, liqP: liqAfterAdd(c, add),
    pRec: recHours.length / N_SIM_REPAIR,
    pLiq: liqN / N_SIM_REPAIR,
    pRec7: recHours.filter((h) => h <= 7 * 24).length / N_SIM_REPAIR,
    d25: qd(0.25), d50: qd(0.5), d75: qd(0.75),
    endMed: quantile(endTotals, 0.5),
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
  const { vol } = dailyVol(q, kl, c.days);
  const H = buildHMM(q, vol, kl, c.days);

  const adds = [...new Set([0, 0.25, 0.5, 1].map((f) => Math.round(c.avail * f)))];
  const rows = adds.map((a) => simRepairScenario(c, H, a));

  const rec = rows.find((r) => r.pLiq <= 0.05 && r.pRec >= 0.5)
           || rows.find((r) => r.pLiq <= 0.05)
           || rows.reduce((a, b) => (b.pLiq < a.pLiq ? b : a));

  renderRepair(c, rows, rec, q, H);
  btn.disabled = false; btn.textContent = 'Analisa Repair';
}

function renderRepair(c, rows, rec, q, H) {
  const dirLab = c.dir === 'short' ? 'Short' : 'Long';
  const fD = (d) => (d == null ? '>' + c.days : d.toFixed(1));
  const tgtMode = c.targetManual != null ? `manual ${fmt(c.targetManual, 2)} USDT` : 'auto 1% × (investasi + add), min 1 USDT';
  let h = `<div class="bd" style="padding-bottom:6px">
    <div class="tag">POSISI SAAT INI — ${S.coin} FUTURES ${dirLab.toUpperCase()}${q.demo ? ' · HARGA DEMO' : ''}</div>
    <div style="font-size:12px; margin-top:4px">
      ${c.Q0} koin @ avg ${fmt(c.avg, 4)} · harga ${fmt(c.P0, 4)} · Total PnL <b class="${pctCls(c.pnlNow)}">${fmt(c.pnlNow, 2)} USDT</b> ·
      floating model ${fmt(c.fl0, 2)} · offset kalibrasi ${fmt(c.offset, 2)} USDT · target exit: ${tgtMode}
      ${Math.abs(c.Qs - c.Q0) > c.qty * 0.01 ? `<br><span class="dn">Catatan: posisi ${c.Q0} bukan kelipatan qty/grid ${c.qty} — model memakai ${c.nUnits} unit (${fmt(c.Qs, 4)} koin).</span>` : ''}
    </div>
  </div>
  <div style="overflow-x:auto"><table class="rpt">
    <tr><th>Add (USDT)</th><th>Target exit</th><th>Liq awal</th><th>P(liq)</th><th>P(recover ≤${c.days}h)</th><th>P(≤7 hari)</th><th>Median hari</th><th>P25–P75 hari</th></tr>`;
  for (const r of rows) {
    const isRec = r === rec;
    h += `<tr class="${isRec ? 'rec' : ''}">
      <td><b>${fmt(r.add, 0)}</b>${isRec ? ' ★' : ''}</td>
      <td>+${fmt(r.target, 2)}</td>
      <td>${fmt(r.liqP, 4)}</td>
      <td class="${r.pLiq > 0.05 ? 'dn' : 'up'}">${(r.pLiq * 100).toFixed(1)}%</td>
      <td class="${r.pRec >= 0.5 ? 'up' : ''}">${(r.pRec * 100).toFixed(1)}%</td>
      <td>${(r.pRec7 * 100).toFixed(1)}%</td>
      <td><b>${fD(r.d50)}</b></td>
      <td>${fD(r.d25)} – ${fD(r.d75)}</td>
    </tr>`;
  }
  h += `</table></div>`;

  const liqShiftPct = Math.abs(rec.liqP / c.P0 - 1) * 100;
  let verdict;
  if (rec.pLiq <= 0.05 && rec.pRec >= 0.5) {
    verdict = `<b>Rekomendasi: tambah ${fmt(rec.add, 0)} USDT.</b> Liq awal bergeser ke ${fmt(rec.liqP, 4)}
      (${liqShiftPct.toFixed(1)}% dari harga sekarang), P(likuidasi ${c.days} hari) ${(rec.pLiq * 100).toFixed(1)}%,
      dan ${(rec.pRec * 100).toFixed(0)}% path mencapai exit +${fmt(rec.target, 2)} USDT (bersih fee penutupan) —
      median <b>${fD(rec.d50)} hari</b> (rentang tengah ${fD(rec.d25)}–${fD(rec.d75)} hari).`;
  } else if (rec.pLiq <= 0.05) {
    verdict = `<b>Rekomendasi: tambah ${fmt(rec.add, 0)} USDT untuk keamanan liq</b> (P(liq) ${(rec.pLiq * 100).toFixed(1)}%),
      tapi peluang mencapai +${fmt(rec.target, 2)} USDT dalam ${c.days} hari hanya ${(rec.pRec * 100).toFixed(0)}%
      — median total profit di akhir horizon ${rec.endMed == null ? '—' : fmt(rec.endMed, 2)} USDT.
      Pertimbangkan cut loss sebagian, target manual lebih kecil, atau horizon lebih panjang.`;
  } else {
    verdict = `<b>⚠ Tidak ada skenario yang menekan P(likuidasi) ≤ 5%.</b> Skenario teraman masih
      P(liq) ${(rec.pLiq * 100).toFixed(1)}%. Menambah investasi di sini berisiko "menambah uang ke posisi buruk" —
      pertimbangkan cut loss sebagian atau tutup bot.`;
  }
  h += `<div class="bd" style="font-size:12px">${verdict}</div>
  <div class="bd" style="padding-top:0; font-size:11px; color:var(--muted)">
    Asumsi model: (1) exit saat Total Profit dikurangi fee penutupan ≥ target (dicek tiap jam);
    (2) likuidasi dinamis: equity terkalibrasi dari liq Pionex, dicek tiap 15 menit di open/high/low/close intrabar
    (Brownian bridge), termasuk posisi baru yang dibuka grid; "Liq awal" = liq untuk posisi saat ini saja;
    (3) order grid dengan histeresis ala Pionex (fill di garis k → order baru di k±1);
    (4) funding ${(c.funding * 100).toFixed(3)}%/8 jam konstan (positif = short menerima);
    (5) grid di luar range tidak membuka posisi baru;
    (6) volatilitas & regime ${H.fitted ? `HMM hasil fit ${H.nObs} candle 1 jam` : 'HMM heuristik (candle tidak tersedia)'}.
    ${N_SIM_REPAIR.toLocaleString()} path/skenario — estimasi, bukan jaminan.
  </div>`;
  $('repairBody').innerHTML = h;
  $('repairBadge').textContent = `★ ADD ${fmt(rec.add, 0)} USDT`;
  $('repairBadge').className = 'badge ' + (rec.pLiq <= 0.05 ? 'live' : 'demo');
}

// ---------- render umum ----------
const fmt = (x, d = 4) => x == null || !isFinite(x) ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const pctCls = (x) => (x >= 0 ? 'up' : 'dn');
const pctTxt = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');
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

function renderMarket(q, vol, volSrc) {
  $('mktPrice').innerHTML = '$' + fmt(q.price) + ' <small>' + S.coin + '/USDT · ' +
    (q.demo ? 'DEMO' : new Date(q.last_updated || Date.now()).toLocaleTimeString()) + '</small>';
  [['ch1', q.change_1h], ['ch24', q.change_24h], ['ch7', q.change_7d], ['ch30', q.change_30d]]
    .forEach(([id, v]) => { $(id).textContent = pctTxt(v); $(id).className = 'v ' + pctCls(v || 0); });
  $('volD').textContent = (vol * 100).toFixed(2) + '%';
  const srcTxt = q.demo ? 'MODE DEMO' : q.src === 'BINANCE' ? 'HARGA BINANCE' : 'HARGA CMC';
  $('mktSrc').textContent = srcTxt + ' · VOL ' + volSrc;
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
  return `${one(V.vr6)} · ${one(V.vr24)}. ${imp}`;
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
      ? `HMM di-fit (Baum-Welch) pada ${H.nObs} return 1 jam. Regime dominan: ${names[dom]} (${(H.alpha[dom] * 100).toFixed(0)}%). ${regTxt}. Level σ dikalibrasi ×${H.volScale.toFixed(2)} ke estimator OHLC; drift di-shrink 75%.`
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
      Resolusi ${T.resFine} menit untuk 24 jam pertama, lalu ${T.resLate} menit. Persentase dihitung terhadap SEMUA ${N_SIM.toLocaleString()} path
      (path yang tidak pernah mencapai target ikut dihitung sebagai "belum"). Angka &lt; 1 jam paling sensitif terhadap spread, wick & latensi bot
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
    `${R.useHMM ? 'HMM 3-REGIME' : 'GBM'} · ${N_SIM.toLocaleString()} PATH · STEP ${60 / sim.SF}→${60 / sim.SUB} MENIT · BRIDGE INTRABAR · ANTITHETIC · FAT-TAIL · ${R.days} HARI · σ ${(R.vol * 100).toFixed(2)}%/HARI`;
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
     Dari ${N_SIM.toLocaleString()} kemungkinan jalan harga selama ${R.days} hari:
     skenario tengah (P50) menghasilkan <b>${pctTxt(sim.median)}</b> (≈ ${usd(sim.median)} USDT dari modal ${fmt(R.invest, 2)}),
     5% skenario terburuk berakhir ≤ <b>${pctTxt(sim.p5)}</b> (≈ ${usd(sim.p5)} USDT), dan 5% terbaik ≥ <b>${pctTxt(sim.p95)}</b>.
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
  ctx.fillText('HARGA — 60 SAMPLE DARI ' + N_SIM.toLocaleString() + ' · HIJAU = RANGE GRID · ORANYE = FAN P5/P50/P95', padL, H - 5);
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
  ctx.fillText('EQUITY % MODAL — DISTRIBUSI ' + N_SIM.toLocaleString() + ' PATH', padL, padT - 2);
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
  const T = sim.ttt, t0 = 5, t1 = Math.max(T.horizonMin, 10);
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
  for (const t of T.hitMin) { ctx.lineTo(X(t), Y(c / N_SIM)); c++; ctx.lineTo(X(t), Y(c / N_SIM)); }
  ctx.lineTo(X(t1), Y(c / N_SIM));
  ctx.stroke(); ctx.lineWidth = 1;

  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText(`P(TARGET +${fmt(R.targetUsd, 2)} USDT TERCAPAI ≤ t) — SUMBU WAKTU LOG`, padL, padT - 3);
}

// ---------- main ----------
$('btnGo').addEventListener('click', async () => {
  const btn = $('btnGo');
  btn.disabled = true; btn.textContent = 'MENGAMBIL DATA…';
  try {
    const { q, kl } = await loadMarket(S.coin);
    btn.textContent = `MENJALANKAN ${N_SIM.toLocaleString()} SIMULASI (${S.model.toUpperCase()})…`;
    await new Promise((r) => setTimeout(r, 30));

    const days = readDays();
    const V = dailyVol(q, kl, days);
    const T = buildTrend(q, V.vol, kl);
    const H = buildHMM(q, V.vol, kl, days);
    const R = buildReco(q, T, H, V.vol);
    renderMarket(q, V.vol, V.src);
    const sim = simulate(R, H);
    renderTrend(T, H, R, sim, V);
    renderReco(R, sim);
    renderTTT(R, sim);
    renderStats(R, sim);
    drawPaths(R, sim);
    drawEquityFan(R, sim);
    drawHist3(sim);
    renderMcSummary(R, sim);
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
