// api/product-image.js — Busca la foto EXACTA de un producto en Emove por su SKU
const BASE = 'https://emovedistribution.com';

export default async function handler(req, res) {
  const sku = String(req.query.sku || '').trim();
  if (!sku) return res.status(400).json({ sku, image: '' });

  const norm = sku.toLowerCase();
  let image = '';

  try {
    // WooCommerce Store API (público). Probamos v1 y fallback legacy.
    const endpoints = [
      `${BASE}/wp-json/wc/store/v1/products?search=${encodeURIComponent(sku)}&per_page=8`,
      `${BASE}/wp-json/wc/store/products?search=${encodeURIComponent(sku)}&per_page=8`
    ];
    for (const url of endpoints) {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (!r.ok) continue;
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.products || []);
      // 1) coincidencia EXACTA de SKU (garantiza que es ese producto)
      let found = list.find(p => String(p.sku || '').toLowerCase() === norm);
      // 2) si no, coincidencia por nombre que contenga el SKU
      if (!found) found = list.find(p => (String(p.sku||'')+' '+String(p.name||'')).toLowerCase().includes(norm));
      if (found && Array.isArray(found.images) && found.images.length) {
        image = found.images[0].src || found.images[0].url || found.images[0].thumbnail || '';
      }
      if (image) break;
    }
  } catch (e) { image = ''; }

  // Si hay foto, cache larga en el edge; si no, cache corta para reintentar luego
  res.setHeader('Cache-Control', image ? 's-maxage=86400, stale-while-revalidate=604800' : 's-maxage=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ sku, image });
}
