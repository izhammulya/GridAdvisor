// /api/quotes?symbol=LINK  →  proxy ke CoinMarketCap quotes/latest
// API key disimpan di Environment Variable Vercel: CMC_API_KEY
// Hanya dipanggil saat user menekan tombol "Minta Rekomendasi" (tidak polling terus-menerus).

const ALLOWED = new Set(['LINK', 'SOL', 'ETH']);

module.exports = async (req, res) => {
  const symbol = String((req.query && req.query.symbol) || '').toUpperCase();

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120'); // cache CDN 60 dtk → hemat kuota CMC

  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ error: 'Symbol harus LINK, SOL, atau ETH' });
  }

  const key = process.env.CMC_API_KEY;
  if (!key) {
    return res.status(200).json({ demo: true, error: 'CMC_API_KEY belum di-set di Vercel. Menggunakan mode demo.' });
  }

  try {
    const url =
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=' +
      encodeURIComponent(symbol) + '&convert=USD';

    const r = await fetch(url, {
      headers: { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json' },
    });
    const j = await r.json();

    if (!r.ok || !j.data || !j.data[symbol]) {
      return res.status(502).json({ error: 'CoinMarketCap error', detail: j.status || null });
    }

    const q = j.data[symbol].quote.USD;
    return res.status(200).json({
      symbol,
      price: q.price,
      change_1h: q.percent_change_1h,
      change_24h: q.percent_change_24h,
      change_7d: q.percent_change_7d,
      change_30d: q.percent_change_30d,
      volume_24h: q.volume_24h,
      market_cap: q.market_cap,
      last_updated: q.last_updated,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi CoinMarketCap', detail: String(e) });
  }
};
