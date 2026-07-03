/* GRIDFISH — Pionex Grid Advisor (LINK/SOL/ETH)
   - Harga: /api/quotes (proxy CoinMarketCap, on-demand saja)
   - Rekomendasi: range, jumlah grid, trigger, TP/SL, est. liq
   - Validasi: 5.000 simulasi Monte Carlo (GBM) dari volatilitas 1h/24h/7d/30d
   Model aproksimasi — bukan jaminan profit. */

'use strict';

// ---------- state ----------
const S = { coin: 'LINK', prod: 'spot', dir: 'long' };
const N_SIM = 5000;
const $ = (id) => document.getElementById(id);

// harga fallback bila API key belum di-set (mode demo)
const DEMO = {
  LINK: { price: 7.83, change_1h: -0.3, change_24h: -2.1, change_7d: -5.4, change_30d: 4.2 },
  SOL:  { price: 145.2, change_1h: 0.2, change_24h: 1.8, change_7d: -3.9, change_30d: 9.5 },
  ETH:  { price: 3412.5, change_1h: 0.1, change_24h: 0.9, change_7d: 2.7, change_30d: 6.1 },
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

// ---------- mesin rekomendasi ----------
function buildReco(q) {
  const P = q.price;
  const days = Math.max(1, +$('inDays').value || 7);
  const fee = Math.max(0, +$('inFee').value || 0.05) / 100;
  const invest = Math.max(10, +$('inInvest').value || 50);
  const fut = S.prod === 'fut';
  const dir = fut ? S.dir : 'neutral';
  const lev = fut ? Math.min(10, Math.max(1, Math.round(+$('inLev').value || 3))) : 1;

  const vol = dailyVol(q);
  const horizonVol = vol * Math.sqrt(days);
  const z = 1.28; // ~80% containment

  // range menurut arah
  let lowM = z, highM = z;
  if (dir === 'long') { lowM = 1.25 * z; highM = 0.85 * z; }
  if (dir === 'short') { lowM = 0.85 * z; highM = 1.25 * z; }
  const low = P * (1 - lowM * horizonVol);
  const high = P * (1 + highM * horizonVol);

  // jumlah grid: target profit bersih per grid ~0.35%
  const netPerGrid = 0.0035;
  const grossStepPct = netPerGrid + 2 * fee;
  let grids = Math.round((high - low) / (P * grossStepPct));
  grids = Math.min(200, Math.max(6, grids));
  const step = (high - low) / grids;
  const profitPerGridNet = step / P - 2 * fee; // % dari modal per-grid

  // trigger, TP, SL, liq
  const trigger = dir === 'long' ? P * 0.998 : dir === 'short' ? P * 1.002 : null;
  const sl = dir === 'short' ? high * 1.02 : low * 0.98;
  const tp = dir === 'short' ? low : high;
  const mmr = 0.005;
  const liq = !fut || dir === 'neutral' ? null
    : dir === 'long' ? P * (1 - (1 - mmr) / lev)
    : P * (1 + (1 - mmr) / lev);

  return { P, days, fee, invest, fut, dir, lev, vol, low, high, grids, step, profitPerGridNet, trigger, sl, tp, liq };
}

// ---------- Monte Carlo 5.000 path ----------
let gaussSpare = null;
function gauss() {
  if (gaussSpare !== null) { const v = gaussSpare; gaussSpare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  const m = Math.sqrt(-2 * Math.log(s) / s);
  gaussSpare = v * m; return u * m;
}

function simulate(R) {
  const stepsPerDay = 24, n = Math.round(R.days * stepsPerDay), dt = 1 / stepsPerDay;
  const sigH = R.vol * Math.sqrt(dt);
  // drift momentum kecil (dibatasi) dari arah pasar 7 hari
  const mu = 0;

  const notional = R.invest * R.lev;
  const perGridCap = notional / R.grids;
  const stepPct = R.step / R.P;
  const netGrid = perGridCap * (stepPct - 2 * R.fee); // profit $ per siklus grid

  const pnl = new Float64Array(N_SIM);
  const endPx = new Float64Array(N_SIM);
  let liqCount = 0, slCount = 0;
  const samplePaths = [];

  for (let i = 0; i < N_SIM; i++) {
    let p = R.P;
    let level = Math.floor((p - R.low) / R.step);
    // inventori awal: long grid langsung buka posisi pada grid di atas harga; neutral setengah
    let inv = R.dir === 'long' ? Math.max(0, R.grids - level)
            : R.dir === 'short' ? Math.max(0, level)
            : Math.round(R.grids / 2);
    const inv0 = inv;
    let realized = 0, dead = false, deadPx = 0;
    const keepPath = i < 60 ? [p] : null;

    for (let t = 0; t < n; t++) {
      p = p * Math.exp((mu - 0.5 * sigH * sigH) * 1 + sigH * gauss());
      if (keepPath) keepPath.push(p);

      // liq / SL menghentikan path
      if (R.liq && ((R.dir === 'long' && p <= R.liq) || (R.dir === 'short' && p >= R.liq))) {
        realized = -R.invest; dead = true; deadPx = p; liqCount++; break;
      }
      if ((R.dir !== 'short' && p <= R.sl) || (R.dir === 'short' && p >= R.sl)) {
        // stop loss: rugi floating pada SL + realized sejauh ini
        dead = true; deadPx = p; slCount++; break;
      }

      const nl = Math.min(R.grids, Math.max(0, Math.floor((p - R.low) / R.step)));
      if (nl > level) { // harga naik melewati grid
        const up = nl - level;
        if (R.dir !== 'short') { const fills = Math.min(up, inv); realized += fills * netGrid; inv -= fills; }
        else { inv += up; }
      } else if (nl < level) { // harga turun melewati grid
        const dn = level - nl;
        if (R.dir === 'short') { const fills = Math.min(dn, inv); realized += fills * netGrid; inv -= fills; }
        else { inv += dn; }
      }
      level = nl;
    }

    // floating PnL dari inventori tersisa (aproksimasi: entry rata-rata = tengah zona held)
    let float_ = 0;
    const pEnd = dead ? deadPx : p;
    if (realized !== -R.invest) {
      const heldCap = Math.min(inv, R.grids) * perGridCap;
      if (R.dir !== 'short') {
        const avgEntry = (Math.min(pEnd, R.P) + R.low) / 2 + R.step * 0.5;
        const deltaInv = Math.max(0, inv - inv0) * perGridCap; // posisi yg dibuka saat harga turun
        const baseInv = Math.min(inv, inv0) * perGridCap;      // posisi awal
        float_ = baseInv * (pEnd - R.P) / R.P + deltaInv * (pEnd - avgEntry) / avgEntry;
        if (R.dir === 'neutral') float_ *= 0.5;
      } else {
        const avgEntry = (Math.max(pEnd, R.P) + R.high) / 2 - R.step * 0.5;
        const deltaInv = Math.max(0, inv - inv0) * perGridCap;
        const baseInv = Math.min(inv, inv0) * perGridCap;
        float_ = baseInv * (R.P - pEnd) / R.P + deltaInv * (avgEntry - pEnd) / avgEntry;
      }
      // batasi kerugian futures pada margin
      float_ = Math.max(float_, -R.invest - realized);
    }

    pnl[i] = realized === -R.invest ? -R.invest : realized + float_;
    endPx[i] = pEnd;
    if (keepPath) samplePaths.push(keepPath);
  }

  const pct = Array.from(pnl, (x) => (x / R.invest) * 100).sort((a, b) => a - b);
  const q = (p) => pct[Math.min(pct.length - 1, Math.floor(p * pct.length))];
  const prob = (f) => pct.filter(f).length / pct.length;

  return {
    pct, samplePaths,
    median: q(0.5), p5: q(0.05), p95: q(0.95),
    pWin: prob((x) => x > 0),
    p1: prob((x) => x >= 1),
    p2: prob((x) => x >= 2),
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

function frow(label, sub, value, copyVal) {
  const cp = copyVal == null ? '' :
    `<button class="cp" data-cp="${copyVal}">salin</button>`;
  return `<div class="frow"><div class="fk">${label}<s>${sub || ''}</s></div>
          <div class="fv"><b>${value}</b>${cp}</div></div>`;
}

function renderReco(R, sim) {
  const dirLabel = R.fut ? { long: 'Long', short: 'Short', neutral: 'Neutral' }[R.dir] : 'Spot (Neutral)';
  $('recoTitle').textContent = `Rekomendasi ${S.coin}/USDT — ${R.fut ? 'Futures Grid' : 'Grid Trading'} · ${dirLabel}`;
  const conf = sim.p1 * 100;
  $('recoBadge').textContent = 'CONFIDENCE ' + conf.toFixed(0) + '%';
  $('recoBadge').className = 'badge ' + (conf >= 55 ? 'live' : 'demo');

  let h = '';
  if (R.fut) h += frow('Arah', 'pilih tab di Pionex', dirLabel);
  h += frow('1. Price Range', 'Lowest price USDT', fmt(R.low), fmt(R.low));
  h += frow('', 'Highest Price USDT', fmt(R.high), fmt(R.high));
  h += frow('2. Quantity of Grids', 'Profit/grid net ≈ ' + (R.profitPerGridNet * 100).toFixed(2) + '%', R.grids, R.grids);
  h += frow('3. Investment', R.fut ? 'margin USDT' : 'total USDT', fmt(R.invest, 2), fmt(R.invest, 2));
  if (R.fut) h += frow('Leverage', 'dropdown ' + R.lev + 'x', R.lev + 'x');
  h += frow('Trigger price', 'opsional', R.trigger ? fmt(R.trigger) : '— (kosongkan)', R.trigger ? fmt(R.trigger) : null);
  h += frow('Take Profit', 'stop by price', fmt(R.tp), fmt(R.tp));
  h += frow('Stop Loss', 'stop by price', fmt(R.sl), fmt(R.sl));
  h += frow('Grid mode', 'pilih', 'Arithmetic');
  if (R.liq) h += frow('Est. liq price', 'pembanding — jaga SL sebelum liq', fmt(R.liq));
  $('recoBody').innerHTML = h;

  $('recoBody').querySelectorAll('.cp').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.cp.replace(/,/g, ''));
      b.textContent = '✓'; setTimeout(() => (b.textContent = 'salin'), 900);
    }));
}

function renderStats(R, sim) {
  const cell = (k, v, cls = '', barPct = null) =>
    `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div>${
      barPct == null ? '' : `<div class="bar"><i style="width:${Math.min(100, barPct)}%"></i></div>`}</div>`;
  $('simStats').innerHTML =
    cell('P(profit ≥ +1%)', (sim.p1 * 100).toFixed(1) + '%', sim.p1 >= 0.5 ? 'up' : '', sim.p1 * 100) +
    cell('P(profit ≥ +2%)', (sim.p2 * 100).toFixed(1) + '%', '', sim.p2 * 100) +
    cell('P(PnL > 0)', (sim.pWin * 100).toFixed(1) + '%', sim.pWin >= 0.5 ? 'up' : 'dn', sim.pWin * 100) +
    cell('Median PnL', pctTxt(sim.median), pctCls(sim.median)) +
    cell('P5 / P95', pctTxt(sim.p5) + ' / ' + pctTxt(sim.p95)) +
    cell(R.liq ? 'P(likuidasi) / P(SL)' : 'P(stop loss)',
         (R.liq ? (sim.pLiq * 100).toFixed(1) + '% / ' : '') + (sim.pSL * 100).toFixed(1) + '%',
         (sim.pLiq + sim.pSL) > 0.2 ? 'dn' : '');
  $('simMeta').textContent = `MONTE CARLO · ${N_SIM.toLocaleString()} PATH · ${R.days} HARI · σ ${(R.vol * 100).toFixed(2)}%/HARI`;
}

// ---------- charts (canvas, tanpa library) ----------
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

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
  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText('60 SAMPLE PATH DARI ' + N_SIM.toLocaleString() + ' — ZONA HIJAU = RANGE GRID', padL, H - 5);
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
    ctx.fillStyle = c >= 1 ? css('--green') : c >= 0 ? '#9CC7A6' : css('--red');
    ctx.fillRect(X(i) + 1, H - padB - h, (W - padL - padR) / bins - 2, h);
  }
  // garis 0% dan +1%
  [[0, css('--ink'), '0%'], [1, css('--green'), '+1%']].forEach(([v, col, lab]) => {
    if (v < lo || v > hi) return;
    const x = padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
    ctx.strokeStyle = col; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col; ctx.font = '10px ui-monospace'; ctx.fillText(lab, x + 3, padT + 10);
  });
  ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace';
  ctx.fillText('DISTRIBUSI PnL % TERHADAP MODAL — ' + N_SIM.toLocaleString() + ' SIMULASI', padL, H - 6);
}

// ---------- main ----------
$('btnGo').addEventListener('click', async () => {
  const btn = $('btnGo');
  btn.disabled = true; btn.textContent = 'MENGAMBIL HARGA…';
  const q = await getQuote(S.coin);
  btn.textContent = 'MENJALANKAN 5.000 SIMULASI…';
  await new Promise((r) => setTimeout(r, 30)); // biarkan UI update

  const R = buildReco(q);
  renderMarket(q, R.vol);
  const sim = simulate(R);
  renderReco(R, sim);
  renderStats(R, sim);
  drawPaths(R, sim);
  drawHist(sim);

  btn.disabled = false; btn.textContent = 'Minta Rekomendasi';
});
