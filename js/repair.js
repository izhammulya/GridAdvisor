/* Repair bot: futures grid yang sedang rugi → ADD / HOLD / CUT */
import { SIM, TARGET, MMR } from './config.js';
import { clamp, quantile, esOf } from './util.js';
import { GridBook, Runner, MODE } from './grid.js';
import { PathSampler, stepPlan } from './sim.js';

// input mentah dari form Pionex → state model (kalibrasi offset & ekuitas dari harga liq Pionex)
export function repairState(inp, marketPrice) {
  const dir = inp.dir === 'long' ? 'long' : 'short';
  const P0 = inp.price > 0 ? inp.price : marketPrice;
  const Q0 = Math.abs(inp.qty);
  const qty = Math.max(1e-9, inp.qtyGrid);
  const nUnits = Math.max(1, Math.round(Q0 / qty));
  const Qs = nUnits * qty;
  const fl0 = dir === 'short' ? Qs * (inp.avg - P0) : Qs * (P0 - inp.avg);
  const E0 = inp.liq > 0
    ? (dir === 'short' ? Q0 * (inp.liq - P0) + MMR * Q0 * inp.liq : Q0 * (P0 - inp.liq) - MMR * Q0 * inp.liq)
    : inp.invest + inp.pnl;
  return {
    ...inp, dir, P0, Q0, qty, nUnits, Qs, fl0, E0,
    grids: Math.max(2, Math.round(inp.grids)),
    days: clamp(Math.round(inp.days), 3, 60),
    offset: inp.pnl - inp.gridProfit - fl0,   // funding historis & selisih akuntansi Pionex
  };
}

export const repairTarget = (c, add) => (c.target > 0 ? c.target : Math.max(1, (c.invest + add) * TARGET.fut));

export function liqAfterAdd(c, add) {
  if (c.Q0 <= 0) return c.liq;
  return c.dir === 'short' ? c.liq + add / (c.Q0 * (1 + MMR)) : c.liq - add / (c.Q0 * (1 - MMR));
}

export function simRepair(c, H, add, V, noise) {
  const nH = c.days * 24;
  const sampler = new PathSampler(H, { nH, plan: stepPlan(nH, c.days, 'repair'), tailP: V.tailP ?? 0.02, noise });
  const book = new GridBook({
    low: c.low, step: (c.high - c.low) / c.grids, grids: c.grids, qty: c.qty, fee: c.fee,
    mode: c.dir === 'short' ? MODE.SHORT : MODE.LONG,
  });
  const run = new Runner({ fut: true, funding: c.funding, invest: c.invest + add, P: c.P0 }, book);
  const target = repairTarget(c, add), base = c.gridProfit + c.offset;

  const recMin = [], endTotals = [], outcomes = [];
  let liqN = 0, liq, rec, out;
  const onVisit = (q, t) => {
    if (run.visit(q)) { liq = true; return true; }
    const nv = base + run.net(q);
    if (nv >= target) { rec = t; out = nv; return true; }
    return false;
  };
  const onHour = (h, p) => { run.accrue(p); return false; };

  for (let i = 0; i < SIM.N_REPAIR; i++) {
    sampler.draw(i);
    book.seed(c.P0, c.nUnits, c.avg);
    run.fund = 0;
    run.equity0 = c.E0 + add - book.fl(c.P0);
    liq = false; rec = -1; out = 0;
    sampler.walk(c.P0, onVisit, onHour);
    if (liq) { liqN++; outcomes.push(-(c.invest + add)); }
    else if (rec >= 0) { recMin.push(rec); outcomes.push(out); }
    else { const e = base + run.net(sampler.lastP); endTotals.push(e); outcomes.push(e); }
  }

  recMin.sort((a, b) => a - b); endTotals.sort((a, b) => a - b); outcomes.sort((a, b) => a - b);
  const N = SIM.N_REPAIR;
  const qm = (p) => { const k = Math.ceil(p * N) - 1; return k < recMin.length ? recMin[Math.max(0, k)] : null; };
  return {
    add, target, liqP: liqAfterAdd(c, add),
    pRec: recMin.length / N, pLiq: liqN / N,
    pRec7: recMin.filter((m) => m <= 7 * 1440).length / N,
    m25: qm(0.25), m50: qm(0.5), m75: qm(0.75),
    endMed: quantile(endTotals, 0.5),
    ev: outcomes.reduce((a, b) => a + b, 0) / N,
    es5: esOf(outcomes, 0.05),
  };
}

// bandingkan nilai harapan menahan/menambah vs cut loss sekarang
export function repairDecision(c, rows) {
  const cutNow = c.pnl - c.fee * c.Q0 * c.P0;
  const margin = Math.max(0.5, 0.005 * c.invest);
  const safe = rows.filter((r) => r.pLiq <= 0.05);
  if (!safe.length) return { v: 'CUT', rec: rows.reduce((a, b) => (b.pLiq < a.pLiq ? b : a)), cutNow, margin, why: 'liq' };
  const bestEV = Math.max(...safe.map((r) => r.ev));
  // EV hampir sama → pilih add terkecil (modal berisiko lebih sedikit)
  const rec = safe.filter((r) => r.ev >= bestEV - margin).reduce((a, b) => (b.add < a.add ? b : a));
  if (rec.ev > cutNow + margin) return { v: rec.add > 0 ? 'ADD' : 'HOLD', rec, cutNow, margin };
  return { v: 'CUT', rec, cutNow, margin, why: 'ev' };
}
