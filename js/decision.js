/* mesin keputusan GO / HOLD / NO-GO + pencari setting alternatif */
import { SIM, DEC } from './config.js';
import { clamp, sleep, pct1, pctTxt, fmt } from './util.js';
import { buildReco, MODE } from './grid.js';
import { simulate, stressOpts } from './sim.js';

const ok3 = (v, okT, warnT) => (v <= okT ? 'ok' : v <= warnT ? 'warn' : 'fail');

export function decide({ R, base, alt, stress, bt, T, H, V, q }) {
  const fut = R.fut, tp = (R.targetUsd / R.invest) * 100;
  const W = fut ? { tgt: 25, liq: 25, sl: 15, tail: 15, ev: 10, reg: 10 }
                : { tgt: 30, liq: 0, sl: 20, tail: 20, ev: 15, reg: 15 };
  const checks = [], caps = [], fixes = [];
  let score = 0, hard = false;
  const push = (c) => { checks.push(c); score += c.pts; if (c.hard) hard = true; };
  const pts3 = (st, w, warnF = 0.5) => (st === 'ok' ? w : st === 'warn' ? w * warnF : 0);

  // peluang target gabungan: utama 50%, alternatif 20%, stress 20%, backtest ≤10%
  const btOk = !!(bt && bt.n >= 8 && bt.indep >= 2);
  let ws = 0.5, ps = 0.5 * base.pTarget;
  if (alt) { ws += 0.2; ps += 0.2 * alt.pTarget; }
  if (stress) { ws += 0.2; ps += 0.2 * stress.pTarget; }
  if (btOk) { const wb = 0.1 * Math.min(1, bt.indep / 4); ws += wb; ps += wb * bt.pTarget; }
  const pCons = ps / ws;

  { // 1. peluang target
    const st = pCons >= 0.55 ? 'ok' : pCons >= 0.35 ? 'warn' : 'fail';
    push({ key: 'tgt', name: 'Peluang capai target', val: `${pct1(pCons)} gabungan · model utama ${pct1(base.pTarget)}`,
      st, pts: W.tgt * clamp((pCons - 0.25) / 0.35, 0, 1), max: W.tgt });
    if (st !== 'ok') fixes.push('Peluang target kurang: perpanjang horizon, kecilkan target, atau coba range lebih sempit.');
  }

  if (fut) { // 2. likuidasi
    const bL = base.pLiq, sL = stress ? stress.pLiq : bL;
    const hardL = R.liqBeforeSL || bL > 0.05;
    const st = hardL ? 'fail' : bL <= 0.01 && sL <= 0.05 ? 'ok' : bL <= 0.03 && sL <= 0.12 ? 'warn' : 'fail';
    push({ key: 'liq', name: 'Risiko likuidasi', val: `${pct1(bL)} normal · ${pct1(sL)} stress${R.liqBeforeSL ? ' · liq sebelum SL' : ''}`,
      st, pts: st === 'ok' ? W.liq : st === 'warn' ? W.liq * 0.45 : 0, max: W.liq, hard: hardL });
    if (st !== 'ok') fixes.push(`Turunkan leverage (sekarang ${R.lev}x)${R.liqBeforeSL ? ' — harga likuidasi tersentuh sebelum Stop Loss' : ''}.`);
  }

  { // 3. bot mati karena SL / liq
    const x = base.pSL + base.pLiq, st = ok3(x, 0.10, 0.25);
    push({ key: 'sl', name: fut ? 'Bot mati (SL + liq)' : 'Kena stop loss',
      val: pct1(x) + (stress ? ` · stress ${pct1(stress.pSL + stress.pLiq)}` : ''),
      st, pts: pts3(st, W.sl), max: W.sl, hard: x > 0.40 });
    if (st !== 'ok') fixes.push('Banyak path kena SL: perlebar range atau pilih arah searah trend.');
  }

  { // 4. kerugian ekor (ES5)
    const [okT, warnT, hardT] = fut ? [-12, -30, -60] : [-8, -15, -35];
    const e = base.es5, es = stress ? stress.es5 : e;
    const st = e >= okT ? 'ok' : e >= warnT ? 'warn' : 'fail';
    push({ key: 'tail', name: 'Rata-rata 5% skenario terburuk', val: `${pctTxt(e)} (${fmt((e * R.invest) / 100, 2)} USDT) · stress ${pctTxt(es)}`,
      st, pts: pts3(st, W.tail), max: W.tail, hard: es <= hardT });
    if (st !== 'ok') fixes.push(`Kerugian skenario buruk besar: kecilkan investasi${fut ? ' atau leverage' : ''}.`);
  }

  { // 5. expected value
    const m = base.mean, st = m >= 0 ? 'ok' : m >= -tp ? 'warn' : 'fail';
    push({ key: 'ev', name: 'Expected value', val: `${pctTxt(m)} (${fmt((m * R.invest) / 100, 2)} USDT)${stress ? ` · stress ${pctTxt(stress.mean)}` : ''}`,
      st, pts: pts3(st, W.ev, 0.4), max: W.ev });
  }

  { // 6. arah vs regime / trend / variance ratio
    const dirSign = R.mode === MODE.LONG ? 1 : R.mode === MODE.SHORT ? -1 : 0;
    const pAg = dirSign > 0 ? H.alpha[2] : dirSign < 0 ? H.alpha[0] : 0;
    const trendAg = dirSign > 0 ? T.label === 'DOWNTREND' : dirSign < 0 ? T.label === 'UPTREND' : T.label !== 'SIDEWAYS';
    const vrTr = (V.vr6 && V.vr6.z >= 2) || (V.vr24 && V.vr24.z >= 2);
    const nb = (pAg > 0.5) + trendAg + vrTr;
    const st = nb === 0 ? 'ok' : trendAg || nb > 1 ? 'fail' : 'warn';
    const parts = [];
    if (dirSign) parts.push(`regime lawan ${(pAg * 100).toFixed(0)}%`);
    parts.push('trend ' + T.label.toLowerCase(), vrTr ? 'VR trending' : 'VR netral');
    push({ key: 'reg', name: fut ? 'Arah vs regime & trend' : 'Kondisi pasar', val: parts.join(' · '),
      st, pts: pts3(st, W.reg, 0.3), max: W.reg, hard: trendAg });
    if (nb > 0) fixes.push(dirSign > 0 && fut ? 'Long melawan trend — pertimbangkan Short atau tunggu.'
      : dirSign < 0 ? 'Short melawan trend — pertimbangkan Long atau tunggu.'
      : 'Grid rawan saat trending kuat — tunggu sideways.');
  }

  { // 7. konsistensi antar-model (penalti)
    const why = [];
    if (alt && Math.abs(base.pTarget - alt.pTarget) > 0.2) why.push(`model alternatif ${pct1(alt.pTarget)}`);
    if (btOk && bt.pTarget < base.pTarget - 0.25) why.push(`backtest ${pct1(bt.pTarget)}`);
    if (fut && btOk && bt.pLiq > base.pLiq + 0.05) why.push(`liq backtest ${pct1(bt.pLiq)}`);
    if (alt || btOk) {
      push({ key: 'agree', name: 'Konsistensi antar-model', val: why.length ? 'berbeda: ' + why.join(', ') : 'selaras',
        st: why.length ? 'warn' : 'ok', pts: why.length ? -8 : 0, max: 0 });
      if (why.length) fixes.push('Model tidak sepakat → ketidakpastian tinggi, pakai ukuran kecil.');
    }
  }

  { // gerbang: profit/grid
    const ok = R.profitPerGridNet > 0.0005;
    push({ key: 'ppg', name: 'Profit per grid bersih', val: (R.profitPerGridNet * 100).toFixed(3) + '%',
      st: ok ? 'ok' : 'fail', pts: 0, max: 0, hard: !ok });
    if (!ok) fixes.push('Profit per grid habis dimakan fee — kurangi jumlah grid.');
  }

  // pembatas: maksimal HOLD
  if (q.demo || !V.live) caps.push('Data harga tidak live — angka hanya proxy kasar.');
  const z1 = V.vol > 0 ? Math.abs((q.change_1h || 0) / 100) / (V.vol / Math.sqrt(24)) : 0;
  if (z1 > 2.5) caps.push(`Lonjakan 1 jam ${pctTxt(q.change_1h)} (${z1.toFixed(1)}σ) — tunggu 1–2 candle sampai tenang.`);
  if (fut && checks.some((c) => (c.key === 'liq' || c.key === 'tail') && c.st === 'fail'))
    caps.push('Futures: risiko likuidasi/ekor gagal — maksimal HOLD sampai setting diubah.');

  score = clamp(Math.round(score), 0, 100);
  const anyFail = checks.some((c) => c.st === 'fail');
  let verdict = 'GO', size = 0;
  if (hard || score < DEC.NOGO) verdict = 'NO-GO';
  else if (caps.length || score < DEC.GO) verdict = 'HOLD';
  else {
    const liqOk = !fut || checks.find((c) => c.key === 'liq').st === 'ok';
    size = score >= DEC.FULL && !anyFail && liqOk ? 1 : 0.5;
  }
  return { verdict, size, score, checks, caps, fixes: [...new Set(fixes)], pCons, btOk };
}

export const verdictLabel = (d) => (d.verdict === 'GO' ? `GO ${d.size * 100}%` : d.verdict);
export const verdictCls = (v) => (v === 'GO' ? 'go' : v === 'HOLD' ? 'hold' : 'nogo');
export const sameCfg = (a, b) => a.dir === b.dir && a.lev === b.lev && Math.abs(a.width - b.width) < 1e-6;

// screening arah × leverage × lebar range dengan angka acak yang sama (common random numbers)
export async function optimize(ctx, cfg, seedTag, onProgress) {
  const { q, T, H, V, noise } = ctx;
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
    onProgress?.(i + 1, cands.length);
    await sleep(0);
    const c = cands[i];
    const R = buildReco(q, T, H, V, c);
    const base = simulate(R, H, { n: SIM.N_OPT, coarse: true, light: true, seed: seedTag('opt'), noise });
    const stress = simulate(R, H, { n: SIM.N_OPT_S, coarse: true, light: true, seed: seedTag('opt-s'), noise, ...stressOpts(R) });
    const d = decide({ R, base, stress, alt: null, bt: null, T, H, V, q });
    out.push({ cfg: c, R, base, stress, d, cur: sameCfg(c, cfg) });
  }
  const rank = { GO: 2, HOLD: 1, 'NO-GO': 0 };
  out.sort((a, b) => rank[b.d.verdict] - rank[a.d.verdict] || b.d.size - a.d.size || b.d.score - a.d.score);
  return out;
}
