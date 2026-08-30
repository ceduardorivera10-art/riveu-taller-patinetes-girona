// api/create-checkout-session.js — Pago Stripe + envío + restricción a España.
function parseCSV(text){const rows=[];const lines=text.split(/\r?\n/);if(lines.length<2)return rows;const header=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
 for(let i=1;i<lines.length;i++){const line=lines[i].trim();if(!line)continue;const f=[];let cur='',q=false;
  for(let j=0;j<line.length;j++){const c=line[j];if(c==='"'){q=!q;}else if(c===','&&!q){f.push(cur);cur='';}else{cur+=c;}}f.push(cur);
  const o={};header.forEach((h,idx)=>{o[h]=(f[idx]||'').trim().replace(/^"|"$/g,'');});if(o.SKU)rows.push(o);}return rows;}

export default async function handler(req, res){
  if(req.method!=='POST') return res.status(405).json({error:'Método no permitido'});
  const secret=process.env.STRIPE_SECRET_KEY;
  if(!secret) return res.status(500).json({error:'Stripe no configurado en Vercel'});

  let body={}; try{ body = typeof req.body==='string'? JSON.parse(req.body) : (req.body||{}); }catch(e){}
  const sku=String(body.sku||'').trim();
  const qty=Math.max(1, parseInt(body.qty||1,10)||1);
  if(!sku) return res.status(400).json({error:'Falta el SKU del producto'});

  let title=sku, price=null;
  try{
    const r=await fetch('https://emovedistribution.com/wp-content/uploads/woo-feed/custom/csv/scootech-2.csv');
    const rows=parseCSV(await r.text()); const p=rows.find(x=>x.SKU===sku);
    if(p){ title=p.title||sku; price=parseFloat((p.price||'').replace(',','.')); }
  }catch(e){}
  if(price===null||isNaN(price)){
    try{ const r2=await fetch('productos.csv'); const rows2=parseCSV(await r2.text()); const p2=rows2.find(x=>x.SKU===sku);
      if(p2){ title=p2.title||sku; price=parseFloat((p2.price||'').replace(',','.')); } }catch(e){}
  }
  if(price===null||isNaN(price)) return res.status(404).json({error:'Producto no encontrado'});

  const unit=Math.round(price*100);
  const subtotal=unit*qty;
  const origin='https://'+(req.headers.host||'riveu-taller-patinetes-girona.vercel.app');

  const params=new URLSearchParams();
  params.append('mode','payment');
  params.append('success_url', origin+'/?pago=ok');
  params.append('cancel_url', origin+'/?pago=cancelado');
  // Solo se permiten direcciones de España en Stripe (red de seguridad)
  params.append('shipping_address_collection[allowed_countries][]','ES');
  params.append('line_items[0][quantity]', String(qty));
  params.append('line_items[0][price_data][currency]','eur');
  params.append('line_items[0][price_data][unit_amount]', String(unit));
  params.append('line_items[0][price_data][product_data][name]', title);

  if(subtotal < 10000){
    params.append('line_items[1][quantity]','1');
    params.append('line_items[1][price_data][currency]','eur');
    params.append('line_items[1][price_data][unit_amount]','500');
    params.append('line_items[1][price_data][product_data][name]','Envío 24-48h (España peninsular)');
  }

  const sr=await fetch('https://api.stripe.com/v1/checkout/sessions',{
    method:'POST',
    headers:{'Authorization':'Bearer '+secret,'Content-Type':'application/x-www-form-urlencoded'},
    body:params
  });
  const data=await sr.json();
  if(!sr.ok) return res.status(sr.status).json({error:(data.error&&data.error.message)||'Error de Stripe'});
  res.status(200).json({url:data.url});
}
