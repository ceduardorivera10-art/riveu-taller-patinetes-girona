// Capa compartida Emove. El prefijo "_" impide que Vercel la exponga como ruta.
// La clave vive solo aquí. El precio neto NUNCA sale del servidor.

const BASE = 'https://emovedistribution.com/wp-json/emove-api/v1';
const UA = 'RiveuTaller/1.0 (+https://www.riveu.es)';

export class EmoveError extends Error {
  constructor(message, status, code, hint, data) {
    super(message);
    this.status = status; this.code = code; this.hint = hint || null; this.data = data || null;
    this.retryAfter = null;
  }
}

const hintFor = (s, p) =>
  s === 400 ? 'Datos de entrada inválidos. Revisa SKU (máx. 110), cantidad (1–10000) y los campos obligatorios de la dirección.'
  : s === 401 ? 'Clave inválida. Revisa EMOVE_API_KEY en las variables de entorno.'
  : s === 403 ? 'Permiso insuficiente o IP no autorizada. Cada ruta exige un permiso: catalogo, stock, precios, pedidos_crear, pedidos_leer o tarjeta_guardada. Vercel sale por IP dinámica: pide a Emove autorización por dominio o una salida con IP fija.'
  : s === 404 ? 'El recurso solicitado no existe. Comprueba el identificador.'
  : s === 409 ? (p && (p.message || p.mensaje)) || 'Conflicto: cotización caducada, stock insuficiente o dirección sin número que requiere confirmación.'
  : s === 413 ? 'Petición demasiado grande. El límite es 64 KiB: reduce el lote.'
  : s === 429 ? 'Cuota excedida. Se reintenta con espera creciente.'
  : s === 503 ? 'Emove no disponible temporalmente.'
  : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = (n, ra) => ra ? ra * 1000 : Math.min(30000, 10000 * Math.pow(1.6, n)) * (0.75 + Math.random() * 0.5);

async function once(path, { method = 'GET', body, headers = {}, timeout = 15000 } = {}) {
  const key = process.env.EMOVE_API_KEY;
  if (!key) {
    throw new EmoveError('EMOVE_API_KEY no está configurada en el servidor.', 503, 'NO_KEY',
      'Añade EMOVE_API_KEY en Vercel → Variables ambientales y redespliega.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        'User-Agent': UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store'
    });
  } catch (e) {
    clearTimeout(timer);
    throw new EmoveError(
      e.name === 'AbortError' ? 'Tiempo de espera agotado contactando con Emove.' : 'No se pudo contactar con Emove.',
      504, 'UPSTREAM', 'Reintenta. Si persiste, consulta el estado del servicio con soporte de Emove.');
  }
  clearTimeout(timer);

  const ra = Number(res.headers.get('Retry-After')) || null;
  const txt = await res.text();
  let payload = null;
  try { payload = txt ? JSON.parse(txt) : null; } catch (_) {}

  if (!res.ok) {
    const err = new EmoveError(
      (payload && (payload.message || payload.mensaje)) || 'Emove devolvió ' + res.status,
      res.status,
      (payload && (payload.code || payload.codigo)) || 'HTTP_' + res.status,
      hintFor(res.status, payload),
      payload && payload.data
    );
    err.retryAfter = ra;
    throw err;
  }
  return { payload, status: res.status };
}

export async function emove(path, opts = {}) {
  let last;
  for (let n = 0; n < 3; n++) {
    try { return await once(path, opts); }
    catch (e) {
      last = e;
      const retriable = e instanceof EmoveError && (e.status === 429 || e.status === 503 || e.status === 504);
      if (!retriable || opts.noRetry || n === 2) throw e;
      await sleep(backoff(n, e.retryAfter));
    }
  }
  throw last;
}

export const fail = (res, e) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(e instanceof EmoveError ? e.status : 500).json({
    ok: false, error: e.code || 'ERROR', mensaje: e.message || 'Error inesperado.',
    pista: e.hint || null, datos: e.data || null
  });
};

export const ok = (res, data, seconds) => {
  res.setHeader('Cache-Control', seconds ? `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 2}` : 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(200).json({ ok: true, ...data });
};

export const int = (v, min, max, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const readBody = req => {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
  return b || {};
};

export const money = n => { const v = Number(n); return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; };

// ÚNICA fuente de redondeo. Checkout y webhook usan esta misma función,
// así el importe cobrado y el recalculado coinciden céntimo a céntimo.
export function pvpCents(neto) {
  const m = parseFloat(process.env.RIVEU_MARKUP);
  const ivaRaw = parseFloat(process.env.RIVEU_IVA ?? '0.21');
  const n = Number(neto);
  if (!Number.isFinite(m) || m <= 0) return null;
  if (!Number.isFinite(n) || n < 0) return null;
  const iva = Number.isFinite(ivaRaw) && ivaRaw >= 0 && ivaRaw < 1 ? ivaRaw : 0.21;
  return Math.round(n * m * (1 + iva) * 100);
}
export const pvp = neto => { const c = pvpCents(neto); return c == null ? null : c / 100; };

export const esPruebas = (payload, id) =>
  (payload && String(payload.entorno || '').toLowerCase().startsWith('prueb')) ||
  (typeof id === 'string' && id.startsWith('sim-'));

// ── Validadores compartidos, exactos al OpenAPI de producción ──
const ADDR_REQ = ['first_name', 'address_1', 'city', 'postcode', 'country', 'phone'];
const ADDR_OPT = ['last_name', 'company', 'address_2', 'state', 'email'];
export const ADDR_KEYS = ADDR_REQ.concat(ADDR_OPT);

// additionalProperties:false → solo se envían claves permitidas y no vacías.
export function direccion(input, { soloES = true } = {}) {
  const a = {};
  ADDR_KEYS.forEach(k => { const v = str(input?.[k], 254); if (v) a[k] = v; });
  const faltan = ADDR_REQ.filter(k => !a[k]);
  if (faltan.length) {
    throw new EmoveError('Faltan campos obligatorios del destinatario: ' + faltan.join(', '), 400, 'DIRECCION_INCOMPLETA',
      'Nombre, dirección, ciudad, código postal, país y teléfono son obligatorios. Apellidos y email son opcionales.');
  }
  if (!/^[a-zA-Z]{2}$/.test(a.country)) {
    throw new EmoveError('El país debe ser un código de dos letras.', 400, 'PAIS', 'Por ejemplo ES.');
  }
  a.country = a.country.toUpperCase();
  if (soloES && a.country !== 'ES') {
    throw new EmoveError('Las compras y los envíos de la tienda Riveu están disponibles solo dentro de España.',
      400, 'FUERA_ESPANA', 'Si necesitas el pedido en otro país, llama al taller y lo estudiamos.');
  }
  if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) {
    throw new EmoveError('El email del destinatario no es válido.', 400, 'EMAIL', 'Corrígelo o déjalo vacío.');
  }
  return a;
}

export function articulos(list) {
  const out = (Array.isArray(list) ? list : [])
    .filter(a => a && str(a.sku, 110))
    .slice(0, 100)
    .map(a => ({ sku: str(a.sku, 110), cantidad: int(a.cantidad, 1, 10000, 1) }));
  if (!out.length) throw new EmoveError('El pedido no tiene artículos.', 400, 'SIN_ARTICULOS', 'Añade al menos un recambio.');
  return out;
}

export function clientIp(req) {
  const xf = str(req.headers['x-forwarded-for'] || '', 200);
  if (xf) return xf.split(',')[0].trim();
  return str(req.socket && req.socket.remoteAddress || '', 45) || '';
}

export function owner(req) {
  const tok = process.env.OWNER_TOKEN;
  if (!tok) {
    throw new EmoveError('OWNER_TOKEN no está configurado.', 503, 'SIN_OWNER_TOKEN',
      'Añade OWNER_TOKEN en Vercel con un valor largo que inventes tú y redespliega. Sin él, confirmar y pagar quedan cerrados.');
  }
  const sent = str(req.headers['x-owner-token'] || req.query.owner || '', 200);
  if (sent !== tok) throw new EmoveError('Token de propietario incorrecto.', 401, 'OWNER', 'Esta operación solo puede hacerla el taller.');
}
