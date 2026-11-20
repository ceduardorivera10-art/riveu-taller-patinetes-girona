import { emove, fail, ok, readBody, pvpCents, str, articulos, direccion, clientIp, EmoveError } from './_emove.js';
import { createSession, chunkMeta, StripeError } from './_stripe.js';

const SITE = () => (process.env.SITE_URL || 'https://www.riveu.es').replace(/\/+$/, '');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METODO', mensaje: 'Usa POST.' });
  }
  const b = readBody(req);

  try {
    // Sin margen configurado NO se vende: evita vender a precio de coste.
    if (pvpCents(1) == null) {
      throw new EmoveError('El precio de venta no está configurado.', 503, 'SIN_MARKUP',
        'Configura RIVEU_MARKUP (por ejemplo 1.45) y RIVEU_IVA (0.21) en Vercel y redespliega.');
    }

    const arts = articulos(b.articulos);
    const dir = direccion(b.direccion);

    const { payload: q } = await emove('/pedidos/cotizaciones', {
      method: 'POST',
      body: { articulos: arts, metodo_pago: 'redsys', direccion_envio: dir }
    });

    const cents = pvpCents(q?.total);
    if (cents == null || cents <= 0) {
      throw new EmoveError('No se pudo calcular el importe a cobrar.', 502, 'COTIZACION', 'Vuelve a intentarlo en unos segundos.');
    }
    if (cents < 50) {
      throw new EmoveError('El importe es inferior al mínimo de la pasarela (0,50 €).', 400, 'IMPORTE_MINIMO', 'Añade algún artículo más al pedido.');
    }
    const moneda = String(q?.moneda || 'EUR').toUpperCase();
    if (moneda !== 'EUR') throw new EmoveError('El distribuidor devolvió una moneda no admitida.', 502, 'MONEDA', 'Contacta con el taller.');

    const compact = arts.map(a => a.sku + ':' + a.cantidad).join('|');
    const nav = b.navegador || {};
    const md = Object.assign({
      origen: 'riveu-tienda',
      pais: 'ES',
      moneda: 'EUR',
      metodo_pago: 'redsys',
      lock_cents: String(cents),
      nav_width: str(nav.width, 5) || '1024',
      nav_height: str(nav.height, 5) || '768',
      nav_depth: str(nav.depth, 2) || '24',
      nav_tz: str(nav.tz, 4) || '60',
      nav_lang: str(nav.language, 35) || 'es-ES',
      nav_accept: str(nav.accept, 480) || '*/*',
      nav_ip: clientIp(req)
    }, chunkMeta('items', compact), chunkMeta('nav_agent', str(nav.agent, 2000) || 'Mozilla/5.0'));

    Object.keys(dir).forEach(k => { md['addr_' + k] = dir[k]; });
    md.addr_country = 'ES';

    const resumen = arts.map(a => a.sku + ' ×' + a.cantidad).join(', ').slice(0, 480);

    const session = await createSession({
      mode: 'payment',
      locale: 'es',
      customer_email: dir.email || undefined,
      success_url: SITE() + '/gracias.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: SITE() + '/tienda.html?cancelado=1',
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
        metadata: { origen: 'riveu-tienda', lock_cents: String(cents) }
      },
      metadata: md
    }, 'riveu-ck-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));

    return ok(res, { url: session.url, session_id: session.id, total_pvp: cents / 100, moneda: 'EUR', pais: 'ES' }, 0);
  } catch (e) {
    if (e instanceof StripeError) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(e.status).json({ ok: false, error: e.code, mensaje: e.message, pista: e.hint });
    }
    return fail(res, e);
  }
}
