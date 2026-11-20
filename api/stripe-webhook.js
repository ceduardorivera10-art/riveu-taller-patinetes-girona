import { emove, pvp, esPruebas, EmoveError } from './_emove.js';
import { readRaw, verifySignature, getSession, updatePaymentIntent, refund, unchunkMeta } from './_stripe.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const REQ = ['first_name', 'address_1', 'city', 'postcode', 'country', 'phone'];
const OPT = ['last_name', 'company', 'address_2', 'state', 'email'];
const HEX64 = /^[a-f0-9]{64}$/i;

const parseItems = md => unchunkMeta(md, 'items').split('|').map(s => {
  const m = s.trim().match(/^(.+):(\d+)$/);
  return m ? { sku: m[1].slice(0, 110), cantidad: Math.max(1, Math.min(10000, parseInt(m[2], 10))) } : null;
}).filter(Boolean).slice(0, 100);

const parseAddr = md => { const a = {}; REQ.concat(OPT).forEach(k => { if (md['addr_' + k]) a[k] = String(md['addr_' + k]).slice(0, 254); }); return a; };
const parseNav = md => ({
  width: md.nav_width || '1024', height: md.nav_height || '768', depth: md.nav_depth || '24',
  tz: md.nav_tz || '60', language: md.nav_lang || 'es-ES',
  agent: unchunkMeta(md, 'nav_agent') || 'Mozilla/5.0',
  accept: md.nav_accept || '*/*', ip: md.nav_ip || '127.0.0.1'
});

async function fulfil(session) {
  const md = session.metadata || {};
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id);
  if (!pi) return { estado: 'sin_payment_intent' };
  const piMeta = (typeof session.payment_intent === 'object' && session.payment_intent.metadata) || {};
  if (piMeta.emove_pedido_id) return { estado: 'ya_procesado', pedido_id: piMeta.emove_pedido_id };

  const articulos = parseItems(md), direccion = parseAddr(md);
  if (!articulos.length || REQ.some(k => !direccion[k])) {
    await updatePaymentIntent(pi, { metadata: { emove_estado: 'datos_incompletos' } });
    return { estado: 'datos_incompletos' };
  }

  let quote;
  try {
    const r = await emove('/pedidos/cotizaciones', { method: 'POST', body: { articulos, metodo_pago: 'redsys', direccion_envio: direccion, referencia_cliente: md.referencia || undefined } });
    quote = r.payload;
  } catch (e) {
    if (e instanceof EmoveError && (e.status === 400 || e.status === 409)) {
      await refund(pi, 'riveu-refund-' + session.id);
      await updatePaymentIntent(pi, { metadata: { emove_estado: 'reembolsado_sin_stock', emove_motivo: String(e.message).slice(0, 400) } });
      return { estado: 'reembolsado', motivo: e.message };
    }
    await updatePaymentIntent(pi, { metadata: { emove_estado: 'cotizacion_fallida', emove_motivo: String(e.message).slice(0, 400) } });
    throw e;
  }

  const cid = quote?.id ?? quote?.cotizacion_id;
  if (!cid) throw new Error('Emove no devolvió id de cotización.');

  const { payload: pedido } = await emove('/pedidos', {
    method: 'POST',
    headers: { 'Idempotency-Key': ('riveu-' + session.id).slice(0, 120) },
    body: { cotizacion_id: cid, acepta_condiciones: true },
    noRetry: true
  });
  const pedidoId = String(pedido?.id ?? pedido?.pedido_id ?? '');
  const patch = {
    emove_pedido_id: pedidoId,
    emove_estado: String(pedido?.estado || 'pending'),
    emove_entorno: String(pedido?.entorno || ''),
    emove_total_pvp: String(pvp(pedido?.total) ?? '')
  };

  if (process.env.EMOVE_AUTOPAY !== '0' && /^[0-9]+$/.test(pedidoId)) {
    try {
      const { payload: pay } = await emove('/pedidos/' + pedidoId + '/pago-tarjeta-guardada');
      const tarjeta = (pay?.tarjetas || []).find(t => t.predeterminada) || (pay?.tarjetas || [])[0];
      if (pay?.estado === 'pagado') patch.emove_pago = 'pagado';
      else if (tarjeta && HEX64.test(String(pay?.confirmacion || '')) && pay?.estado !== 'no_disponible') {
        const { payload: conf } = await emove('/pedidos/' + pedidoId + '/pago-tarjeta-guardada/confirmar', {
          method: 'POST', noRetry: true,
          body: { acepta: true, tarjeta: tarjeta.id, confirmacion: pay.confirmacion, navegador: parseNav(md) }
        });
        patch.emove_pago = String(conf?.estado || 'desconocido');
        if (conf?.verificacion?.url) patch.emove_3ds = String(conf.verificacion.url).slice(0, 480);
      } else patch.emove_pago = String(pay?.estado || 'no_disponible');
    } catch (e) { patch.emove_pago = 'pendiente'; patch.emove_motivo = String(e.message).slice(0, 400); }
  } else patch.emove_pago = 'pendiente';

  await updatePaymentIntent(pi, { metadata: patch });
  return { estado: 'creado', pedido_id: pedidoId, pago: patch.emove_pago };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).send('Usa POST.'); }
  let raw; try { raw = await readRaw(req); } catch (_) { return res.status(400).send('Body ilegible.'); }
  try { verifySignature(raw, req.headers['stripe-signature']); } catch (e) { return res.status(e.status || 400).send(e.message); }
  let event; try { event = JSON.parse(raw); } catch (_) { return res.status(400).send('JSON inválido.'); }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].indexOf(event.type) < 0) {
    return res.status(200).json({ received: true, ignored: event.type });
  }
  try {
    const session = await getSession(event.data.object.id);
    if (session.payment_status !== 'paid') return res.status(200).json({ received: true, paid: false });
    const out = await fulfil(session);
    return res.status(200).json({ received: true, ...out });
  } catch (e) {
    return res.status(500).json({ received: false, error: e.code || 'ERROR', message: e.message });
  }
}
