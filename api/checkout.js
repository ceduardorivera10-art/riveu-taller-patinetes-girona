import { emove, fail, ok, readBody, pvp, int, EmoveError } from './_emove.js';
import { createSession, chunkMeta, StripeError } from './_stripe.js';

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const REQ = ['first_name', 'address_1', 'city', 'postcode', 'phone'];
const OPT = ['last_name', 'company', 'address_2', 'state', 'email'];
const SITE = () => (process.env.SITE_URL || 'https://www.riveu.es').replace(/\/+$/, '');

function clientIp(req) {
  const xf = str(req.headers['x-forwarded-for'] || '', 200);
  if (xf) return xf.split(',')[0].trim();
  return str(req.socket && req.socket.remoteAddress || '', 45) || '';
}

function direccion(input) {
  const a = {};
  REQ.concat(OPT).forEach(k => { const v = str(input?.[k], 254); if (v) a[k] = v; });
  const faltan = REQ.filter(k => !a[k]);
  if (faltan.length) {
    throw new EmoveError('Faltan campos del destinatario: ' + faltan.join(', '), 400, 'DIRECCION',
      'Nombre, dirección, ciudad, código postal y teléfono son obligatorios.');
  }
  // Restricción comercial: solo se vende y se envía dentro de España.
  const pais = (str(input?.country, 2) || 'ES').toUpperCase();
  if (pais !== 'ES') {
    throw new EmoveError('Las compras y los envíos de la tienda Riveu están disponibles solo dentro de España.',
      400, 'FUERA_ESPANA',
      'Si necesitas el pedido en otro país, contacta con el taller por teléfono y lo estudiamos caso a caso.');
  }
  a.country = 'ES';
  if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) {
    throw new EmoveError('El email no es válido.', 400, 'EMAIL', 'Corrígelo o déjalo vacío.');
  }
  return a;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'METODO', mensaje: 'Usa POST.' }); }
  const b = readBody(req);

  try {
    const articulos = (Array.isArray(b.articulos) ? b.articulos : [])
      .filter(a => a && str(a.sku, 110))
      .slice(0, 100)
      .map(a => ({ sku: str(a.sku, 110), cantidad: int(a.cantidad, 1, 10000, 1) }));
    if (!articulos.length) throw new EmoveError('El carrito está vacío.', 400, 'SIN_ARTICULOS', 'Añade al menos un recambio.');

    const dir = direccion(b.direccion);

    const { payload: q } = await emove('/pedidos/cotizaciones', {
      method: 'POST',
      body: { articulos, metodo_pago: 'redsys', direccion_envio: dir, referencia_cliente: str(b.referencia, 80) || undefined }
    });

    const totalPvp = pvp(q?.total);
    if (totalPvp == null || totalPvp <= 0) {
      throw new EmoveError('No se puede calcular el precio de venta.', 503, 'SIN_MARKUP',
        'Configura RIVEU_MARKUP (por ejemplo 1.45) y RIVEU_IVA (0.21) en Vercel y redespliega.');
    }
    const cents = Math.round(totalPvp * 100);
    if (cents < 50) throw new EmoveError('El importe es inferior al mínimo de la pasarela.', 400, 'IMPORTE_MINIMO', 'Añade algún artículo más al pedido.');

    const compact = articulos.map(a => a.sku + ':' + a.cantidad).join('|');
    const nav = b.navegador || {};
    const ip = clientIp(req);
    const md = Object.assign({
      origen: 'riveu-tienda',
      pais: 'ES',
      moneda: 'EUR',
      total_pvp: String(totalPvp),
      metodo_pago: 'redsys',
      referencia: str(b.referencia, 80),
      nav_width: str(nav.width, 5) || '1024',
      nav_height: str(nav.height, 5) || '768',
      nav_depth: str(nav.depth, 2) || '24',
      nav_tz: str(nav.tz, 4) || '60',
      nav_lang: str(nav.language, 35) || 'es-ES',
      nav_accept: str(nav.accept, 480) || '*/*',
      nav_ip: ip
    }, chunkMeta('items', compact), chunkMeta('nav_agent', str(nav.agent, 2000) || 'Mozilla/5.0'));

    REQ.concat(OPT).forEach(k => { if (dir[k]) md['addr_' + k] = dir[k]; });
    md.addr_country = 'ES';

    const resumen = articulos.map(a => a.sku + ' ×' + a.cantidad).join(', ').slice(0, 480);

    const session = await createSession({
      mode: 'payment',
      locale: 'es',
      client_reference_id: str(b.referencia, 80) || undefined,
      customer_email: dir.email || undefined,
      success_url: SITE() + '/gracias.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: SITE() + '/tienda.html?cancelado=1',
      // Stripe también queda limitado a España: si alguien llega por otra vía,
      // el propio Checkout solo ofrecerá direcciones españolas.
      shipping_address_collection: { allowed_countries: ['ES'] },
      billing_address_collection: 'auto',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: cents,
          product_data: {
            name: 'Recambios de patinete · Riveu Girona',
            description: resumen + ' · portes e impuestos incluidos · envío solo en España'
          }
        }
      }],
      payment_intent_data: {
        description: 'Riveu · ' + resumen.slice(0, 300),
        metadata: { items_0: md.items_0 || '', referencia: md.referencia || '', pais: 'ES' }
      },
      metadata: md
    }, 'riveu-checkout-' + Date.now());

    return ok(res, { url: session.url, session_id: session.id, total_pvp: totalPvp, moneda: 'EUR', pais: 'ES' }, 0);
  } catch (e) {
    if (e instanceof StripeError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ ok: false, error: e.code, mensaje: e.message, pista: e.hint });
    }
    return fail(res, e);
  }
}
