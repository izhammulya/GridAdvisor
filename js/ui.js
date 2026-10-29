/* rendering HTML: hero, tab keputusan, setting, waktu, Monte Carlo, pasar, repair, jurnal */
import { DEC, SIM, TAIL_K, PARAM_SD } from './config.js';
import { $, fmt, fmtPx, pctTxt, pct1, pct0, fmtDur, signCls, escapeHtml } from './util.js';
import { verdictLabel, verdictCls } from './decision.js';
import { stressOpts } from './sim.js';
import { OUTCOME_KEYS } from './charts.js';

const dirName = (c) => (c.fut ? { long: 'Long', short: 'Short', neutral: 'Neutral' }[c.dir] : 'Spot');
const dot = (st) => `<span class="dot ${st}" aria-label="${st}"></span>`;
const table = (head, rows) => `<div class="tbl-wrap"><table class="t"><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.join('')}</table></div>`;

// ---------- ticker di top bar ----------
export function renderTicker(coin, q, klSrc) {
  const c24 = q.change_24h;
  $('ticker').innerHTML = `<span class="px">${coin} ${fmtPx(q.price)}</span>
    <span class="${signCls(c24 || 0)}">${pctTxt(c24)} 24j</span>
    <span class="src ${q.demo ? 'demo' : ''}">${q.demo ? 'demo — ' + escapeHtml(q.reason || 'API mati') : (q.src === 'PIONEX' ? 'Pionex ' + (q.market || 'spot') : q.src)}${klSrc && klSrc !== q.src ? ' · candle ' + klSrc : ''}</span>`;
}

// ---------- hero ----------
export function renderHero({ R, d, sim, time }) {
  const cls = 'v-' + verdictCls(d.verdict);
  const size = d.verdict === 'GO'
    ? (d.size === 1 ? `Investasi penuh ${fmt(R.invest, 2)} USDT` : `Setengah ukuran: ${fmt(R.invest / 2, 2)} USDT`)
    : d.verdict === 'HOLD' ? 'Tunggu, jalankan ulang nanti' : 'Jangan buka dengan setting ini';
  const failN = d.checks.filter((c) => c.st === 'fail').map((c) => c.name.toLowerCase());
  const why = d.caps[0] || (failN.length ? 'Gagal: ' + failN.join(', ') + '.' : d.verdict === 'GO' ? 'Kriteria utama lolos.' : `Skor di zona abu-abu (${DEC.NOGO}–${DEC.GO - 1}).`);

  const main = time.primary;
  const risk = R.fut
    ? { k: 'Risiko likuidasi', v: pct1(sim.pLiq), s: `stress ${pct1(time.stress ? time.stress.pLiq : null)}`, c: sim.pLiq > 0.01 ? 'neg' : '' }
    : { k: 'Kena stop loss', v: pct1(sim.pSL), s: `stress ${pct1(time.stress ? time.stress.pSL : null)}`, c: sim.pSL > 0.1 ? 'neg' : '' };

  $('hero').innerHTML = `
    <div class="hero-grid ${cls}">
      <div>
        <div class="verdict-word">${d.verdict}</div>
        <div class="verdict-size">${size}</div>
        <div class="verdict-why">${escapeHtml(why)}</div>
        <div class="meter" role="img" aria-label="Skor ${d.score} dari 100"><i style="width:${d.score}%"></i></div>
        <div class="meter-lab"><span>Skor ${d.score}/100</span><span>HOLD ≥${DEC.NOGO} · GO ≥${DEC.GO} · penuh ≥${DEC.FULL}</span></div>
      </div>
      <div class="kpis">
        <div class="kpi"><div class="k">Peluang kena target</div><div class="v">${pct0(d.pCons)}</div>
          <div class="s">+${fmt(R.targetUsd, 2)} USDT dalam ${R.days} hari</div></div>
        <div class="kpi"><div class="k">Estimasi waktu (median)</div><div class="v">${main ? fmtDur(main.q50) : '—'}</div>
          <div class="s">${main ? `80% dalam ≤ ${fmtDur(main.q80)} · ${main.src}` : 'target jarang tercapai'}</div></div>
        <div class="kpi"><div class="k">${risk.k}</div><div class="v ${risk.c}">${risk.v}</div><div class="s">${risk.s}</div></div>
        <div class="kpi"><div class="k">Rata-rata 5% terburuk</div><div class="v neg">${fmt((sim.es5 * R.invest) / 100, 2)}</div>
          <div class="s">USDT · ${pctTxt(sim.es5)} modal</div></div>
      </div>
    </div>
    <div class="hero-actions">
      <button class="btn" id="btnLog" type="button">Catat setup ini ke jurnal</button>
      <span class="note" id="logNote">Setelah bot ditutup, isi durasi aktual di tab Jurnal — estimasi waktu ikut makin akurat.</span>
    </div>`;
}

// ---------- tab keputusan ----------
export function renderDecision(R, d, X, V) {
  const { base, alt, stress, bt } = X;
  const todo = [...d.caps, ...d.fixes];
  const todoHtml = todo.length && !(d.verdict === 'GO' && d.size === 1)
    ? `<div class="todo"><b>${d.verdict === 'GO' ? 'Supaya bisa GO 100%' : 'Supaya bisa GO'}</b><ul>${todo.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>` : '';

  const ck = table(['Kriteria', 'Nilai', 'Status', 'Poin'], d.checks.map((c) =>
    `<tr><td>${dot(c.st)}${c.name}${c.hard ? '<span class="gate">gerbang</span>' : ''}</td><td class="wrap">${c.val}</td>
     <td>${{ ok: 'lolos', warn: 'perhatian', fail: 'gagal' }[c.st]}</td><td>${c.max ? `${Math.round(c.pts)}/${c.max}` : c.pts ? Math.round(c.pts) : '—'}</td></tr>`));

  const xrow = (name, note, r) => `<tr><td><b>${name}</b><br><span class="small">${note}</span></td>
    <td>${pct1(r.pTarget)}</td><td>${r.t50 != null ? fmtDur(r.t50) : '—'}</td>${R.fut ? `<td class="${r.pLiq > 0.03 ? 'neg' : ''}">${pct1(r.pLiq)}</td>` : ''}
    <td>${pct1(r.pSL)}</td><td class="${signCls(r.median)}">${pctTxt(r.median)}</td><td class="neg">${pctTxt(r.es5)}</td></tr>`;
  const so = stressOpts(R);
  const xr = [xrow('Model utama', `${R.useHMM ? 'HMM' : 'GBM'} · ${base.N.toLocaleString()} jalur`, base)];
  if (alt) xr.push(xrow('Model alternatif', `${R.useHMM ? 'GBM' : 'HMM'} · ${alt.N.toLocaleString()} jalur`, alt));
  if (stress) xr.push(xrow('Stress', `σ×${so.volMult}${so.driftD ? ' + drift melawan arah' : ''}`, stress));
  if (bt && bt.n > 0) xr.push(xrow('Backtest historis', `${bt.n} jendela · ≈${bt.indep.toFixed(1)} periode independen${d.btOk ? '' : ' (info saja)'}`, bt));
  const xt = table(['Uji silang', 'P(target)', 'Median waktu', ...(R.fut ? ['P(liq)'] : []), 'P(SL)', 'Median PnL', 'ES5'], xr);

  const until = new Date(Date.now() + DEC.VALID_MIN * 60000);
  const band = 0.2 * V.vol;
  $('decBody').innerHTML = `${todoHtml}
    <h3 class="sec">Kenapa ${verdictLabel(d)}</h3>${ck}
    <h3 class="sec">Uji silang</h3>${xt}
    <div class="valid">Berlaku sampai <b>${until.toTimeString().slice(0, 5)}</b> selama harga di <b>${fmtPx(R.P * (1 - band))} – ${fmtPx(R.P * (1 + band))}</b>. Di luar itu, jalankan ulang sebelum membuka bot.</div>
    <p class="small">Aturan: gerbang gagal atau skor &lt; ${DEC.NOGO} → NO-GO. Skor ${DEC.NOGO}–${DEC.GO - 1}, data tidak live, atau lonjakan 1 jam → HOLD. Skor ≥ ${DEC.GO} → GO; GO 100% bila skor ≥ ${DEC.FULL} tanpa kriteria gagal. Peluang gabungan = 50% model utama + 20% alternatif + 20% stress + ≤10% backtest.</p>`;
  $('decAlt').innerHTML = '<p class="small" style="margin-top:14px">Mencari setting alternatif…</p>';
}

export function renderOptimizer(opt, cfg, onApply) {
  const cur = opt.find((o) => o.cur), best = opt[0];
  const top = opt.slice(0, 6);
  if (cur && !top.includes(cur)) top.push(cur);
  const rank = { GO: 2, HOLD: 1, 'NO-GO': 0 };
  const desc = (o) => (o.cfg.fut ? `${dirName(o.cfg)} ${o.cfg.lev}x, lebar ×${o.cfg.width.toFixed(2)}` : `lebar ×${o.cfg.width.toFixed(2)}`);
  const summary = !cur || best === cur ? 'Setting Anda sudah yang terbaik di antara kombinasi yang diuji.'
    : rank[best.d.verdict] > rank[cur.d.verdict] || best.d.size > cur.d.size || best.d.score >= cur.d.score + 5
      ? `Lebih baik: <b>${desc(best)}</b> — ${verdictLabel(best.d)}, skor ${best.d.score} vs ${cur.d.score}.`
      : 'Tidak ada alternatif yang jelas lebih baik — selisihnya masih dalam noise screening.';
  const rows = top.map((o) => `<tr class="${o.cur ? 'cur' : ''}">
    ${cfg.fut ? `<td>${dirName(o.cfg)}</td><td>${o.cfg.lev}x</td>` : ''}<td>×${o.cfg.width.toFixed(2)}</td>
    <td>${fmtPx(o.R.low)} – ${fmtPx(o.R.high)}</td><td>${o.R.grids}</td><td>${pct1(o.base.pTarget)}</td>
    <td>${o.base.t50 != null ? fmtDur(o.base.t50) : '—'}</td>
    ${cfg.fut ? `<td class="${o.base.pLiq > 0.01 ? 'neg' : ''}">${pct1(o.base.pLiq)} / ${pct1(o.stress.pLiq)}</td>` : ''}
    <td class="neg">${pctTxt(o.base.es5)}</td><td><b>${o.d.score}</b></td>
    <td><span class="chip ${verdictCls(o.d.verdict)}">${verdictLabel(o.d)}</span></td>
    <td>${o.cur ? '<span class="small">sekarang</span>' : `<button class="cp" data-i="${opt.indexOf(o)}">Terapkan</button>`}</td></tr>`);
  $('decAlt').innerHTML = `<h3 class="sec">Setting alternatif</h3><p class="para">${summary}</p>
    ${table([...(cfg.fut ? ['Arah', 'Lev'] : []), 'Lebar', 'Range', 'Grid', 'P(target)', 'Median waktu', ...(cfg.fut ? ['P(liq) / stress'] : []), 'ES5', 'Skor', 'Keputusan', ''], rows)}
    <p class="small" style="margin-top:8px">Screening ${opt.length} kombinasi × ${SIM.N_OPT} jalur (+${SIM.N_OPT_S} stress), langkah 15 menit, angka acak sama untuk semua kombinasi. "Terapkan" mengisi form lalu menjalankan analisa lengkap.</p>`;
  $('decAlt').querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => onApply(opt[+b.dataset.i].cfg)));
}

// ---------- tab setting Pionex ----------
function crow(label, sub, value, copy) {
  return `<div class="crow"><div class="ck">${label}${sub ? `<small>${sub}</small>` : ''}</div><div class="cv">${value}</div>
    ${copy != null ? `<button class="cp" data-cp="${copy}">Salin</button>` : '<span class="cp-ph"></span>'}</div>`;
}
function ruler(R) {
  const marks = [
    ['Low', R.low, 'var(--teal)'], ['High', R.high, 'var(--teal)'], ['Entry', R.P, 'var(--ink)'],
    ['SL', R.slLow, 'var(--coral)'], ['SL', R.slHigh, 'var(--coral)'],
    ['TP', R.tpHigh ?? R.tpLow, 'var(--teal)'], ['Liq', R.liqLow, 'var(--coral)'], ['Liq', R.liqHigh, 'var(--coral)'],
  ].filter(([, v]) => v != null && isFinite(v));
  // TP yang sama dengan High/Low tidak perlu digambar dua kali
  const uniq = marks.filter(([lab, v], i) => !(lab === 'TP' && marks.some(([l2, v2], j) => j !== i && l2 !== 'TP' && Math.abs(v2 - v) < 1e-9)));
  const vs = uniq.map((m) => m[1]);
  const mn = Math.min(...vs), mx = Math.max(...vs), pad = (mx - mn) * 0.06 || 1;
  const pos = (v) => ((v - mn + pad) / (mx - mn + 2 * pad)) * 100;
  const sorted = [...uniq].sort((a, b) => a[1] - b[1]);
  return `<div class="ruler" aria-label="Posisi harga penting">
    <div class="track"></div>
    <div class="rng" style="left:${pos(R.low)}%;width:${pos(R.high) - pos(R.low)}%"></div>
    ${sorted.map(([lab, v, col], i) => `<div class="mk" style="left:${pos(v)}%;background:${col}"></div>
      <div class="ml ${i % 2 ? 'dn' : 'up'}" style="left:${pos(v)}%;color:${col}">${lab}<small>${fmtPx(v)}</small></div>`).join('')}
  </div>`;
}
export function renderReco(R, sim) {
  const tp = R.tpHigh ?? R.tpLow;
  const sl = R.slLow != null && R.slHigh != null ? `${fmtPx(R.slLow)} / ${fmtPx(R.slHigh)}` : fmtPx(R.slLow ?? R.slHigh);
  const lq = [R.liqLow != null ? '↓ ' + fmtPx(R.liqLow) : null, R.liqHigh != null ? '↑ ' + fmtPx(R.liqHigh) : null].filter(Boolean).join('  ') || '—';
  const raw = (x) => (x == null ? null : String(+x.toFixed(8)));
  $('recoBody').innerHTML = `
    ${R.liqBeforeSL ? `<div class="warnbox">Likuidasi tercapai sebelum Stop Loss — turunkan leverage atau persempit SL.</div>` : ''}
    <h3 class="sec">${R.fut ? 'Futures grid · ' + dirName(R) : 'Grid trading spot'} — isi berurutan</h3>
    ${ruler(R)}
    <div class="copylist">
      ${R.fut ? crow('Arah', 'tab di Pionex', dirName(R)) : ''}
      ${crow('Harga terendah', 'Lowest price (USDT)', fmtPx(R.low), raw(R.low))}
      ${crow('Harga tertinggi', 'Highest price (USDT)', fmtPx(R.high), raw(R.high))}
      ${crow('Jumlah grid', !R.fut && R.points != null ? `${R.points} point ÷ ${R.divisor} + 1${R.feeAdjusted ? ', dikurangi agar profit > fee' : ''}` : 'profit bersih ≈ ' + (R.profitPerGridNet * 100).toFixed(2) + '% per grid', R.grids, R.grids)}
      ${crow('Mode grid', '', 'Arithmetic')}
      ${crow('Investasi', R.fut ? 'margin USDT' : 'total USDT', fmt(R.invest, 2), raw(R.invest))}
      ${R.fut ? crow('Leverage', '', R.lev + 'x', R.lev) : ''}
      ${crow('Trigger price', 'opsional', R.trigger ? fmtPx(R.trigger) : 'kosongkan', R.trigger ? raw(R.trigger) : null)}
      ${crow('Take profit', 'stop by price', tp != null ? fmtPx(tp) : 'kosongkan', tp != null ? raw(tp) : null)}
      ${crow('Stop loss', 'stop by price', sl, R.slLow != null && R.slHigh != null ? null : raw(R.slLow ?? R.slHigh))}
    </div>
    <h3 class="sec">Angka pendukung</h3>
    <div class="stats">
      <div><div class="k">Profit per grid</div><div class="v">${(R.profitPerGridNet * 100).toFixed(3)}%</div><div class="s">bersih fee 2 sisi</div></div>
      <div><div class="k">Qty per grid (model)</div><div class="v">${fmt(R.qty, 4)}</div><div class="s">koin, investasi×lev ÷ grid</div></div>
      <div><div class="k">Target</div><div class="v">${fmt(R.targetUsd, 2)} USDT</div><div class="s">${R.exitOnTarget ? 'bot ditutup saat tercapai' : 'dicek di akhir horizon'}</div></div>
      <div><div class="k">Lebar range</div><div class="v">×${R.width.toFixed(2)}</div><div class="s">±1.28σ√hari</div></div>
      ${R.fut ? `<div><div class="k">Perkiraan liq</div><div class="v">${lq}</div><div class="s">dinamis, grid ikut terisi</div></div>
      <div><div class="k">Funding</div><div class="v">${(R.funding * 100).toFixed(3)}%</div><div class="s">per 8 jam (asumsi)</div></div>` : ''}
      <div><div class="k">Confidence</div><div class="v">${(sim.pTarget * 100).toFixed(1)}%</div><div class="s">± ${sim.se.toFixed(1)}% noise simulasi</div></div>
    </div>`;
  $('recoBody').querySelectorAll('.cp[data-cp]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.cp); b.textContent = 'Tersalin'; }
    catch (_) { b.textContent = 'Gagal'; }
    setTimeout(() => (b.textContent = 'Salin'), 1100);
  }));
}

// ---------- tab waktu target ----------
export function renderTime(R, sim, time, loo) {
  const T = sim.ttt, cal = time.cal;
  const head = cal
    ? `<p class="para">Dari <b>${cal.n}</b> trade di jurnal Anda (${cal.nGroup} untuk ${time.coin} ${time.dirKey}), setup seperti ini biasanya kena target dalam <b>${fmtDur(cal.q(0.5))}</b>.
       Seperempat tercepat ≤ ${fmtDur(cal.q(0.25))}; 80% ≤ <b>${fmtDur(cal.q(0.8))}</b>; 10% paling lambat butuh lebih dari ${fmtDur(cal.q(0.9))}.</p>`
    : '<p class="para">Jurnal belum cukup (minimal 12 trade selesai) — estimasi di bawah murni dari Monte Carlo.</p>';
  const mc = T.t50 != null
    ? `Monte Carlo: separuh jalur menyentuh target dalam <b>${fmtDur(T.t50)}</b>${T.t80 != null ? `, 80% dalam ${fmtDur(T.t80)}` : `; 80% tidak tercapai dalam ${R.days} hari`}.`
    : `Monte Carlo: hanya ${pct1(sim.pTouch)} jalur menyentuh target dalam ${R.days} hari.`;

  const marks = [5, 15, 30, 60, 120, 240, 720, 1440].filter((t) => t <= T.horizonMin);
  if (marks[marks.length - 1] !== T.horizonMin) marks.push(T.horizonMin);
  const buckets = marks.map((t) => {
    const p = cal ? cal.cdf(t) : T.cdf(t);
    return `<div class="bucket"><div class="fill" style="height:${Math.round(p * 100)}%"></div>
      <div class="bk">≤ ${fmtDur(t)}</div><div class="bv">${pct0(p)}</div>${cal ? `<div class="bm">MC ${pct0(T.cdf(t))}</div>` : ''}</div>`;
  }).join('');

  const e = T.eta;
  $('tttBody').innerHTML = `${head}<p class="para">${mc}</p>
    <div class="buckets">${buckets}</div>
    <div class="legend"><span><i style="background:var(--teal)"></i>Terkalibrasi jurnal</span><span><i style="background:var(--violet)"></i>Monte Carlo</span></div>`;
  $('tttNote').innerHTML = `
    <h3 class="sec">Seberapa bisa dipercaya</h3>
    <div class="stats">
      <div><div class="k">ETA dasar (rumus v6)</div><div class="v">${e ? fmtDur(e.minutes) : '—'}</div><div class="s">${cal ? `di jurnal, ${pct0(cal.legacyCover)} trade selesai sebelum angka ini` : 'angka lama, bukan median'}</div></div>
      ${loo ? `<div><div class="k">Uji jujur batas 50%</div><div class="v">${pct0(loo.c50)}</div><div class="s">trade selesai ≤ median (ideal 50%)</div></div>
      <div><div class="k">Uji jujur batas 80%</div><div class="v">${pct0(loo.c80)}</div><div class="s">trade selesai ≤ batas 80% (ideal 80%)</div></div>
      <div><div class="k">Meleset tipikal</div><div class="v">×${loo.mdlFactor.toFixed(1)}</div><div class="s">rasio aktual vs median</div></div>` : ''}
    </div>
    <p class="small">Waktu hit sangat acak: dari data Anda, trade dengan ETA sama bisa selesai dalam 1 menit atau 20 jam. Karena itu yang ditampilkan adalah rentang peluang, bukan satu angka.
    "Uji jujur" = leave-one-out: tiap trade ditebak dari model yang dilatih tanpa trade itu. Monte Carlo memakai langkah 1 menit di 2 jam pertama, 5 menit s/d 24 jam, lalu ${60 / sim.plan.subs[sim.plan.subs.length - 1]} menit, plus noise mikrostruktur dari candle 5 menit Pionex.</p>`;
}

// ---------- tab Monte Carlo ----------
export function renderMC(R, sim) {
  $('mcHead').innerHTML = `<div class="stats">
    <div><div class="k">P(≥ target di akhir)</div><div class="v">${pct1(sim.pTarget)}</div><div class="s">± ${sim.se.toFixed(1)}%</div></div>
    <div><div class="k">P(menyentuh target)</div><div class="v">${pct1(sim.pTouch)}</div><div class="s">${sim.ttt.t50 != null ? 'median ' + fmtDur(sim.ttt.t50) : 'median tak tercapai'}</div></div>
    <div><div class="k">P(PnL &gt; 0)</div><div class="v ${sim.pWin >= 0.5 ? 'pos' : 'neg'}">${pct1(sim.pWin)}</div><div class="s">rata-rata ${pctTxt(sim.mean)}</div></div>
    <div><div class="k">Bot berhenti</div><div class="v ${sim.pLiq + sim.pSL > 0.2 ? 'neg' : ''}">${pct1(sim.pLiq + sim.pSL)}</div><div class="s">${R.fut ? `liq ${pct1(sim.pLiq)} · ` : ''}SL ${pct1(sim.pSL)}</div></div>
    <div><div class="k">Harga H+${R.days} (median)</div><div class="v">${fmtPx(sim.pxP50)}</div><div class="s">90%: ${fmtPx(sim.pxP5)} – ${fmtPx(sim.pxP95)}</div></div>
  </div>`;
  $('outLegend').innerHTML = OUTCOME_KEYS.map(([st, col, lab]) => {
    const n = sim.stArr.reduce((a, s) => a + (s === st), 0);
    return n ? `<span><i style="background:var(${col})"></i>${lab} ${pct1(n / sim.N)}</span>` : '';
  }).join('');

  const row = (m, a, b, c, f) => `<tr><td>${m}</td><td class="${signCls(a)}">${f(a)}</td><td class="${signCls(b)}">${f(b)}</td><td class="${signCls(c)}">${f(c)}</td></tr>`;
  const usd = (p) => fmt((p * R.invest) / 100, 2);
  const sh = sim.shP50 >= 2 ? 'sangat baik' : sim.shP50 >= 1 ? 'baik' : sim.shP50 >= 0 ? 'lemah' : 'negatif';
  $('mcSummary').innerHTML = `<h3 class="sec">Ringkasan persentil</h3>
    ${table(['Metrik', 'P5 (buruk)', 'P50 (median)', 'P95 (bagus)'], [
      row('Total return', sim.p5, sim.median, sim.p95, pctTxt),
      row('Max drawdown', sim.ddP5, sim.ddP50, sim.ddP95, pctTxt),
      ...(R.exitOnTarget ? [] : [row('Sharpe', sim.shP5, sim.shP50, sim.shP95, (x) => x.toFixed(2))]),
      row('Siklus grid', sim.cyP5, sim.cyP50, sim.cyP95, (x) => x.toFixed(0)),
    ])}
    <p class="para" style="margin-top:12px">Skenario tengah berakhir <b>${pctTxt(sim.median)}</b> (≈ ${usd(sim.median)} USDT); 5% terburuk ≤ ${pctTxt(sim.p5)} dengan rata-rata ${pctTxt(sim.es5)} (≈ ${usd(sim.es5)} USDT).
    ${R.exitOnTarget ? '' : `Sharpe median ${sim.shP50.toFixed(2)} (${sh}). `}${sim.mean < sim.median ? 'Rata-rata di bawah median → ada ekor kiri: sedikit skenario rugi besar.' : 'Tidak ada ekor rugi ekstrem yang dominan.'}</p>
    <p class="small">${R.useHMM ? 'HMM 3-regime' : 'GBM'} · ${sim.N.toLocaleString()} jalur antithetic · bridge intrabar · fat-tail ${((R.tailP || 0) * 100).toFixed(1)}% jam (σ×${TAIL_K}) · ketidakpastian σ ${PARAM_SD * 100}% · σ ${(R.vol * 100).toFixed(2)}%/hari.</p>`;
}

// ---------- tab pasar ----------
export function renderMarket(q, V, T, H, R, sim, noise) {
  const names = ['Bull', 'Side', 'Bear'], key = ['bull', 'side', 'bear'];
  const dom = H.alpha.indexOf(Math.max(...H.alpha));
  const vrTag = (o) => (o.z <= -2 ? 'mean-reverting' : o.z >= 2 ? 'trending' : 'mendekati random walk');
  const ch = (k, v) => `<div><div class="k">${k}</div><div class="v ${signCls(v || 0)}">${pctTxt(v)}</div></div>`;
  $('mktBody').innerHTML = `<div class="stats">
      ${ch('1 jam', q.change_1h)}${ch('24 jam', q.change_24h)}${ch('7 hari', q.change_7d)}${ch('30 hari', q.change_30d)}
      <div><div class="k">Volatilitas</div><div class="v">${(V.vol * 100).toFixed(2)}%</div><div class="s">σ per hari</div></div>
      <div><div class="k">Trend</div><div class="v ${T.label === 'UPTREND' ? 'pos' : T.label === 'DOWNTREND' ? 'neg' : ''}">${T.label.toLowerCase()}</div><div class="s">${pctTxt(T.slope * 100)}/hari · R² ${(T.r2 * 100).toFixed(0)}%</div></div>
    </div>
    <h3 class="sec">Regime pasar sekarang</h3>
    <div class="regime">${H.alpha.map((p, k) => `<div class="${key[k]}" style="flex:${Math.max(p, 0.001)}">${p > 0.08 ? `${names[k]} ${pct0(p)}` : ''}</div>`).join('')}</div>
    <p class="small">${H.fitted ? `HMM di-fit pada ${H.nObs} return 1 jam (3 inisialisasi). Dominan: ${names[dom]}. σ per regime: ${H.sgD.map((s, k) => `${names[k]} ${(s * 100).toFixed(1)}%`).join(', ')}/hari.` : 'Candle tidak tersedia → HMM heuristik (kasar).'}</p>
    <h3 class="sec">30 hari terakhir &amp; range rekomendasi</h3>`;
  const g = V.garch;
  $('mktNotes').innerHTML = `<h3 class="sec">Karakter harga</h3><div class="stats">
      <div><div class="k">Variance ratio 6 jam</div><div class="v">${V.vr6 ? V.vr6.vr.toFixed(2) : '—'}</div><div class="s">${V.vr6 ? vrTag(V.vr6) : 'butuh candle 1 jam'}${V.vr24 ? ` · 24 jam ${V.vr24.vr.toFixed(2)}` : ''}</div></div>
      ${g ? `<div><div class="k">GARCH σ sekarang</div><div class="v">${(g.nowD * 100).toFixed(2)}%</div><div class="s">jangka panjang ${(g.lrD * 100).toFixed(2)}% · half-life ${isFinite(g.hl) ? g.hl.toFixed(0) + ' jam' : '∞'}</div></div>` : ''}
      <div><div class="k">Fat tail</div><div class="v">${((V.tailP || 0) * 100).toFixed(1)}%</div><div class="s">jam "stres" σ×${TAIL_K}${V.kurt ? ` · kurtosis ${V.kurt.toFixed(1)}` : ''}</div></div>
      <div><div class="k">Noise 5 menit</div><div class="v">${noise.n ? (noise.share * 100).toFixed(0) + '%' : '—'}</div><div class="s">${noise.n ? `bagian varians 5m yang balik arah · VR(1j/5m) ${noise.vr.toFixed(2)}` : 'candle 5 menit tidak tersedia'}</div></div>
    </div>
    <p class="small">Prediksi harga H+${R.days}: median ${fmtPx(sim.pxP50)}, 90% di ${fmtPx(sim.pxP5)} – ${fmtPx(sim.pxP95)}. Sumber volatilitas: ${V.src}.</p>`;
}

// ---------- tab repair ----------
export function renderRepair(c, rows, D, coin, q, H) {
  const rec = D.rec;
  const dur = (m) => (m == null ? `> ${c.days} hari` : fmtDur(m));
  const range = (r) => (r.m25 == null ? '' : `<br><span class="small">${dur(r.m25)} – ${dur(r.m75)}</span>`);
  let text;
  if (D.v === 'ADD' || D.v === 'HOLD') {
    text = `<b>${D.v === 'ADD' ? `Tambah ${fmt(rec.add, 0)} USDT ke bot.` : 'Tahan bot tanpa menambah dana.'}</b>
      Nilai harapan ${fmt(rec.ev, 2)} USDT, lebih baik dari cut loss sekarang (${fmt(D.cutNow, 2)} USDT).
      Liq jadi ${fmtPx(rec.liqP)} (${(Math.abs(rec.liqP / c.P0 - 1) * 100).toFixed(1)}% dari harga), P(likuidasi ${c.days} hari) ${pct1(rec.pLiq)}.
      ${pct0(rec.pRec)} jalur mencapai +${fmt(rec.target, 2)} USDT — median <b>${dur(rec.m50)}</b>.`;
  } else if (D.why === 'liq') {
    text = `<b>Tutup bot.</b> Tidak ada skenario tambah dana yang menekan P(likuidasi) ≤ 5% (teraman ${pct1(rec.pLiq)}). Cut sekarang ≈ ${fmt(D.cutNow, 2)} USDT.`;
  } else {
    text = `<b>Tutup bot.</b> Menahan memberi nilai harapan ${fmt(rec.ev, 2)} USDT, tidak lebih baik dari mengunci rugi sekarang (${fmt(D.cutNow, 2)} USDT). Coba target lebih kecil atau horizon lebih panjang.`;
  }
  const cls = D.v === 'CUT' ? 'v-nogo' : D.v === 'HOLD' ? 'v-hold' : 'v-go';
  const tr = rows.map((r) => `<tr class="${r === rec ? 'rec' : ''}"><td><b>${fmt(r.add, 0)}</b>${r === rec ? ' ★' : ''}</td><td>+${fmt(r.target, 2)}</td>
    <td>${fmtPx(r.liqP)}</td><td class="${r.pLiq > 0.05 ? 'neg' : 'pos'}">${pct1(r.pLiq)}</td><td>${pct1(r.pRec)}</td><td>${pct1(r.pRec7)}</td>
    <td><b>${dur(r.m50)}</b>${range(r)}</td>
    <td class="${r.ev > D.cutNow ? 'pos' : 'neg'}">${fmt(r.ev, 2)}</td><td class="neg">${fmt(r.es5, 2)}</td></tr>`);
  tr.push(`<tr><td colspan="7" class="small">Cut loss sekarang (total profit − fee penutupan)</td><td><b>${fmt(D.cutNow, 2)}</b></td><td></td></tr>`);
  $('repairBody').innerHTML = `
    <div class="rp-verdict ${cls}"><div class="verdict-word">${D.v}</div><p class="para">${text}</p></div>
    <p class="small" style="margin-bottom:10px">${coin} ${c.dir}${q.demo ? ' (harga demo)' : ''}: ${c.Q0} koin @ ${fmtPx(c.avg)}, harga ${fmtPx(c.P0)}, total profit ${fmt(c.pnl, 2)} USDT, offset kalibrasi ${fmt(c.offset, 2)} USDT.
    ${Math.abs(c.Qs - c.Q0) > c.qty * 0.01 ? `Posisi bukan kelipatan qty/grid — model memakai ${c.nUnits} unit (${fmt(c.Qs, 4)} koin).` : ''}</p>
    ${table(['Tambah (USDT)', 'Target', 'Liq awal', 'P(liq)', `P(pulih ≤ ${c.days} hari)`, 'P(≤ 7 hari)', 'Median waktu', 'EV', 'ES5'], tr)}
    <p class="small" style="margin-top:10px">ADD/HOLD hanya bila P(liq) ≤ 5% dan EV lebih baik dari cut loss minimal ${fmt(D.margin, 2)} USDT; bila setara dipilih tambahan terkecil.
    Likuidasi dikalibrasi dari harga liq Pionex, dicek di tiap titik intrabar; volatilitas ${H.fitted ? `HMM ${H.nObs} candle` : 'heuristik'}; ${SIM.N_REPAIR.toLocaleString()} jalur per skenario.</p>`;
}

// ---------- tab jurnal ----------
export function renderJournal(rows, cal, loo, mcCov, showAll = false) {
  const done = rows.filter((r) => r.actual != null).length;
  $('jStats').innerHTML = `<div class="stats">
    <div><div class="k">Trade tercatat</div><div class="v">${rows.length}</div><div class="s">${done} selesai · ${rows.length - done} belum diisi</div></div>
    <div><div class="k">Waktu nyata ÷ ETA dasar</div><div class="v">${cal ? '×' + cal.medRatio.toFixed(2) : '—'}</div><div class="s">median; ETA lama terlalu lambat</div></div>
    <div><div class="k">Kalibrasi lolos uji 80%</div><div class="v">${loo ? pct0(loo.c80) : '—'}</div><div class="s">leave-one-out, ideal 80%</div></div>
    <div><div class="k">Prediksi MC v7 vs aktual</div><div class="v">${mcCov ? pct0(mcCov.c50) : '—'}</div><div class="s">${mcCov ? `selesai ≤ median MC (ideal 50%), n=${mcCov.n}` : 'butuh ≥ 3 entri dari aplikasi'}</div></div>
  </div>`;
  const LIM = showAll ? 2000 : 30;
  const recent = [...rows].reverse().slice(0, LIM);
  const tr = recent.map((r) => `<tr>
    <td>${r.ts ? new Date(r.ts).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : `<span class="small">${r.source === 'seed' ? 'data awal' : 'impor'}</span>`}</td>
    <td>${escapeHtml(r.coin)}</td><td>${escapeHtml(r.dir)}</td><td>${r.pred != null ? Math.round(r.pred) : '—'}</td>
    <td>${r.mc50 != null ? Math.round(r.mc50) : '—'}</td>
    <td><input type="number" min="0" step="1" data-id="${r.id}" value="${r.actual ?? ''}" placeholder="menit" aria-label="Durasi aktual"></td>
    <td>${r.profit ?? ''}</td><td><button class="cp" data-del="${r.id}" aria-label="Hapus">Hapus</button></td></tr>`);
  $('jTable').innerHTML = table(['Waktu', 'Koin', 'Arah', 'ETA dasar', 'MC P50', 'Aktual (menit)', 'Profit', ''], tr)
    + (rows.length > LIM ? `<p style="margin-top:8px"><button class="btn" type="button" id="btnJAll">Tampilkan semua ${rows.length} entri</button></p>` : '');
}
