/* mesin grid: buku order ala Pionex, runner (SL/TP/likuidasi/funding), rekomendasi setting */
import { TARGET, SLIP, MMR } from './config.js';
import { clamp } from './util.js';

export const MODE = { LONG: 0, SHORT: 1, NEUTRAL: 2 };
export const modeOf = (fut, dir) => (!fut || dir === 'long' ? MODE.LONG : dir === 'short' ? MODE.SHORT : MODE.NEUTRAL);

/* ---------- buku order grid ----------
   Kuantitas koin per grid TETAP (seperti "Qty per grid" di Pionex).
   Garis k = low + k·step (k = 0..grids). Order beli menunggu di garis nb, jual di ns.
   Fee dibayar per eksekusi: saat buka posisi dan saat tutup. */
export class GridBook {
  constructor({ low, step, grids, qty, fee, mode, maxUnits }) {
    Object.assign(this, { low, step, grids, qty, fee, mode, maxUnits: maxUnits ?? grids });
    this.L = []; this.S = [];
    this.clear();
  }
  line(k) { return this.low + k * this.step; }
  levelOf(p) { return clamp(Math.floor((p - this.low) / this.step), 0, this.grids); }
  clear() {
    this.L.length = 0; this.S.length = 0;
    this.sumL = 0; this.sumS = 0; this.realized = 0; this.cycles = 0;
  }
  setLevel(p) { const lvl = this.levelOf(p); this.nb = lvl; this.ns = lvl + 1; return lvl; }

  // start bot baru di harga p (posisi awal dibeli/dijual di harga pasar)
  reset(p) {
    this.clear();
    const lvl = this.setLevel(p);
    if (this.mode === MODE.LONG) for (let k = 0; k < this.grids - lvl; k++) this.open(this.L, p);
    else if (this.mode === MODE.SHORT) for (let k = 0; k < lvl; k++) this.open(this.S, p);
  }
  // bot yang sudah berjalan: n unit di harga rata-rata avg (fee masuk sudah dibayar)
  seed(p, units, avg) {
    this.clear();
    this.setLevel(p);
    const side = this.mode === MODE.SHORT ? this.S : this.L;
    for (let k = 0; k < units; k++) side.push(avg);
    if (side === this.S) this.sumS = units * avg; else this.sumL = units * avg;
  }

  open(side, px) {
    if (side.length >= this.maxUnits) return;
    side.push(px);
    if (side === this.L) this.sumL += px; else this.sumS += px;
    this.realized -= this.fee * this.qty * px;
  }
  closeL(px) {
    const e = this.L.pop(); this.sumL = this.L.length ? this.sumL - e : 0;
    this.realized += this.qty * (px - e) - this.fee * this.qty * px; this.cycles++;
  }
  closeS(px) {
    const e = this.S.pop(); this.sumS = this.S.length ? this.sumS - e : 0;
    this.realized += this.qty * (e - px) - this.fee * this.qty * px; this.cycles++;
  }
  fillSell(px) {
    if (this.mode === MODE.SHORT) this.open(this.S, px);
    else if (this.L.length) this.closeL(px);
    else if (this.mode === MODE.NEUTRAL) this.open(this.S, px);
  }
  fillBuy(px) {
    if (this.mode === MODE.LONG) this.open(this.L, px);
    else if (this.S.length) this.closeS(px);
    else if (this.mode === MODE.NEUTRAL) this.open(this.L, px);
  }
  // harga bergerak ke p: isi semua order yang terlewati (histeresis ala Pionex)
  move(p) {
    while (this.ns <= this.grids && p >= this.line(this.ns)) {
      this.fillSell(this.line(this.ns)); this.nb = this.ns - 1; this.ns++;
    }
    while (this.nb >= 0 && p <= this.line(this.nb)) {
      this.fillBuy(this.line(this.nb)); this.ns = this.nb + 1; this.nb--;
    }
  }
  units() { return this.L.length + this.S.length; }
  fl(p) { return this.qty * (p * this.L.length - this.sumL) + this.qty * (this.sumS - p * this.S.length); }
  notional(p) { return this.qty * p * (this.L.length + this.S.length); }
  closeAll(px) {
    this.realized += this.fl(px) - this.fee * this.notional(px);
    this.L.length = 0; this.S.length = 0; this.sumL = 0; this.sumS = 0;
  }
}

export const STATUS = { RUN: 0, LIQ: 1, SL: 2, TP: 3, TARGET: 4 };

/* ---------- runner: grid + SL/TP + likuidasi + funding ----------
   Dipakai Monte Carlo, backtest, optimizer, dan repair → satu sumber kebenaran. */
export class Runner {
  constructor(R, book = new GridBook(R)) {
    this.R = R; this.b = book;
    this.slLow = R.slLow ?? -Infinity; this.slHigh = R.slHigh ?? Infinity;
    this.tpLow = R.tpLow ?? -Infinity; this.tpHigh = R.tpHigh ?? Infinity;
    this.fundH = R.fut ? (R.funding || 0) / 8 : 0;
    this.equity0 = R.equity0 ?? R.invest;
    this.fund = 0; this.exitPx = R.P;
  }
  reset(p) { this.b.reset(p); this.fund = 0; this.exitPx = p; }
  liqAt(q) {
    return this.R.fut && this.equity0 + this.b.realized + this.b.fl(q) + this.fund <= MMR * this.b.notional(q);
  }
  // kembalikan STATUS
  visit(q) {
    const b = this.b;
    if (q <= this.slLow || q >= this.slHigh) {
      const lvl = q <= this.slLow ? this.slLow : this.slHigh;
      b.move(lvl); this.exitPx = lvl;
      if (this.liqAt(lvl)) return STATUS.LIQ;
      b.closeAll(lvl * (q <= this.slLow ? 1 - SLIP : 1 + SLIP));
      return STATUS.SL;
    }
    if (q >= this.tpHigh || q <= this.tpLow) {
      const lvl = q >= this.tpHigh ? this.tpHigh : this.tpLow;
      b.move(lvl); b.closeAll(lvl); this.exitPx = lvl;
      return STATUS.TP;
    }
    b.move(q);
    if (this.liqAt(q)) { this.exitPx = q; return STATUS.LIQ; }
    return STATUS.RUN;
  }
  // total profit bila bot ditutup di harga q (termasuk fee penutupan)
  net(q) { return this.b.realized + this.b.fl(q) + this.fund - this.b.fee * this.b.notional(q); }
  eq(p) { return Math.max(-this.R.invest, this.b.realized + this.b.fl(p) + this.fund); }
  accrue(p) {   // funding positif: long bayar, short terima
    if (this.fundH) this.fund += this.fundH * this.b.qty * p * (this.b.S.length - this.b.L.length);
  }
  final(st, p) {
    if (st === STATUS.LIQ) return -this.R.invest;
    if (st === STATUS.SL || st === STATUS.TP) return Math.max(-this.R.invest, this.b.realized + this.fund);
    return this.eq(p);
  }
}

// harga likuidasi bila harga bergerak monoton (grid ikut terisi di jalan)
export function liqScan(R, dirSign) {
  if (!R.fut) return null;
  const run = new Runner({ ...R, slLow: null, slHigh: null, tpLow: null, tpHigh: null });
  run.reset(R.P);
  for (let k = 1; k <= 4000; k++) {
    const p = R.P * (1 + dirSign * k * 0.0005);
    if (p <= 0) return null;
    run.b.move(p);
    if (run.liqAt(p)) return p;
  }
  return null;
}

// ---------- aturan grid custom (spot) ----------
export function pointScale(P) {
  const scale = 10 ** Math.max(0, Math.floor(Math.log10(P)) - 1);
  return { scale, point: 0.01 * scale };
}
export const gridDivisor = (P) => Math.max(2, Math.floor(P / pointScale(P).scale / 10) + 2);

// ---------- rekomendasi setting ----------
export function buildReco(q, T, H, V, cfg) {
  const P = q.price, vol = V.vol;
  const { days, fee, invest, fut, dir, lev, funding, useHMM, width } = cfg;
  const targetRate = fut ? TARGET.fut : TARGET.spot;

  // range: ±1.28σ√hari × lebar, digeser mengikuti drift, asimetris sesuai arah
  const horizonVol = vol * Math.sqrt(days) * width;
  const z = 1.28;
  const mu = useHMM ? H.muEff : T.muSim;
  const center = P * Math.exp(mu * days * 0.5);
  const [lowM, highM] = dir === 'long' ? [1.25 * z, 0.85 * z] : dir === 'short' ? [0.85 * z, 1.25 * z] : [z, z];

  const { point } = pointScale(P);
  const divisor = gridDivisor(P);
  const low = Math.round(Math.max(center * (1 - lowM * horizonVol), P * 0.3) / point) * point;
  const high = Math.round(center * (1 + highM * horizonVol) / point) * point;

  let grids, points = null, feeAdjusted = false;
  if (!fut) {
    points = Math.round((high - low) / point);
    grids = Math.round(points / divisor) + 1;
    const maxGrids = Math.max(2, Math.floor((high - low) / (P * (2 * fee + 0.0005))));
    if (grids > maxGrids) { grids = maxGrids; feeAdjusted = true; }
    grids = clamp(grids, 2, 200);
  } else {
    grids = clamp(Math.round((high - low) / (P * (0.0035 + 2 * fee))), 6, 200);
  }

  const step = (high - low) / grids;
  const qty = (invest * lev) / (grids * (low + high) / 2);
  const targetUsd = cfg.targetUsd > 0 ? cfg.targetUsd : invest * targetRate;

  let slLow = null, slHigh = null, tpLow = null, tpHigh = null;
  if (!fut || dir === 'long') { slLow = low * 0.98; tpHigh = high; }
  else if (dir === 'short') { slHigh = high * 1.02; tpLow = low; }
  else { slLow = low * 0.98; slHigh = high * 1.02; }

  const R = {
    P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step, qty, funding, width,
    mode: modeOf(fut, dir),
    profitPerGridNet: step / P - 2 * fee,
    trigger: dir === 'long' ? P * 0.998 : dir === 'short' ? P * 1.002 : null,
    slLow, slHigh, tpLow, tpHigh,
    point, divisor, points, feeAdjusted, targetUsd, targetRate, mu, useHMM,
    tailP: V.tailP, exitOnTarget: !!cfg.exitOnTarget,
  };
  R.liqLow = liqScan(R, -1);
  R.liqHigh = liqScan(R, +1);
  R.liqBeforeSL = !!((R.liqLow && slLow && R.liqLow >= slLow) || (R.liqHigh && slHigh && R.liqHigh <= slHigh));
  return R;
}

/* ---------- ETA dasar (rumus v6, SENGAJA tidak diubah) ----------
   Waktu keluar Brownian dari (−δ, +δ): E[τ] = δ²/σ². Separuh fill menutup posisi → 2δ²/σ² per siklus.
   Angka ini yang tercatat di jurnal sebagai "Prediksi Durasi Hit", jadi rumusnya dibekukan
   agar kalibrasi empiris dari jurnal tetap berlaku. Jangan dipakai mentah — lihat journal.js. */
export function etaBase(R, sgHourly) {
  const delta = Math.log(1 + R.step / R.P);
  const tau = (delta * delta) / (sgHourly * sgHourly);
  const perCycle = ((R.invest * R.lev) / R.grids) * R.profitPerGridNet;
  if (!(perCycle > 0) || !(tau > 0)) return null;
  const cycles = Math.ceil(R.targetUsd / perCycle);
  return { tauMin: tau * 60, cycles, perCycle, minutes: 2 * cycles * tau * 60 };
}
