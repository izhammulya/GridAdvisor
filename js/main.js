/* GRIDFISH v7 — wiring: form → data Pionex → model → simulasi → keputusan → tampilan */
import { SIM } from './config.js';
import { $, clamp, sleep, setSeed, fmtPx } from './util.js';
import { loadMarket } from './data.js';
import { dailyVol, microNoise, buildTrend, buildHMM } from './models.js';
import { buildReco } from './grid.js';
import { simulate, stressOpts, backtest } from './sim.js';
import { decide, optimize } from './decision.js';
import { repairState, simRepair, repairDecision } from './repair.js';
import { loadJournal, saveJournal, resetJournal, newEntry, parseJournal, toTSV, fitCalibration, predictTime, looCoverage, mcCoverage } from './journal.js';
import { drawCone, drawEquity, drawOutcome, drawTTT, drawSpark } from './charts.js';
import * as ui from './ui.js';

const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm', rpDir: 'short' };
let RUN_ID = '';
let LAST = null;               // hasil analisa terakhir (untuk menggambar ulang grafik)
let journal = loadJournal();
let calModel = null, loo = null, showAllJournal = false;

// ---------- kontrol segmen ----------
function selectSeg(el, b, key) {
  el.querySelectorAll('button').forEach((x) => { x.classList.remove('on', 'long', 'short'); x.setAttribute('aria-checked', 'false'); });
  b.classList.add('on'); b.setAttribute('aria-checked', 'true');
  if (b.dataset.v === 'long' || b.dataset.v === 'short') b.classList.add(b.dataset.v);
  S[key] = b.dataset.v;
}
function seg(id, key, onChange) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => b.setAttribute('role', 'radio'));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    selectSeg(el, b, key); onChange?.();
  });
}
const setSeg = (id, key, v) => { const b = $(id).querySelector(`button[data-v="${v}"]`); if (b) selectSeg($(id), b, key); };

function syncProduct() {
  const fut = S.prod === 'fut';
  document.querySelectorAll('.fut-only').forEach((el) => el.classList.toggle('hide', !fut));
  $('inTarget').placeholder = `otomatis ${fut ? '1% margin' : '0,30%'}`;
}
seg('segCoin', 'coin');
seg('segProd', 'prod', syncProduct);
seg('segDir', 'dir');
seg('segModel', 'model');
seg('segRpDir', 'rpDir');
syncProduct();

const tick = () => { $('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC'; };
tick(); setInterval(tick, 1000);

// ---------- tab ----------
let activeTab = 'decision';
const drawers = {
  time: () => LAST && drawTTT($('cvTTT'), LAST.R, LAST.sim, LAST.time.cal),
  mc: () => { if (!LAST) return; drawCone($('cvCone'), LAST.R, LAST.sim); drawEquity($('cvEquity'), LAST.R, LAST.sim); drawOutcome($('cvOutcome'), LAST.R, LAST.sim); },
  market: () => LAST && drawSpark($('cvSpark'), LAST.T, LAST.R),
};
function activateTab(name) {
  activeTab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hide', p.id !== 'tab-' + name));
  drawers[name]?.();
}
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) activateTab(b.dataset.tab); });
let rz = 0;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => drawers[activeTab]?.(), 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => drawers[activeTab]?.());

// ---------- input ----------
const numOr = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
const seedVal = () => $('inSeed').value.trim();
const seedTag = (t) => (seedVal() || 'auto-' + RUN_ID) + '|' + t;

function readCfg() {
  const fut = S.prod === 'fut';
  return {
    days: clamp(Math.round(numOr('inDays', 7)), 1, 30),
    fee: Math.max(0, numOr('inFee', 0.05)) / 100,
    invest: Math.max(10, numOr('inInvest', 50)),
    fut, dir: fut ? S.dir : 'neutral',
    lev: fut ? clamp(Math.round(numOr('inLev', 3)), 1, 10) : 1,
    funding: fut ? numOr('inFunding', 0) / 100 : 0,
    useHMM: S.model === 'hmm',
    width: clamp(numOr('inWidth', 1), 0.5, 2.5),
    targetUsd: Math.max(0, numOr('inTarget', 0)),
    exitOnTarget: $('inExit').checked,
  };
}

// ---------- estimasi waktu: jurnal (utama) + Monte Carlo ----------
function refreshCalibration() {
  calModel = fitCalibration(journal);
  loo = looCoverage(journal);
}
function timeEstimate(R, sim, stress) {
  const dirKey = R.fut ? R.dir : 'spot';
  const eta = sim.ttt.eta ? sim.ttt.eta.minutes : null;
  const p = predictTime(calModel, eta, S.coin, dirKey);
  const cal = p ? { ...p, legacyCover: calModel.legacyCover } : null;
  const primary = cal ? { q50: cal.q(0.5), q80: cal.q(0.8), src: `jurnal ${cal.n} trade` }
    : sim.ttt.t50 != null ? { q50: sim.ttt.t50, q80: sim.ttt.t80, src: 'Monte Carlo' } : null;
  return { cal, primary, coin: S.coin, dirKey, stress };
}

// ---------- analisa utama ----------
async function run() {
  const btn = $('btnGo');
  if (btn.disabled) return;
  btn.disabled = true;
  RUN_ID = Math.random().toString(36).slice(2, 10);
  const step = async (t) => { btn.textContent = t; await sleep(20); };
  try {
    await step('Mengambil data Pionex…');
    const cfg = readCfg();
    const { q, kl, m5, klSrc } = await loadMarket(S.coin, cfg.fut ? 'perp' : 'spot');
    ui.renderTicker(S.coin, q, klSrc);

    const V = dailyVol(q, kl, cfg.days);
    const T = buildTrend(q, V.vol, kl);
    const H = buildHMM(q, V.vol, kl, cfg.days);
    const noise = microNoise(m5);
    const R = buildReco(q, T, H, V, cfg);

    await step(`Simulasi ${SIM.N.toLocaleString()} jalur…`);
    const sim = simulate(R, H, { seed: seedVal(), noise });

    await step('Uji silang & backtest…');
    const Ralt = { ...R, useHMM: !R.useHMM, mu: R.useHMM ? T.muSim : H.muEff };
    const alt = simulate(Ralt, H, { n: SIM.N_X, coarse: true, light: true, seed: seedTag('alt'), noise });
    const stress = simulate(R, H, { n: SIM.N_X, coarse: true, light: true, seed: seedTag('stress'), noise, ...stressOpts(R) });
    const bt = backtest(R, kl);
    const d = decide({ R, base: sim, alt, stress, bt, T, H, V, q });
    const time = timeEstimate(R, sim, stress);

    LAST = { cfg, q, V, T, H, R, sim, d, time, noise };
    ui.renderHero({ R, d, sim, time });
    $('btnLog').addEventListener('click', logCurrent);
    ui.renderDecision(R, d, { base: sim, alt, stress, bt }, V);
    ui.renderReco(R, sim);
    ui.renderTime(R, sim, time, loo);
    ui.renderMC(R, sim);
    ui.renderMarket(q, V, T, H, R, sim, noise);
    drawers[activeTab]?.();
    if (matchMedia('(max-width: 920px)').matches) $('hero').scrollIntoView({ block: 'start' });

    try {
      const opt = await optimize({ q, T, H, V, noise }, cfg, seedTag, (i, n) => { btn.textContent = `Screening alternatif ${i}/${n}…`; });
      ui.renderOptimizer(opt, cfg, applyCfg);
    } catch (e) {
      console.error(e);
      $('decAlt').innerHTML = `<p class="small">Screening alternatif gagal: ${e.message}</p>`;
    }
  } catch (e) {
    console.error(e);
    $('hero').innerHTML = `<p class="hero-q">Analisa gagal</p><p class="hero-sub">${e.message}. Periksa input lalu coba lagi.</p>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Analisa setup';
  }
}

function applyCfg(c) {
  if (c.fut) { setSeg('segDir', 'dir', c.dir); $('inLev').value = c.lev; }
  $('inWidth').value = c.width.toFixed(2);
  activateTab('decision');
  $('hero').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  run();
}

// ---------- jurnal ----------
function refreshJournal() {
  refreshCalibration();
  ui.renderJournal(journal, calModel, loo, mcCoverage(journal), showAllJournal);
}
function commitJournal() { saveJournal(journal); refreshJournal(); }

function logCurrent() {
  if (!LAST) return;
  const { R, sim, time } = LAST;
  journal.push(newEntry({
    coin: S.coin, dir: time.dirKey, pred: sim.ttt.eta ? Math.round(sim.ttt.eta.minutes) : null,
    mc50: sim.ttt.t50, mc80: sim.ttt.t80, modal: R.invest, target: R.targetUsd, profit: null,
  }));
  commitJournal();
  $('logNote').textContent = 'Tercatat. Isi durasi aktual di tab Jurnal setelah bot ditutup.';
}

$('jTable').addEventListener('change', (e) => {
  const inp = e.target.closest('input[data-id]'); if (!inp) return;
  const r = journal.find((x) => x.id === inp.dataset.id); if (!r) return;
  const v = parseFloat(inp.value);
  r.actual = isFinite(v) && v >= 0 ? v : null;
  commitJournal();
});
$('jTable').addEventListener('click', (e) => {
  if (e.target.closest('#btnJAll')) { showAllJournal = true; refreshJournal(); return; }
  const b = e.target.closest('button[data-del]'); if (!b) return;
  journal = journal.filter((x) => x.id !== b.dataset.del);
  commitJournal();
});
$('btnJImport').addEventListener('click', () => $('jImportBox').classList.toggle('hide'));
$('btnJImportApply').addEventListener('click', () => {
  const rows = parseJournal($('jImportText').value);
  if (!rows.length) { $('jImportText').placeholder = 'Tidak ada baris terbaca. Kolom minimal: koin, arah, prediksi, aktual.'; $('jImportText').value = ''; return; }
  journal = rows; commitJournal();
  $('jImportBox').classList.add('hide'); $('jImportText').value = '';
});
$('btnJExport').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  try { await navigator.clipboard.writeText(toTSV(journal)); b.textContent = 'Tersalin — tempel ke spreadsheet'; }
  catch (_) { b.textContent = 'Clipboard diblokir browser'; }
  setTimeout(() => (b.textContent = 'Salin sebagai TSV'), 2200);
});
$('btnJReset').addEventListener('click', () => {
  if (confirm('Ganti jurnal dengan 114 trade bawaan? Entri yang Anda catat akan hilang.')) { journal = resetJournal(); refreshJournal(); }
});

// ---------- repair ----------
async function runRepair() {
  const btn = $('btnRepair');
  btn.disabled = true; btn.textContent = 'Mengambil data…';
  try {
    const { q, kl, m5 } = await loadMarket(S.coin, 'perp');
    const n = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
    const c = repairState({
      dir: S.rpDir, qty: n('rpQty', 0), avg: n('rpAvg', 0), price: n('rpPrice', 0),
      low: n('rpLow', 0), high: n('rpHigh', 0), grids: n('rpGrids', 2), qtyGrid: n('rpQtyGrid', 1),
      fee: Math.max(0, n('rpFee', 0.05)) / 100, funding: n('rpFund', 0.01) / 100,
      pnl: n('rpPnl', 0), gridProfit: n('rpGridProfit', 0), invest: Math.max(1, n('rpInvest', 1)),
      avail: Math.max(0, n('rpAvail', 0)), liq: n('rpLiq', 0), target: n('rpTarget', 0), days: n('rpDays', 30),
    }, q.price);
    if (!(c.high > c.low && c.low > 0 && c.qty > 0)) throw new Error('range atau qty per grid tidak valid');
    if (c.liq > 0 && (c.dir === 'short' ? c.P0 >= c.liq : c.P0 <= c.liq))
      throw new Error(`harga ${S.coin} sekarang (${fmtPx(c.P0)}) sudah melewati harga likuidasi ${fmtPx(c.liq)} — pastikan koin di setup sama dengan bot, atau isi "Harga sekarang"`);

    setSeed(seedVal());
    const V = dailyVol(q, kl, c.days);
    const H = buildHMM(q, V.vol, kl, c.days);
    const noise = microNoise(m5);
    const adds = [...new Set([0, 0.25, 0.5, 1].map((f) => Math.round(c.avail * f)))];
    const rows = [];
    for (const [i, a] of adds.entries()) {
      btn.textContent = `Skenario ${i + 1}/${adds.length}…`; await sleep(20);
      rows.push(simRepair(c, H, a, V, noise));
    }
    ui.renderRepair(c, rows, repairDecision(c, rows), S.coin, q, H);
  } catch (e) {
    console.error(e);
    $('repairBody').innerHTML = `<div class="warnbox">Analisa gagal: ${e.message}. Periksa angka posisi.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Analisa repair';
  }
}

$('btnGo').addEventListener('click', run);
$('btnRepair').addEventListener('click', runRepair);
refreshJournal();
