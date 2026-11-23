/* data pasar: Pionex (lewat proxy /api) → fallback Binance → fallback demo */
import { DEMO, KLINES, CACHE_MS } from './config.js';

async function getJSON(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j;
  } finally { clearTimeout(to); }
}

// ---------- harga terkini ----------
async function fetchQuote(sym, market) {
  try {
    const j = await getJSON(`/api/quotes?symbol=${sym}&market=${market}`);
    if (!(j && j.price > 0)) throw new Error('respon /api/quotes tidak valid');
    return { ...j, demo: false };
  } catch (e) {
    return { symbol: sym, ...DEMO[sym], demo: true, src: 'DEMO', reason: e.message };
  }
}

// ---------- candle ----------
const BINANCE_IV = { '60M': '1h', '5M': '5m' };
const cache = new Map();
const valid = (k) => k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0 && k.h >= k.l;

async function fetchKlines(sym, { interval, limit }, market) {
  const key = `${sym}|${interval}|${market}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c.val;

  let val = null;
  try {
    const j = await getJSON(`/api/klines?symbol=${sym}&interval=${interval}&limit=${limit}&market=${market}`, 15000);
    if (Array.isArray(j.klines) && j.klines.length >= 100) val = { data: j.klines.filter(valid), src: 'PIONEX' };
  } catch (_) { /* lanjut ke fallback */ }

  if (!val) {
    try {
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=${BINANCE_IV[interval]}&limit=${Math.min(limit, 1000)}`;
      const j = await getJSON(url);
      if (Array.isArray(j) && j.length >= 100) {
        val = { data: j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).filter(valid), src: 'BINANCE' };
      }
    } catch (_) { /* tanpa candle */ }
  }
  if (val) cache.set(key, { at: Date.now(), val });
  return val;
}

/* Satu pintu untuk semua data pasar.
   Harga diambil dari ticker Pionex; perubahan 1J/7H/30H dihitung dari candle supaya konsisten. */
export async function loadMarket(sym, market = 'spot') {
  const [q0, h1, m5] = await Promise.all([
    fetchQuote(sym, market),
    fetchKlines(sym, KLINES.H1, market),
    fetchKlines(sym, KLINES.M5, market),
  ]);
  const kl = h1 ? h1.data : null;
  const q = { ...q0 };

  if (kl && kl.length > 24) {
    if (q.demo) Object.assign(q, { price: kl[kl.length - 1].c, demo: false, src: h1.src, reason: null });
    const n = kl.length;
    const chg = (h) => (n - 1 - h >= 0 ? (q.price / kl[n - 1 - h].c - 1) * 100 : null);
    q.change_1h = chg(1);
    q.change_7d = chg(168);
    q.change_30d = chg(Math.min(720, n - 1));
    if (q.change_24h == null || !isFinite(q.change_24h)) q.change_24h = chg(24);
  }
  q.last_updated = q.last_updated || new Date().toISOString();
  return { q, kl, m5: m5 ? m5.data : null, klSrc: h1 ? h1.src : null, m5Src: m5 ? m5.src : null };
}
