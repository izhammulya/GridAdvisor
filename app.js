/* GRIDFISH v3 — Pionex Grid Advisor (LINK/SOL/ETH/INJ)
   ================================================================
   BARU DI v3:
   1. REPAIR BOT (Futures) — untuk bot yang sedang floating loss:
      - Rekomendasi berapa Add Investment (margin tambahan) yang layak,
        dihitung dari 4 skenario (0% / 25% / 50% / 100% dari saldo tersedia).
      - Estimasi berapa lama bot recovery sampai Total Profit ≥ target exit
        (default +1 USDT) via Monte Carlo first-passage-time:
        median hari, rentang P25–P75, P(recover ≤ 7 hari), P(recover ≤ horizon).
      - P(likuidasi) per skenario; liq price baru dihitung dgn kalibrasi
        dari liq price yang tertera di Pionex:
          short: liqBaru = liq0 + ΔM / (Q·(1+mmr))
          long : liqBaru = liq0 − ΔM / (Q·(1−mmr))
      - Selisih akuntansi Pionex (funding fee dll) dikalibrasi otomatis
        sebagai offset konstan: offset = PnL_lapor − (gridProfit + floating).
   2. MONTE CARLO ala "MC Stress Test" (referensi gambar user):
      - EQUITY CURVE FAN: 60 sample path equity + garis persentil P5/P50/P95
        empiris dari 5.000 path, berlabel nilai akhir.
      - 3 HISTOGRAM: Total Return, Max Drawdown, Sharpe Ratio.
      - TABEL SUMMARY persentil 5/50/95 + interpretasi otomatis (bahasa manusia).
   3. Perbaikan teknis: RNG bisa di-seed (hasil reproducible), equity di-track
      per jam (drawdown akurat), typed array, RNG state di-reset tiap run.

   Aturan lama tetap: target 0.3% investasi, grid spot = point/pembagi + 1,
   HMM 3-regime + antithetic + fat tails. Model aproksimasi — bukan jaminan. */

'use strict';

// ---------- state ----------
const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm', rpDir: 'short' };
const N_SIM = 5000;
const N_SIM_REPAIR = 1500;      // per skenario add-investment (4 skenario)
const TARGET_RATE = 0.003;      // 0.15 USDT per 50 USDT
const MMR = 0.005;              // maintenance margin rate (aproksimasi Pionex)
const $ = (id) => document.getElementById(id);

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
  $('fldDir').classList.toggle('hide', !fut);
  $('fldLev').classList.toggle('hide', !fut);
});
seg('segDir', 'dir');
seg('segModel', 'model');
seg('segRpDir', 'rpDir');

setInterval(() => { $('clock').textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }, 1000);

// ---------- fetch harga (on-demand) ----------
async function getQuote(sym) {
  try {
    const r = await fetch('/api/quotes?symbol=' + sym);
    const j = await r.json();
    if (j && typeof j.price === 'number') return { ...j, demo: false };
    return { ...DEMO[sym], symbol: sym, demo: true, reason: (j && j.error) || 'API tidak tersedia' };
  } catch (e) {
    return { ...DEMO[sym], symbol: sym, demo: true, reason: 'Tidak bisa mengakses /api/quotes (jalankan via Vercel)' };
  }
}

// ---------- volatilitas harian ----------
function dailyVol(q) {
  const c = [
    Math.abs(q.change_24h || 0),
    Math.abs(q.change_7d || 0) / Math.sqrt(7),
    Math.abs(q.change_30d || 0) / Math.sqrt(30),
    Math.abs(q.change_1h || 0) * Math.sqrt(24),
  ].map((x) => x / 100);
  const ms = c.reduce((a, b) => a + b * b, 0) / c.length;
  let vol = Math.sqrt(ms) * 1.15;
  return Math.min(0.12, Math.max(0.02, vol));
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
function buildTrend(q, vol) {
  const P = q.price;
  const pts = [
    { t: -30,     lab: '-30D', p: P / (1 + (q.change_30d || 0) / 100) },
    { t: -7,      lab: '-7D',  p: P / (1 + (q.change_7d  || 0) / 100) },
    { t: -1,      lab: '-24H', p: P / (1 + (q.change_24h || 0) / 100) },
    { t: -1 / 24, lab: '-1H',  p: P / (1 + (q.change_1h  || 0) / 100) },
    { t: 0,       lab: 'NOW',  p: P },
  ];
  const n = pts.length;
  const xs = pts.map((o) => o.t), ys = pts.map((o) => Math.log(o.p));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  const muSim = Math.max(-0.5 * vol, Math.min(0.5 * vol, slope * 0.5 * r2));
  let label = 'SIDEWAYS', cls = '';
  if (slope > 0.3 * vol && r2 > 0.3) { label = 'UPTREND'; cls = 'up'; }
  else if (slope < -0.3 * vol && r2 > 0.3) { label = 'DOWNTREND'; cls = 'dn'; }
  return { pts, slope, r2, muSim, label, cls };
}

// ---------- HMM 3-regime ----------
function buildHMM(q, vol) {
  const mu = [ +0.9 * vol, 0, -0.9 * vol ];
  const sg = [ 1.0 * vol, 0.75 * vol, 1.30 * vol ];
  const A = [
    [0.88, 0.10, 0.02],
    [0.08, 0.84, 0.08],
    [0.02, 0.10, 0.88],
  ];
  const P = q.price;
  const p30 = P / (1 + (q.change_30d || 0) / 100);
  const p7  = P / (1 + (q.change_7d  || 0) / 100);
  const p1  = P / (1 + (q.change_24h || 0) / 100);
  const ph  = P / (1 + (q.change_1h  || 0) / 100);
  const obs = [
    { r: Math.log(p7 / p30), L: 23 },
    { r: Math.log(p1 / p7),  L: 6 },
    { r: Math.log(ph / p1),  L: 23 / 24 },
    { r: Math.log(P / ph),   L: 1 / 24 },
  ];
  const matMul = (X, Y) => X.map((row) =>
    Y[0].map((_, j) => row.reduce((s, v, k) => s + v * Y[k][j], 0)));
  const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  function matPow(L) {
    let M = I3;
    const w = Math.floor(L);
    for (let i = 0; i < w; i++) M = matMul(M, A);
    const f = L - w;
    if (f > 1e-9) {
      const Af = A.map((row, i) => row.map((v, j) => (i === j ? 1 + f * (v - 1) : f * v)));
      M = matMul(M, Af);
    }
    return M;
  }
  const emis = (r, L, k) => {
    const v = sg[k] * sg[k] * L;
    return Math.exp(-((r - mu[k] * L) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
  };
  let alpha = [1 / 3, 1 / 3, 1 / 3];
  for (const o of obs) {
    const T = matPow(o.L);
    const pred = [0, 1, 2].map((j) => alpha[0] * T[0][j] + alpha[1] * T[1][j] + alpha[2] * T[2][j]);
    let upd = pred.map((p, k) => p * emis(o.r, o.L, k));
    const Z = upd[0] + upd[1] + upd[2];
    alpha = Z > 0 ? upd.map((x) => x / Z) : [1 / 3, 1 / 3, 1 / 3];
  }
  const dt = 1 / 24;
  const Ah = A.map((row, i) => row.map((v, j) => (i === j ? 1 + dt * (v - 1) : dt * v)));
  const AhCum = Ah.map((row) => [row[0], row[0] + row[1], 1]);
  const piCum = [alpha[0], alpha[0] + alpha[1], 1];
  const muExp0 = alpha[0] * mu[0] + alpha[1] * mu[1] + alpha[2] * mu[2];
  const muEff = Math.max(-0.5 * vol, Math.min(0.5 * vol, muExp0 * 0.6));
  return { mu, sg, A, Ah, AhCum, alpha, piCum, muEff };
}

// ---------- mesin rekomendasi ----------
function buildReco(q, T, H) {
  const P = q.price;
  const days = Math.max(1, +$('inDays').value || 7);
  const fee = Math.max(0, +$('inFee').value || 0.05) / 100;
  const invest = Math.max(10, +$('inInvest').value || 50);
  const fut = S.prod === 'fut';
  const dir = fut ? S.dir : 'neutral';
  const lev = fut ? Math.min(10, Math.max(1, Math.round(+$('inLev').value || 3))) : 1;
  const useHMM = S.model === 'hmm';

  const vol = dailyVol(q);
  const horizonVol = vol * Math.sqrt(days);
  const z = 1.28;
  const mu = useHMM ? H.muEff : T.muSim;
  const centerShift = Math.exp(mu * days * 0.5);

  let lowM = z, highM = z;
  if (dir === 'long') { lowM = 1.25 * z; highM = 0.85 * z; }
  if (dir === 'short') { lowM = 0.85 * z; highM = 1.25 * z; }
  let low = P * centerShift * (1 - lowM * horizonVol);
  let high = P * centerShift * (1 + highM * horizonVol);

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
    grids = Math.min(200, Math.max(2, grids));
  } else {
    const netPerGrid = 0.0035;
    const grossStepPct = netPerGrid + 2 * fee;
    grids = Math.round((high - low) / (P * grossStepPct));
    grids = Math.min(200, Math.max(6, grids));
  }

  const step = (high - low) / grids;
  const profitPerGridNet = step / P - 2 * fee;
  const targetUsd = invest * TARGET_RATE;
  const trigger = dir === 'long' ? P * 0.998 : dir === 'short' ? P * 1.002 : null;
  const sl = dir === 'short' ? high * 1.02 : low * 0.98;
  const tp = dir === 'short' ? low : high;
  const liq = !fut || dir === 'neutral' ? null
    : dir === 'long' ? P * (1 - (1 - MMR) / lev)
    : P * (1 + (1 - MMR) / lev);

  return {
    P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step,
    profitPerGridNet, trigger, sl, tp, liq,
    point, divisor, points, feeAdjusted, targetUsd, mu, useHMM,
  };
}

// ---------- RNG (bisa di-seed → hasil reproducible) ----------
let _rand = Math.random;
let gaussSpare = null;
function setSeed(seedStr) {
  gaussSpare = null;
  const s = (seedStr || '').trim();
  if (!s) { _rand = Math.random; return; }
  let a = 0;
  for (let i = 0; i < s.length; i++) a = (Math.imul(a, 31) + s.charCodeAt(i)) | 0;
  a = a >>> 0;
  _rand = function mulberry32() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = _rand() * 2 - 1; v = _rand() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  gaussSpare = v * m; return u * m;
}
const quantile = (sortedArr, p) =>
  sortedArr.length ? sortedArr[Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length))] : null;

// ---------- Monte Carlo utama (HMM / GBM) + equity tracking ----------
function simulate(R, H) {
  setSeed($('inSeed') ? $('inSeed').value : '');
  const stepsPerDay = 24, n = Math.round(R.days * stepsPerDay), dt = 1 / stepsPerDay;
  const useHMM = R.useHMM;
  const notional = R.invest * R.lev;
  const perGridCap = notional / R.grids;

  const pnl = new Float64Array(N_SIM);
  const endPx = new Float64Array(N_SIM);
  const maxDD = new Float64Array(N_SIM);   // % dari investasi (negatif)
  const sharpe = new Float64Array(N_SIM);
  let liqCount = 0, slCount = 0;
  const samplePaths = [], sampleEq = [];

  const ckEvery = Math.max(1, Math.round(n / 28));
  const ckIdx = [];
  for (let t = ckEvery; t <= n; t += ckEvery) ckIdx.push(t);
  if (ckIdx[ckIdx.length - 1] !== n) ckIdx.push(n);
  const ckPx = ckIdx.map(() => new Float64Array(N_SIM));
  const ckEq = ckIdx.map(() => new Float32Array(N_SIM));
  const ckFilled = ckIdx.map(() => new Uint8Array(N_SIM));
  const ckAt = new Int16Array(n + 2).fill(-1);
  ckIdx.forEach((t, c) => { ckAt[t] = c; });

  const gBuf = new Float64Array(n);
  const rgBuf = new Int8Array(n);
  const levelOf = (p) => Math.min(R.grids, Math.max(0, Math.floor((p - R.low) / R.step)));

  for (let i = 0; i < N_SIM; i++) {
    const anti = (i & 1) === 1;
    let p = R.P;
    let rg = 1;
    if (useHMM && !anti) {
      const u = _rand();
      rg = u < H.piCum[0] ? 0 : u < H.piCum[1] ? 1 : 2;
    }

    const longs = [], shorts = [];
    let level = levelOf(p);
    if (!R.fut || R.dir === 'long') {
      const above = R.grids - level;
      for (let k = 0; k < above; k++) longs.push(R.P);
    } else if (R.dir === 'short') {
      for (let k = 0; k < level; k++) shorts.push(R.P);
    }
    const centerLevel = level;

    let realized = 0, dead = false, wiped = false;
    let eqNow = 0, peak = 0, minDd = 0;
    let prevDayEq = 0, sumR = 0, sumR2 = 0, nD = 0;
    const keepPath = i < 60 ? [p] : null;
    const keepEq = i < 60 ? [0] : null;

    for (let t = 0; t < n; t++) {
      let sigD = R.vol, muD = R.mu;
      if (useHMM) {
        if (!anti) {
          const u = _rand();
          const cum = H.AhCum[rg];
          rg = u < cum[0] ? 0 : u < cum[1] ? 1 : 2;
          rgBuf[t] = rg;
        } else {
          rg = rgBuf[t];
        }
        sigD = H.sg[rg]; muD = H.mu[rg];
      }
      const sigH = sigD * Math.sqrt(dt);

      let g;
      if (!anti) {
        g = gauss();
        if (_rand() < 0.04) g *= 2.5;
        gBuf[t] = g;
      } else {
        g = -gBuf[t];
      }

      p = p * Math.exp((muD * dt - 0.5 * sigH * sigH) + sigH * g);
      if (keepPath) keepPath.push(p);

      if (R.liq && ((R.dir === 'long' && p <= R.liq) || (R.dir === 'short' && p >= R.liq))) {
        realized = -R.invest; dead = true; wiped = true; eqNow = -R.invest; liqCount++;
        if (keepEq) keepEq.push(-100);
        break;
      }
      if ((R.dir !== 'short' && p <= R.sl) || (R.dir === 'short' && p >= R.sl)) {
        dead = true; slCount++;
        // realisasi floating di harga SL
        let fl = 0;
        for (const e of longs) fl += perGridCap * (p - e) / e;
        for (const e of shorts) fl += perGridCap * (e - p) / e;
        eqNow = Math.max(realized + fl, -R.invest);
        if (keepEq) keepEq.push(eqNow / R.invest * 100);
        break;
      }

      const nl = levelOf(p);
      if (nl !== level) {
        if (nl > level) {
          for (let L = level + 1; L <= nl; L++) {
            const sellPx = R.low + L * R.step;
            if (R.dir === 'neutral' && R.fut) {
              if (L > centerLevel) { shorts.push(sellPx); }
              else if (longs.length) {
                const e = longs.pop();
                realized += perGridCap * ((sellPx - e) / e - 2 * R.fee);
              }
            } else if (R.dir !== 'short') {
              if (longs.length) {
                const e = longs.pop();
                realized += perGridCap * ((sellPx - e) / e - 2 * R.fee);
              }
            } else {
              shorts.push(sellPx);
            }
          }
        } else {
          for (let L = level; L > nl; L--) {
            const buyPx = R.low + (L - 1) * R.step;
            if (R.dir === 'neutral' && R.fut) {
              if (L - 1 < centerLevel) { longs.push(buyPx); }
              else if (shorts.length) {
                const e = shorts.pop();
                realized += perGridCap * ((e - buyPx) / e - 2 * R.fee);
              }
            } else if (R.dir !== 'short') {
              longs.push(buyPx);
            } else {
              if (shorts.length) {
                const e = shorts.pop();
                realized += perGridCap * ((e - buyPx) / e - 2 * R.fee);
              }
            }
          }
        }
        level = nl;
      }

      // ---- equity per jam (utk fan chart, drawdown, sharpe)
      let fl = 0;
      for (const e of longs) fl += perGridCap * (p - e) / e;
      for (const e of shorts) fl += perGridCap * (e - p) / e;
      eqNow = Math.max(realized + fl, -R.invest);
      if (eqNow > peak) peak = eqNow;
      const dd = eqNow - peak;
      if (dd < minDd) minDd = dd;
      if ((t + 1) % 24 === 0) {
        const rD = (eqNow - prevDayEq) / R.invest;
        sumR += rD; sumR2 += rD * rD; nD++;
        prevDayEq = eqNow;
      }
      if (keepEq) keepEq.push(eqNow / R.invest * 100);

      const ci = ckAt[t + 1];
      if (ci >= 0) { ckPx[ci][i] = p; ckEq[ci][i] = eqNow / R.invest * 100; ckFilled[ci][i] = 1; }
    }

    const pEnd = p;
    if (eqNow > peak) peak = eqNow;
    if (eqNow - peak < minDd) minDd = eqNow - peak;

    for (let c = 0; c < ckIdx.length; c++) {
      if (!ckFilled[c][i]) { ckPx[c][i] = pEnd; ckEq[c][i] = eqNow / R.invest * 100; }
    }

    pnl[i] = wiped ? -R.invest : eqNow;
    endPx[i] = pEnd;
    maxDD[i] = (minDd / R.invest) * 100;
    if (nD >= 2) {
      const mu_ = sumR / nD;
      const varc = Math.max(0, sumR2 / nD - mu_ * mu_);
      const sd = Math.sqrt(varc);
      // winsorize ±10: dgn horizon pendek estimasi Sharpe sangat noisy
      sharpe[i] = sd > 1e-9 ? Math.max(-10, Math.min(10, (mu_ / sd) * Math.sqrt(365))) : 0;
    } else sharpe[i] = 0;

    if (keepPath) { samplePaths.push(keepPath); sampleEq.push(keepEq); }
  }

  const pct = Array.from(pnl, (x) => (x / R.invest) * 100).sort((a, b) => a - b);
  const px = Array.from(endPx).sort((a, b) => a - b);
  const ddArr = Array.from(maxDD).sort((a, b) => a - b);
  const shArr = Array.from(sharpe).sort((a, b) => a - b);
  const prob = (f) => pct.filter(f).length / pct.length;
  const targetPct = TARGET_RATE * 100;
  const mean = pct.reduce((a, b) => a + b, 0) / pct.length;

  const fan = ckIdx.map((t, c) => {
    const arr = Array.from(ckPx[c]).sort((a, b) => a - b);
    return { t, p5: quantile(arr, 0.05), p50: quantile(arr, 0.5), p95: quantile(arr, 0.95) };
  });
  const eqFan = ckIdx.map((t, c) => {
    const arr = Array.from(ckEq[c]).sort((a, b) => a - b);
    return { t, p5: quantile(arr, 0.05), p50: quantile(arr, 0.5), p95: quantile(arr, 0.95) };
  });

  const pTarget = prob((x) => x >= targetPct);
  const se = Math.sqrt(Math.max(1e-9, pTarget * (1 - pTarget) / N_SIM)) * 100;

  return {
    pct, samplePaths, sampleEq, mean, targetPct, fan, eqFan, nSteps: n,
    ddArr, shArr,
    median: quantile(pct, 0.5), p5: quantile(pct, 0.05), p95: quantile(pct, 0.95),
    ddP5: quantile(ddArr, 0.05), ddP50: quantile(ddArr, 0.5), ddP95: quantile(ddArr, 0.95),
    shP5: quantile(shArr, 0.05), shP50: quantile(shArr, 0.5), shP95: quantile(shArr, 0.95),
    pxP5: quantile(px, 0.05), pxP50: quantile(px, 0.5), pxP95: quantile(px, 0.95),
    pWin: prob((x) => x > 0),
    pTarget, se,
    p1: prob((x) => x >= 1),
    pLiq: liqCount / N_SIM, pSL: slCount / N_SIM,
  };
}

// ================================================================
// REPAIR BOT — futures grid yang sedang rugi
// ================================================================
function readRepairCfg(q) {
  const num = (id, d) => { const v = +$(id).value; return isFinite(v) ? v : d; };
  const dir = S.rpDir;
  const Q0 = Math.abs(num('rpQty', 234));
  const avg = num('rpAvg', 5.245);
  const P0 = num('rpPrice', 0) > 0 ? num('rpPrice', 0) : q.price;
  const low = num('rpLow', 4.9);
  const high = num('rpHigh', 5.75);
  const grids = Math.max(2, Math.round(num('rpGrids', 85)));
  const qty = Math.max(1e-9, num('rpQtyGrid', 3.6));
  const fee = Math.max(0, num('rpFee', 0.05)) / 100;
  const pnlNow = num('rpPnl', -55.83);
  const gridNow = num('rpGridProfit', 11.86);
  const invest = Math.max(1, num('rpInvest', 335.59));
  const avail = Math.max(0, num('rpAvail', 278.11));
  const liq0 = num('rpLiq', 6.16);
  const target = Math.max(1, num('rpTarget', 1));     // exit minimal +1 USDT
  const days = Math.min(60, Math.max(3, Math.round(num('rpDays', 30))));
  const fl0 = dir === 'short' ? Q0 * (avg - P0) : Q0 * (P0 - avg);
  const offset = pnlNow - gridNow - fl0;              // kalibrasi funding/akuntansi Pionex
  return { dir, Q0, avg, P0, low, high, grids, qty, fee, pnlNow, gridNow, invest, avail, liq0, target, days, fl0, offset };
}

function liqAfterAdd(c, add) {
  if (c.Q0 <= 0) return c.liq0;
  return c.dir === 'short'
    ? c.liq0 + add / (c.Q0 * (1 + MMR))
    : c.liq0 - add / (c.Q0 * (1 - MMR));
}

function simRepairScenario(c, H, add) {
  const n = c.days * 24, dt = 1 / 24;
  const step = (c.high - c.low) / c.grids;
  const liqP = liqAfterAdd(c, add);
  const short = c.dir === 'short';
  const nUnits = Math.max(1, Math.round(c.Q0 / c.qty));
  const levelOf = (p) => Math.min(c.grids, Math.max(0, Math.floor((p - c.low) / step)));

  const recHours = [];
  let liqN = 0;
  const endTotals = [];

  for (let i = 0; i < N_SIM_REPAIR; i++) {
    let p = c.P0;
    const u0 = _rand();
    let rg = u0 < H.piCum[0] ? 0 : u0 < H.piCum[1] ? 1 : 2;

    // stack posisi eksisting: semua unit di avg hold price
    const stack = new Array(nUnits).fill(c.avg);
    let level = levelOf(p);
    let gridCum = 0, done = false;

    for (let t = 0; t < n; t++) {
      const u = _rand();
      const cum = H.AhCum[rg];
      rg = u < cum[0] ? 0 : u < cum[1] ? 1 : 2;
      const sigH = H.sg[rg] * Math.sqrt(dt);
      let g = gauss();
      if (_rand() < 0.04) g *= 2.5;
      p = p * Math.exp((H.mu[rg] * dt - 0.5 * sigH * sigH) + sigH * g);

      // likuidasi?
      if ((short && p >= liqP) || (!short && p <= liqP)) { liqN++; done = true; break; }

      const nl = levelOf(p);
      if (nl !== level) {
        if (nl > level) {
          for (let L = level + 1; L <= nl; L++) {
            const px = c.low + L * step;
            if (short) {
              if (stack.length < c.grids) stack.push(px);            // buka short baru
            } else if (stack.length) {
              const e = stack.pop();                                  // tutup long (profit)
              gridCum += c.qty * (px - e) - c.fee * c.qty * (px + e);
            }
          }
        } else {
          for (let L = level; L > nl; L--) {
            const px = c.low + (L - 1) * step;
            if (short) {
              if (stack.length) {
                const e = stack.pop();                                // tutup short (profit)
                gridCum += c.qty * (e - px) - c.fee * c.qty * (px + e);
              }
            } else if (stack.length < c.grids) {
              stack.push(px);                                         // buka long baru
            }
          }
        }
        level = nl;
      }

      // total profit bot (mengikuti angka "Total Profit" Pionex)
      let fl = 0;
      for (const e of stack) fl += short ? c.qty * (e - p) : c.qty * (p - e);
      const total = c.gridNow + gridCum + fl + c.offset;
      if (total >= c.target) { recHours.push(t + 1); done = true; break; }
    }

    if (!done) {
      let fl = 0;
      for (const e of stack) fl += short ? c.qty * (e - p) : c.qty * (p - e);
      endTotals.push(c.gridNow + gridCum + fl + c.offset);
    }
  }

  recHours.sort((a, b) => a - b);
  endTotals.sort((a, b) => a - b);
  const pRec = recHours.length / N_SIM_REPAIR;
  return {
    add, liqP,
    pRec,
    pLiq: liqN / N_SIM_REPAIR,
    pRec7: recHours.filter((h) => h <= 7 * 24).length / N_SIM_REPAIR,
    d25: quantile(recHours, 0.25) / 24 || null,
    d50: quantile(recHours, 0.5) / 24 || null,
    d75: quantile(recHours, 0.75) / 24 || null,
    endMed: quantile(endTotals, 0.5),
  };
}

async function runRepair() {
  const btn = $('btnRepair');
  btn.disabled = true; btn.textContent = 'MENGAMBIL HARGA…';
  const q = await getQuote(S.coin);
  const c = readRepairCfg(q);
  btn.textContent = `SIMULASI 4 SKENARIO × ${N_SIM_REPAIR.toLocaleString()}…`;
  await new Promise((r) => setTimeout(r, 30));

  setSeed($('inSeed') ? $('inSeed').value : '');
  const vol = dailyVol(q);
  const H = buildHMM(q, vol);

  const adds = [...new Set([0, 0.25, 0.5, 1].map((f) => Math.round(c.avail * f)))];
  const rows = adds.map((a) => simRepairScenario(c, H, a));

  // rekomendasi: add terkecil dgn P(liq) ≤ 5% dan P(recover) ≥ 50%;
  // fallback: P(liq) ≤ 5%; fallback terakhir: skenario paling aman.
  let rec = rows.find((r) => r.pLiq <= 0.05 && r.pRec >= 0.5)
        || rows.find((r) => r.pLiq <= 0.05)
        || rows[rows.length - 1];

  renderRepair(c, rows, rec, q);
  btn.disabled = false; btn.textContent = 'Analisa Repair';
}

function renderRepair(c, rows, rec, q) {
  const dirLab = c.dir === 'short' ? 'Short' : 'Long';
  const fD = (d) => (d == null ? '>' + c.days : d.toFixed(1));
  let h = `<div class="bd" style="padding-bottom:6px">
    <div class="tag">POSISI SAAT INI — ${S.coin} FUTURES ${dirLab.toUpperCase()}${q.demo ? ' · HARGA DEMO' : ''}</div>
    <div style="font-size:12px; margin-top:4px">
      ${c.Q0} koin @ avg ${fmt(c.avg, 4)} · harga ${fmt(c.P0, 4)} · Total PnL <b class="${pctCls(c.pnlNow)}">${fmt(c.pnlNow, 2)} USDT</b> ·
      floating model ${fmt(c.fl0, 2)} · offset kalibrasi (funding dll) ${fmt(c.offset, 2)} USDT
    </div>
  </div>
  <div style="overflow-x:auto"><table class="rpt">
    <tr><th>Add (USDT)</th><th>Liq baru</th><th>P(liq)</th><th>P(recover ≤${c.days}h)</th><th>P(≤7 hari)</th><th>Median hari → +${fmt(c.target, 2)}</th><th>P25–P75 hari</th></tr>`;
  for (const r of rows) {
    const isRec = r === rec;
    h += `<tr class="${isRec ? 'rec' : ''}">
      <td><b>${fmt(r.add, 0)}</b>${isRec ? ' ★' : ''}</td>
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
    verdict = `<b>Rekomendasi: tambah ${fmt(rec.add, 0)} USDT.</b> Liq price bergeser ke ${fmt(rec.liqP, 4)}
      (${liqShiftPct.toFixed(1)}% dari harga sekarang), P(likuidasi ${c.days} hari) turun ke ${(rec.pLiq * 100).toFixed(1)}%,
      dan ${(rec.pRec * 100).toFixed(0)}% path mencapai exit +${fmt(c.target, 2)} USDT — median <b>${fD(rec.d50)} hari</b>
      (rentang tengah ${fD(rec.d25)}–${fD(rec.d75)} hari).`;
  } else if (rec.pLiq <= 0.05) {
    verdict = `<b>Rekomendasi: tambah ${fmt(rec.add, 0)} USDT untuk keamanan liq</b> (P(liq) ${(rec.pLiq * 100).toFixed(1)}%),
      tapi peluang recovery ke +${fmt(c.target, 2)} USDT dalam ${c.days} hari hanya ${(rec.pRec * 100).toFixed(0)}%
      — median total profit di akhir horizon ${rec.endMed == null ? '—' : fmt(rec.endMed, 2)} USDT.
      Pertimbangkan juga opsi cut loss / perlebar horizon.`;
  } else {
    verdict = `<b>⚠ Tidak ada skenario yang menekan P(likuidasi) ≤ 5%.</b> Bahkan dengan seluruh saldo,
      P(liq) masih ${(rec.pLiq * 100).toFixed(1)}%. Menambah investasi di sini berisiko "menambah uang ke posisi buruk" —
      pertimbangkan cut loss sebagian atau tutup bot.`;
  }
  h += `<div class="bd" style="font-size:12px">${verdict}</div>
  <div class="bd" style="padding-top:0; font-size:11px; color:var(--muted)">
    Asumsi model: (1) exit dilakukan tepat saat Total Profit menyentuh +${fmt(c.target, 2)} USDT;
    (2) selisih akuntansi Pionex (funding fee, dsb.) dianggap konstan sebesar offset kalibrasi — funding short/long ke depan tidak dimodelkan dinamis;
    (3) liq baru dihitung linear dari liq yang tertera: ΔLiq = Add ÷ (Qty × (1±mmr));
    (4) grid di luar range tidak membuka posisi baru. Semua angka = estimasi Monte Carlo (${N_SIM_REPAIR.toLocaleString()} path/skenario, HMM regime), bukan jaminan.
  </div>`;
  $('repairBody').innerHTML = h;
  $('repairBadge').textContent = `★ ADD ${fmt(rec.add, 0)} USDT`;
  $('repairBadge').className = 'badge ' + (rec.pLiq <= 0.05 ? 'live' : 'demo');
}

// ---------- render umum ----------
const fmt = (x, d = 4) => x == null ? '—' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const pctCls = (x) => (x >= 0 ? 'up' : 'dn');
const pctTxt = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%');

function renderMarket(q, vol) {
  $('mktPrice').innerHTML = '$' + fmt(q.price) + ' <small>' + S.coin + '/USDT · ' +
    (q.demo ? 'DEMO' : new Date(q.last_updated).toLocaleTimeString()) + '</small>';
  [['ch1', q.change_1h], ['ch24', q.change_24h], ['ch7', q.change_7d], ['ch30', q.change_30d]]
    .forEach(([id, v]) => { $(id).textContent = pctTxt(v); $(id).className = 'v ' + pctCls(v || 0); });
  $('volD').textContent = (vol * 100).toFixed(2) + '%';
  $('mktSrc').textContent = q.demo ? 'MODE DEMO — SET CMC_API_KEY' : 'COINMARKETCAP · ON-DEMAND';
  const b = $('modeBadge');
  b.className = 'badge ' + (q.demo ? 'demo' : 'live');
  b.textContent = q.demo ? '● DEMO' : '● LIVE';
}

function renderTrend(T, H, R, sim) {
  const lb = $('trLabel');
  lb.textContent = T.label;
  lb.className = 'v ' + T.cls;
  $('trDrift').textContent = pctTxt(T.slope * 100) + '/hari';
  $('trDrift').className = 'v ' + pctCls(T.slope);
  $('trR2').textContent = (T.r2 * 100).toFixed(0) + '%';

  const names = ['BULL', 'SIDE', 'BEAR'], clss = ['up', '', 'dn'];
  const bars = H.alpha.map((p, k) =>
    `<div><div class="k">P(${names[k]})</div><div class="v ${clss[k]}">${(p * 100).toFixed(0)}%</div>
     <div class="bar"><i style="width:${Math.min(100, p * 100)}%"></i></div></div>`).join('');
  $('hmmRow').innerHTML = bars;
  const dom = H.alpha.indexOf(Math.max(...H.alpha));
  $('hmmNote').textContent = R.useHMM
    ? `Filter HMM (forward algorithm pada 4 return CMC) → regime dominan saat ini: ${names[dom]} (${(H.alpha[dom] * 100).toFixed(0)}%). Simulasi menyampel regime awal dari distribusi ini dan regime boleh berpindah tiap jam.`
    : 'Mode GBM klasik aktif — posterior regime hanya ditampilkan sebagai referensi, simulasi memakai drift regresi trend.';

  $('trPred').innerHTML =
    `Prediksi H+${R.days} (${R.useHMM ? 'HMM regime-switching' : 'GBM'}, ${N_SIM.toLocaleString()} simulasi): ` +
    `<b>P50 $${fmt(sim.pxP50)}</b> · band 90% $${fmt(sim.pxP5)} – $${fmt(sim.pxP95)}`;

  let note = '';
  if (T.label === 'SIDEWAYS') note = '✓ Kondisi ideal untuk grid — harga bolak-balik di dalam range menghasilkan siklus profit.';
  else if (T.label === 'UPTREND') note = 'Trend naik: grid spot tetap oke, sebagian profit datang dari apresiasi harga. Range sudah digeser sedikit ke atas mengikuti drift.';
  else note = '⚠ Trend turun: grid spot rawan floating loss (beli terus saat harga turun). Pertimbangkan tunggu sideways, kecilkan investasi, atau disiplinkan stop loss.';
  $('trNote').textContent = note;

  drawSpark(T);
}

function frow(label, sub, value, copyVal) {
  const cp = copyVal == null ? '' :
    `<button class="cp" data-cp="${copyVal}">salin</button>`;
  return `<div class="frow"><div class="fk">${label}<s>${sub || ''}</s></div>
          <div class="fv"><b>${value}</b>${cp}</div></div>`;
}

function renderReco(R, sim) {
  const dirLabel = R.fut ? { long: 'Long', short: 'Short', neutral: 'Neutral' }[R.dir] : 'Spot (Neutral)';
  $('recoTitle').textContent = `Rekomendasi ${S.coin}/USDT — ${R.fut ? 'Futures Grid' : 'Grid Trading'} · ${dirLabel}`;

  const conf = sim.pTarget * 100;
  $('recoBadge').textContent = `CONFIDENCE ${conf.toFixed(0)}% ±${sim.se.toFixed(1)}`;
  $('recoBadge').className = 'badge ' + (conf >= 55 ? 'live' : 'demo');

  let h = '';
  if (R.fut) h += frow('Arah', 'pilih tab di Pionex', dirLabel);
  h += frow('1. Price Range', 'Lowest price USDT', fmt(R.low), fmt(R.low));
  h += frow('', 'Highest Price USDT', fmt(R.high), fmt(R.high));
  if (!R.fut && R.points != null) {
    h += frow('2. Quantity of Grids',
      `${R.points} point ÷ ${R.divisor} + 1${R.feeAdjusted ? ' · dikurangi agar profit/grid > fee' : ''}`,
      R.grids, R.grids);
  } else {
    h += frow('2. Quantity of Grids', 'Profit/grid net ≈ ' + (R.profitPerGridNet * 100).toFixed(2) + '%', R.grids, R.grids);
  }
  h += frow('Profit / grid (net)', 'setelah fee 2 sisi', (R.profitPerGridNet * 100).toFixed(3) + '%');
  h += frow('3. Investment', R.fut ? 'margin USDT' : 'total USDT', fmt(R.invest, 2), fmt(R.invest, 2));
  h += frow('Target profit', (TARGET_RATE * 100).toFixed(2) + '% dari investasi', fmt(R.targetUsd, 2) + ' USDT');
  if (R.fut) h += frow('Leverage', 'dropdown ' + R.lev + 'x', R.lev + 'x');
  h += frow('Trigger price', 'opsional', R.trigger ? fmt(R.trigger) : '— (kosongkan)', R.trigger ? fmt(R.trigger) : null);
  h += frow('Take Profit', 'stop by price', fmt(R.tp), fmt(R.tp));
  h += frow('Stop Loss', 'stop by price', fmt(R.sl), fmt(R.sl));
  h += frow('Grid mode', 'pilih', 'Arithmetic');
  if (R.liq) h += frow('Est. liq price', 'pembanding — jaga SL sebelum liq', fmt(R.liq));
  h += frow('Confidence', `${N_SIM.toLocaleString()} sim (${R.useHMM ? 'HMM' : 'GBM'}) · % path dgn PnL ≥ ${fmt(R.targetUsd, 2)} USDT`,
    conf.toFixed(1) + '% ± ' + sim.se.toFixed(1) + '%');
  $('recoBody').innerHTML = h;

  $('recoBody').querySelectorAll('.cp').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.cp.replace(/,/g, ''));
      b.textContent = '✓'; setTimeout(() => (b.textContent = 'salin'), 900);
    }));
}

function renderStats(R, sim) {
  const tUsd = fmt(R.targetUsd, 2);
  const cell = (k, v, cls = '', barPct = null) =>
    `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div>${
      barPct == null ? '' : `<div class="bar"><i style="width:${Math.min(100, barPct)}%"></i></div>`}</div>`;
  $('simStats').innerHTML =
    cell(`P(≥ target ${tUsd} USDT)`, (sim.pTarget * 100).toFixed(1) + '% ±' + sim.se.toFixed(1), sim.pTarget >= 0.55 ? 'up' : '', sim.pTarget * 100) +
    cell('P(PnL > 0)', (sim.pWin * 100).toFixed(1) + '%', sim.pWin >= 0.5 ? 'up' : 'dn', sim.pWin * 100) +
    cell('P(profit ≥ +1%)', (sim.p1 * 100).toFixed(1) + '%', '', sim.p1 * 100) +
    cell('Median PnL', pctTxt(sim.median) + ' (' + fmt(sim.median * R.invest / 100, 2) + ' USDT)', pctCls(sim.median)) +
    cell('Rata-rata / P5 / P95', pctTxt(sim.mean) + ' · ' + pctTxt(sim.p5) + ' / ' + pctTxt(sim.p95)) +
    cell(R.liq ? 'P(likuidasi) / P(SL)' : 'P(stop loss)',
         (R.liq ? (sim.pLiq * 100).toFixed(1) + '% / ' : '') + (sim.pSL * 100).toFixed(1) + '%',
         (sim.pLiq + sim.pSL) > 0.2 ? 'dn' : '');
  $('simMeta').textContent =
    `MONTE CARLO · ${R.useHMM ? 'HMM 3-REGIME' : 'GBM'} · ${N_SIM.toLocaleString()} PATH · ANTITHETIC · FAT-TAIL · ${R.days} HARI · σ ${(R.vol * 100).toFixed(2)}%/HARI`;
}

// ---------- summary persentil + interpretasi otomatis ----------
function renderMcSummary(R, sim) {
  const row = (m, p5, p50, p95, fmtFn) =>
    `<tr><td>${m}</td><td class="${pctCls(p5)}">${fmtFn(p5)}</td><td class="${pctCls(p50)}">${fmtFn(p50)}</td><td class="${pctCls(p95)}">${fmtFn(p95)}</td></tr>`;
  $('mcSummary').innerHTML =
    `<table class="rpt">
      <tr><th>Metric</th><th>P5 (buruk)</th><th>P50 (median)</th><th>P95 (bagus)</th></tr>
      ${row('Total Return', sim.p5, sim.median, sim.p95, pctTxt)}
      ${row('Max Drawdown', sim.ddP5, sim.ddP50, sim.ddP95, pctTxt)}
      ${row('Sharpe Ratio', sim.shP5, sim.shP50, sim.shP95, (x) => x.toFixed(2))}
    </table>`;

  // ---- interpretasi dalam bahasa manusia
  const usd = (p) => fmt(p * R.invest / 100, 2);
  const shTxt = sim.shP50 >= 2 ? 'sangat baik (return jauh melebihi guncangannya)'
    : sim.shP50 >= 1 ? 'baik (return sepadan dengan risikonya)'
    : sim.shP50 >= 0 ? 'lemah (return kecil dibanding naik-turunnya equity)'
    : 'negatif (strategi ini di median justru rugi terhadap risikonya)';
  const skew = sim.mean < sim.median
    ? 'Rata-rata < median → distribusi punya ekor kiri: sebagian kecil skenario rugi besar menyeret rata-rata turun. Jangan hanya lihat median.'
    : 'Rata-rata ≥ median → tidak ada ekor rugi ekstrem yang dominan pada horizon ini.';
  const riskTail = (sim.pLiq + sim.pSL) > 0.2
    ? `⚠ ${((sim.pLiq + sim.pSL) * 100).toFixed(0)}% path berakhir kena SL/likuidasi — range/SL terlalu sempit atau leverage terlalu besar untuk volatilitas saat ini.`
    : `Path yang mati karena SL/likuidasi hanya ${((sim.pLiq + sim.pSL) * 100).toFixed(1)}% — setting cukup lega untuk σ ${(R.vol * 100).toFixed(1)}%/hari.`;

  $('mcInterp').innerHTML =
    `<b>Cara membaca hasil di atas.</b>
     Dari ${N_SIM.toLocaleString()} kemungkinan jalan harga selama ${R.days} hari:
     skenario tengah (P50) menghasilkan <b>${pctTxt(sim.median)}</b> (≈ ${usd(sim.median)} USDT dari modal ${fmt(R.invest, 2)}),
     5% skenario terburuk berakhir ≤ <b>${pctTxt(sim.p5)}</b> (≈ ${usd(sim.p5)} USDT), dan 5% terbaik ≥ <b>${pctTxt(sim.p95)}</b>.
     Max drawdown median <b>${pctTxt(sim.ddP50)}</b> artinya di tengah perjalanan equity biasanya sempat turun sedalam itu dari puncaknya
     — siapkan mental (dan margin) untuk itu, bukan hanya untuk angka akhirnya. Di 5% skenario terburuk, drawdown mencapai ${pctTxt(sim.ddP5)}.
     Sharpe median ${sim.shP50.toFixed(2)} = ${shTxt}. ${skew} ${riskTail}
     Peluang mencapai target ${fmt(R.targetUsd, 2)} USDT: <b>${(sim.pTarget * 100).toFixed(1)}% ± ${sim.se.toFixed(1)}%</b> —
     angka ± adalah noise simulasi; dua run dengan hasil beda dalam rentang itu sama saja.`;
}

// ---------- charts ----------
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

function drawSpark(T) {
  const cv = $('cvSpark'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 14, padR = 70, padT = 14, padB = 22;
  const ps = T.pts.map((o) => o.p);
  const mn = Math.min(...ps), mx = Math.max(...ps), span = (mx - mn) || 1;
  const X = (i) => padL + (i / (ps.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / span) * (H - padT - padB);

  ctx.strokeStyle = css(T.cls === 'dn' ? '--red' : T.cls === 'up' ? '--green' : '--ink');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ps.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(0), Y(v))));
  ctx.stroke();

  ctx.font = '9px ui-monospace';
  T.pts.forEach((o, i) => {
    ctx.beginPath(); ctx.arc(X(i), Y(o.p), 3, 0, Math.PI * 2);
    ctx.fillStyle = css('--ink'); ctx.fill();
    ctx.fillStyle = css('--muted');
    ctx.fillText(o.lab, X(i) - 10, H - 6);
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
  const X = (i, n) => padL + (i / (n - 1)) * (W - padL - padR);
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
  if (R.liq) {
    ctx.strokeStyle = css('--red'); ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(padL, Y(R.liq)); ctx.lineTo(W - padR, Y(R.liq)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css('--red');
    ctx.fillText('LIQ ' + fmt(R.liq), 4, Y(R.liq) + 3);
  }

  ctx.globalAlpha = 0.18; ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1;
  paths.forEach((p) => {
    ctx.beginPath(); p.forEach((v, i) => (i ? ctx.lineTo(X(i, p.length), Y(v)) : ctx.moveTo(X(0, p.length), Y(v))));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  const amber = css('--amber');
  const fanLine = (key, dash, lab) => {
    ctx.strokeStyle = amber; ctx.lineWidth = 1.4; ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(X(0, sim.nSteps + 1), Y(R.P));
    sim.fan.forEach((f) => ctx.lineTo(X(f.t, sim.nSteps + 1), Y(f[key])));
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

// ---------- equity curve fan (ala referensi MC stress test) ----------
function drawEquityFan(R, sim) {
  const cv = $('cvEquity'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 56, padR = 86, padT = 12, padB = 20;
  let mn = 0, mx = 0;
  sim.eqFan.forEach((f) => { mn = Math.min(mn, f.p5); mx = Math.max(mx, f.p95); });
  sim.sampleEq.forEach((p) => p.forEach((v) => { if (v < mn) mn = v; if (v > mx) mx = v; }));
  const span = (mx - mn) || 1; mn -= span * 0.06; mx += span * 0.06;
  const X = (t) => padL + (t / sim.nSteps) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);

  // grid garis 0% & target
  [[0, css('--line'), '0%'], [sim.targetPct, css('--green'), 'TARGET']].forEach(([v, col, lab]) => {
    if (v < mn || v > mx) return;
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--muted'); ctx.font = '9px ui-monospace';
    ctx.fillText(lab, 6, Y(v) + 3);
  });

  // sample equity paths (translucent)
  ctx.globalAlpha = 0.16; ctx.lineWidth = 1; ctx.strokeStyle = css('--ink');
  sim.sampleEq.forEach((p) => {
    ctx.beginPath();
    p.forEach((v, i) => (i ? ctx.lineTo(X(i * sim.nSteps / (p.length - 1)), Y(v)) : ctx.moveTo(X(0), Y(v))));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // garis persentil empiris
  const perc = [
    ['p95', css('--green'), 'P95'],
    ['p50', css('--ink'),   'P50'],
    ['p5',  css('--red'),   'P5'],
  ];
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

  // sumbu waktu
  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  for (let d = 0; d <= R.days; d += Math.max(1, Math.round(R.days / 6))) {
    ctx.fillText('H' + d, X(d * 24) - 6, H - 6);
  }
  ctx.fillText('EQUITY % MODAL — DISTRIBUSI ' + N_SIM.toLocaleString() + ' PATH', padL, padT - 2);
}

// ---------- 3 histogram: Total Return / Max Drawdown / Sharpe ----------
function drawHist3(sim) {
  const cv = $('cvHist3'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, gap = 22;
  const pw = (W - 2 * gap) / 3;

  const panel = (x0, dataSorted, color, title, markers, fmtFn) => {
    const padL = 6, padR = 6, padT = 16, padB = 26;
    const lo = quantile(dataSorted, 0.005), hi = quantile(dataSorted, 0.995);
    const span = (hi - lo) || 1;
    const bins = 31, bw = span / bins, cnt = new Array(bins).fill(0);
    dataSorted.forEach((v) => {
      const b = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / bw)));
      cnt[b]++;
    });
    const mxC = Math.max(...cnt);
    const X = (v) => x0 + padL + ((v - lo) / span) * (pw - padL - padR);
    for (let i = 0; i < bins; i++) {
      const h = (cnt[i] / mxC) * (H - padT - padB);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x0 + padL + (i / bins) * (pw - padL - padR) + 1, H - padB - h, (pw - padL - padR) / bins - 2, h);
    }
    ctx.globalAlpha = 1;
    // marker P5/P50/P95
    markers.forEach(([p, lab]) => {
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
    const med = fmtFn(quantile(dataSorted, 0.5));
    ctx.fillText('med ' + med, x0 + pw / 2 - ctx.measureText('med ' + med).width / 2, H - 2);
  };

  const mk = [[0.05], [0.5], [0.95]];
  panel(0,               sim.pct,   css('--green'), 'TOTAL RETURN %', mk, (v) => v.toFixed(1) + '%');
  panel(pw + gap,        sim.ddArr, '#3D6ECC',      'MAX DRAWDOWN %', mk, (v) => v.toFixed(1) + '%');
  panel(2 * (pw + gap),  sim.shArr, '#7A4FA3',      'SHARPE RATIO',   mk, (v) => v.toFixed(2));
}

// ---------- main ----------
$('btnGo').addEventListener('click', async () => {
  const btn = $('btnGo');
  btn.disabled = true; btn.textContent = 'MENGAMBIL HARGA…';
  const q = await getQuote(S.coin);
  btn.textContent = `MENJALANKAN ${N_SIM.toLocaleString()} SIMULASI (${S.model.toUpperCase()})…`;
  await new Promise((r) => setTimeout(r, 30));

  const vol = dailyVol(q);
  const T = buildTrend(q, vol);
  const H = buildHMM(q, vol);
  const R = buildReco(q, T, H);
  renderMarket(q, R.vol);
  const sim = simulate(R, H);
  renderTrend(T, H, R, sim);
  renderReco(R, sim);
  renderStats(R, sim);
  drawPaths(R, sim);
  drawEquityFan(R, sim);
  drawHist3(sim);
  renderMcSummary(R, sim);

  btn.disabled = false; btn.textContent = 'Minta Rekomendasi';
});

$('btnRepair').addEventListener('click', runRepair);
