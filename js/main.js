/* GRIDFISH v8 — wiring: form → data Pionex + jurnal Google Sheet → model → simulasi → keputusan → tampilan */
import { SIM, JOURNAL } from './config.js';
import { $, clamp, sleep, setSeed, fmtPx } from './util.js';
import { loadMarket } from './data.js';
import { dailyVol, microNoise, buildTrend, buildHMM } from './models.js';
import { evaluate, optimize, better } from './decision.js';
import { repairState, simRepair, repairDecision } from './repair.js';
import { fetchSheet, loadSheetCache, savePasted, parsePaste, loadPending, savePending, newPending, matchPending,
  fitTimeModel, predictTime, forwardTest, mcCoverage, groupStats } from './journal.js';
import { drawCone, drawEquity, drawOutcome, drawTTT, drawSpark } from './charts.js';
import * as ui from './ui.js';

const S = { coin: 'LINK', prod: 'spot', dir: 'long', model: 'hmm', rpDir: 'short' };
let RUN_ID = '';
let LAST = null;               // hasil yang sedang ditampilkan (untuk menggambar ulang grafik)
let CTX = null;                // potret pasar dari analisa terakhir (dipakai ulang oleh alternatif)
let OPT = null;                // { rows, rest } setting alternatif
let BUSY = false;

let sheet = loadSheetCache();  // { rows, at, src }
let pending = loadPending();
let timeModel = null, fwd = null, syncMsg = '';

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
  time: () => LAST && drawTTT($('cvTTT'), LAST.R, LAST.sim, LAST.time.jt),
  mc: () => { if (!LAST) return; drawCone($('cvCone'), LAST.R, LAST.sim); drawEquity($('cvEquity'), LAST.R, LAST.sim); drawOutcome($('cvOutcome'), LAST.R, LAST.sim); },
  market: () => LAST && drawSpark($('cvSpark'), CTX.T, LAST.R),
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
// semua simulasi dalam satu analisa memakai seed turunan yang sama → hasil bisa diulang & dibandingkan
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

/* ---------- estimasi waktu: jurnal (utama, bila relevan) + Monte Carlo ----------
   Jurnal dipakai sebagai angka utama hanya bila: futures, ≥ 8 trade untuk koin|arah itu,
   dan target (% modal) masih dalam kebiasaan jurnal (0,5× – 2,5× median). Di luar itu → Monte Carlo. */
function timeEstimate(coin, R, sim) {
  const dirKey = R.fut ? R.dir : 'spot';
  const jt = R.fut ? predictTime(timeModel, coin, dirKey) : null;
  const rate = R.targetUsd / R.invest, typ = timeModel ? timeModel.typTarget : null;
  const offTarget = !!(typ && (rate < 0.5 * typ || rate > 2.5 * typ));
  const T = sim.ttt;
  const mc = T.t50 != null ? { q50: T.t50, q80: T.t80, q90: T.t90 } : null;
  let why = null;
  if (!R.fut) why = 'jurnal hanya berisi bot futures';
  else if (!jt) why = 'jurnal belum cukup';
  else if (jt.nGroup < 8) why = `baru ${jt.nGroup} trade ${coin} ${dirKey} di jurnal`;
  else if (offTarget) why = `target ${(rate * 100).toFixed(2)}% modal di luar kebiasaan jurnal (${(typ * 100).toFixed(2)}%)`;
  const primary = !why ? { q50: jt.q(0.5), q80: jt.q(0.8), q90: jt.q(0.9), kind: 'journal', src: `jurnal · ${jt.nGroup} trade ${coin} ${dirKey}` }
    : mc ? { ...mc, kind: 'mc', src: 'Monte Carlo' } : null;
  return { jt, mc, primary, why, coin, dirKey, at: Date.now(), pNever: 1 - sim.pTouch };
}

// ---------- jurnal ----------
function refreshJournal() {
  timeModel = fitTimeModel(sheet.rows);
  fwd = forwardTest(sheet.rows);
  ui.renderJournal({ sheet, pending, model: timeModel, fwd, mcCov: mcCoverage(pending), groups: groupStats(sheet.rows), syncMsg });
}
async function syncJournal(force) {
  if (!force && sheet.at && sheet.src === 'sheet' && Date.now() - sheet.at < JOURNAL.STALE_MS) return;
  const btn = $('btnJSync');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyinkronkan…'; }
  try {
    const before = sheet.rows.length;
    sheet = await fetchSheet();
    const filled = matchPending(pending, sheet.rows);
    if (filled) savePending(pending);
    const added = sheet.rows.length - before;
    syncMsg = `Tersinkron ${new Date(sheet.at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`
      + (added > 0 ? ` · ${added} baris baru` : '') + (filled ? ` · ${filled} setup terisi otomatis` : '');
  } catch (e) {
    syncMsg = `Sheet tidak terjangkau (${e.message}) — memakai ${sheet.src === 'bawaan' ? 'salinan bawaan 23 Nov 2026' : 'data tersimpan terakhir'}.`;
  }
  refreshJournal();
}

function logCurrent() {
  if (!LAST || !LAST.time.primary) return;
  const { R, sim, time } = LAST;
  const pred = Math.max(1, Math.round(time.primary.q50));
  pending.push(newPending({
    coin: time.coin, dir: time.dirKey, pred, mc50: sim.ttt.t50, mc80: sim.ttt.t80,
    jq50: time.jt ? time.jt.q(0.5) : null, modal: R.invest, target: R.targetUsd, sheetN: sheet.rows.length,
  }));
  savePending(pending); refreshJournal();
  $('logNote').textContent = `Tercatat. Namai bot ${ui.botName(time)} — begitu barisnya muncul di sheet, durasi aktual terisi otomatis.`;
}

// ---------- tampilkan satu hasil evaluasi (utama atau alternatif yang diterapkan) ----------
function show(res) {
  const time = timeEstimate(CTX.coin, res.R, res.sim);
  LAST = { ...res, time };
  ui.renderHero(LAST);
  $('btnLog')?.addEventListener('click', logCurrent);
  ui.renderDecision(res.R, res.d, res, CTX.V);
  ui.renderReco(res.R, res.sim);
  ui.renderTime(res.R, res.sim, time, fwd);
  ui.renderMC(res.R, res.sim);
  ui.renderMarket(CTX.q, CTX.V, CTX.T, CTX.H, res.R, res.sim, CTX.noise);
  drawers[activeTab]?.();
}
function showOptimizer() {
  if (!OPT) return;
  OPT.rows.sort((a, b) => better(a, b) || (b.cur ? 1 : 0) - (a.cur ? 1 : 0));
  ui.renderOptimizer(OPT, { onApply: applyResult, onVerify: verifyRow });
}

// ---------- analisa utama ----------
async function run() {
  const btn = $('btnGo');
  if (BUSY) return;
  BUSY = true; btn.disabled = true;
  RUN_ID = Math.random().toString(36).slice(2, 10);
  const step = async (t) => { btn.textContent = t; await sleep(20); };
  try {
    await step('Mengambil data Pionex & jurnal…');
    const cfg = readCfg(), coin = S.coin;
    const [{ q, kl, m5, klSrc }] = await Promise.all([loadMarket(coin, cfg.fut ? 'perp' : 'spot'), syncJournal(false)]);
    ui.renderTicker(coin, q, klSrc);

    const V = dailyVol(q, kl, cfg.days);
    const T = buildTrend(q, V.vol, kl);
    const H = buildHMM(q, V.vol, kl, cfg.days);
    CTX = { coin, q, kl, klSrc, V, T, H, noise: microNoise(m5) };
    OPT = null;
    $('decAlt').innerHTML = '<p class="small" style="margin-top:14px">Mencari setting alternatif…</p>';

    const main = await evaluate(CTX, cfg, seedTag, (s) => step(s === 'sim' ? `Simulasi ${SIM.N.toLocaleString()} jalur…` : 'Uji silang & backtest…'));
    show(main);
    if (matchMedia('(max-width: 920px)').matches) $('hero').scrollIntoView({ block: 'start' });

    try {
      OPT = await optimize(CTX, main, seedTag, (t) => { btn.textContent = t; });
      showOptimizer();
    } catch (e) {
      console.error(e);
      $('decAlt').innerHTML = `<p class="small">Pencarian alternatif gagal: ${e.message}</p>`;
    }
  } catch (e) {
    console.error(e);
    $('hero').innerHTML = `<p class="hero-q">Analisa gagal</p><p class="hero-sub">${e.message}. Periksa input lalu coba lagi.</p>`;
  } finally {
    BUSY = false; btn.disabled = false; btn.textContent = 'Analisa setup';
  }
}

/* "Terapkan": hasil uji penuh yang SUDAH ditampilkan di tabel dinaikkan menjadi keputusan utama.
   Tidak ada simulasi ulang → keputusan di atas dijamin sama dengan yang tertulis di tabel. */
function applyResult(res) {
  if (BUSY || !OPT) return;
  const c = res.cfg;
  if (c.fut) { setSeg('segDir', 'dir', c.dir); $('inLev').value = c.lev; }
  $('inWidth').value = c.width.toFixed(2);
  OPT.rows.forEach((r) => { r.cur = r === res; });
  show(res);
  showOptimizer();
  activateTab('decision');
  $('hero').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
// baris yang baru di-screening: jalankan pipeline penuh dulu, baru boleh diterapkan
async function verifyRow(row, btn) {
  if (BUSY || !OPT) return;
  BUSY = true; $('btnGo').disabled = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Menguji…'; }
  await sleep(20);
  try {
    const res = await evaluate(CTX, row.cfg, seedTag);
    OPT.rest = OPT.rest.filter((r) => r !== row);
    OPT.rows.push(res);
    showOptimizer();
  } catch (e) { console.error(e); }
  finally { BUSY = false; $('btnGo').disabled = false; }
}

// ---------- tab jurnal: aksi ----------
$('tab-journal').addEventListener('click', (e) => {
  if (e.target.closest('#btnJSync')) { syncJournal(true); return; }
  if (e.target.closest('#btnJImport')) { $('jImportBox').classList.toggle('hide'); return; }
  if (e.target.closest('#btnJImportApply')) {
    const rows = parsePaste($('jImportText').value);
    if (rows.length < 5) { $('jImportText').value = ''; $('jImportText').placeholder = 'Tidak ada baris terbaca. Salin tabel "Evaluasi agent" beserta header-nya.'; return; }
    sheet = savePasted(rows);
    if (matchPending(pending, sheet.rows)) savePending(pending);
    syncMsg = `${rows.length} baris ditempel manual.`;
    refreshJournal();
    return;
  }
  const del = e.target.closest('button[data-del]');
  if (del) { pending = pending.filter((x) => x.id !== del.dataset.del); savePending(pending); refreshJournal(); }
});
$('tab-journal').addEventListener('change', (e) => {
  const inp = e.target.closest('input[data-id]'); if (!inp) return;
  const r = pending.find((x) => x.id === inp.dataset.id); if (!r) return;
  const v = parseFloat(inp.value);
  r.actual = isFinite(v) && v >= 0 ? v : null; r.manual = r.actual != null;
  savePending(pending); refreshJournal();
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
syncJournal(false);
