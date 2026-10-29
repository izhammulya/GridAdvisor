/* /api/quotes — harga terkini dari Pionex (Vercel Serverless Function)
   GET /api/quotes?symbol=LINK|SOL|ETH|INJ&market=spot|perp
   Respons: { symbol, pionexSymbol, market, price, open_24h, high_24h, low_24h, change_24h, volume_24h, src, last_updated }

   Catatan Pionex:
   - simbol memakai underscore: LINK_USDT, perpetual: LINK_USDT_PERP
   - ticker 24 jam berisi open/close/high/low (tanpa field persentase) → change_24h = close/open − 1
   Cache in-memory 30 detik per simbol+market. */

const ALLOWED = new Set(['LINK', 'SOL', 'ETH', 'INJ']); // ← tambah koin baru di sini
const BASE = 'https://api.pionex.com';
const CACHE_MS = 30 * 1000;
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

const candidates = (sym, market) =>
  market === 'perp' ? [`${sym}_USDT_PERP`, `${sym}_USDT`] : [`${sym}_USDT`];

async function fetchTicker(pSym) {
  const j = await getJSON(`${BASE}/api/v1/market/tickers?symbol=${pSym}`);
  const t = j && j.result !== false && j.data && Array.isArray(j.data.tickers)
    ? j.data.tickers.find((x) => x.symbol === pSym) : null;
  if (!t) throw new Error('ticker ' + pSym + ' tidak ada');
  const close = parseFloat(t.close), open = parseFloat(t.open);
  if (!(close > 0)) throw new Error('harga ' + pSym + ' tidak valid');
  return {
    price: close,
    open_24h: open > 0 ? open : null,
    high_24h: parseFloat(t.high) || null,
    low_24h: parseFloat(t.low) || null,
    change_24h: open > 0 ? (close / open - 1) * 100 : null,
    volume_24h: parseFloat(t.amount) || parseFloat(t.volume) || null,
    time: t.time || null,
  };
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const market = String(req.query.market || 'spot').toLowerCase() === 'perp' ? 'perp' : 'spot';
  if (!ALLOWED.has(symbol)) return res.status(400).json({ error: 'Symbol tidak didukung: ' + symbol });

  const key = symbol + '|' + market;
  const hit = cache.get(key);
  res.setHeader('cache-control', 'no-store');
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.setHeader('x-cache', 'HIT');
    return res.status(200).json(hit.data);
  }

  const errors = [];
  for (const pSym of candidates(symbol, market)) {
    try {
      const t = await fetchTicker(pSym);
      const data = {
        symbol, pionexSymbol: pSym, market: pSym.endsWith('_PERP') ? 'perp' : 'spot',
        ...t, src: 'PIONEX',
        last_updated: new Date(t.time || Date.now()).toISOString(),
      };
      cache.set(key, { at: Date.now(), data });
      res.setHeader('x-cache', 'MISS');
      return res.status(200).json(data);
    } catch (e) { errors.push(e.message); }
  }
  return res.status(502).json({ error: 'Pionex: ' + errors.join('; ') });
}
