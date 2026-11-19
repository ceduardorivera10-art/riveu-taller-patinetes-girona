import { emove, fail, ok, readBody, pvp, money, int, esPruebas, EmoveError } from './_emove.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Campos y límites exactos de components → direccion_envio del OpenAPI.
const OBLIGATORIOS = ['first_name', 'address_1', 'city', 'postcode', 'country', 'phone'];
const OPCIONALES = ['last_name', 'company', 'address_2', 'state', 'email'];

function direccion(input) {
  const a = {};
  OBLIGATORIOS.concat(OPCIONALES).forEach(k => {
    const v = str(input?.[k], 254);
    if (v) a[k] = v;
  });

  const faltan = OBLIGATORIOS.filter(k => !a[k]);
  if (faltan.length) {
    throw new EmoveError('Faltan campos obligatorios del destinatario: ' + faltan.join(', '),
      400, 'DIRECCION_INCOMPLETA', 'Nombre, dirección, ciudad, código postal, país y teléfono son obligatorios. Apellidos y email son opcionales.');
  }
  if (!/^[a-zA-Z]{2}$/.test(a.country)) {
    throw new EmoveError('El país debe ser un código de dos letras (ES, FR, PT…).', 400, 'PAIS', 'Usa el código ISO de dos letras.');
  }
  a.country = a.country.toUpperCase();
  // El email es opcional, pero si viene, debe ser válido.
  if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) {
    throw new EmoveError('El email del destinatario no es válido.', 400, 'EMAIL', 'Corrige el correo o déjalo vacío.');
  }
  return a;
}

function articulos(list) {
  const out = (Array.isArray(list) ? list : [])
    .filter(a => a && str(a.sku, 110))
    .slice(0, 100)
    .map(a => ({ sku: str(a.sku, 110), cantidad: int(a.cantidad, 1, 10000, 1) }));
  if (!out.length) throw new EmoveError('El pedido no tiene artículos.', 400, 'SIN_ARTICULOS', 'Añade al menos un recambio.');
  return out;
}

async function metodoPago(requested) {
  const m = str(requested, 20);
  if (m === 'redsys' || m === 'bacs') return m;
  // El OpenAPI marca metodo_pago como obligatorio. Si el cliente no lo manda,
  // lo resolvemos desde la cuenta; si hay varios, hay que elegir.
  const { payload } = await emove('/pedidos/metodos-pago');
  const ids = (payload?.metodos || []).map(x => (typeof x === 'string' ? x : x.id)).filter(Boolean);
  if (ids.length === 1) return ids[0];
  throw new EmoveError('Hay que indicar el método de pago.', 400, 'METODO_PAGO',
    ids.length ? 'Métodos disponibles: ' + ids.join(', ') : 'La cuenta no tiene métodos de pago autorizados. Contacta con soporte de Emove.');
}

export default async function handler(req, res) {
  const op = (req.query.op || '').toString();
  const b = readBody(req);

  try {
    if (op === 'metodos' && req.method === 'GET') {
      const { payload } = await emove('/pedidos/metodos-pago');
      const LABEL = { redsys: 'Tarjeta (Redsys)', bacs: 'Transferencia bancaria' };
      const metodos = (payload?.metodos || []).map(m => {
        const id = typeof m === 'string' ? m : (m.id ?? m.codigo);
        return { id, nombre: (typeof m === 'object' && m.nombre) || LABEL[id] || id };
      }).filter(m => m.id);
      return ok(res, { metodos }, 600);
    }

    if (op === 'direcciones' && req.method === 'GET') {
      const { payload } = await emove('/pedidos/direcciones-envio');
      return ok(res, { direcciones: payload?.direcciones || [] }, 300);
    }

    if (op === 'cotizar' && req.method === 'POST') {
      const payload = {
        articulos: articulos(b.articulos),
        metodo_pago: await metodoPago(b.metodo_pago)
      };

      const ref = str(b.referencia_cliente, 80); // maxLength 80 según OpenAPI
      if (ref) payload.referencia_cliente = ref;

      // El esquema prohíbe mandar más de uno de estos tres a la vez.
      const idDir = str(b.direccion_envio_id, 120);
      if (idDir) payload.direccion_envio_id = idDir;
      else if (b.direccion_envio || b.shipping) payload.direccion_envio = direccion(b.direccion_envio || b.shipping);

      if (b.confirmar_direccion_sin_numero === true) payload.confirmar_direccion_sin_numero = true;

      const { payload: p } = await emove('/pedidos/cotizaciones', { method: 'POST', body: payload });

      // La cotización devuelve un total neto, sin desglose garantizado.
      // Aplicamos el margen sobre ese total: es la cifra autoritativa.
      const totalNeto = money(p?.total);
      const totalPvp = pvp(totalNeto);

      const lineas = (p?.articulos || p?.lineas || []).map(l => ({
        sku: l.sku,
        cantidad: int(l.cantidad, 1, 10000, 1),
        pvp: pvp(l.precio_unitario_neto)
      }));

      return ok(res, {
        cotizacion_id: p?.id ?? p?.cotizacion_id ?? null,
        metodo_pago: payload.metodo_pago,
        lineas,
        total_pvp: totalPvp,
        desglose: totalPvp == null ? null : {
          // Solo si la API trae desglose; si no, el total ya lo incluye todo.
          portes: pvp(p?.portes ?? p?.envio ?? p?.shipping_total) ?? null,
          impuestos: pvp(p?.impuestos ?? p?.tax_total) ?? null
        },
        moneda: p?.moneda || 'EUR',
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, null),
        segundos_validez: 600
      }, 0);
    }

    if (op === 'confirmar' && req.method === 'POST') {
      const cid = str(b.cotizacion_id, 120);
      if (!UUID.test(cid)) {
        throw new EmoveError('cotizacion_id debe ser un UUID válido.', 400, 'COTIZACION', 'Vuelve a cotizar antes de confirmar.');
      }
      if (b.acepta_condiciones !== true) {
        throw new EmoveError('Hay que aceptar las condiciones.', 400, 'CONDICIONES', 'Marca la casilla de aceptación.');
      }

      // Idempotency-Key: 8–120 caracteres, estable por cotización.
      // Un reintento repite la clave y Emove devuelve 200 en vez de duplicar.
      const idem = ('riveu-' + cid).slice(0, 120);
      const { payload: p, status } = await emove('/pedidos', {
        method: 'POST',
        headers: { 'Idempotency-Key': idem },
        body: { cotizacion_id: cid, acepta_condiciones: true },
        noRetry: true
      });

      const id = p?.id ?? p?.pedido_id ?? null;
      return ok(res, {
        pedido_id: id,
        estado: p?.estado ?? null,
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, id),
        reintento: status === 200,
        total_pvp: pvp(p?.total),
        moneda: p?.moneda || 'EUR'
      }, 0);
    }

    if (op === 'estado' && req.method === 'GET') {
      const id = str(req.query.id, 160);
      if (!id) throw new EmoveError('Falta el identificador del pedido.', 400, 'SIN_ID', null);
      const { payload: p } = await emove('/pedidos/' + encodeURIComponent(id));
      return ok(res, {
        pedido_id: p?.id ?? id,
        estado: p?.estado ?? null,
        entorno: p?.entorno || null,
        pruebas: esPruebas(p, id),
        seguimiento: p?.seguimiento ?? p?.tracking ?? null,
        total_pvp: pvp(p?.total)
      }, 0);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(404).json({
      ok: false, error: 'OP',
      mensaje: 'Operación no reconocida. Usa op=metodos|direcciones|cotizar|confirmar|estado.'
    });
  } catch (e) { return fail(res, e); }
}
