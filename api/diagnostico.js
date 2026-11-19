// Banco de diagnóstico. Protegido por DIAG_TOKEN.
// No devuelve la clave, ni SKUs, ni precios: solo estado, código HTTP y arreglo.

const BASE = 'https://emovedistribution.com/wp-json/emove-api/v1';
const UA = 'RiveuDiag/1.0 (+https://www.riveu.es)';

const mask = v => {
  const s = String(v || '');
  if (!s) return null;
  return s.length <= 8 ? '•'.repeat(s.length) : s.slice(0, 3) + '•'.repeat(Math.max(4, s.length - 7)) + s.slice(-4);
};

async function probe(path, { method = 'GET', body, timeout = 9000 } = {}) {
  const key = process.env.EMOVE_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + key,
        'User-Agent': UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store'
    });
    clearTimeout(timer);
    const txt = await res.text();
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      code: (json && (json.code || json.codigo)) || null,
      message: (json && (json.message || json.mensaje)) || null,
      json
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false, status: 0, code: e.name === 'AbortError' ? 'TIMEOUT' : 'RED',
      message: e.name === 'AbortError' ? 'Emove no respondió en 9 s.' : 'No se pudo contactar con Emove.',
      json: null
    };
  }
}

const fixFor = s =>
  s === 401 ? 'La clave no es válida o está mal copiada. Vuelve a pegarla en EMOVE_API_KEY, sin espacios ni comillas, y redespliega.'
  : s === 403 ? 'Permiso insuficiente para esta operación, o la IP de salida no está autorizada. Pide a Emove que active este permiso en tu clave y que autorice Vercel (IP dinámica) o un proxy con IP fija.'
  : s === 404 ? 'La ruta no existe en tu cuenta. Confirma con Emove que la API v1 está habilitada.'
  : s === 409 ? 'Conflicto devuelto por Emove. Lee el mensaje adjunto.'
  : s === 413 ? 'Petición demasiado grande. Reduce el lote.'
  : s === 429 ? 'Cuota excedida. Espera un minuto y repite el diagnóstico.'
  : s === 503 ? 'Emove no disponible temporalmente. Repite en unos minutos.'
  : s === 0 ? 'Sin respuesta de red. Reintenta; si persiste, es conectividad o bloqueo de salida.'
  : null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const token = process.env.DIAG_TOKEN;
  if (!token) {
    return res.status(503).json({
      ok: false, error: 'DIAG_DESACTIVADO',
      mensaje: 'El diagnóstico está desactivado.',
      pista: 'Añade DIAG_TOKEN en Vercel → Variables ambientales con un valor largo que inventes tú, y redespliega.'
    });
  }
  const sent = (req.query.t || req.headers['x-diag-token'] || '').toString();
  if (sent !== token) {
    return res.status(401).json({ ok: false, error: 'TOKEN', mensaje: 'Token de diagnóstico incorrecto.' });
  }

  const checks = [];
  const add = (id, grupo, nombre, estado, detalle, arreglo, codigo) =>
    checks.push({ id, grupo, nombre, estado, detalle: detalle || null, arreglo: arreglo || null, codigo: codigo ?? null });

  // ── Entorno ───────────────────────────────────────────────
  add('node', 'Entorno', 'Versión de Node', 'ok', process.version + ' · fetch nativo disponible.');

  let mod = null;
  try {
    mod = await import('./_emove.js');
    add('esm', 'Entorno', 'Módulos ESM (_emove.js)', 'ok', 'Se importa correctamente. package.json tiene "type": "module".');
  } catch (e) {
    add('esm', 'Entorno', 'Módulos ESM (_emove.js)', 'fail',
      'No se pudo importar: ' + (e && e.message ? e.message.slice(0, 180) : 'error desconocido'),
      'Comprueba que package.json está en la raíz y contiene "type": "module". Sin eso, las cuatro funciones de api/ fallan.');
  }
  if (mod && typeof mod.emove !== 'function') {
    add('esmexp', 'Entorno', 'Export de emove()', 'fail', 'El módulo carga pero no exporta emove().', 'Restaura api/_emove.js con el archivo original.');
  }

  // ── Credenciales ──────────────────────────────────────────
  const key = process.env.EMOVE_API_KEY;
  if (!key) {
    add('key', 'Credenciales', 'EMOVE_API_KEY', 'fail', 'No definida en el servidor.',
      'Añádela en Vercel → Variables ambientales → Producción, y redespliega. Sin redespliegue no se lee.');
  } else if (key.trim() !== key || /["']/.test(key)) {
    add('key', 'Credenciales', 'EMOVE_API_KEY', 'warn',
      'Presente (' + mask(key) + ') pero contiene espacios o comillas.',
      'Vuelve a pegarla limpia: sin espacios al inicio o final y sin comillas envolviéndola.');
  } else {
    add('key', 'Credenciales', 'EMOVE_API_KEY', 'ok', 'Presente · ' + mask(key) + ' · ' + key.length + ' caracteres.');
  }

  const markup = parseFloat(process.env.RIVEU_MARKUP);
  if (!Number.isFinite(markup) || markup <= 0) {
    add('markup', 'Credenciales', 'RIVEU_MARKUP', 'fail', 'Ausente o no numérica. Los precios saldrán como «Consultar».',
      'Añade RIVEU_MARKUP con tu multiplicador, por ejemplo 1.45, y redespliega.');
  } else if (markup < 1) {
    add('markup', 'Credenciales', 'RIVEU_MARKUP', 'warn', 'Valor ' + markup + ' — venderías por debajo del coste.',
      'El multiplicador debe ser mayor que 1. Para un 45 % de margen se escribe 1.45, no 0.45.');
  } else {
    add('markup', 'Credenciales', 'RIVEU_MARKUP', 'ok', 'Multiplicador ' + markup + ' aplicado en el servidor.');
  }

  const iva = parseFloat(process.env.RIVEU_IVA ?? '0.21');
  add('iva', 'Credenciales', 'RIVEU_IVA', Number.isFinite(iva) && iva >= 0 && iva < 1 ? 'ok' : 'warn',
    Number.isFinite(iva) ? 'IVA ' + Math.round(iva * 100) + ' % incluido en el PVP.' : 'Valor no numérico.',
    Number.isFinite(iva) ? null : 'Usa 0.21 para el 21 %.');

  if (!key) {
    add('cat', 'Permisos Emove', 'GET /catalogo', 'skip', 'Omitido: falta la clave.', 'Define EMOVE_API_KEY primero.');
    add('stock', 'Permisos Emove', 'POST /stock/consultas', 'skip', 'Omitido: falta la clave.', null);
    add('price', 'Permisos Emove', 'POST /precios/consultas', 'skip', 'Omitido: falta la clave.', null);
    add('pay', 'Permisos Emove', 'GET /pedidos/metodos-pago', 'skip', 'Omitido: falta la clave.', null);
    add('read', 'Permisos Emove', 'GET /pedidos/{id}', 'skip', 'No verificable sin un pedido existente.', null);
    return res.status(200).json({ ok: true, generado_en: new Date().toISOString(), checks });
  }

  // ── Permisos Emove, en cadena real ────────────────────────
  const cat = await probe('/catalogo?limite=1');
  if (cat.ok) {
    add('cat', 'Permisos Emove', 'GET /catalogo', 'ok', 'Permiso «catalogo» activo. La clave y la IP son válidas.', null, 200);
  } else {
    add('cat', 'Permisos Emove', 'GET /catalogo', 'fail',
      (cat.code ? cat.code + ' · ' : '') + (cat.message || 'Sin detalle'), fixFor(cat.status), cat.status);
  }

  // SKU interno solo para sondear; nunca se devuelve.
  let sku = null;
  if (cat.ok && cat.json) {
    const arr = cat.json.productos || cat.json.articulos || cat.json.datos || (Array.isArray(cat.json) ? cat.json : []);
    const first = Array.isArray(arr) ? arr[0] : null;
    sku = first ? (first.sku || first.referencia || null) : null;
    if (!sku && Array.isArray(first?.variantes)) sku = first.variantes[0]?.sku || null;
  }

  if (!sku) {
    const why = cat.ok ? 'El catálogo respondió pero no se pudo extraer un SKU de prueba.' : 'Bloqueado por el fallo de catálogo.';
    add('stock', 'Permisos Emove', 'POST /stock/consultas', 'skip', why, cat.ok ? 'Revisa la forma de la respuesta de /catalogo.' : 'Arregla catálogo primero.');
    add('price', 'Permisos Emove', 'POST /precios/consultas', 'skip', why, null);
  } else {
    const st = await probe('/stock/consultas', { method: 'POST', body: { skus: [sku] } });
    add('stock', 'Permisos Emove', 'POST /stock/consultas', st.ok ? 'ok' : 'fail',
      st.ok ? 'Permiso «stock» activo.' : (st.code ? st.code + ' · ' : '') + (st.message || 'Sin detalle'),
      st.ok ? null : fixFor(st.status), st.status);

    const pr = await probe('/precios/consultas', { method: 'POST', body: { articulos: [{ sku, cantidad: 1 }] } });
    const neto = pr.json?.articulos?.[0]?.precio_unitario_neto;
    add('price', 'Permisos Emove', 'POST /precios/consultas', pr.ok ? 'ok' : 'fail',
      pr.ok ? 'Permiso «precios» activo. Tarifa neta recibida' + (neto != null ? ' y convertida a PVP en el servidor.' : '.')
            : (pr.code ? pr.code + ' · ' : '') + (pr.message || 'Sin detalle'),
      pr.ok ? null : fixFor(pr.status), pr.status);
  }

  const pay = await probe('/pedidos/metodos-pago');
  if (pay.ok) {
    const ids = (pay.json?.metodos || []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
    add('pay', 'Permisos Emove', 'GET /pedidos/metodos-pago', 'ok',
      'Permiso «pedidos_crear» activo. Métodos: ' + (ids.length ? ids.join(', ') : 'ninguno devuelto') + '.',
      ids.length ? null : 'La cuenta no tiene métodos de pago autorizados. Pídelo a soporte de Emove.', 200);
  } else {
    add('pay', 'Permisos Emove', 'GET /pedidos/metodos-pago', 'fail',
      (pay.code ? pay.code + ' · ' : '') + (pay.message || 'Sin detalle'), fixFor(pay.status), pay.status);
  }

  add('read', 'Permisos Emove', 'GET /pedidos/{id}', 'skip',
    'El permiso «pedidos_leer» solo se comprueba con un pedido real. Se verificará al confirmar el primero.', null);

  return res.status(200).json({ ok: true, generado_en: new Date().toISOString(), checks });
}
