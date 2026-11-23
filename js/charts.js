/* grafik canvas: tajam di layar retina, mengikuti tema terang/gelap, dengan tooltip hover */
import { quantile, fmtPx, fmtDur, fmtDurShort, pctTxt, clamp } from './util.js';
import { STATUS } from './grid.js';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const FONT = '500 11px "Instrument Sans", system-ui, sans-serif';
const FONT_S = '500 10px "Instrument Sans", system-ui, sans-serif';

function setup(cv, h) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(280, cv.parentElement.clientWidth);
  cv.style.height = h + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, h);
  ctx.font = FONT; ctx.textBaseline = 'middle';
  return { ctx, W, H: h };
}

function hline(ctx, x0, x1, y, color, dash = [], width = 1) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke();
  ctx.setLineDash([]);
}
function poly(ctx, pts, color, width = 1.5, dash = []) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
  ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  ctx.setLineDash([]);
}
function band(ctx, top, bot, color, alpha) {
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.beginPath();
  top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
  ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
}
function clipTo(ctx, x, y, w, h) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); }
function tag(ctx, text, x, y, color, align = 'left') {
  ctx.font = FONT_S; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(text, x, y); ctx.textAlign = 'left';
}

/* hover: garis vertikal + tooltip. fn(xCss) → { x, html } | null */
function hover(cv, fn) {
  const box = cv.parentElement;
  let line = box.querySelector('.xhair'), tip = box.querySelector('.ctip');
  if (!line) {
    line = document.createElement('div'); line.className = 'xhair'; box.appendChild(line);
    tip = document.createElement('div'); tip.className = 'ctip'; box.appendChild(tip);
    const hide = () => { line.style.opacity = 0; tip.style.opacity = 0; };
    cv.addEventListener('pointerleave', hide);
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const res = cv._hover && cv._hover(e.clientX - r.left);
      if (!res) return hide();
      line.style.left = res.x + 'px'; line.style.opacity = 1;
      tip.innerHTML = res.html; tip.style.opacity = 1;
      const tw = tip.offsetWidth;
      tip.style.left = clamp(res.x + 12 + tw > r.width ? res.x - tw - 12 : res.x + 12, 0, r.width - tw) + 'px';
    });
  }
  cv._hover = fn;
}
// label hari di sumbu waktu, dijarangkan di layar sempit
function dayTicks(ctx, X, days, W, y, color) {
  const step = Math.max(1, Math.ceil(days / (W < 560 ? 4 : 7)));
  for (let d = 0; d <= days; d += step) tag(ctx, d ? `H+${d}` : 'kini', X(d * 24), y, color, d ? 'center' : 'left');
}
const nearestIdx = (xs, x) => { let b = 0; for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[b] - x)) b = i; return b; };

/* ---------- 1. kerucut harga: kepadatan 5.000 jalur + garis grid + persentil ---------- */
export function drawCone(cv, R, sim) {
  const { ctx, W, H } = setup(cv, 300);
  const narrow = W < 560;
  const padL = narrow ? 72 : 88, margW = narrow ? 46 : 74, padR = margW + 10, padT = 16, padB = 24;
  const C = { teal: css('--teal'), ink: css('--ink'), muted: css('--muted'), line: css('--line'), coral: css('--coral'), violet: css('--violet'), soft: css('--teal-soft') };

  const fan = sim.fan;
  let yMin = Math.min(R.low, ...fan.map((f) => f.p5)), yMax = Math.max(R.high, ...fan.map((f) => f.p95));
  const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
  const X = (h) => padL + (h / sim.nH) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

  // range grid + garis grid
  ctx.fillStyle = C.soft; ctx.globalAlpha = 0.55;
  ctx.fillRect(padL, Y(R.high), W - padL - padR, Y(R.low) - Y(R.high)); ctx.globalAlpha = 1;
  const stride = Math.max(1, Math.ceil(R.grids / 60));
  ctx.globalAlpha = 0.45;
  for (let k = 0; k <= R.grids; k += stride) hline(ctx, padL, W - padR, Y(R.low + k * R.step), C.teal, [], 0.5);
  ctx.globalAlpha = 1;

  // kepadatan
  const BINS = 72, cols = [{ t: 0, arr: null }, ...sim.ckIdx.map((t, c) => ({ t, arr: sim.ckPx[c] }))];
  const binOf = (v) => Math.floor(((v - yMin) / (yMax - yMin)) * BINS);
  const bh = (H - padT - padB) / BINS;
  ctx.fillStyle = C.teal;
  for (let c = 1; c < cols.length; c++) {
    const cnt = new Uint32Array(BINS);
    for (const v of cols[c].arr) { const b = binOf(v); if (b >= 0 && b < BINS) cnt[b]++; }
    let mx = 0; for (const n of cnt) if (n > mx) mx = n;
    const x0 = X(cols[c - 1].t), x1 = X(cols[c].t);
    for (let b = 0; b < BINS; b++) {
      if (!cnt[b]) continue;
      ctx.globalAlpha = 0.08 + 0.72 * Math.pow(cnt[b] / mx, 0.55);
      ctx.fillRect(x0, padT + (BINS - 1 - b) * bh, x1 - x0 + 0.6, bh + 0.6);
    }
  }
  ctx.globalAlpha = 1;

  // persentil
  const pts = (k) => [[X(0), Y(R.P)], ...fan.map((f) => [X(f.t), Y(f[k])])];
  poly(ctx, pts('p5'), C.violet, 1, [2, 3]); poly(ctx, pts('p95'), C.violet, 1, [2, 3]);
  poly(ctx, pts('p25'), C.violet, 1.2, [5, 3]); poly(ctx, pts('p75'), C.violet, 1.2, [5, 3]);
  poly(ctx, pts('p50'), C.ink, 2);

  // garis acuan
  const refs = [
    [R.high, C.teal, 'High', []], [R.low, C.teal, 'Low', []], [R.P, C.ink, 'Entry', [2, 3]],
    [R.slLow, C.coral, 'SL', [6, 3]], [R.slHigh, C.coral, 'SL', [6, 3]],
    [R.liqLow, C.coral, 'Liq', []], [R.liqHigh, C.coral, 'Liq', []],
  ];
  for (const [v, col, lab, dash] of refs) {
    if (v == null || v < yMin || v > yMax) continue;
    hline(ctx, padL, W - padR, Y(v), col, dash, lab === 'Liq' ? 1.5 : 1);
    tag(ctx, `${lab} ${fmtPx(v)}`, padL - 6, Y(v), col, 'right');
  }

  // marginal kanan: distribusi harga akhir
  const cnt = new Uint32Array(BINS); let mx = 0;
  for (const v of sim.endPx) { const b = binOf(v); if (b >= 0 && b < BINS) cnt[b]++; }
  for (const n of cnt) if (n > mx) mx = n;
  const mx0 = W - margW;
  ctx.fillStyle = C.violet; ctx.globalAlpha = 0.75;
  for (let b = 0; b < BINS; b++) if (cnt[b]) ctx.fillRect(mx0, padT + (BINS - 1 - b) * bh, (cnt[b] / mx) * (margW - 8), Math.max(1, bh - 0.5));
  ctx.globalAlpha = 1;
  hline(ctx, mx0 - 4, W, Y(R.P), C.ink, [2, 3]);
  tag(ctx, 'akhir', mx0, 7, C.muted);

  dayTicks(ctx, X, R.days, W, H - 9, C.muted);

  const xs = [X(0), ...fan.map((f) => X(f.t))];
  hover(cv, (x) => {
    if (x < padL || x > W - padR) return null;
    const i = nearestIdx(xs, x);
    if (i === 0) return null;
    const f = fan[i - 1];
    return { x: xs[i], html: `<b>${fmtDur(f.t * 60)}</b><br>P95 ${fmtPx(f.p95)}<br>P50 <b>${fmtPx(f.p50)}</b><br>P5 ${fmtPx(f.p5)}<br>Di dalam range ${Math.round(sim.inRange[i - 1] * 100)}%` };
  });
}

/* ---------- 2. kipas equity ---------- */
export function drawEquity(cv, R, sim) {
  const { ctx, W, H } = setup(cv, 230);
  const padL = W < 560 ? 70 : 84, padR = 14, padT = 12, padB = 24;
  const C = { ink: css('--ink'), muted: css('--muted'), line: css('--line'), teal: css('--teal'), violet: css('--violet'), coral: css('--coral') };
  const fan = sim.eqFan;
  let mn = Math.min(0, ...fan.map((f) => f.p5)), mx = Math.max(sim.targetPct, ...fan.map((f) => f.p95));
  const span = mx - mn || 1; mn -= span * 0.08; mx += span * 0.12;
  const X = (h) => padL + (h / sim.nH) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);

  hline(ctx, padL, W - padR, Y(0), C.line);
  tag(ctx, '0%', padL - 6, Y(0), C.muted, 'right');
  hline(ctx, padL, W - padR, Y(sim.targetPct), C.teal, [5, 3]);
  tag(ctx, `target ${pctTxt(sim.targetPct)}`, padL - 6, Y(sim.targetPct), C.teal, 'right');

  clipTo(ctx, padL, padT, W - padL - padR, H - padT - padB);
  ctx.globalAlpha = 0.09;
  for (const p of sim.sampleEq) poly(ctx, p.map((v, i) => [X(Math.min(i, sim.nH)), Y(v)]), C.ink, 1);
  ctx.globalAlpha = 1;

  const P = (k) => [[X(0), Y(0)], ...fan.map((f) => [X(f.t), Y(f[k])])];
  band(ctx, P('p95'), P('p5'), C.violet, 0.14);
  band(ctx, P('p75'), P('p25'), C.violet, 0.26);
  poly(ctx, P('p50'), C.violet, 2.2);
  ctx.restore();

  const last = fan[fan.length - 1];
  tag(ctx, `P95 ${pctTxt(last.p95)}`, W - padR, Y(last.p95) - 8, C.muted, 'right');
  tag(ctx, `P5 ${pctTxt(last.p5)}`, W - padR, Y(last.p5) + 9, C.coral, 'right');
  dayTicks(ctx, X, R.days, W, H - 9, C.muted);

  const xs = fan.map((f) => X(f.t));
  hover(cv, (x) => {
    if (x < padL || x > W - padR) return null;
    const f = fan[nearestIdx(xs, x)];
    const usd = (p) => ((p * R.invest) / 100).toFixed(2);
    return { x: X(f.t), html: `<b>${fmtDur(f.t * 60)}</b><br>P95 ${pctTxt(f.p95)} (${usd(f.p95)})<br>P50 <b>${pctTxt(f.p50)}</b> (${usd(f.p50)})<br>P5 ${pctTxt(f.p5)} (${usd(f.p5)})` };
  });
}

/* ---------- 3. histogram hasil akhir, ditumpuk menurut cara bot berakhir ---------- */
export const OUTCOME_KEYS = [
  [STATUS.TARGET, '--teal', 'Ditutup di target'],
  [STATUS.TP, '--teal-2', 'Take profit'],
  [STATUS.RUN, '--muted', 'Masih jalan di akhir'],
  [STATUS.SL, '--ochre', 'Stop loss'],
  [STATUS.LIQ, '--coral', 'Likuidasi'],
];
export function drawOutcome(cv, R, sim) {
  const { ctx, W, H } = setup(cv, 200);
  const padL = 14, padR = 14, padT = 14, padB = 26;
  let lo = Math.min(quantile(sim.pct, 0.01), 0), hi = Math.max(quantile(sim.pct, 0.995), sim.targetPct);
  const sp = hi - lo || 1; lo -= sp * 0.03; hi += sp * 0.06;
  const BINS = 44, bw = (hi - lo) / BINS || 1;
  const stack = Array.from({ length: BINS }, () => [0, 0, 0, 0, 0]);
  for (let i = 0; i < sim.N; i++) {
    const b = clamp(Math.floor((sim.pctRaw[i] - lo) / bw), 0, BINS - 1);
    stack[b][sim.stArr[i]]++;
  }
  const mx = Math.max(...stack.map((s) => s.reduce((a, b) => a + b, 0))) || 1;
  const X = (v) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const cw = (W - padL - padR) / BINS;
  for (let b = 0; b < BINS; b++) {
    let y = H - padB;
    for (const [st, col] of OUTCOME_KEYS) {
      const n = stack[b][st]; if (!n) continue;
      const tot = stack[b].reduce((a, c) => a + c, 0);
      const h = (n / tot) * Math.sqrt(tot / mx) * (H - padT - padB);   // tinggi ∝ √jumlah: batang kecil tetap terlihat
      ctx.fillStyle = css(col); ctx.fillRect(padL + b * cw + 0.5, y - h, cw - 1.5, h); y -= h;
    }
  }
  const C = { ink: css('--ink'), muted: css('--muted'), teal: css('--teal') };
  for (const [v, col, lab] of [[0, C.ink, '0%'], [sim.targetPct, C.teal, 'target']]) {
    if (v < lo || v > hi) continue;
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(v) + 0.5, padT); ctx.lineTo(X(v) + 0.5, H - padB); ctx.stroke(); ctx.setLineDash([]);
    const left = v === 0 || X(v) > W - 70;   // "0%" di kiri garis, "target" di kanan
    tag(ctx, lab, X(v) + (left ? -4 : 4), padT + 4, col, left ? 'right' : 'left');
  }
  tag(ctx, pctTxt(lo, 1), padL, H - 9, C.muted);
  tag(ctx, pctTxt(hi, 1), W - padR, H - 9, C.muted, 'right');
  tag(ctx, 'PnL akhir (% modal)', W / 2, H - 9, C.muted, 'center');

  hover(cv, (x) => {
    if (x < padL || x > W - padR) return null;
    const b = clamp(Math.floor((x - padL) / cw), 0, BINS - 1), s = stack[b];
    const tot = s.reduce((a, c) => a + c, 0);
    if (!tot) return null;
    const rows = OUTCOME_KEYS.filter(([st]) => s[st]).map(([st, , lab]) => `${lab}: ${s[st]}`).join('<br>');
    return { x: padL + (b + 0.5) * cw, html: `<b>${pctTxt(lo + b * bw, 1)} … ${pctTxt(lo + (b + 1) * bw, 1)}</b><br>${tot} jalur<br>${rows}` };
  });
}

/* ---------- 4. waktu capai target: kurva peluang kumulatif (sumbu waktu log) ---------- */
export function drawTTT(cv, R, sim, cal) {
  const { ctx, W, H } = setup(cv, 240);
  const padL = 40, padR = 14, padT = 14, padB = 26;
  const C = { ink: css('--ink'), muted: css('--muted'), line: css('--line'), teal: css('--teal'), violet: css('--violet') };
  const T = sim.ttt, t0 = 1, t1 = Math.max(T.horizonMin, 10), N = sim.N;
  const X = (t) => padL + (Math.log(Math.max(t, t0) / t0) / Math.log(t1 / t0)) * (W - padL - padR);
  const Y = (p) => padT + (1 - p) * (H - padT - padB);

  for (const p of [0, 0.25, 0.5, 0.8, 1]) {
    hline(ctx, padL, W - padR, Y(p), C.line, p === 0.5 || p === 0.8 ? [3, 3] : []);
    tag(ctx, Math.round(p * 100) + '%', padL - 6, Y(p), C.muted, 'right');
  }
  for (const t of [1, 5, 15, 60, 240, 720, 1440, 4320, 10080, 43200].filter((t) => t <= t1)) {
    ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(X(t) + 0.5, padT); ctx.lineTo(X(t) + 0.5, H - padB); ctx.stroke();
    tag(ctx, fmtDurShort(t), X(t), H - 9, C.muted, 'center');
  }

  // Monte Carlo (tangga)
  const mc = [[X(t0), Y(0)]];
  let c = 0;
  for (const t of T.hitMin) { mc.push([X(t), Y(c / N)]); c++; mc.push([X(t), Y(c / N)]); }
  mc.push([X(t1), Y(c / N)]);
  band(ctx, mc, [[X(t0), Y(0)], [X(t1), Y(0)]], C.violet, 0.12);
  poly(ctx, mc, C.violet, 2);

  // kalibrasi dari jurnal trade nyata
  const n = 160, calPts = [];
  if (cal) for (let i = 0; i <= n; i++) { const t = t0 * (t1 / t0) ** (i / n); calPts.push([X(t), Y(cal.cdf(t))]); }
  if (cal) poly(ctx, calPts, C.teal, 2.4);

  const mark = (t, col, lab) => {
    if (t == null || t > t1) return;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(t), Y(0.5), 4, 0, Math.PI * 2); ctx.fill();
    tag(ctx, lab, X(t) + 7, Y(0.5) - 9, col);
  };
  if (cal) mark(cal.q(0.5), C.teal, fmtDur(cal.q(0.5)));
  mark(T.t50, C.violet, fmtDur(T.t50));

  hover(cv, (x) => {
    if (x < padL || x > W - padR) return null;
    const t = t0 * (t1 / t0) ** ((x - padL) / (W - padL - padR));
    return { x, html: `<b>≤ ${fmtDur(t)}</b><br>${cal ? `Jurnal: <b>${Math.round(cal.cdf(t) * 100)}%</b><br>` : ''}Monte Carlo: ${Math.round(T.cdf(t) * 100)}%` };
  });
}

/* ---------- 5. harga 30 hari + range rekomendasi ---------- */
export function drawSpark(cv, T, R) {
  const { ctx, W, H } = setup(cv, 170);
  const padL = 10, padR = 74, padT = 12, padB = 22;
  const C = { ink: css('--ink'), muted: css('--muted'), teal: css('--teal'), soft: css('--teal-soft'), coral: css('--coral') };
  const ps = T.pts.map((o) => o.p);
  let mn = Math.min(...ps), mx = Math.max(...ps);
  if (R) { mn = Math.min(mn, R.low); mx = Math.max(mx, R.high); }
  const span = mx - mn || 1; mn -= span * 0.06; mx += span * 0.06;
  const t0 = T.pts[0].t, tS = T.pts[T.pts.length - 1].t - t0 || 1;
  const X = (t) => padL + ((t - t0) / tS) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);
  if (R) {
    ctx.fillStyle = C.soft; ctx.fillRect(padL, Y(R.high), W - padL - padR, Y(R.low) - Y(R.high));
    tag(ctx, `range ${fmtPx(R.low)}–${fmtPx(R.high)}`, padL + 6, Y(R.high) + 9, C.teal);
  }
  const col = T.label === 'DOWNTREND' ? C.coral : T.label === 'UPTREND' ? C.teal : C.ink;
  const pts = T.pts.map((o) => [X(o.t), Y(o.p)]);
  band(ctx, pts, [[X(t0), H - padB], [X(T.pts[T.pts.length - 1].t), H - padB]], col, 0.07);
  poly(ctx, pts, col, 1.8);
  const last = pts[pts.length - 1];
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(last[0], last[1], 3.5, 0, Math.PI * 2); ctx.fill();
  tag(ctx, fmtPx(ps[ps.length - 1]), last[0] + 8, last[1], C.ink);
  for (const [t, lab] of [[-30, '30 hari lalu'], [-7, '7 hari'], [0, 'kini']]) if (t >= t0) tag(ctx, lab, X(t), H - 8, C.muted, t === 0 ? 'right' : 'left');
}
