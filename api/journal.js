/* /api/journal — jurnal trade dari Google Sheet (Vercel Serverless Function)
   GET /api/journal  →  text/csv: isi tab "Evaluasi agent" apa adanya (baris pertama = header)

   Sheet harus dibagikan "Siapa saja yang memiliki link → Pelihat". Fungsi ini HANYA meneruskan
   satu tab itu (ID & nama tab dikunci di sini / env, tidak bisa diganti lewat query),
   jadi tab lain di file yang sama tidak ikut lewat proxy ini.
   Env opsional: JOURNAL_SHEET_ID, JOURNAL_TAB, JOURNAL_GID.
   Cache in-memory 60 detik. */

const SHEET_ID = process.env.JOURNAL_SHEET_ID || '13Ud6nYUvHWXb2cpEVW_Oe-TZcMBdWLFDQzu0Q0U5-kc';
const TAB = process.env.JOURNAL_TAB || 'Evaluasi agent';
const GID = process.env.JOURNAL_GID || '415695419';
const CACHE_MS = 60 * 1000;
let cache = null;

async function getText(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { accept: 'text/csv' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (/^\s*</.test(t)) throw new Error('Google mengembalikan halaman HTML — sheet belum dibagikan lewat link');
    if (t.split('\n').length < 3) throw new Error('tab kosong');
    return t;
  } finally { clearTimeout(to); }
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (cache && Date.now() - cache.at < CACHE_MS) {
    res.setHeader('x-cache', 'HIT');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    return res.status(200).send(cache.text);
  }
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
  const urls = [
    `${base}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(TAB)}`,   // per nama tab
    `${base}/export?format=csv&gid=${GID}`,                                      // cadangan: per gid
  ];
  const errors = [];
  for (const u of urls) {
    try {
      const text = await getText(u);
      cache = { at: Date.now(), text };
      res.setHeader('x-cache', 'MISS');
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      return res.status(200).send(text);
    } catch (e) { errors.push(e.message); }
  }
  return res.status(502).json({ error: 'Google Sheet: ' + errors.join('; ') });
}
