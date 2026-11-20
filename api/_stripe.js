// Cliente Stripe REST sin dependencias externas. Firma verificada con node:crypto.
import crypto from 'node:crypto';

const API = 'https://api.stripe.com/v1';

export class StripeError extends Error {
  constructor(message, status, code, hint) {
    super(message); this.status = status; this.code = code; this.hint = hint || null;
  }
}

function encode(obj, prefix = '', out = []) {
  Object.keys(obj || {}).forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null) return;
    const name = prefix ? prefix + '[' + k + ']' : k;
    if (Array.isArray(v)) v.forEach((item, i) => encode({ [i]: item }, name, out));
    else if (typeof v === 'object') encode(v, name, out);
    else out.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(v)));
  });
  return out;
}

function secret() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new StripeError('STRIPE_SECRET_KEY no está configurada.', 503, 'NO_STRIPE_KEY',
    'Añade STRIPE_SECRET_KEY en Vercel → Variables ambientales y redespliega.');
  return k;
}

async function call(path, { method = 'POST', body, idempotency } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + secret(),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {})
    },
    body: body ? encode(body).join('&') : undefined,
    cache: 'no-store'
  });
  const txt = await res.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
  if (!res.ok) {
    const e = (j && j.error) || {};
    throw new StripeError(e.message || ('Stripe devolvió ' + res.status), res.status, e.code || 'STRIPE_' + res.status,
      res.status === 401 ? 'La clave secreta no es válida para este entorno.' : null);
  }
  return j;
}

export const createSession = (body, idempotency) => call('/checkout/sessions', { body, idempotency });
export const updatePaymentIntent = (id, body) => call('/payment_intents/' + encodeURIComponent(id), { body });
export const refund = (paymentIntent, reason, idempotency) =>
  call('/refunds', { body: { payment_intent: paymentIntent, reason: reason || 'requested_by_customer' }, idempotency });
export const getSession = id =>
  call('/checkout/sessions/' + encodeURIComponent(id) + '?expand[]=payment_intent', { method: 'GET' });

export async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

export function verifySignature(raw, header, toleranceSec = 300) {
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  if (!wh) throw new StripeError('STRIPE_WEBHOOK_SECRET no está configurada.', 503, 'NO_WH_SECRET',
    'Crea el endpoint en Stripe → Developers → Webhooks apuntando a /api/stripe-webhook y copia el whsec_…');
  if (!header) throw new StripeError('Falta la cabecera Stripe-Signature.', 400, 'NO_SIG', null);
  const parts = header.split(',').map(s => s.trim());
  const t = (parts.find(p => p.startsWith('t=')) || '').slice(2);
  const sigs = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !sigs.length) throw new StripeError('Firma mal formada.', 400, 'BAD_SIG', null);
  const expected = crypto.createHmac('sha256', wh).update(t + '.' + raw, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex');
  const valid = sigs.some(s => {
    let b; try { b = Buffer.from(s, 'hex'); } catch (_) { return false; }
    return b.length === a.length && crypto.timingSafeEqual(b, a);
  });
  if (!valid) throw new StripeError('Firma no válida.', 400, 'BAD_SIG', 'Comprueba que STRIPE_WEBHOOK_SECRET corresponde al endpoint de este dominio.');
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) throw new StripeError('Marca de tiempo fuera de tolerancia.', 400, 'OLD_SIG', null);
  return true;
}

// Metadata de Stripe: máx. 50 claves y 500 caracteres por valor. Troceamos.
export function chunkMeta(prefix, text, size = 480) {
  const s = String(text || '');
  const out = {};
  for (let i = 0, n = 0; i < s.length && n < 6; i += size, n++) out[prefix + '_' + n] = s.slice(i, i + size);
  if (!Object.keys(out).length) out[prefix + '_0'] = '';
  return out;
}
export function unchunkMeta(md, prefix) {
  let s = '';
  for (let n = 0; n < 6; n++) { const v = md[prefix + '_' + n]; if (v === undefined) break; s += v; }
  return s;
}
