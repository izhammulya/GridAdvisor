/* GRIDFISH v8 — konstanta & konfigurasi
   Semua angka "ajaib" dikumpulkan di sini supaya mudah dicari dan diubah. */

export const COINS = ['LINK', 'SOL', 'ETH', 'INJ'];

// jumlah path Monte Carlo
export const SIM = {
  N: 5000,        // simulasi utama
  N_X: 1500,      // uji silang: model alternatif & stress
  N_OPT: 400,     // screening setting alternatif (hanya untuk memilih kandidat)
  N_OPT_S: 200,   // screening stress
  VERIFY: 3,      // kandidat teratas yang diuji ulang dengan pipeline penuh (sama persis dgn keputusan utama)
  N_REPAIR: 1500, // per skenario repair
};

// resolusi waktu: makin dekat ke "sekarang", makin halus (hit cepat butuh resolusi menit)
export const STEP = {
  ULTRA_H: 2, ULTRA_SUB: 60,  // 2 jam pertama: langkah 1 menit
  FINE_H: 24, FINE_SUB: 12,   // s/d 24 jam: langkah 5 menit
  COARSE_SUB: 4,              // repair (horizon panjang): langkah 15 menit
};
export const lateSub = (days) => (days <= 7 ? 6 : days <= 14 ? 4 : 2);

export const TARGET = { spot: 0.003, fut: 0.01 }; // spot 0.30% investasi · futures 1 USDT / 100 USDT margin
export const SLIP = 0.0005;        // slippage eksekusi stop loss
export const MMR = 0.005;          // maintenance margin rate (aproksimasi Pionex)
export const TAIL_K = 3;           // jam "stres": σ × 3
export const PARAM_SD = 0.10;      // ketidakpastian σ per path (lognormal)
export const DRIFT_SHRINK = 0.25;  // simpan 25% drift hasil estimasi
export const STRESS = { vol: 1.35, volNeutral: 1.5, drift: 0.15 };
export const DEC = { NOGO: 45, GO: 65, FULL: 80, VALID_MIN: 60 };

// noise mikrostruktur (bid-ask bounce / wick) dari candle 5 menit, model OU.
// Estimasinya di-shrink menurut signifikansi statistik: bila tidak terdeteksi jelas → dianggap 0.
export const NOISE = { TAU_MIN: 5, MAX_SHARE: 0.6, MIN_BARS: 200 };

export const KLINES = { H1: { interval: '60M', limit: 1000 }, M5: { interval: '5M', limit: 1500 } };
export const CACHE_MS = 60_000;

// jurnal trade nyata: tab "Evaluasi agent" di Google Sheet (harus "siapa saja yang punya link bisa melihat")
export const JOURNAL = {
  SHEET_ID: '13Ud6nYUvHWXb2cpEVW_Oe-TZcMBdWLFDQzu0Q0U5-kc',
  TAB: 'Evaluasi agent',
  STALE_MS: 5 * 60_000,   // sinkron ulang otomatis bila data lebih tua dari ini
  K_GROUP: 8,             // shrink efek koin|arah
  MIN_ROWS: 30,           // minimal trade selesai agar model jurnal dipakai
  TEST_START: 150,        // uji maju dimulai setelah trade ke-150
};

export const DEMO = {
  LINK: { price: 7.83,   change_1h: -0.3, change_24h: -2.1, change_7d: -5.4, change_30d: 4.2 },
  SOL:  { price: 145.2,  change_1h: 0.2,  change_24h: 1.8,  change_7d: -3.9, change_30d: 9.5 },
  ETH:  { price: 3412.5, change_1h: 0.1,  change_24h: 0.9,  change_7d: 2.7,  change_30d: 6.1 },
  INJ:  { price: 5.355,  change_1h: 0.4,  change_24h: -1.2, change_7d: 3.8,  change_30d: -6.5 },
};
