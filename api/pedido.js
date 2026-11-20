import { emove, fail, ok, readBody, pvp, money, str, owner, clientIp, articulos, direccion, esPruebas, EmoveError } from './_emove.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMID = /^[0-9]{1,12}$/;
const SIMID = /^sim-[0-9a-f-]{6,}$/i;
const HEX64 = /^[a-f0-9]{64}$/i;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;
const DEPTHS = ['1', '4', '8', '15', '16', '24', '30', '32', '48'];

async function metodoPago(requested) {
  const m = str(requested, 20);
  if (m === 'redsys' || m === 'bacs') return m;
  const { payload } = await emove('/pedidos/metodos-pago');
  const ids = (payload?.metodos || []).map(x => (typeof x === 'string' ? x : x.id)).filter(Boolean);
  if (ids.length === 1) return ids[0];
  throw new EmoveError('Hay que indicar el método de pago.', 400, 'METODO_PAGO',
    ids.length ? 'Disponibles: ' + ids.join(', ') : 'La cuenta no tiene métodos autorizados. Contacta con Emove.');
}

export default async function handler(req, res) {
  const op = (req.query.op || '').toString();
  const b = readBody(req);

  try {
    // ── Público: solo lectura de métodos y cotización (devuelve PVP, nunca el neto) ──
    if (op === 'metodos' && req.method === 'GET') {
      const { payload } = await emove('/pedidos/metodos-pago');
      const LABEL = { redsys: 'Tarjeta (Redsys)', bacs: 'Transferencia bancaria' };
      return ok(res, {
        metodos: (payload?.metodos || []).map(m => {
          const id = typeof m === 'string' ? m : (m.id ?? m.codigo);
          return { id, nombre: (typeof m === 'object' && m.nombre) || LABEL[id] || id, tarjeta_guardada: !!(m && m.tarjeta_guardada) };
        }).filter(m => m.id)
      }, 600);
    }

    if (op === 'cotizar' && req.method === 'POST') {
      const payload = {
        articulos: articulos(b.articulos),
        metodo_pago: await metodoPago(b.metodo_pago || 'redsys')
      };
      const ref = str(b.referencia_cliente || b.referencia, 80);
      if (ref) payload.referencia_cliente = ref;
      const idDir = str(b.direccion_envio_id, 120);
      if (idDir) payload.direccion_envio_id = idDir;
      else if (b.direccion_envio || b.shipping) payload.direccion_envio = direccion(b.direccion_envio || b.shipping);
      if (b.confirmar_direccion_sin_numero === true) payload.confirmar_direccion_sin_numero = true;

      const { payload: p } = await emove('/pedidos/cotizaciones', { method: 'POST', body: payload });
      return ok(res, {
        cotizacion_id: p?.id ?? p?.cotizacion_id ?? null,
        metodo_pago: payload.metodo_pago,
        total_pvp: pvp(p?.total),
        moneda: p?.moneda || 'EUR',
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, null),
        segundos_validez: 600
      }, 0);
    }

    // ── Privado: todo lo que crea pedidos o mueve dinero ──
    if (op === 'direcciones' && req.method === 'GET') {
      owner(req);
      const { payload } = await emove('/pedidos/direcciones-envio');
      return ok(res, { direcciones: payload?.direcciones || [] }, 300);
    }

    if (op === 'confirmar' && req.method === 'POST') {
      owner(req);
      const cid = str(b.cotizacion_id, 120);
      if (!UUID.test(cid)) throw new EmoveError('cotizacion_id debe ser un UUID válido.', 400, 'COTIZACION', 'Cotiza de nuevo antes de confirmar.');
      if (b.acepta_condiciones !== true) throw new EmoveError('Hay que aceptar las condiciones.', 400, 'CONDICIONES', 'Marca la aceptación.');
      const { payload: p, status } = await emove('/pedidos', {
        method: 'POST',
        headers: { 'Idempotency-Key': ('riveu-man-' + cid).slice(0, 120) },
        body: { cotizacion_id: cid, acepta_condiciones: true },
        noRetry: true
      });
      const id = p?.id ?? p?.pedido_id ?? null;
      return ok(res, {
        pedido_id: id == null ? null : String(id),
        estado: p?.estado ?? null,
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, id),
        reintento: status === 200,
        total_pvp: pvp(p?.total),
        moneda: p?.moneda || 'EUR'
      }, 0);
    }

    if (op === 'estado' && req.method === 'GET') {
      owner(req);
      const id = str(req.query.id, 160);
      if (!NUMID.test(id) && !SIMID.test(id)) throw new EmoveError('Id de pedido no válido.', 400, 'ID', 'En producción es numérico; en pruebas empieza por sim-.');
      const { payload: p } = await emove('/pedidos/' + encodeURIComponent(id));
      return ok(res, {
        pedido_id: String(p?.id ?? id),
        estado: p?.estado ?? null,
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, id),
        seguimiento: p?.seguimiento ?? p?.tracking ?? null,
        total_pvp: pvp(p?.total)
      }, 0);
    }

    if (op === 'pago' && req.method === 'GET') {
      owner(req);
      const id = str(req.query.id, 20);
      if (!NUMID.test(id)) throw new EmoveError('El pago con tarjeta guardada solo aplica a pedidos de producción (id numérico).', 400, 'ID', 'Usa el número de pedido devuelto al confirmar.');
      const { payload: p } = await emove('/pedidos/' + id + '/pago-tarjeta-guardada');
      return ok(res, {
        pedido_id: id,
        estado: p?.estado ?? null,
        total: money(p?.total),
        moneda: p?.moneda || 'EUR',
        tarjetas: (p?.tarjetas || []).map(t => ({ id: t.id, marca: t.marca || null, ultimos4: t.ultimos4 || null, predeterminada: t.predeterminada === true })),
        confirmacion: p?.confirmacion ?? null,
        verificacion: p?.verificacion ? { url: p.verificacion.url || null } : null
      }, 0);
    }

    if (op === 'pago-confirmar' && req.method === 'POST') {
      owner(req);
      const id = str(b.pedido_id, 20);
      if (!NUMID.test(id)) throw new EmoveError('Id de pedido no válido para pago.', 400, 'ID', 'Debe ser el número de pedido de producción.');
      const tarjeta = str(b.tarjeta, 64);
      const confirmacion = str(b.confirmacion, 64);
      if (!HEX64.test(tarjeta) || !HEX64.test(confirmacion)) {
        throw new EmoveError('Tokens de pago inválidos o caducados.', 400, 'PAGO', 'Vuelve a consultar op=pago y usa la tarjeta y la confirmación frescas.');
      }
      const nav = b.navegador || {};
      const depth = String(nav.depth ?? '');
      if (DEPTHS.indexOf(depth) < 0) throw new EmoveError('Profundidad de color no admitida.', 400, 'NAVEGADOR', 'Valores válidos: ' + DEPTHS.join(', '));
      const ip = clientIp(req);
      const navegador = {
        width: str(nav.width, 5), height: str(nav.height, 5), depth,
        tz: str(nav.tz, 4), language: str(nav.language, 35),
        agent: str(nav.agent, 2048),
        accept: str(req.headers['accept'] || '*/*', 2048),
        ip
      };
      if (!/^[1-9][0-9]{0,4}$/.test(navegador.width) || !/^[1-9][0-9]{0,4}$/.test(navegador.height)) throw new EmoveError('Dimensiones de pantalla no válidas.', 400, 'NAVEGADOR', null);
      if (!/^-?[0-9]{1,3}$/.test(navegador.tz)) throw new EmoveError('Zona horaria no válida.', 400, 'NAVEGADOR', null);
      if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(navegador.language)) throw new EmoveError('Idioma del navegador no válido.', 400, 'NAVEGADOR', null);
      if (!navegador.agent || !navegador.accept) throw new EmoveError('Faltan agent o accept del navegador.', 400, 'NAVEGADOR', null);
      if (!IPV4.test(ip) && !IPV6.test(ip)) throw new EmoveError('No se pudo determinar tu IP.', 400, 'IP', 'Reintenta desde el backoffice.');

      const { payload: p } = await emove('/pedidos/' + id + '/pago-tarjeta-guardada/confirmar', {
        method: 'POST', noRetry: true,
        body: { acepta: true, tarjeta, confirmacion, navegador }
      });
      return ok(res, {
        pedido_id: id,
        estado: p?.estado ?? null,
        total: money(p?.total),
        moneda: p?.moneda || 'EUR',
        verificacion: p?.verificacion ? { url: p.verificacion.url || null } : null
      }, 0);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(404).json({ ok: false, error: 'OP', mensaje: 'Operación no reconocida. Usa op=metodos|cotizar|direcciones|confirmar|estado|pago|pago-confirmar.' });
  } catch (e) { return fail(res, e); }
}
