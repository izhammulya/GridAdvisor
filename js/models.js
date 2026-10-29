/* model statistik: volatilitas (GK/EWMA ⊕ GARCH), fat tail, noise mikrostruktur,
   variance ratio, regresi trend, HMM 3-regime */
import { TAIL_K, DRIFT_SHRINK, NOISE } from './config.js';
import { clamp } from './util.js';

export function logReturns(kl) {
  const r = [];
  for (let i = 1; i < kl.length; i++) {
    const x = Math.log(kl[i].c / kl[i - 1].c);
    if (isFinite(x)) r.push(x);
  }
  return r;
}

// ---------- variance ratio (Lo–MacKinlay, overlapping) ----------
// VR < 1 → mean-reverting (bagus utk grid) · VR > 1 → trending (model random-walk terlalu optimis)
export function varianceRatio(r, qn) {
  const T = r.length;
  if (T < qn * 20) return null;
  let m = 0; for (const x of r) m += x; m /= T;
  let v1 = 0; for (const x of r) v1 += (x - m) ** 2; v1 /= T;
  if (!(v1 > 0)) return null;
  let s = 0; for (let i = 0; i < qn; i++) s += r[i];
  let vq = 0, cnt = 0;
  for (let i = qn; ; i++) {
    vq += (s - qn * m) ** 2; cnt++;
    if (i >= T) break;
    s += r[i] - r[i - qn];
  }
  vq /= cnt;
  const se = Math.sqrt((2 * (2 * qn - 1) * (qn - 1)) / (3 * qn * T));
  const vr = vq / (qn * v1);
  return { q: qn, vr, se, z: (vr - 1) / se };
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
      if (!best || ll > best.ll) best = { a, b, w };
    }
  }
  const { a, b, w } = best;
  let h = v; const z = new Float64Array(T);
  for (let t = 0; t < T; t++) { z[t] = e[t] / Math.sqrt(h); h = w + a * e[t] * e[t] + b * h; }
  return { a, b, per: a + b, lr: v, hNext: h, z };
}

// rata-rata varians per jam selama H jam ke depan (term structure GARCH)
const garchAvgVar = (g, H) => (g.per >= 0.9999 ? g.hNext
  : g.lr + (g.hNext - g.lr) * (1 - g.per ** H) / ((1 - g.per) * H));

// kurtosis mixture normal (prob p: σ×K), varians dinormalisasi = 1
const tailKurt = (p) => { const k2 = TAIL_K * TAIL_K; return 3 * (1 - p + p * k2 * k2) / (1 - p + p * k2) ** 2; };
function calibrateTail(kurt) {
  if (!isFinite(kurt) || kurt <= 3.05) return 0;
  const tgt = Math.min(kurt, tailKurt(0.1) - 1e-6);
  let a = 0, b = 0.1;
  for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (tailKurt(m) < tgt) a = m; else b = m; }
  return (a + b) / 2;
}

// ---------- volatilitas harian ----------
export function dailyVol(q, kl, days) {
  if (!kl) return proxyVol(q);
  const r = [], gk = [];
  const c2 = 2 * Math.LN2 - 1;
  for (let i = 1; i < kl.length; i++) {
    const x = Math.log(kl[i].c / kl[i - 1].c);
    if (!isFinite(x)) continue;
    const k = kl[i];
    const g = 0.5 * Math.log(k.h / k.l) ** 2 - c2 * Math.log(k.c / k.o) ** 2;   // Garman–Klass
    r.push(x); gk.push(isFinite(g) && g > 0 ? g : x * x);
  }
  const T = r.length;
  let cc = 0, gkm = 0;
  for (let t = 0; t < T; t++) { cc += r[t] * r[t]; gkm += gk[t]; }
  const longRun = 0.5 * cc / T + 0.5 * gkm / T;

  let ew = longRun;                                       // EWMA, half-life ≈ 46 jam
  for (let t = 0; t < T; t++) ew = 0.985 * ew + 0.015 * (0.5 * r[t] * r[t] + 0.5 * gk[t]);
  const wS = days <= 3 ? 0.7 : days <= 10 ? 0.5 : 0.3;
  const vEw = wS * ew + (1 - wS) * longRun;

  const g = fitGARCH(r);
  let vG = vEw, kurt = null, tailP = 0.02, garch = null;
  if (g) {
    vG = garchAvgVar(g, Math.max(24, days * 24)) * clamp(longRun / g.lr, 0.7, 1.3);
    let m2 = 0, m4 = 0;
    for (let t = 0; t < T; t++) { const z2 = g.z[t] * g.z[t]; m2 += z2; m4 += z2 * z2; }
    kurt = (m4 / T) / (m2 / T) ** 2;
    tailP = calibrateTail(kurt);
    garch = {
      a: g.a, b: g.b, per: g.per,
      hl: g.per < 1 ? Math.log(0.5) / Math.log(g.per) : Infinity,
      nowD: Math.sqrt(g.hNext * 24), lrD: Math.sqrt(g.lr * 24),
    };
  }
  return {
    vol: clamp(Math.sqrt((0.5 * vEw + 0.5 * vG) * 24), 0.01, 0.15),
    src: `GK+EWMA ⊕ GARCH · ${T} candle 1J`,
    vr6: varianceRatio(r, 6), vr24: varianceRatio(r, 24),
    tailP, kurt, garch, live: true,
  };
}

// tanpa candle: σ dari 4 titik perubahan harga. E|X| = σ√(2/π)
function proxyVol(q) {
  const c = [
    Math.abs(q.change_24h || 0), Math.abs(q.change_7d || 0) / Math.sqrt(7),
    Math.abs(q.change_30d || 0) / Math.sqrt(30), Math.abs(q.change_1h || 0) * Math.sqrt(24),
  ].map((x) => x / 100);
  const ms = c.reduce((a, b) => a + b * b, 0) / c.length;
  return {
    vol: clamp(Math.sqrt(ms * Math.PI / 2), 0.02, 0.12), src: 'proxy 4 titik (kasar)',
    vr6: null, vr24: null, tailP: 0.02, kurt: null, garch: null, live: false,
  };
}

/* ---------- noise mikrostruktur dari candle 5 menit ----------
   Harga teramati = harga efisien + ε, ε ~ proses OU (half-life ≈ τ menit).
   Var return lag L menit: σ²L + 2η²(1 − e^(−L/τ)).
   Dengan lag 5 & 60 menit dari data yang SAMA:
     η² = (12·v5 − v60) / (24(1−e^(−5/τ)) − 2(1−e^(−60/τ)))
   η > 0 berarti harga "bergetar" balik dalam hitungan menit → grid terisi lebih cepat
   daripada yang diramalkan random walk murni. Inilah sumber utama hit < 15 menit. */
export function microNoise(m5) {
  const none = { eta: 0, tau: NOISE.TAU_MIN, share: 0, vr: null, n: 0 };
  if (!m5 || m5.length < NOISE.MIN_BARS) return none;
  const r = logReturns(m5);
  const T = r.length;
  let m = 0; for (const x of r) m += x; m /= T;
  let v5 = 0; for (const x of r) v5 += (x - m) ** 2; v5 /= T;
  let s = 0, v60 = 0, cnt = 0;
  for (let i = 0; i < T; i++) {
    s += r[i] - m;
    if (i >= 12) s -= r[i - 12] - m;
    if (i >= 11) { v60 += s * s; cnt++; }
  }
  v60 /= cnt;
  if (!(v5 > 0 && v60 > 0)) return none;
  const tau = NOISE.TAU_MIN;
  const denom = 24 * (1 - Math.exp(-5 / tau)) - 2 * (1 - Math.exp(-60 / tau));
  let eta2 = Math.max(0, (12 * v5 - v60) / denom) * NOISE.SHRINK;
  const noiseVar5 = (e2) => 2 * e2 * (1 - Math.exp(-5 / tau));
  if (noiseVar5(eta2) > NOISE.MAX_SHARE * v5) eta2 = NOISE.MAX_SHARE * v5 / (2 * (1 - Math.exp(-5 / tau)));
  return { eta: Math.sqrt(eta2), tau, share: noiseVar5(eta2) / v5, vr: v60 / (12 * v5), n: T };
}

// ---------- regresi trend (31 close harian) ----------
export function buildTrend(q, vol, kl) {
  const P = q.price;
  let pts;
  if (kl && kl.length >= 24 * 30 - 24) {
    pts = [];
    for (let d = 30; d >= 0; d--) {
      const idx = kl.length - 1 - 24 * d;
      if (idx >= 0) pts.push({ t: -d, p: d === 0 ? P : kl[idx].c });
    }
  } else {
    pts = [[-30, q.change_30d], [-7, q.change_7d], [-1, q.change_24h], [-1 / 24, q.change_1h], [0, 0]]
      .map(([t, c]) => ({ t, p: P / (1 + (c || 0) / 100) }));
  }
  const n = pts.length;
  const xs = pts.map((o) => o.t), ys = pts.map((o) => Math.log(o.p));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const r2 = syy > 0 && sxx > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  let label = 'SIDEWAYS';
  if (slope > 0.3 * vol && r2 > 0.3) label = 'UPTREND';
  else if (slope < -0.3 * vol && r2 > 0.3) label = 'DOWNTREND';
  return { pts, slope, r2, muSim: clamp(slope * 0.5 * r2, -0.2 * vol, 0.2 * vol), label, daily: n > 6 };
}

// ---------- HMM 3-regime (Baum-Welch, return 1 jam) ----------
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
    // forward (ter-skala)
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
    // backward
    for (let k = 0; k < K; k++) be[(T - 1) * K + k] = 1;
    for (let t = T - 2; t >= 0; t--) for (let i = 0; i < K; i++) {
      let v = 0;
      for (let j = 0; j < K; j++) v += A[i][j] * B[(t + 1) * K + j] * be[(t + 1) * K + j];
      be[t * K + i] = v / sc[t + 1];
    }
    ll = 0; for (let t = 0; t < T; t++) ll += Math.log(sc[t]);

    // M-step
    const gS = [0, 0, 0], gR = [0, 0, 0], xi = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) {
      const g = al[t * K + k] * be[t * K + k]; gS[k] += g; gR[k] += g * r[t];
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
    for (let t = 0; t < T; t++) for (let k = 0; k < K; k++) gV[k] += al[t * K + k] * be[t * K + k] * (r[t] - mu[k]) ** 2;
    for (let k = 0; k < K; k++) sg[k] = Math.max(sgFloor, Math.sqrt(gV[k] / Math.max(gS[k], 1e-9)));

    if (Math.abs(ll - prevLL) < 1e-7 * Math.abs(ll)) break;
    prevLL = ll;
  }
  const L = (T - 1) * K;
  return { mu, sg, A, alpha: [al[L], al[L + 1], al[L + 2]], ll };
}

function fitHMMBest(r) {
  let best = null;
  for (const s of [[0.9, 0.55, 1.7], [1.0, 0.7, 1.4], [0.8, 0.45, 2.2]]) {   // multi-start
    const f = fitHMM(r, 60, s);
    if (isFinite(f.ll) && (!best || f.ll > best.ll)) best = f;
  }
  return best;
}

const cumRow = (row) => { const s = row[0] + row[1] + row[2]; return [row[0] / s, (row[0] + row[1]) / s, 1]; };

export function buildHMM(q, vol, kl, days) {
  const r = kl ? logReturns(kl) : null;
  const f = r && r.length >= 200 ? fitHMMBest(r.slice(-720)) : null;
  const H = f ? fittedHMM(f, vol, days, Math.min(720, r.length)) : heuristicHMM(q, vol);
  H.AhCum = H.Ah.map(cumRow);
  H.piCum = [H.alpha[0], H.alpha[0] + H.alpha[1], 1];
  const muExpD = 24 * (H.alpha[0] * H.muH[0] + H.alpha[1] * H.muH[1] + H.alpha[2] * H.muH[2]);
  H.muEff = clamp(muExpD, -0.2 * vol, 0.2 * vol);
  H.sgD = H.sgH.map((s) => s * Math.sqrt(24));
  H.muD = H.muH.map((m) => m * 24);
  return H;
}

function fittedHMM(f, vol, days, nObs) {
  const ord = [0, 1, 2].sort((a, b) => f.mu[b] - f.mu[a]);   // BULL, SIDE, BEAR
  let sgH = ord.map((k) => f.sg[k]);
  const Ah = ord.map((i) => ord.map((j) => f.A[i][j]));
  const alpha = ord.map((k) => f.alpha[k]);

  // kalibrasi level σ ke estimator volatilitas (dibatasi 0.8–1.25 agar info regime tetap)
  const steps = Math.max(24, Math.round((days || 7) * 24));
  let pi = alpha.slice(), acc = 0;
  for (let t = 0; t < steps; t++) {
    acc += pi[0] * sgH[0] ** 2 + pi[1] * sgH[1] ** 2 + pi[2] * sgH[2] ** 2;
    pi = [0, 1, 2].map((j) => pi[0] * Ah[0][j] + pi[1] * Ah[1][j] + pi[2] * Ah[2][j]);
  }
  const volScale = clamp(Math.sqrt((vol * vol / 24) / (acc / steps)), 0.8, 1.25);
  sgH = sgH.map((s) => s * volScale);
  const muH = ord.map((k, i) => clamp(f.mu[k] * DRIFT_SHRINK, -0.1 * sgH[i], 0.1 * sgH[i]));
  return { fitted: true, nObs, volScale, muH, sgH, Ah, alpha };
}

// tanpa candle: filter HMM pada 4 titik perubahan harga (kasar)
function heuristicHMM(q, vol) {
  const muD = [0.3 * vol, 0, -0.3 * vol], sgD = [1.0 * vol, 0.75 * vol, 1.3 * vol];
  const A = [[0.88, 0.10, 0.02], [0.08, 0.84, 0.08], [0.02, 0.10, 0.88]];
  const P = q.price, back = (c) => P / (1 + (c || 0) / 100);
  const p30 = back(q.change_30d), p7 = back(q.change_7d), p1 = back(q.change_24h), ph = back(q.change_1h);
  const obs = [
    { r: Math.log(p7 / p30), L: 23 }, { r: Math.log(p1 / p7), L: 6 },
    { r: Math.log(ph / p1), L: 23 / 24 }, { r: Math.log(P / ph), L: 1 / 24 },
  ];
  const mul = (X, Y) => X.map((row) => Y[0].map((_, j) => row.reduce((s, v, k) => s + v * Y[k][j], 0)));
  const pow = (L) => {
    let M = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < Math.floor(L); i++) M = mul(M, A);
    const fr = L - Math.floor(L);
    return fr > 1e-9 ? mul(M, A.map((row, i) => row.map((v, j) => (i === j ? 1 + fr * (v - 1) : fr * v)))) : M;
  };
  let alpha = [1 / 3, 1 / 3, 1 / 3];
  for (const o of obs) {
    const Tm = pow(o.L);
    const upd = [0, 1, 2].map((k) => {
      const pred = alpha[0] * Tm[0][k] + alpha[1] * Tm[1][k] + alpha[2] * Tm[2][k];
      const v = sgD[k] ** 2 * o.L;
      return pred * Math.exp(-((o.r - muD[k] * o.L) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
    });
    const Z = upd[0] + upd[1] + upd[2];
    alpha = Z > 0 ? upd.map((x) => x / Z) : [1 / 3, 1 / 3, 1 / 3];
  }
  return {
    fitted: false, nObs: 0, volScale: 1, alpha,
    muH: muD.map((m) => m / 24), sgH: sgD.map((s) => s / Math.sqrt(24)),
    Ah: A.map((row, i) => row.map((v, j) => (i === j ? 1 + (v - 1) / 24 : v / 24))),
  };
}
