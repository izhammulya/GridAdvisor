/* Monte Carlo: generator jalur harga + simulasi bot + backtest historis */
import { SIM, STEP, lateSub, TAIL_K, PARAM_SD, STRESS } from './config.js';
import { rand, gauss, setSeed, quantile, esOf, countLE, sortedCopy } from './util.js';
import { Runner, STATUS, etaBase } from './grid.js';

const pickCum = (cum, u) => (u < cum[0] ? 0 : u < cum[1] ? 1 : 2);

// high/low Brownian bridge di dalam satu langkah (log harga y0 → y1, v2 = 2σ²)
const bridgeHi = (y0, y1, v2) => 0.5 * (y0 + y1 + Math.sqrt((y1 - y0) ** 2 - v2 * Math.log(1 - rand())));
const bridgeLo = (y0, y1, v2) => 0.5 * (y0 + y1 - Math.sqrt((y1 - y0) ** 2 - v2 * Math.log(1 - rand())));

// parameter model: HMM 3-regime, atau GBM satu regime
export function modelParams(R, H) {
  if (R.useHMM) return H;
  return { muH: [R.mu / 24], sgH: [R.vol / Math.sqrt(24)], AhCum: [[1, 1, 1]], piCum: [1, 1, 1] };
}

// jumlah sub-langkah per jam: 1 menit (2 jam awal) → 5 menit (s/d 24 jam) → 10–30 menit
export function stepPlan(nH, days, mode = 'full') {
  const subs = new Int16Array(nH), off = new Int32Array(nH + 1);
  for (let h = 0; h < nH; h++) {
    subs[h] = mode === 'coarse' ? (h < STEP.ULTRA_H ? STEP.FINE_SUB : STEP.COARSE_SUB)
      : mode === 'repair' ? (h < STEP.ULTRA_H ? STEP.FINE_SUB : STEP.COARSE_SUB)
      : h < STEP.ULTRA_H ? STEP.ULTRA_SUB : h < STEP.FINE_H ? STEP.FINE_SUB : lateSub(days);
    off[h + 1] = off[h] + subs[h];
  }
  return { subs, off, n: off[nH] };
}

/* ---------- generator jalur ----------
   log harga efisien x: HMM regime-switching + fat tail per jam + ketidakpastian σ per path.
   Harga teramati y = x + ε (noise OU dari candle 5 menit) — inilah yang dilihat order grid.
   Antara dua titik, high/low disampel dengan Brownian bridge.
   Pasangan path (genap, ganjil) antithetic: angka acak sama, tanda berlawanan. */
export class PathSampler {
  constructor(M, { nH, plan, volMult = 1, driftD = 0, tailP = 0.02, noise = null }) {
    const eta = noise && noise.eta > 0 ? noise.eta : 0;
    const avgVar = M.sgH.reduce((a, s) => a + s * s, 0) / M.sgH.length;
    const eff = Math.sqrt(Math.max(0.4, 1 - (2 * eta * eta) / avgVar));   // varians 1 jam teramati tetap
    Object.assign(this, {
      nH, plan, eta, tau: (noise && noise.tau) || 5,
      sg: M.sgH.map((s) => s * volMult * eff), mu: M.muH.map((m) => m + driftD / 24),
      AhCum: M.AhCum, piCum: M.piCum,
      tailP, tailN: 1 / Math.sqrt(1 - tailP + tailP * TAIL_K * TAIL_K),
      z: new Float64Array(plan.n), zn: eta ? new Float64Array(plan.n) : null,
      rg: new Int8Array(nH), mult: new Float64Array(nH),
      u: 1, e0: 0, sgn: 1, lastP: 0,
    });
  }
  draw(i) {
    if (i & 1) { this.sgn = -1; return; }
    this.sgn = 1;
    let rg = pickCum(this.piCum, rand());
    for (let h = 0; h < this.nH; h++) {
      rg = pickCum(this.AhCum[rg], rand());
      this.rg[h] = rg;
      this.mult[h] = (rand() < this.tailP ? TAIL_K : 1) * this.tailN;
    }
    for (let t = 0; t < this.plan.n; t++) this.z[t] = gauss();
    if (this.zn) for (let t = 0; t < this.plan.n; t++) this.zn[t] = gauss();
    this.u = Math.exp(PARAM_SD * gauss() - PARAM_SD * PARAM_SD);
    this.e0 = this.eta ? gauss() * this.eta * Math.SQRT1_2 : 0;
  }
  // onVisit(harga, menit) / onHour(jam, harga) → true untuk berhenti. Return menit berhenti, −1 bila sampai akhir.
  walk(P0, onVisit, onHour) {
    const { plan, sg, mu, z, zn, eta, tau, sgn } = this;
    let eps = sgn * this.e0, y = Math.log(P0), x = y - eps;
    for (let h = 0; h < this.nH; h++) {
      const Sx = plan.subs[h], base = plan.off[h], rg = this.rg[h], dt = 60 / Sx;
      const s = sg[rg] * this.u * this.mult[h] / Math.sqrt(Sx);
      const d = mu[rg] / Sx - 0.5 * s * s, v2 = 2 * s * s;
      const phi = eta ? Math.exp(-dt / tau) : 0, nsd = eta * Math.sqrt(1 - phi * phi);
      for (let j = 0; j < Sx; j++) {
        x += d + s * sgn * z[base + j];
        if (eta) eps = phi * eps + nsd * sgn * zn[base + j];
        const y1 = x + eps, up = y1 >= y;
        const hi = bridgeHi(y, y1, v2), lo = bridgeLo(y, y1, v2);
        const t = h * 60 + (j + 1) * dt;
        // naik: O→L→H→C · turun: O→H→L→C
        if (onVisit(Math.exp(up ? lo : hi), t) || onVisit(Math.exp(up ? hi : lo), t) || onVisit(Math.exp(y1), t)) {
          this.lastP = Math.exp(y1); return t;
        }
        y = y1;
      }
      this.lastP = Math.exp(y);
      if (onHour(h, this.lastP)) return (h + 1) * 60;
    }
    return -1;
  }
}

function checkpoints(nH) {
  const every = Math.max(1, Math.round(nH / 72));
  const idx = [];
  for (let h = every; h <= nH; h += every) idx.push(h);
  if (idx[idx.length - 1] !== nH) idx.push(nH);
  const at = new Int32Array(nH + 2).fill(-1);
  idx.forEach((h, c) => { at[h] = c; });
  return { idx, at };
}

const N_KEEP = 40;   // jalur contoh untuk digambar

/* ---------- simulasi utama ----------
   o: { n, light, coarse, volMult, driftD, seed, noise } */
export function simulate(R, H, o = {}) {
  const N = o.n || SIM.N, light = !!o.light;
  setSeed(o.seed ?? '');
  const M = modelParams(R, H);
  const nH = Math.round(R.days * 24);
  const plan = stepPlan(nH, R.days, o.coarse ? 'coarse' : 'full');
  const sampler = new PathSampler(M, { nH, plan, volMult: o.volMult, driftD: o.driftD, tailP: R.tailP ?? 0.02, noise: o.noise });
  const run = new Runner(R), tgt = R.targetUsd, inv = R.invest;

  const pnl = new Float64Array(N), stArr = new Uint8Array(N), endPx = new Float64Array(N);
  const maxDD = new Float64Array(N), sharpe = new Float64Array(N), cyc = new Float64Array(N);
  const hitMin = [], counts = [0, 0, 0, 0, 0];
  const ck = light ? null : checkpoints(nH);
  const ckPx = ck ? ck.idx.map(() => new Float32Array(N)) : null;
  const ckEq = ck ? ck.idx.map(() => new Float32Array(N)) : null;
  const samplePx = [], sampleEq = [];

  // state per path (dipakai ulang oleh callback, tanpa alokasi per langkah)
  // Setelah bot berhenti (target/SL/TP/liq), harga tetap disimulasikan sampai akhir horizon
  // supaya kerucut harga di grafik tetap utuh; di mode "light" jalur langsung dihentikan.
  let i = 0, status, done, tStop, hit, eq, peak, minDd, prevDayEq, sR, sR2, nD, kp, ke;

  const stop = (st, val, t) => {
    status = st; done = true; tStop = t; eq = val;
    if (eq > peak) peak = eq;
    if (eq - peak < minDd) minDd = eq - peak;
    return light;
  };
  const onVisit = (q, t) => {
    if (done) return false;
    const s = run.visit(q);
    if (s) return stop(s, run.final(s, run.exitPx), t);
    if (hit < 0) {
      const nv = run.net(q);
      if (nv >= tgt) {
        hit = t;
        if (R.exitOnTarget) return stop(STATUS.TARGET, nv, t);
      }
    }
    return false;
  };
  const onHour = (h, p) => {
    if (!done) {
      run.accrue(p);
      eq = run.eq(p);
      if (eq > peak) peak = eq;
      if (eq - peak < minDd) minDd = eq - peak;
      if ((h + 1) % 24 === 0) { const r = (eq - prevDayEq) / inv; sR += r; sR2 += r * r; nD++; prevDayEq = eq; }
    }
    if (kp) { kp.push(p); ke.push((eq / inv) * 100); }
    if (ck) { const c = ck.at[h + 1]; if (c >= 0) { ckPx[c][i] = p; ckEq[c][i] = (eq / inv) * 100; } }
    return false;
  };

  for (i = 0; i < N; i++) {
    sampler.draw(i);
    run.reset(R.P);
    status = STATUS.RUN; done = false; tStop = -1; hit = -1;
    eq = 0; peak = 0; minDd = 0; prevDayEq = 0; sR = 0; sR2 = 0; nD = 0;
    kp = !light && i < N_KEEP ? [R.P] : null; ke = kp ? [0] : null;

    sampler.walk(R.P, onVisit, onHour);
    if (hit < 0 && status && eq >= tgt) hit = tStop;
    counts[status]++;
    if (hit >= 0) hitMin.push(hit);
    pnl[i] = eq; stArr[i] = status; endPx[i] = sampler.lastP; cyc[i] = run.b.cycles;
    maxDD[i] = (minDd / inv) * 100;
    if (nD >= 2) {
      const m = sR / nD, sd = Math.sqrt(Math.max(0, sR2 / nD - m * m));
      sharpe[i] = sd > 1e-9 ? Math.max(-10, Math.min(10, (m / sd) * Math.sqrt(365))) : 0;
    } else sharpe[i] = 0;
    if (kp) { samplePx.push(kp); sampleEq.push(ke); }
  }

  // ---------- statistik ----------
  const pctRaw = Float32Array.from(pnl, (x) => (x / inv) * 100);
  const pct = sortedCopy(pctRaw);
  let nTarget = 0, nWin = 0, sumP = 0;
  for (let k = 0; k < N; k++) { if (pnl[k] >= tgt - 1e-9) nTarget++; if (pnl[k] > 0) nWin++; sumP += pctRaw[k]; }
  hitMin.sort((a, b) => a - b);
  const se = (p) => Math.sqrt(Math.max(1e-9, (p * (1 - p)) / N)) * 100;
  const uq = (p) => { const k = Math.ceil(p * N) - 1; return k < hitMin.length ? hitMin[Math.max(0, k)] : null; };
  const pTarget = nTarget / N, pTouch = hitMin.length / N;

  const common = {
    N, targetPct: (tgt / inv) * 100, mean: sumP / N,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05), p95: quantile(pct, 0.95), es5: esOf(pct, 0.05),
    pWin: nWin / N, pTarget, se: se(pTarget), pTouch, seTouch: se(pTouch),
    pLiq: counts[STATUS.LIQ] / N, pSL: counts[STATUS.SL] / N, pTP: counts[STATUS.TP] / N, pExit: counts[STATUS.TARGET] / N,
    cyP50: quantile(sortedCopy(cyc), 0.5), t50: uq(0.5),
  };
  if (light) return common;

  const horizonMin = nH * 60;
  const bucketMins = [5, 15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080, 20160].filter((t) => t < horizonMin).concat([horizonMin]);
  const ttt = {
    hitMin, horizonMin,
    cdf: (t) => countLE(hitMin, t) / N,
    buckets: bucketMins.map((t) => ({ t, p: countLE(hitMin, t) / N })),
    t25: uq(0.25), t50: uq(0.5), t80: uq(0.8), t90: uq(0.9),
    eta: etaBase(R, Math.sqrt(M.sgH.reduce((a, s) => a + s * s, 0) / M.sgH.length)),
  };

  const fanOf = (arrs) => ck.idx.map((t, c) => {
    const a = sortedCopy(arrs[c]);
    return { t, p5: quantile(a, 0.05), p25: quantile(a, 0.25), p50: quantile(a, 0.5), p75: quantile(a, 0.75), p95: quantile(a, 0.95) };
  });
  const inRange = ck.idx.map((_, c) => { let k = 0; const a = ckPx[c]; for (let j = 0; j < N; j++) if (a[j] >= R.low && a[j] <= R.high) k++; return k / N; });
  const dd = sortedCopy(maxDD), sh = sortedCopy(sharpe), px = sortedCopy(endPx), cy = sortedCopy(cyc);

  return {
    ...common, pct, pctRaw, stArr, endPx, ckIdx: ck.idx, ckPx, inRange, samplePx, sampleEq, nH, plan, ttt,
    fan: fanOf(ckPx), eqFan: fanOf(ckEq),
    ddP5: quantile(dd, 0.05), ddP50: quantile(dd, 0.5), ddP95: quantile(dd, 0.95),
    shP5: quantile(sh, 0.05), shP50: quantile(sh, 0.5), shP95: quantile(sh, 0.95),
    cyP5: quantile(cy, 0.05), cyP95: quantile(cy, 0.95),
    pxP5: quantile(px, 0.05), pxP50: quantile(px, 0.5), pxP95: quantile(px, 0.95),
  };
}

export function stressOpts(R) {
  const sgn = R.mode === 0 ? -1 : R.mode === 1 ? 1 : 0;    // drift melawan arah posisi
  return sgn ? { volMult: STRESS.vol, driftD: sgn * STRESS.drift * R.vol } : { volMult: STRESS.volNeutral, driftD: 0 };
}

/* ---------- backtest historis ----------
   Setting yang sama dijalankan di jalur harga asli (candle 1 jam, urutan O→L→H→C / O→H→L→C),
   jendela bergeser. Hit time beresolusi ±15 menit. */
export function backtest(R, kl) {
  if (!kl) return null;
  const nH = Math.round(R.days * 24);
  const indep = kl.length / nH;
  if (kl.length < nH + 24) return { n: 0, indep };
  const stepH = Math.max(3, Math.round(nH / 24));
  const run = new Runner(R);
  const pct = [], hits = [];
  const cnt = [0, 0, 0, 0, 0];
  let tgtEnd = 0, n = 0;
  for (let s = 0; s + nH <= kl.length; s += stepH) {
    const f = R.P / kl[s].o;
    run.reset(R.P);
    let st = STATUS.RUN, hit = -1, last = R.P, eq = null;
    outer:
    for (let h = 0; h < nH; h++) {
      const k = kl[s + h];
      const seq = k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c];
      for (let w = 0; w < 4; w++) {
        const qx = seq[w] * f;
        const r = run.visit(qx);
        if (r) { st = r; last = run.exitPx; break outer; }
        last = qx;
        if (hit < 0 && run.net(qx) >= R.targetUsd) {
          hit = h * 60 + (w + 1) * 15;
          if (R.exitOnTarget) { st = STATUS.TARGET; eq = run.net(qx); break outer; }
        }
      }
      run.accrue(k.c * f);
    }
    if (eq == null) eq = run.final(st, last);
    cnt[st]++; n++;
    if (eq >= R.targetUsd - 1e-9) { tgtEnd++; if (hit < 0) hit = nH * 60; }
    if (hit >= 0) hits.push(hit);
    pct.push((eq / R.invest) * 100);
  }
  pct.sort((a, b) => a - b); hits.sort((a, b) => a - b);
  const kq = Math.ceil(0.5 * n) - 1;
  return {
    n, indep, stepH,
    pTarget: tgtEnd / n, pTouch: hits.length / n, pLiq: cnt[STATUS.LIQ] / n, pSL: cnt[STATUS.SL] / n, pTP: cnt[STATUS.TP] / n,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05), mean: pct.reduce((a, b) => a + b, 0) / n, es5: esOf(pct, 0.05),
    t50: kq < hits.length ? hits[kq] : null,
  };
}
