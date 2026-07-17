/* /api/quotes — proxy CoinMarketCap (Vercel Serverless Function)
   ENV: CMC_API_KEY (Settings → Environment Variables)
   Dipanggil frontend: /api/quotes?symbol=LINK|SOL|ETH|INJ
   Respons: { symbol, price, change_1h, change_24h, change_7d, change_30d, last_updated }
   Cache in-memory 60 detik per simbol → hemat kredit CMC (on-demand saja). */

const ALLOWED = new Set(['LINK', 'SOL', 'ETH', 'INJ']); // ← tambah koin baru di sini
const CACHE_MS = 60 * 1000;
const cache = {}; // { SYM: { t, data } }

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ error: 'Symbol tidak didukung: ' + symbol });
  }

  const key = process.env.CMC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'CMC_API_KEY belum di-set di environment Vercel' });
  }

  // cache 60 dtk
  const hit = cache[symbol];
  if (hit && Date.now() - hit.t < CACHE_MS) {
    res.setHeader('x-cache', 'HIT');
    return res.status(200).json(hit.data);
  }

  try {
    const url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest' +
      '?symbol=' + encodeURIComponent(symbol) + '&convert=USDT';
    const r = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': key } });
    const j = await r.json();

    const d = j && j.data && j.data[symbol];
    const q = d && d.quote && (d.quote.USDT || d.quote.USD);
    if (!q || typeof q.price !== 'number') {
      return res.status(502).json({ error: (j.status && j.status.error_message) || 'Respons CMC tidak valid' });
    }

    const data = {
      symbol,
      price: q.price,
      change_1h: q.percent_change_1h,
      change_24h: q.percent_change_24h,
      change_7d: q.percent_change_7d,
      change_30d: q.percent_change_30d,
      last_updated: q.last_updated,
    };
    cache[symbol] = { t: Date.now(), data };
    res.setHeader('x-cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi CoinMarketCap: ' + e.message });
  }
}
