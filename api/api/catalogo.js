import { emove, fail, ok, int } from './_emove.js';

// GET /catalogo · permiso "catalogo" · límite 1–100 (default 50 según OpenAPI).
// Una página por llamada, cacheada en el CDN: 12 peticiones/min por clave.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'METODO', mensaje: 'Usa GET.' });
  }

  const qs = new URLSearchParams({ limite: String(int(req.query.limite, 1, 100, 50)) });
  const cursor = (req.query.cursor || '').toString().trim();
  const desde = (req.query.desde || '').toString().trim();
  if (cursor) qs.set('cursor', cursor);
  if (desde) qs.set('desde', desde);

  try {
    const { payload: p } = await emove('/catalogo?' + qs.toString());
    const raw = Array.isArray(p?.productos) ? p.productos
      : Array.isArray(p?.articulos) ? p.articulos
      : Array.isArray(p?.datos) ? p.datos
      : Array.isArray(p) ? p : [];

    const productos = raw.map(x => ({
      id: x.id ?? x.producto_id ?? null,
      sku: String(x.sku ?? x.referencia ?? '').slice(0, 110) || null,
      ean: x.ean ?? null,
      nombre: x.nombre ?? x.titulo ?? x.name ?? '',
      categoria: x.categoria ?? (Array.isArray(x.categorias) ? x.categorias[0] : null) ?? 'Recambios',
      marca: x.marca ?? null,
      estado: x.estado ?? 'activo',
      foto: x.foto ?? x.imagen ?? (Array.isArray(x.fotos) ? x.fotos[0] : null) ?? null,
      variantes: Array.isArray(x.variantes)
        ? x.variantes.map(v => ({ sku: v.sku ?? null, nombre: v.nombre ?? null }))
        : []
    })).filter(x => x.sku && x.estado !== 'retirado');

    return ok(res, {
      productos,
      siguiente_cursor: p?.siguiente_cursor ?? null,
      entorno: p?.entorno ?? null
    }, 21600);
  } catch (e) { return fail(res, e); }
}
