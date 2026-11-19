import { emove, fail, ok, readBody, pvp } from './_emove.js';

// Stock y precios COMPARTEN 30 consultas/min por clave.
// Los pedimos juntos para gastar la mitad. Máx. 100 referencias, SKU ≤ 110.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METODO', mensaje: 'Usa POST.' });
  }

  const skus = (readBody(req).skus || [])
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => s.trim().slice(0, 110))
    .slice(0, 100);

  if (!skus.length) {
    return res.status(400).json({ ok: false, error: 'SIN_SKUS', mensaje: 'Envía un array "skus" con al menos una referencia.' });
  }

  try {
    const [s, p] = await Promise.all([
      emove('/stock/consultas', { method: 'POST', body: { skus } }),
      emove('/precios/consultas', { method: 'POST', body: { articulos: skus.map(sku => ({ sku, cantidad: 1 })) } })
    ]);

    const items = {};
    skus.forEach(k => { items[k] = { disponible: false, pvp: null, error: null }; });

    (s.payload?.articulos || []).forEach(a => {
      if (!items[a.sku]) items[a.sku] = { disponible: false, pvp: null, error: null };
      items[a.sku].disponible = a.disponible === true;
      items[a.sku].error = a.error || null; // "referencia_no_disponible"
    });

    (p.payload?.articulos || []).forEach(a => {
      if (!items[a.sku]) items[a.sku] = { disponible: false, pvp: null, error: null };
      items[a.sku].pvp = pvp(a.precio_unitario_neto); // viene como texto decimal
    });

    return ok(res, {
      items,
      actualizado_en: s.payload?.actualizado_en || null,
      moneda: p.payload?.articulos?.[0]?.moneda || 'EUR'
    }, 90);
  } catch (e) { return fail(res, e); }
}
