/* /api/klines — candle dari Pionex (Vercel Serverless Function)
   GET /api/klines?symbol=INJ&interval=60M|5M|15M|1M&limit=1000&market=spot|perp
   Respons: { symbol, pionexSymbol, interval, klines: [{ t, o, h, l, c, v }] }  (urut waktu naik)

   Pionex membatasi 500 candle per request → di sini dipaginasi mundur pakai endTime.
   Cache: 60 detik (5M/1M), 5 menit (interval lain). */

const ALLOWED = new Set(['LINK', 'SOL', 'ETH', 'INJ']);
const INTERVALS = new Set(['1M', '5M', '15M', '30M', '60M', '4H', '8H', '12H', '1D']);
const BASE = 'https://api.pionex.com';
const PAGE = 500, MAX_TOTAL = 1500;
const cache = new Map();

async function getJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

const norm = (k) => ({
  t: +k.time, o: parseFloat(k.open), h: parseFloat(k.high), l: parseFloat(k.low), c: parseFloat(k.close), v: parseFloat(k.volume) || 0,
});

async function fetchAll(pSym, interval, limit) {
  const byTime = new Map();
  let endTime = null;
  while (byTime.size < limit) {
    const n = Math.min(PAGE, limit - byTime.size);
    const url = `${BASE}/api/v1/market/klines?symbol=${pSym}&interval=${interval}&limit=${n}` + (endTime ? `&endTime=${endTime}` : '');
    const j = await getJSON(url);
    const rows = j && j.data && Array.isArray(j.data.klines) ? j.data.klines.map(norm).filter((k) => k.t > 0 && k.c > 0) : [];
    if (!rows.length) break;
    const before = byTime.size;
    let oldest = Infinity;
    for (const k of rows) { byTime.set(k.t, k); if (k.t < oldest) oldest = k.t; }
    if (byTime.size === before || rows.length < n) break; // tidak ada data lebih lama
    endTime = oldest - 1;
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const interval = String(req.query.interval || '60M').toUpperCase();
  const limit = Math.max(1, Math.min(MAX_TOTAL, parseInt(req.query.limit, 10) || 500));
  const market = String(req.query.market || 'spot').toLowerCase() === 'perp' ? 'perp' : 'spot';
  if (!ALLOWED.has(symbol)) return res.status(400).json({ error: 'Symbol tidak didukung: ' + symbol });
  if (!INTERVALS.has(interval)) return res.status(400).json({ error: 'Interval tidak didukung: ' + interval });

  const key = [symbol, interval, limit, market].join('|');
  const ttl = interval === '1M' || interval === '5M' ? 60_000 : 300_000;
  const hit = cache.get(key);
  res.setHeader('cache-control', 'no-store');
  if (hit && Date.now() - hit.at < ttl) {
    res.setHeader('x-cache', 'HIT');
    return res.status(200).json(hit.data);
  }

  const cands = market === 'perp' ? [`${symbol}_USDT_PERP`, `${symbol}_USDT`] : [`${symbol}_USDT`];
  const errors = [];
  for (const pSym of cands) {
    try {
      const klines = await fetchAll(pSym, interval, limit);
      if (klines.length < 50) throw new Error(`${pSym}: hanya ${klines.length} candle`);
      const data = { symbol, pionexSymbol: pSym, interval, klines };
      cache.set(key, { at: Date.now(), data });
      res.setHeader('x-cache', 'MISS');
      return res.status(200).json(data);
    } catch (e) { errors.push(e.message); }
  }
  return res.status(502).json({ error: 'Pionex klines: ' + errors.join('; ') });
}
