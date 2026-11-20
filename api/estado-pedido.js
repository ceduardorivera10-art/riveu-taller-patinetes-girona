import { emove, ok, fail, pvp, esPruebas } from './_emove.js';
import { getSession, unchunkMeta, StripeError } from './_stripe.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ ok: false, error: 'METODO', mensaje: 'Usa GET.' }); }
  const id = (req.query.session_id || '').toString().trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ ok: false, error: 'SESSION', mensaje: 'Identificador de sesión no válido.' });
  try {
    const s = await getSession(id);
    const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
    const md = (pi && pi.metadata) || {};
    const pedidoId = md.emove_pedido_id || null;
    const out = {
      pagado: s.payment_status === 'paid',
      importe: (s.amount_total || 0) / 100,
      moneda: (s.currency || 'eur').toUpperCase(),
      email: s.customer_details?.email || s.customer_email || null,
      pedido_id: pedidoId,
      pago_distribuidor: md.emove_pago || null,
      verificacion_url: md.emove_3ds || null,
      reembolsado: md.emove_estado === 'reembolsado_sin_stock',
      motivo: md.emove_motivo || null,
      articulos: unchunkMeta(s.metadata || {}, 'items').split('|').filter(Boolean),
      envio: {
        nombre: [s.metadata?.addr_first_name, s.metadata?.addr_last_name].filter(Boolean).join(' '),
        linea: s.metadata?.addr_address_1 || '',
        ciudad: [s.metadata?.addr_postcode, s.metadata?.addr_city].filter(Boolean).join(' '),
        pais: s.metadata?.addr_country || ''
      },
      estado: null, entorno: null, pruebas: false, seguimiento: null
    };
    if (pedidoId) {
      try {
        const { payload: p } = await emove('/pedidos/' + encodeURIComponent(pedidoId));
        out.estado = p?.estado ?? null; out.entorno = p?.entorno ?? null;
        out.pruebas = esPruebas(p, pedidoId);
        out.seguimiento = p?.seguimiento ?? p?.tracking ?? null;
        if (p?.total != null) out.coste_pvp = pvp(p.total);
      } catch (_) {}
    }
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, out, 0);
  } catch (e) {
    if (e instanceof StripeError) { res.setHeader('Cache-Control', 'no-store'); return res.status(e.status).json({ ok: false, error: e.code, mensaje: e.message, pista: e.hint }); }
    return fail(res, e);
  }
}
