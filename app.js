/* GRIDFISH — Pionex Grid Advisor (LINK/SOL/ETH/INJ)
   - Harga: /api/quotes (proxy CoinMarketCap, on-demand saja)
   - Grid Spot mengikuti ATURAN CUSTOM:
       * Target profit = 0.3% dari investasi (0.15 USDT per 50 USDT)
       * Jumlah grid  = (range dalam "point" ÷ pembagi) + 1
         - point LINK (harga < 10)  = 0.01  → range 7.6–8.1 = 50 point → 50/2+1 = 26 grid
         - pembagi: harga <10 → 2, 10–20 → 3, 20–30 → 4, dst (+1 tiap kelipatan 10)
         - SOL/ETH: satuan point diskalakan mengikuti orde harga (SOL ≈ 0.1, ETH ≈ 1)
           INJ (harga belasan USD) memakai point 0.01 seperti LINK — semua otomatis
           lewat pointScale().
   - Confidence = % dari 5.000 simulasi Monte Carlo yang PnL-nya ≥ target
     (± margin error binomial ditampilkan supaya jujur soal noise simulasi)

   ===== MESIN SIMULASI v2 =====
   1. HMM 3-REGIME (default): Bull / Sideways / Bear.
      - Emisi Gaussian per regime (drift & vol berbeda), transisi Markov persisten.
      - Filter forward dijalankan pada 4 log-return CMC (30d→7d, 7d→24h, 24h→1h,
        1h→now) → probabilitas regime SAAT INI (bukan tebakan, tapi inferensi Bayes).
      - Tiap path Monte Carlo menyampel regime awal dari posterior itu, lalu
        regime boleh berpindah tiap jam mengikuti matriks transisi → volatilitas
        clustering & perubahan trend tersimulasi, bukan GBM lurus.
   2. GBM klasik tetap tersedia (toggle) sebagai pembanding.
   3. Fat tails: 4% shock diambil dari distribusi 2.5σ (proksi jump/berita).
   4. Antithetic variates: path berpasangan (+g / −g) → error Monte Carlo turun
      tanpa menambah jumlah simulasi.
   5. Grid engine pakai STACK ENTRY PRICE per posisi → floating PnL dihitung dari
      entry sebenarnya, bukan aproksimasi "tengah zona". Spot dimodelkan seperti
      Pionex asli: beli inventori awal di harga pasar untuk order jual di atas.
   6. Fan chart P5/P50/P95 sekarang EMPIRIS dari 5.000 path (checkpoint per ~6 jam),
      jadi konsisten dengan model apa pun yang dipilih.

   Model aproksimasi — bukan jaminan profit. */

'use strict';

// ---------- state ----------
const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm' };
const N_SIM = 5000;
const TARGET_RATE = 0.003; // 0.15 USDT per 50 USDT investasi
const $ = (id) => document.getElementById(id);

// harga fallback bila API key belum di-set (mode demo)
const DEMO = {
  LINK: { price: 7.83,   change_1h: -0.3, change_24h: -2.1, change_7d: -5.4, change_30d: 4.2 },
  SOL:  { price: 145.2,  change_1h: 0.2,  change_24h: 1.8,  change_7d: -3.9, change_30d: 9.5 },
  ETH:  { price: 3412.5, change_1h: 0.1,  change_24h: 0.9,  change_7d: 2.7,  change_30d: 6.1 },
  INJ:  { price: 13.42,  change_1h: 0.4,  change_24h: -1.2, change_7d: 3.8,  change_30d: -6.5 },
};

// ---------- segmented controls ----------
function seg(id, key, onChange) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$(id).querySelectorAll('button')].forEach((x) => x.classList.remove('on', 'long', 'short'));
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

// jam header
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

// ---------- estimasi volatilitas harian dari % change ----------
function dailyVol(q) {
  const c = [
    Math.abs(q.change_24h || 0),
    Math.abs(q.change_7d || 0) / Math.sqrt(7),
    Math.abs(q.change_30d || 0) / Math.sqrt(30),
    Math.abs(q.change_1h || 0) * Math.sqrt(24),
  ].map((x) => x / 100);
  const ms = c.reduce((a, b) => a + b * b, 0) / c.length;
  let vol = Math.sqrt(ms) * 1.15; // buffer 15%
  return Math.min(0.12, Math.max(0.02, vol)); // clamp 2%–12% per hari
}

// ---------- ATURAN GRID CUSTOM ----------
// Satuan "point": LINK (harga < 10) → 0.01 sesuai definisi user.
// Koin berharga besar diskalakan mengikuti orde harga agar step grid tetap
// ±0.15–0.3% dari harga (SOL ~145 → 0.1; ETH ~3400 → 1; INJ ~13 → 0.01).
function pointScale(P) {
  const exp = Math.max(0, Math.floor(Math.log10(P)) - 1);
  const scale = Math.pow(10, exp);           // LINK/INJ: 1, SOL: 10, ETH: 100
  return { scale, point: 0.01 * scale };     // LINK/INJ: 0.01, SOL: 0.1, ETH: 1
}
// Pembagi: harga (ternormalisasi ke skala LINK) <10 → 2, 10–20 → 3, 20–30 → 4, dst.
function gridDivisor(P) {
  const { scale } = pointScale(P);
  return Math.max(2, Math.floor(P / scale / 10) + 2);
}

// ---------- ANALISA TREND SERIES (regresi — tetap dipakai utk label & sparkline) ----------
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
  const slope = sxy / sxx;                                   // drift ln-price per hari
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;        // kekuatan trend 0..1

  // drift GBM klasik: bobot R², diredam 50%, dibatasi ±0.5σ
  const muSim = Math.max(-0.5 * vol, Math.min(0.5 * vol, slope * 0.5 * r2));

  let label = 'SIDEWAYS', cls = '';
  if (slope > 0.3 * vol && r2 > 0.3) { label = 'UPTREND'; cls = 'up'; }
  else if (slope < -0.3 * vol && r2 > 0.3) { label = 'DOWNTREND'; cls = 'dn'; }
  return { pts, slope, r2, muSim, label, cls };
}

// ---------- HMM 3-REGIME ----------
// State 0 = BULL, 1 = SIDEWAYS, 2 = BEAR.
// Parameter drift/vol diskalakan dari σ harian koin — jadi otomatis beradaptasi
// per koin tanpa perlu data historis panjang.
function buildHMM(q, vol) {
  const mu = [ +0.9 * vol, 0, -0.9 * vol ];       // drift/hari per regime
  const sg = [ 1.0 * vol, 0.75 * vol, 1.30 * vol ]; // σ/hari per regime (bear paling liar)
  // matriks transisi PER HARI (persisten: regime crypto bertahan berhari-hari)
  const A = [
    [0.88, 0.10, 0.02],
    [0.08, 0.84, 0.08],
    [0.02, 0.10, 0.88],
  ];

  // ---- observasi: 4 log-return antar snapshot CMC, dgn panjang interval berbeda
  const P = q.price;
  const p30 = P / (1 + (q.change_30d || 0) / 100);
  const p7  = P / (1 + (q.change_7d  || 0) / 100);
  const p1  = P / (1 + (q.change_24h || 0) / 100);
  const ph  = P / (1 + (q.change_1h  || 0) / 100);
  const obs = [
    { r: Math.log(p7 / p30), L: 23 },        // 30d → 7d
    { r: Math.log(p1 / p7),  L: 6 },         // 7d  → 24h
    { r: Math.log(ph / p1),  L: 23 / 24 },   // 24h → 1h
    { r: Math.log(P / ph),   L: 1 / 24 },    // 1h  → now
  ];

  // ---- alat matriks kecil
  const matMul = (X, Y) => X.map((row) =>
    Y[0].map((_, j) => row.reduce((s, v, k) => s + v * Y[k][j], 0)));
  const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // A^L: bagian bulat dgn perkalian berulang, sisa pecahan dgn interpolasi linier
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

  // emisi: return interval L hari di regime k ~ N(mu_k·L, sg_k²·L)
  const emis = (r, L, k) => {
    const v = sg[k] * sg[k] * L;
    return Math.exp(-((r - mu[k] * L) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
  };

  // ---- forward filter → posterior regime saat ini
  let alpha = [1 / 3, 1 / 3, 1 / 3];
  for (const o of obs) {
    const T = matPow(o.L);
    const pred = [0, 1, 2].map((j) => alpha[0] * T[0][j] + alpha[1] * T[1][j] + alpha[2] * T[2][j]);
    let upd = pred.map((p, k) => p * emis(o.r, o.L, k));
    const Z = upd[0] + upd[1] + upd[2];
    alpha = Z > 0 ? upd.map((x) => x / Z) : [1 / 3, 1 / 3, 1 / 3];
  }

  // matriks transisi per-JAM utk simulasi (aproksimasi generator)
  const dt = 1 / 24;
  const Ah = A.map((row, i) => row.map((v, j) => (i === j ? 1 + dt * (v - 1) : dt * v)));
  // kumulatif utk sampling cepat
  const AhCum = Ah.map((row) => [row[0], row[0] + row[1], 1]);
  const piCum = [alpha[0], alpha[0] + alpha[1], 1];

  // drift efektif (utk geser range & label): E[mu] posterior, diredam 60%
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
  const z = 1.28; // ~80% containment

  // drift utk penggeseran range & fan: HMM → E[mu] posterior; GBM → regresi trend
  const mu = useHMM ? H.muEff : T.muSim;
  const centerShift = Math.exp(mu * days * 0.5);

  // range menurut arah
  let lowM = z, highM = z;
  if (dir === 'long') { lowM = 1.25 * z; highM = 0.85 * z; }
  if (dir === 'short') { lowM = 0.85 * z; highM = 1.25 * z; }
  let low = P * centerShift * (1 - lowM * horizonVol);
  let high = P * centerShift * (1 + highM * horizonVol);

  // ---- jumlah grid ----
  const { point } = pointScale(P);
  const divisor = gridDivisor(P);
  let grids, points = null, feeAdjusted = false;

  // bulatkan range ke kelipatan point supaya hitungan point bulat & rapi
  low = Math.round(low / point) * point;
  high = Math.round(high / point) * point;

  if (!fut) {
    // ATURAN CUSTOM (Grid Spot): grid = point/pembagi + 1
    points = Math.round((high - low) / point);
    grids = Math.round(points / divisor) + 1;
    // pengaman fee: pastikan profit per grid tetap positif setelah 2× fee (+buffer 0.05%)
    const minStepPct = 2 * fee + 0.0005;
    const maxGrids = Math.max(2, Math.floor((high - low) / (P * minStepPct)));
    if (grids > maxGrids) { grids = maxGrids; feeAdjusted = true; }
    grids = Math.min(200, Math.max(2, grids));
  } else {
    // Futures: tetap pakai target profit bersih per grid ~0.35%
    const netPerGrid = 0.0035;
    const grossStepPct = netPerGrid + 2 * fee;
    grids = Math.round((high - low) / (P * grossStepPct));
    grids = Math.min(200, Math.max(6, grids));
  }

  const step = (high - low) / grids;
  const profitPerGridNet = step / P - 2 * fee; // % dari modal per-grid

  // target profit: 0.3% dari investasi (0.15 USDT per 50 USDT)
  const targetUsd = invest * TARGET_RATE;

  // trigger, TP, SL, liq
  const trigger = dir === 'long' ? P * 0.998 : dir === 'short' ? P * 1.002 : null;
  const sl = dir === 'short' ? high * 1.02 : low * 0.98;
  const tp = dir === 'short' ? low : high;
  const mmr = 0.005;
  const liq = !fut || dir === 'neutral' ? null
    : dir === 'long' ? P * (1 - (1 - mmr) / lev)
    : P * (1 + (1 - mmr) / lev);

  return {
    P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step,
    profitPerGridNet, trigger, sl, tp, liq,
    point, divisor, points, feeAdjusted, targetUsd, mu, useHMM,
  };
}

// ---------- RNG ----------
let gaussSpare = null;
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  gaussSpare = v * m; return u * m;
}

// ---------- Monte Carlo 5.000 path (HMM regime-switching / GBM) ----------
function simulate(R, H) {
  const stepsPerDay = 24, n = Math.round(R.days * stepsPerDay), dt = 1 / stepsPerDay;
  const useHMM = R.useHMM;

  const notional = R.invest * R.lev;
  const perGridCap = notional / R.grids;

  const pnl = new Float64Array(N_SIM);
  const endPx = new Float64Array(N_SIM);
  let liqCount = 0, slCount = 0;
  const samplePaths = [];

  // checkpoint utk fan chart empiris (per ~6 jam)
  const ckEvery = Math.max(1, Math.round(n / 28));
  const ckIdx = [];
  for (let t = ckEvery; t <= n; t += ckEvery) ckIdx.push(t);
  if (ckIdx[ckIdx.length - 1] !== n) ckIdx.push(n);
  const ckPx = ckIdx.map(() => new Float64Array(N_SIM));
  const ckAt = new Int16Array(n + 2).fill(-1);
  ckIdx.forEach((t, c) => { ckAt[t] = c; });

  // buffer antithetic: path ganjil memakai regime & |shock| path genap dgn tanda dibalik
  const gBuf = new Float64Array(n);
  const rgBuf = new Int8Array(n);

  // level harga grid: idx 0..grids → low + idx*step
  const levelOf = (p) => Math.min(R.grids, Math.max(0, Math.floor((p - R.low) / R.step)));

  for (let i = 0; i < N_SIM; i++) {
    const anti = (i & 1) === 1; // path antithetic (pasangan path genap sebelumnya)
    let p = R.P;

    // ---- regime awal (HMM): sampel dari posterior filter (pasangan reuse jalur regime)
    let rg = 1;
    if (useHMM && !anti) {
      const u = Math.random();
      rg = u < H.piCum[0] ? 0 : u < H.piCum[1] ? 1 : 2;
    }

    // ---- inventori sebagai stack harga entry
    // Spot (Pionex): beli inventori awal di harga pasar utk order jual di atas.
    // Futures long: idem (posisi long utk sell order di atas).
    // Futures short: buka short di harga pasar utk buy-back order di bawah.
    // Futures neutral: mulai kosong — long dibuka saat harga turun, short saat naik.
    const longs = [], shorts = [];
    let level = levelOf(p);
    if (!R.fut || R.dir === 'long') {
      const above = R.grids - level;
      for (let k = 0; k < above; k++) longs.push(R.P);
    } else if (R.dir === 'short') {
      for (let k = 0; k < level; k++) shorts.push(R.P);
    }
    const centerLevel = level; // utk neutral

    let realized = 0, dead = false, wiped = false, deadPx = 0;
    const keepPath = i < 60 ? [p] : null;

    for (let t = 0; t < n; t++) {
      // ---- regime transition per jam (anti reuse jalur regime pasangannya)
      let sigD = R.vol, muD = R.mu;
      if (useHMM) {
        if (!anti) {
          const u = Math.random();
          const cum = H.AhCum[rg];
          rg = u < cum[0] ? 0 : u < cum[1] ? 1 : 2;
          rgBuf[t] = rg;
        } else {
          rg = rgBuf[t];
        }
        sigD = H.sg[rg]; muD = H.mu[rg];
      }
      const sigH = sigD * Math.sqrt(dt);

      // ---- shock: antithetic (+g / −g) + fat tails (4% shock dari 2.5σ)
      let g;
      if (!anti) {
        g = gauss();
        if (Math.random() < 0.04) g *= 2.5;
        gBuf[t] = g;
      } else {
        g = -gBuf[t];
      }

      p = p * Math.exp((muD * dt - 0.5 * sigH * sigH) + sigH * g);
      if (keepPath) keepPath.push(p);

      // liq / SL menghentikan path
      if (R.liq && ((R.dir === 'long' && p <= R.liq) || (R.dir === 'short' && p >= R.liq))) {
        realized = -R.invest; dead = true; wiped = true; deadPx = p; liqCount++; break;
      }
      if ((R.dir !== 'short' && p <= R.sl) || (R.dir === 'short' && p >= R.sl)) {
        dead = true; deadPx = p; slCount++; break;
      }

      const nl = levelOf(p);
      if (nl !== level) {
        if (nl > level) {
          // harga naik melewati grid: jual long (realisasi) / buka short (neutral & short)
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
          // harga turun melewati grid: beli long / tutup short (realisasi)
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

      // checkpoint fan chart
      const ci = ckAt[t + 1];
      if (ci >= 0) ckPx[ci][i] = p;
    }

    const pEnd = dead ? deadPx : p;
    // isi checkpoint kosong (path berhenti krn SL/liq) dgn harga akhirnya
    for (let c = 0; c < ckIdx.length; c++) if (ckPx[c][i] === 0) ckPx[c][i] = pEnd;

    // ---- floating PnL dari stack entry sebenarnya
    let float_ = 0;
    if (!wiped) {
      for (const e of longs) float_ += perGridCap * (pEnd - e) / e;
      for (const e of shorts) float_ += perGridCap * (e - pEnd) / e;
      float_ = Math.max(float_, -R.invest - realized);
    }

    pnl[i] = wiped ? -R.invest : realized + float_;
    endPx[i] = pEnd;
    if (keepPath) samplePaths.push(keepPath);
  }

  const pct = Array.from(pnl, (x) => (x / R.invest) * 100).sort((a, b) => a - b);
  const px = Array.from(endPx).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const prob = (f) => pct.filter(f).length / pct.length;
  const targetPct = TARGET_RATE * 100;
  const mean = pct.reduce((a, b) => a + b, 0) / pct.length;

  // fan chart empiris
  const fan = ckIdx.map((t, c) => {
    const arr = Array.from(ckPx[c]).sort((a, b) => a - b);
    return { t, p5: q(arr, 0.05), p50: q(arr, 0.5), p95: q(arr, 0.95) };
  });

  const pTarget = prob((x) => x >= targetPct);
  const se = Math.sqrt(Math.max(1e-9, pTarget * (1 - pTarget) / N_SIM)) * 100; // margin error binomial

  return {
    pct, samplePaths, mean, targetPct, fan, nSteps: n,
    median: q(pct, 0.5), p5: q(pct, 0.05), p95: q(pct, 0.95),
    pxP5: q(px, 0.05), pxP50: q(px, 0.5), pxP95: q(px, 0.95),
    pWin: prob((x) => x > 0),
    pTarget, se,                              // ← CONFIDENCE ± SE
    p1: prob((x) => x >= 1),
    pLiq: liqCount / N_SIM, pSL: slCount / N_SIM,
  };
}

// ---------- render ----------
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

  // ---- regime posterior HMM
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

  // CONFIDENCE = % simulasi yang mencapai target (≥ 0.3% dari investasi) ± SE
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

// ---------- charts (canvas, tanpa library) ----------
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
    ctx.beginPath(); ctx.arc(X(i), Y(o.p), 3, 0, 7);
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

  // zona grid
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

  // 60 sample path
  ctx.globalAlpha = 0.18; ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1;
  paths.forEach((p) => {
    ctx.beginPath(); p.forEach((v, i) => (i ? ctx.lineTo(X(i, p.length), Y(v)) : ctx.moveTo(X(0, p.length), Y(v))));
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // FAN PREDIKSI EMPIRIS: kuantil dari 5.000 path (bukan rumus GBM)
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
  ctx.fillText('60 SAMPLE PATH DARI ' + N_SIM.toLocaleString() + ' — HIJAU = RANGE GRID · ORANYE = FAN EMPIRIS P5/P50/P95', padL, H - 5);
}

function drawHist(sim) {
  const cv = $('cvHist'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const W = cv.width, H = cv.height, padL = 56, padR = 10, padT = 8, padB = 22;
  const lo = Math.max(sim.p5 * 2, sim.pct[0]), hi = Math.min(sim.p95 * 2 + 1, sim.pct[sim.pct.length - 1]);
  const bins = 41, bw = (hi - lo) / bins, cnt = new Array(bins).fill(0);
  sim.pct.forEach((x) => { const b = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / bw))); cnt[b]++; });
  const mx = Math.max(...cnt);
  const X = (i) => padL + (i / bins) * (W - padL - padR);
  for (let i = 0; i < bins; i++) {
    const c = lo + (i + 0.5) * bw;
    const h = (cnt[i] / mx) * (H - padT - padB);
    ctx.fillStyle = c >= sim.targetPct ? css('--green') : c >= 0 ? '#9CC7A6' : css('--red');
    ctx.fillRect(X(i) + 1, H - padB - h, (W - padL - padR) / bins - 2, h);
  }
  [[0, css('--ink'), '0%'], [sim.targetPct, css('--green'), 'TARGET +' + sim.targetPct.toFixed(2) + '%']]
    .forEach(([v, col, lab]) => {
      if (v < lo || v > hi) return;
      const x = padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
      ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.font = '10px ui-monospace'; ctx.fillText(lab, x + 3, padT + 10);
    });
  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText('DISTRIBUSI PnL % TERHADAP MODAL — ' + N_SIM.toLocaleString() + ' SIMULASI · HIJAU TUA = MENCAPAI TARGET', padL, H - 6);
}

// ---------- main ----------
$('btnGo').addEventListener('click', async () => {
  const btn = $('btnGo');
  btn.disabled = true; btn.textContent = 'MENGAMBIL HARGA…';
  const q = await getQuote(S.coin);
  btn.textContent = `MENJALANKAN ${N_SIM.toLocaleString()} SIMULASI (${S.model.toUpperCase()})…`;
  await new Promise((r) => setTimeout(r, 30)); // biarkan UI update

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
  drawHist(sim);

  btn.disabled = false; btn.textContent = 'Minta Rekomendasi';
});
