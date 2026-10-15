// api/create-checkout-session.js — Pago Stripe + catálogo en vivo + diagnóstico
function parseCSV(text){const rows=[];const lines=text.split(/\r?\n/);if(lines.length<2)return rows;const header=lines[0].split(',').map(h=>h.trim().replace(/^"|"$/g,''));
 for(let i=1;i<lines.length;i++){const line=lines[i].trim();if(!line)continue;const f=[];let cur='',q=false;
  for(let j=0;j<line.length;j++){const c=line[j];if(c==='"'){q=!q;}else if(c===','&&!q){f.push(cur);cur='';}else{cur+=c;}}f.push(cur);
  const o={};header.forEach((h,idx)=>{o[h]=(f[idx]||'').trim().replace(/^"|"$/g,'');});if(o.SKU)rows.push(o);}return rows;}

async function lookup(sku, origin){
  const sources=[
    {name:'api-products (catálogo en vivo)', url:origin+'/api/products'},
    {name:'productos.csv (respaldo repo)',   url:origin+'/productos.csv'},
    {name:'emove-feed (CSV externo)',        url:'https://emovedistribution.com/wp-content/uploads/woo-feed/custom/csv/scootech-2.csv'}
  ];
  const attempts=[];
  for(const s of sources){
    try{
      const r=await fetch(s.url,{
        cache:'no-store',
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
      });
      if(!r.ok){ attempts.push({fuente:s.name, estado:r.status}); continue; }
      const rows=parseCSV(await r.text());
      const p=rows.find(x=>String(x.SKU||'').trim()===sku);
      if(p){
        const price=parseFloat(String(p.price||'').replace(',','.'));
        if(!isNaN(price)) return {found:true, source:s.name, title:p.title||sku, price, attempts};
      }
      attempts.push({fuente:s.name, estado:'ok', nota:'SKU no aparece'});
    }catch(e){ attempts.push({fuente:s.name, error:String(e&&e.message||e)}); }
  }
  return {found:false, attempts};
}

export default async function handler(req, res){
  const origin='https://'+(req.headers.host||'www.riveu.es');

  /* MODO DIAGNÓSTICO: abre /api/create-checkout-session?sku=TU-SKU en el navegador */
  if(req.method==='GET'){
    const sku=String(req.query.sku||'').trim();
    if(!sku) return res.status(200).json({uso:'Añade ?sku=TU-SKU al final de esta URL para diagnosticar un producto'});
    const L=await lookup(sku, origin);
    return res.status(200).json(L);
  }

  if(req.method!=='POST') return res.status(405).json({error:'Método no permitido'});
  const secret=process.env.STRIPE_SECRET_KEY;
  if(!secret) return res.status(500).json({error:'Stripe no configurado en Vercel'});

  let body={}; try{ body = typeof req.body==='string'? JSON.parse(req.body) : (req.body||{}); }catch(e){}
  const sku=String(body.sku||'').trim();
  const qty=Math.max(1, parseInt(body.qty||1,10)||1);
  if(!sku) return res.status(400).json({error:'Falta el SKU del producto'});

  const L=await lookup(sku, origin);
  if(!L.found) return res.status(404).json({error:'Producto no encontrado', diagnostico:L.attempts});

  const unit=Math.round(L.price*100);
  const subtotal=unit*qty;

  const params=new URLSearchParams();
  params.append('mode','payment');
  params.append('success_url', origin+'/?pago=ok');
  params.append('cancel_url', origin+'/?pago=cancelado');
  params.append('shipping_address_collection[allowed_countries][]','ES');
  params.append('line_items[0][quantity]', String(qty));
  params.append('line_items[0][price_data][currency]','eur');
  params.append('line_items[0][price_data][unit_amount]', String(unit));
  params.append('line_items[0][price_data][product_data][name]', L.title);

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
