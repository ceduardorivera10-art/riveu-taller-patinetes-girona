// Capa compartida. El prefijo "_" evita que Vercel la exponga como ruta.
// La clave vive solo aquí, en variables de entorno. Nunca llega al navegador.

const BASE = 'https://emovedistribution.com/wp-json/emove-api/v1';
const UA = 'RiveuTaller/1.0 (+https://www.riveu.es)';

export class EmoveError extends Error {
  constructor(message, status, code, hint, data) {
    super(message);
    this.status = status; this.code = code; this.hint = hint || null; this.data = data || null;
  }
}

// Códigos y campos según components.schemas.Error del OpenAPI: { code, message, data }
const hintFor = (s, p) =>
  s === 400 ? 'Datos de entrada inválidos. Revisa SKU (máx. 110), cantidad (1–10000) y los campos obligatorios de la dirección.'
  : s === 401 ? 'Clave inválida. Comprueba EMOVE_API_KEY en las variables de entorno.'
  : s === 403 ? 'Permiso insuficiente para esta operación, o IP no autorizada. Cada ruta exige un permiso: catalogo, stock, precios, pedidos_crear o pedidos_leer. Emove puede restringir el acceso a las IP de tu servidor; Vercel sale por IP dinámica.'
  : s === 404 ? 'El recurso solicitado no existe. Comprueba el identificador.'
  : s === 409 ? (p && (p.message || p.mensaje)) || 'Conflicto. Puede ser cotización caducada, stock insuficiente o una dirección sin número que requiere confirmación.'
  : s === 413 ? 'Petición demasiado grande. El límite es 64 KiB: reduce el número de artículos o referencias por consulta.'
  : s === 429 ? 'Cuota excedida. Se reintenta con espera creciente según Retry-After.'
  : s === 503 ? 'Servicio de Emove temporalmente no disponible.'
  : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = (attempt, retryAfter) =>
  retryAfter ? retryAfter * 1000
  : Math.min(30000, 10000 * Math.pow(1.6, attempt)) * (0.75 + Math.random() * 0.5);

async function once(path, { method = 'GET', body, headers = {}, timeout = 15000 } = {}) {
  const key = process.env.EMOVE_API_KEY;
  if (!key) {
    throw new EmoveError('EMOVE_API_KEY no está configurada en el servidor.', 503, 'NO_KEY',
      'Añade EMOVE_API_KEY en Vercel → Settings → Environment Variables y vuelve a desplegar.');
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await once(path, opts); }
    catch (e) {
      last = e;
      const retriable = e instanceof EmoveError && (e.status === 429 || e.status === 503 || e.status === 504);
      if (!retriable || opts.noRetry || attempt === 2) throw e;
      await sleep(backoff(attempt, e.retryAfter));
    }
  }
  throw last;
}

export const fail = (res, e) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(e instanceof EmoveError ? e.status : 500).json({
    ok: false,
    error: e.code || 'ERROR',
    mensaje: e.message || 'Error inesperado.',
    pista: e.hint || null,
    datos: e.data || null
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

export const readBody = req => {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = null; } }
  return b || {};
};

// El importe neto de Emove NUNCA sale del servidor. Solo el PVP.
export function pvp(neto) {
  const m = parseFloat(process.env.RIVEU_MARKUP);
  const iva = parseFloat(process.env.RIVEU_IVA ?? '0.21');
  const n = Number(neto);
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(n)) return null;
  return Math.round(n * m * (1 + (Number.isFinite(iva) ? iva : 0.21)) * 100) / 100;
}

export const money = n => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
};

// El entorno lo declara la propia API ("pruebas" | "produccion"). No lo inferimos.
export const esPruebas = (payload, id) =>
  (payload && String(payload.entorno || '').toLowerCase().startsWith('prueb')) ||
  (typeof id === 'string' && id.startsWith('sim-'));
