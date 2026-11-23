# Gridfish v8 — penasihat grid bot Pionex

Struktur (deploy di Vercel seperti v7):

```
index.html
css/style.css
js/*.js              # journal-seed.js = salinan offline jurnal (902 trade, 23 Nov 2026)
api/quotes.js        # harga Pionex
api/klines.js        # candle Pionex
api/journal.js       # BARU: meneruskan tab "Evaluasi agent" dari Google Sheet (CSV)
```

## Yang berubah dari v7

1. **Satu pipeline keputusan.** `evaluate()` di `js/decision.js` dipakai keputusan utama dan alternatif.
   Screening hanya memilih kandidat; 3 kandidat teratas diuji penuh dengan data pasar dan angka acak
   yang sama. "Terapkan" menaikkan hasil uji penuh itu menjadi keputusan utama tanpa simulasi ulang.
2. **Resolusi simulasi seragam.** Model alternatif, stress, dan screening tidak lagi memakai langkah 15 menit.
3. **Skor ditahan gerbang.** Bila ada gerbang gagal, skor tampil ≤ 44 (skor kriteria tetap ditampilkan).
4. **Noise mikro di-shrink menurut signifikansi** dan memakai 1.500 candle 5 menit.
5. **Model waktu dari jurnal**: median global + efek koin|arah + residual empiris; tidak bergantung
   pada kolom prediksi. Diuji maju pada 902 trade.
6. **Jurnal otomatis dari Google Sheet** (`/api/journal`, cadangan: langsung ke Google, lalu data tersimpan,
   lalu salinan bawaan). Setup yang dicatat dari aplikasi dicocokkan otomatis dengan baris sheet
   lewat koin + arah + angka di nama bot (`KOIN_Model_Durasi`).
7. **Jam perkiraan tutup & batas tunggu** di hero, tabel "kalau belum kena juga" di tab Waktu target.

## Pengaturan

- Sheet harus dibagikan "Siapa saja yang memiliki link → Pelihat".
- ID sheet / nama tab: `JOURNAL` di `js/config.js` dan konstanta di `api/journal.js`
  (atau env `JOURNAL_SHEET_ID`, `JOURNAL_TAB`, `JOURNAL_GID`).
