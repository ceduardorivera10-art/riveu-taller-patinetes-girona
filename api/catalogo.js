import { emove, fail, ok, int } from './_emove.js';

// El OpenAPI no documenta el campo de imagen: reconocemos cualquier URL
// con aspecto de imagen en cualquier nivel (extensión gráfica o uploads de WP).
const IMG_RE = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i;
const WP_RE = /\/wp-content\/uploads\//i;
const isImgUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v) && (IMG_RE.test(v) || WP_RE.test(v));

function scan(node, depth) {
  if (depth > 2 || node == null) return null;
  if (isImgUrl(node)) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) { const hit = scan(node[i], depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof node === 'object') {
    const prio = ['src', 'url', 'foto', 'imagen', 'image', 'link', 'href', 'thumbnail', 'full', 'large'];
    for (let i = 0; i < prio.length; i++) {
      if (node[prio[i]] !== undefined) { const hit = scan(node[prio[i]], depth + 1); if (hit) return hit; }
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) { const hit = scan(node[keys[i]], depth + 1); if (hit) return hit; }
  }
  return null;
}

function pickFoto(x) {
  if (!x || typeof x !== 'object') return null;
  const known = ['foto', 'fotos', 'imagen', 'imagenes', 'image', 'images', 'thumbnail',
    'featured_image', 'foto_principal', 'url_imagen', 'portada', 'img', 'image_url', 'imagen_url', 'miniatura', 'media'];
  for (let i = 0; i < known.length; i++) {
    if (x[known[i]] !== undefined) { const hit = scan(x[known[i]], 0); if (hit) return hit; }
  }
  const keys = Object.keys(x);
  for (let i = 0; i < keys.length; i++) { const hit = scan(x[keys[i]], 0); if (hit) return hit; }
  return null;
}

// GET /catalogo · permiso "catalogo" · 12 peticiones/min por clave.
// Una página por llamada, cacheada 6 h en el CDN.
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
      foto: pickFoto(x),
      variantes: Array.isArray(x.variantes) ? x.variantes.map(v => ({ sku: v.sku ?? null, nombre: v.nombre ?? null })) : []
    })).filter(x => x.sku && x.estado !== 'retirado');

    const out = { productos, siguiente_cursor: p?.siguiente_cursor ?? null, entorno: p?.entorno ?? null };
    if (productos.length && productos.every(x => !x.foto) && raw[0] && typeof raw[0] === 'object') {
      out.aviso_foto = Object.keys(raw[0]);
    }
    return ok(res, out, 21600);
  } catch (e) { return fail(res, e); }
}
