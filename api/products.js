// api/products.js — Proxy que lee el feed de Emove en tiempo real (sin problemas de CORS)
const EMOVE_CSV = 'https://emovedistribution.com/wp-content/uploads/woo-feed/custom/csv/scootech-2.csv';

export default async function handler(req, res) {
  try {
    const upstream = await fetch(EMOVE_CSV, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RiveuWeb)' },
      cache: 'no-store'
    });
    if (!upstream.ok) throw new Error('Emove respondió ' + upstream.status);
    const text = await upstream.text();

    // Fresco 5 min en el edge de Vercel; si Emove cambia el stock, se ve en ~5 min
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).json({ error: 'No se pudo leer el feed de Emove' });
  }
}
