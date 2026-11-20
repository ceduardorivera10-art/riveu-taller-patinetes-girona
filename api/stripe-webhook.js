import { emove, pvp, pvpCents, esPruebas, EmoveError, ADDR_KEYS } from './_emove.js';
import { readRaw, verifySignature, getSession, updatePaymentIntent, refund, unchunkMeta } from './_stripe.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const HEX64 = /^[a-f0-9]{64}$/i;
const REQ_ADDR = ['first_name', 'address_1', 'city', 'postcode', 'country', 'phone'];

const parseItems = md => unchunkMeta(md, 'items').split('|').map(s => {
  const m = s.trim().match(/^(.+):(\d+)$/);
  if (!m) return null;
  const sku = m[1].slice(0, 110);
  const n = parseInt(m[2], 10);
  if (!sku || !Number.isFinite(n) || n < 1) return null;
  return { sku, cantidad: Math.min(10000, n) };
}).filter(Boolean).slice(0, 100);

const parseAddr = md => {
  const a = {};
  ADDR_KEYS.forEach(k => { const v = md['addr_' + k]; if (v) a[k] = String(v).slice(0, 254); });
  a.country = 'ES';
  return a;
};

const parseNav = md => ({
  width: md.nav_width || '1024',
  height: md.nav_height || '768',
  depth: md.nav_depth || '24',
  tz: md.nav_tz || '60',
  language: md.nav_lang || 'es-ES',
  agent: unchunkMeta(md, 'nav_agent') || 'Mozilla/5.0',
  accept: md.nav_accept || '*/*',
  ip: md.nav_ip || '127.0.0.1'
});

async function mark(pi, patch) {
  try { await updatePaymentIntent(pi, { metadata: patch }); } catch (_) {}
}

async function devolver(pi, sessionId, estado, motivo) {
  try {
    await refund(pi, 'requested_by_customer', 'riveu-rf-' + sessionId);
    await mark(pi, { emove_estado: estado, emove_motivo: String(motivo || '').slice(0, 400), emove_reembolsado: 'si' });
    return true;
  } catch (e) {
    await mark(pi, { emove_estado: 'reembolso_fallido', emove_motivo: String(e.message).slice(0, 400), emove_reembolsado: 'no' });
    return false;
  }
}

async function fulfil(session) {
  const md = session.metadata || {};
  if (md.origen !== 'riveu-tienda') return { estado: 'ajeno' };

  const piObj = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const pi = piObj ? piObj.id : (typeof session.payment_intent === 'string' ? session.payment_intent : null);
  if (!pi) return { estado: 'sin_payment_intent' };

  // Idempotencia: si ya hay pedido, no se vuelve a crear ni a pagar.
  const piMeta = (piObj && piObj.metadata) || {};
  if (piMeta.emove_pedido_id) return { estado: 'ya_procesado', pedido_id: piMeta.emove_pedido_id };

  const chargedCents = Number(session.amount_total);
  if (!Number.isFinite(chargedCents) || chargedCents <= 0) {
    await mark(pi, { emove_estado: 'importe_invalido' });
    return { estado: 'importe_invalido' };
  }
  if (String(session.currency || '').toLowerCase() !== 'eur') {
    await devolver(pi, session.id, 'moneda_invalida', 'Moneda distinta de EUR.');
    return { estado: 'reembolsado' };
  }

  const items = parseItems(md);
  const dir = parseAddr(md);
  if (!items.length || REQ_ADDR.some(k => !dir[k])) {
    await devolver(pi, session.id, 'datos_incompletos', 'Faltan artículos o datos de envío.');
    return { estado: 'reembolsado' };
  }

  // Re-cotizamos: la cotización del checkout caduca a los 10 minutos.
  let quote;
  try {
    const r = await emove('/pedidos/cotizaciones', {
      method: 'POST',
      body: { articulos: items, metodo_pago: 'redsys', direccion_envio: dir }
    });
    quote = r.payload;
  } catch (e) {
    if (e instanceof EmoveError && (e.status === 400 || e.status === 404 || e.status === 409)) {
      await devolver(pi, session.id, 'no_servible', e.message);
      return { estado: 'reembolsado', motivo: e.message };
    }
    await mark(pi, { emove_estado: 'cotizacion_fallida', emove_motivo: String(e.message).slice(0, 400) });
    throw e; // 500 → Stripe reintenta. La idempotencia evita duplicar.
  }

  // ── CERROJO DE PRECIO: nunca pagar más de lo cobrado ──
  const needCents = pvpCents(quote?.total);
  if (needCents == null) {
    await devolver(pi, session.id, 'sin_margen', 'RIVEU_MARKUP no configurado al procesar el pago.');
    return { estado: 'reembolsado' };
  }
  if (needCents > chargedCents) {
    await devolver(pi, session.id, 'precio_subio',
      'El coste del distribuidor subió de ' + (chargedCents / 100).toFixed(2) + ' € a ' + (needCents / 100).toFixed(2) + ' €. Reembolso automático.');
    return { estado: 'reembolsado', motivo: 'precio_subio' };
  }

  const cid = quote?.id ?? quote?.cotizacion_id;
  if (!cid) {
    await mark(pi, { emove_estado: 'cotizacion_sin_id' });
    throw new Error('Emove no devolvió id de cotización.');
  }

  const { payload: pedido } = await emove('/pedidos', {
    method: 'POST',
    headers: { 'Idempotency-Key': ('riveu-' + session.id).slice(0, 120) },
    body: { cotizacion_id: cid, acepta_condiciones: true },
    noRetry: true
  });

  const pedidoId = String(pedido?.id ?? pedido?.pedido_id ?? '');
  if (!pedidoId) {
    await mark(pi, { emove_estado: 'pedido_sin_id' });
    throw new Error('Emove no devolvió id de pedido.');
  }

  const patch = {
    emove_pedido_id: pedidoId,
    emove_estado: String(pedido?.estado || 'pending'),
    emove_entorno: String(pedido?.entorno || ''),
    emove_coste_pvp: String(pvp(pedido?.total) ?? ''),
    emove_cobrado: (chargedCents / 100).toFixed(2)
  };

  // Pago al distribuidor con la tarjeta guardada. Desactivable con EMOVE_AUTOPAY=0.
  if (process.env.EMOVE_AUTOPAY !== '0' && /^[0-9]+$/.test(pedidoId)) {
    try {
      const { payload: pay } = await emove('/pedidos/' + pedidoId + '/pago-tarjeta-guardada');
      const estado = String(pay?.estado || '');
      if (estado === 'pagado') {
        patch.emove_pago = 'pagado';
      } else if (estado === 'no_disponible') {
        patch.emove_pago = 'requiere_accion';
        patch.emove_motivo = 'El distribuidor no ofrece pago con tarjeta guardada para este pedido.';
      } else {
        const tarjeta = (pay?.tarjetas || []).find(t => t.predeterminada) || (pay?.tarjetas || [])[0];
        if (tarjeta && HEX64.test(String(pay?.confirmacion || ''))) {
          const { payload: conf } = await emove('/pedidos/' + pedidoId + '/pago-tarjeta-guardada/confirmar', {
            method: 'POST', noRetry: true,
            body: { acepta: true, tarjeta: tarjeta.id, confirmacion: pay.confirmacion, navegador: parseNav(md) }
          });
          const ce = String(conf?.estado || 'desconocido');
          patch.emove_pago = ce;
          if (conf?.verificacion?.url) patch.emove_3ds = String(conf.verificacion.url).slice(0, 480);
          if (ce !== 'pagado' && ce !== 'verificacion' && ce !== 'procesando') patch.emove_pago = 'requiere_accion';
        } else {
          patch.emove_pago = 'requiere_accion';
          patch.emove_motivo = 'No hay tarjeta guardada utilizable o falta el token de confirmación.';
        }
      }
    } catch (e) {
      patch.emove_pago = 'requiere_accion';
      patch.emove_motivo = String(e.message).slice(0, 400);
    }
  } else {
    patch.emove_pago = 'pendiente';
  }

  await updatePaymentIntent(pi, { metadata: patch });
  return { estado: 'creado', pedido_id: pedidoId, pago: patch.emove_pago };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).send('Usa POST.'); }

  let raw;
  try { raw = await readRaw(req); } catch (_) { return res.status(400).send('Body ilegible.'); }
  try { verifySignature(raw, req.headers['stripe-signature']); }
  catch (e) { return res.status(e.status || 400).send(e.message); }

  let event;
  try { event = JSON.parse(raw); } catch (_) { return res.status(400).send('JSON inválido.'); }

  const tipos = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (tipos.indexOf(event.type) < 0) return res.status(200).json({ received: true, ignored: event.type });

  try {
    const session = await getSession(event.data.object.id);
    // Solo se crea pedido con el cobro confirmado. Nunca antes.
    if (session.payment_status !== 'paid') return res.status(200).json({ received: true, paid: false });
    const out = await fulfil(session);
    return res.status(200).json({ received: true, ...out });
  } catch (e) {
    return res.status(500).json({ received: false, error: e.code || 'ERROR', message: e.message });
  }
}
