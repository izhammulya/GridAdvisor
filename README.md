# GRIDFISH — Pionex Grid Advisor (LINK / SOL / ETH)

Web app rekomendasi **Grid Trading (spot)** dan **Futures Grid** Pionex.
Output-nya disusun 1:1 mengikuti field pada form Pionex (gambar 2 & 3):
Price Range (Lowest/Highest) → Quantity of Grids → Investment → Leverage →
Trigger price → Take Profit → Stop Loss → Grid mode, lengkap dengan tombol **salin** per field.

Setiap rekomendasi divalidasi **5.000 simulasi Monte Carlo (GBM)** dari volatilitas
1h/24h/7d/30d CoinMarketCap, dengan output P(profit ≥ 1%), P(≥ 2%), median PnL,
P5/P95, dan P(likuidasi)/P(stop-loss).

## Struktur
```
pionex-grid-advisor/
├── index.html      # dashboard
├── app.js          # rekomendasi + 5.000 simulasi + chart canvas (tanpa library)
├── api/quotes.js   # serverless proxy CoinMarketCap (API key aman di server)
└── README.md
```

## Kenapa Vercel (bukan Streamlit)?
| | Vercel | Streamlit Cloud |
|---|---|---|
| API key CMC aman di server | ✅ env var + serverless | ✅ tapi app Python |
| Tampilan custom "advance" | ✅ full HTML/CSS/JS | ⚠️ terbatas komponen Streamlit |
| Selalu aktif di free tier | ✅ | ⚠️ sleep bila idle |
| 5.000 simulasi | ✅ instan di browser | server-side, lebih lambat responsnya |

→ **Vercel** paling pas untuk desain seperti gambar 1. (Netlify/Cloudflare Pages juga bisa dengan penyesuaian kecil pada folder function.)

## Deploy ke Vercel (5 menit, gratis)
1. Daftar gratis di https://coinmarketcap.com/api/ → salin **API Key** (Basic plan gratis: 10.000 call/bulan — cukup, karena app hanya hit saat tombol ditekan + cache 60 detik).
2. Push folder ini ke GitHub (repo baru), atau install Vercel CLI: `npm i -g vercel`.
3. Di https://vercel.com → **Add New Project** → import repo → Framework Preset: **Other** → Deploy.
   (via CLI: cukup jalankan `vercel` di folder ini.)
4. Di dashboard Vercel → **Settings → Environment Variables** → tambah:
   - Name: `CMC_API_KEY`
   - Value: API key CoinMarketCap Anda
5. **Redeploy**. Selesai — buka URL `*.vercel.app` Anda.

Tanpa API key, app tetap jalan dalam **mode DEMO** (harga statis) supaya bisa dites dulu.

## Cara pakai
1. Pilih koin (LINK/SOL/ETH) → produk (Grid Spot / Futures Grid) → arah (Long/Short/Neutral) → investasi, leverage, horizon.
2. Tekan **Minta Rekomendasi** → app hit CoinMarketCap sekali, hitung parameter, jalankan 5.000 simulasi.
3. Salin tiap angka ke form Pionex sesuai urutan field.
4. Perhatikan panel probabilitas: kalau P(profit ≥ 1%) rendah atau P(SL) tinggi, pertimbangkan tidak entry / perkecil leverage.

## ⚠️ Disclaimer
Bukan nasihat keuangan. Monte Carlo memodelkan volatilitas historis, bukan memprediksi masa depan.
Target 1–2% tidak dijamin; futures ber-leverage bisa terlikuidasi hingga seluruh margin hilang.
