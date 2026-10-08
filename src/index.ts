import { storefrontHtml } from "./renderHtml-3";

interface Env {
  DB: D1Database;
  AI?: { run(model:string, input:unknown):Promise<{image?:string}> };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

async function hashPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password)
  );

  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureOrderSupport(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_sessions (
      token_hash TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_order_meta (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id), request_key TEXT UNIQUE,
      fingerprint TEXT, validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN (0,1)), validation_key TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_order_cancellations (
      order_id INTEGER PRIMARY KEY REFERENCES orders(id), cancelled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`) 
  ]);
}
async function issueSession(env: Env, merchantId: number) {
  await ensureOrderSupport(env);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  await env.DB.prepare("INSERT INTO mbl_sessions (token_hash,merchant_id,expires_at) VALUES (?,?,?)")
    .bind(await hashPassword(token),merchantId,Date.now()+30*24*3600*1000).run();
  return token;
}
async function ownsShop(env: Env, request: Request, shopId: number) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /,"") || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  await ensureOrderSupport(env);
  return !!await env.DB.prepare(`SELECT s.id FROM shops s JOIN mbl_sessions ms ON ms.merchant_id=s.merchant_id
    WHERE s.id=? AND ms.token_hash=? AND ms.expires_at>?`)
    .bind(shopId,await hashPassword(token),Date.now()).first();
}

async function ensureProductDiscountSupport(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_product_settings (
    product_id INTEGER PRIMARY KEY REFERENCES products(id),
    allow_discount INTEGER NOT NULL DEFAULT 1 CHECK(allow_discount IN (0,1)))`).run();
}

async function ensureFavoritesSupport(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_product_favorites (
    shop_id INTEGER NOT NULL REFERENCES shops(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    visitor_hash TEXT NOT NULL,
    PRIMARY KEY(shop_id,product_id,visitor_hash))`).run();
}

const V11_ICONS:Record<string,string>={"192":"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","512":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAWvklEQVR4nO3deZCc5X3g8e6eQzOjgzk0QloJECBAKMExYAF2bA4hGePEwYCBbO2atTeOE6eclGu9VXY2l7Mb24lzOQ4V4nJiUk4qaxDmju0gyZIFBmwOy2AjARJIIKFzDmnumZ7u/AFljDLSHG+/0+/o9/kU/1Alnn6K0fS3+32f93nyH1r5oxwA8RSqPQEAqkMAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEACEoAAIISAICgBAAgKAEA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AgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABCUAAEEJAEBQAgAQlAAABPUfjPtbtfqIjVoAAAAASUVORK5CYII="};
const V11_SW=`const CACHE='mbl-v11-shell';
self.addEventListener('install',event=>{self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith('mbl-')&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
 if(event.request.mode==='navigate'&&(url.pathname==='/'||url.pathname==='/Index.html')){
  event.respondWith((async()=>{
   const cache=await caches.open(CACHE);
   const key=new Request(self.location.origin+'/');
   try{const response=await fetch(event.request);if(response.ok)await cache.put(key,response.clone());return response;}
   catch(_){return await cache.match(key)||new Response('Connexion indisponible. Reconnectez-vous puis rechargez la boutique.',{status:503,headers:{'Content-Type':'text/plain; charset=UTF-8'}});}
  })());
 }
});`;
async function handleV11(request:Request,env:Env,url:URL):Promise<Response|null>{
 if(url.pathname==='/manifest.webmanifest'&&request.method==='GET'){
  const slug=(url.searchParams.get('shop')||'').trim();
  const start=slug?'/?shop='+encodeURIComponent(slug):'/';
  return new Response(JSON.stringify({id:start,name:'Ma Boutique en Ligne',short_name:'Ma Boutique',
   description:'Vos articles et commandes dans votre boutique en ligne.',start_url:start,scope:'/',
   display:'standalone',background_color:'#f8f9fb',theme_color:'#6035d1',lang:'fr',
   icons:[192,512].map(n=>({src:'/app-icon-'+n+'.png',sizes:n+'x'+n,type:'image/png',purpose:'any maskable'}))}),
   {headers:{'Content-Type':'application/manifest+json','Cache-Control':'no-cache'}});
 }
 const icon=url.pathname.match(/^\/app-icon-(192|512)\.png$/);
 if(icon&&request.method==='GET')return new Response(Uint8Array.from(atob(V11_ICONS[icon[1]]),x=>x.charCodeAt(0)),
  {headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=86400'}});
 if(url.pathname==='/sw.js'&&request.method==='GET')return new Response(V11_SW,
  {headers:{'Content-Type':'text/javascript; charset=UTF-8','Cache-Control':'no-cache','Service-Worker-Allowed':'/'}});
 if(url.pathname==='/api/session'&&request.method==='GET'){
  const sid=Number(url.searchParams.get('shop_id'));
  if(!Number.isSafeInteger(sid)||sid<=0)return json({success:false,message:'Boutique invalide.'},400);
  try{return await ownsShop(env,request,sid)?json({success:true}):json({success:false,message:'Session expirée. Reconnectez-vous.'},401);}
  catch(_){return json({success:false,message:'Vérification momentanément indisponible.'},503);}
 }
 if(url.pathname==='/api/photos/enhance'&&request.method==='POST'){
  try{
   if(Number(request.headers.get('content-length')||0)>360000)return json({success:false,message:'Photo trop volumineuse.'},413);
   const text=await request.text();if(text.length>360000)return json({success:false,message:'Photo trop volumineuse.'},413);
   const body=JSON.parse(text),sid=Number(body.shop_id);
   if(!Number.isSafeInteger(sid)||sid<=0)return json({success:false,message:'Boutique invalide.'},400);
   if(!await ownsShop(env,request,sid))return json({success:false,message:'Reconnectez-vous à votre boutique.'},401);
   if(!env.AI)return json({success:false,message:'Le service IA doit être activé pour cette application. Votre photo originale est conservée.'},503);
   const match=typeof body.image==='string'&&body.image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/);
   if(!match||body.image.length>350000)return json({success:false,message:'Photo invalide.'},400);
   const binary=Uint8Array.from(atob(match[2]),x=>x.charCodeAt(0));
   // Atomic per-shop reservations: at most ten requests per UTC day, including failed runs.
   await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_ai_usage (
    shop_id INTEGER NOT NULL, usage_day TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY(shop_id,usage_day))`).run();
   const day=new Date().toISOString().slice(0,10);
   const reservation=await env.DB.prepare(`INSERT INTO mbl_ai_usage(shop_id,usage_day,requests) VALUES(?,?,1)
    ON CONFLICT(shop_id,usage_day) DO UPDATE SET requests=requests+1 WHERE requests<10 RETURNING requests`)
    .bind(sid,day).first();
   if(!reservation)return json({success:false,message:'Limite de 10 améliorations IA par jour atteinte. Réessayez demain.'},429);
   const form=new FormData();
   form.append('input_image_0',new Blob([binary],{type:'image/'+match[1]}),'product.'+(match[1]==='jpeg'?'jpg':'png'));
   form.append('prompt','Retouch this exact product photograph for an online store. Improve lighting, white balance and clarity naturally. Keep the exact same product, shape, color, markings, text, logos, material and number of objects. Do not add, replace or remove any product or invent details. Keep the composition and background.');
   form.append('width',String(Math.max(256,Math.min(1024,Math.round((Number(body.width)||512)/16)*16))));
   form.append('height',String(Math.max(256,Math.min(1024,Math.round((Number(body.height)||512)/16)*16))));
   const multipart=new Response(form);
   const result=await env.AI.run('@cf/black-forest-labs/flux-2-klein-4b',
    {multipart:{body:multipart.body,contentType:multipart.headers.get('content-type')}});
   if(typeof result?.image!=='string'||!result.image)return json({success:false,message:'L’IA n’a pas renvoyé de photo. Réessayez.'},502);
   return json({success:true,image:'data:image/png;base64,'+result.image});
  }catch(e){return json({success:false,message:e instanceof SyntaxError?'Demande invalide.':'Amélioration IA indisponible. Votre photo originale est conservée.'},e instanceof SyntaxError?400:502);}
 }
 return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if ((url.pathname === "/" || url.pathname === "/Index.html") && request.method === "GET") {
      return new Response(storefrontHtml,{headers:{"Content-Type":"text/html; charset=UTF-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
    }
    const v11=await handleV11(request,env,url);
    if(v11)return v11;
    if (url.pathname === "/api/shops" && request.method === "GET") {
      const slug=(url.searchParams.get("slug")||"").trim();
      if(!slug || slug.length>200)return json({success:false,message:"Lien de boutique invalide"},400);
      try{
        const shop=await env.DB.prepare(`SELECT id,name,slug,logo_url,whatsapp,country,currency,language
          FROM shops WHERE slug=?`).bind(slug).first();
        if(!shop)return json({success:false,message:"Boutique introuvable"},404);
        return json({success:true,shop});
      }catch(error){return json({success:false,message:"Impossible de charger la boutique. Réessayez."},500);}
    }

    if (url.pathname === "/api/favorites" && ["GET","POST"].includes(request.method)) {
      try {
        const body=request.method==="POST"?await request.json() as any:null;
        const sid=Number(body?.shop_id??url.searchParams.get("shop_id"));
        const visitor=body?.visitor_key??url.searchParams.get("visitor_key");
        if(!Number.isSafeInteger(sid)||sid<=0)return json({success:false,message:"Boutique invalide"},400);
        if(visitor!=null && (typeof visitor!=="string"||!/^[a-f0-9]{64}$/.test(visitor)))
          return json({success:false,message:"Favori invalide"},400);
        if(request.method==="POST" && (visitor==null || !Number.isSafeInteger(body.product_id) ||
          body.product_id<=0 || typeof body.enabled!=="boolean"))
          return json({success:false,message:"Favori invalide"},400);
        if(request.method==="GET" && visitor==null && !await ownsShop(env,request,sid))
          return json({success:false,message:"Reconnectez-vous à votre boutique."},401);
        if(!await env.DB.prepare("SELECT id FROM shops WHERE id=?").bind(sid).first())
          return json({success:false,message:"Boutique introuvable"},404);
        await ensureFavoritesSupport(env);
        if(request.method==="POST") {
          const product=await env.DB.prepare("SELECT id FROM products WHERE id=? AND shop_id=? AND active=1")
            .bind(body.product_id,sid).first();
          if(!product)return json({success:false,message:"Article indisponible"},404);
          const visitorHash=await hashPassword(visitor);
          if(body.enabled)await env.DB.prepare(`INSERT OR IGNORE INTO mbl_product_favorites
            (shop_id,product_id,visitor_hash) VALUES (?,?,?)`).bind(sid,body.product_id,visitorHash).run();
          else await env.DB.prepare("DELETE FROM mbl_product_favorites WHERE shop_id=? AND product_id=? AND visitor_hash=?")
            .bind(sid,body.product_id,visitorHash).run();
          return json({success:true,enabled:body.enabled});
        }
        if(visitor!=null) {
          const rows=await env.DB.prepare(`SELECT f.product_id FROM mbl_product_favorites f
            JOIN products p ON p.id=f.product_id AND p.shop_id=f.shop_id
            WHERE f.shop_id=? AND f.visitor_hash=? AND p.active=1 ORDER BY f.product_id`)
            .bind(sid,await hashPassword(visitor)).all();
          return json({success:true,product_ids:(rows.results as any[]).map(x=>Number(x.product_id))});
        }
        const rows=await env.DB.prepare(`SELECT f.product_id,COUNT(*) AS favorite_count FROM mbl_product_favorites f
          JOIN products p ON p.id=f.product_id AND p.shop_id=f.shop_id
          WHERE f.shop_id=? AND p.active=1 GROUP BY f.product_id ORDER BY favorite_count DESC,f.product_id`)
          .bind(sid).all();
        return json({success:true,total:(rows.results as any[]).reduce((sum,x)=>sum+Number(x.favorite_count),0),
          favorites:rows.results});
      }catch(error){return json({success:false,message:"Impossible de synchroniser les favoris. Réessayez."},500);}
    }

    if (url.pathname === "/api/shop-settings" && ["GET","POST"].includes(request.method)) {
      try {
        const body = request.method === "POST" ? await request.json() as any : null;
        const shopId = Number(body?.shop_id ?? url.searchParams.get("shop_id"));
        if (!Number.isSafeInteger(shopId) || shopId <= 0) return json({success:false,message:"Boutique invalide"},400);
        if (request.method === "POST" && !await ownsShop(env,request,shopId))
          return json({success:false,message:"Reconnectez-vous pour enregistrer les paramètres."},403);
        const shop = await env.DB.prepare("SELECT id,name,logo_url,whatsapp FROM shops WHERE id=?").bind(shopId).first();
        if (!shop) return json({success:false,message:"Boutique introuvable"},404);
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_shop_settings (
          shop_id INTEGER PRIMARY KEY REFERENCES shops(id), tagline TEXT NOT NULL DEFAULT '',
          allow_discount INTEGER NOT NULL DEFAULT 1 CHECK(allow_discount IN (0,1)))`).run();
        if (request.method === "GET") {
          const meta = await env.DB.prepare("SELECT tagline,allow_discount FROM mbl_shop_settings WHERE shop_id=?").bind(shopId).first<{tagline:string,allow_discount:number}>();
          return json({success:true,settings:{name:shop.name,logo_url:shop.logo_url||"",whatsapp:shop.whatsapp||"",
            tagline:meta?.tagline||"",allow_discount:meta ? meta.allow_discount===1 : true}});
        }
        const x = body?.settings;
        if (!x || typeof x.name !== "string" || !x.name.trim() || x.name.length>200 ||
          typeof x.whatsapp !== "string" || !/^[0-9]{6,20}$/.test(x.whatsapp) ||
          typeof x.tagline !== "string" || x.tagline.length>2000 || typeof x.allow_discount !== "boolean" ||
          typeof x.logo_url !== "string" || x.logo_url.length>500000 ||
          (x.logo_url && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(x.logo_url) && !/^https:\/\/[^\s<>"']+$/.test(x.logo_url)))
          return json({success:false,message:"Vérifiez le nom, le numéro WhatsApp et le logo."},400);
        const settings={name:x.name.trim(),whatsapp:x.whatsapp,logo_url:x.logo_url,
          tagline:x.tagline.trim(),allow_discount:x.allow_discount};
        await env.DB.batch([
          env.DB.prepare("UPDATE shops SET name=?,whatsapp=?,logo_url=?,updated_at=? WHERE id=?")
            .bind(settings.name,settings.whatsapp,settings.logo_url||null,new Date().toISOString(),shopId),
          env.DB.prepare(`INSERT INTO mbl_shop_settings (shop_id,tagline,allow_discount) VALUES (?,?,?)
            ON CONFLICT(shop_id) DO UPDATE SET tagline=excluded.tagline,allow_discount=excluded.allow_discount`)
            .bind(shopId,settings.tagline,settings.allow_discount?1:0)
        ]);
        return json({success:true,settings});
      } catch (_) { return json({success:false,message:"Impossible de sauvegarder ou charger les paramètres. Réessayez."},500); }
    }

    if (url.pathname === "/api/payments" && ["GET","POST"].includes(request.method)) {
      try {
        const body = request.method === "POST" ? await request.json() as any : null;
        const shopId = Number(body?.shop_id ?? url.searchParams.get("shop_id"));
        if (!Number.isSafeInteger(shopId) || shopId <= 0) return json({success:false,message:"Boutique invalide"},400);
        if (request.method === "POST" && !await ownsShop(env,request,shopId))
          return json({success:false,message:"Reconnectez-vous pour enregistrer les paiements."},403);
        const shop = await env.DB.prepare("SELECT id FROM shops WHERE id=?").bind(shopId).first();
        if (!shop) return json({success:false,message:"Boutique introuvable"},404);
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mbl_shop_payments (
          shop_id INTEGER PRIMARY KEY REFERENCES shops(id), config TEXT NOT NULL)` ).run();
        if (request.method === "GET") {
          const row = await env.DB.prepare("SELECT config FROM mbl_shop_payments WHERE shop_id=?").bind(shopId).first<{config:string}>();
          return json({success:true,payments:row ? JSON.parse(row.config) : {delivery:true,mobile:{}}});
        }
        const input = body?.payments;
        if (!input || typeof input.delivery !== "boolean" || !input.mobile || typeof input.mobile !== "object" || Array.isArray(input.mobile))
          return json({success:false,message:"Configuration des paiements invalide"},400);
        const mobile: Record<string,{enabled:boolean,number:string}> = {};
        const entries = Object.entries(input.mobile);
        if (entries.length > 30) return json({success:false,message:"Trop de moyens de paiement"},400);
        for (const [id,value] of entries) {
          const x = value as any;
          if (!/^[a-z][a-z0-9_]{0,39}$/.test(id) || !x || typeof x.enabled !== "boolean" || typeof x.number !== "string" || x.number.length > 120 || (x.enabled && !x.number.trim()))
            return json({success:false,message:"Vérifiez les numéros des moyens de paiement activés."},400);
          mobile[id] = {enabled:x.enabled,number:x.number.trim()};
        }
        if (!input.delivery && !Object.values(mobile).some(x=>x.enabled))
          return json({success:false,message:"Activez au moins un mode de paiement."},400);
        const payments = {delivery:input.delivery,mobile};
        await env.DB.prepare(`INSERT INTO mbl_shop_payments (shop_id,config) VALUES (?,?)
          ON CONFLICT(shop_id) DO UPDATE SET config=excluded.config`).bind(shopId,JSON.stringify(payments)).run();
        return json({success:true,payments});
      } catch (_) { return json({success:false,message:"Impossible d’enregistrer ou charger les paiements. Réessayez."},500); }
    }

    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const tables = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all();

        return json({
          success: true,
          message: "Connexion D1 réussie",
          tables: tables.results,
        });
      } catch (error) {
        return json({
          success: false,
          message: "Erreur de connexion à D1",
          error: String(error),
        }, 500);
      }
    }

    // Création du commerçant et de sa boutique
    if (url.pathname === "/api/shops" && request.method === "POST") {
      try {
        const body = await request.json() as {
          email?: string;
          password?: string;
          password_hash?: string;
          merchant_name?: string;
          phone?: string;
          shop_name?: string;
          slug?: string;
          logo_url?: string;
          whatsapp?: string;
          country?: string;
          currency?: string;
          language?: string;
        };

        if (
          !body.email ||
          !(body.password || body.password_hash) ||
          !body.merchant_name ||
          !body.shop_name ||
          !body.slug
        ) {
          return json({
            success: false,
            message: "Informations obligatoires manquantes",
          }, 400);
        }

        const email = body.email.toLowerCase().trim();
        const country = body.country || "BF";
        const currency = body.currency || "XOF";
        const language = body.language || "fr";
        const now = new Date().toISOString();
        const passwordHash = body.password
          ? await hashPassword(body.password)
          : String(body.password_hash);

        const existingMerchant = await env.DB.prepare(
          "SELECT id FROM merchants WHERE email = ?"
        ).bind(email).first();

        if (existingMerchant) {
          return json({
            success: false,
            message: "Cette adresse e-mail est déjà utilisée",
          }, 409);
        }

        const existingShop = await env.DB.prepare(
          "SELECT id FROM shops WHERE slug = ?"
        ).bind(body.slug).first();

        if (existingShop) {
          return json({
            success: false,
            message: "Ce lien de boutique est déjà utilisé",
          }, 409);
        }

        const merchant = await env.DB.prepare(`
          INSERT INTO merchants
          (email, password_hash, name, phone, country, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          email,
          passwordHash,
          body.merchant_name,
          body.phone || null,
          country,
          now,
          now
        ).run();

        const merchantId = merchant.meta.last_row_id;

        const shop = await env.DB.prepare(`
          INSERT INTO shops
          (merchant_id, name, slug, logo_url, whatsapp, country,
           currency, language, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          merchantId,
          body.shop_name,
          body.slug,
          body.logo_url || null,
          body.whatsapp || null,
          country,
          currency,
          language,
          now,
          now
        ).run();

        return json({
          success: true,
          message: "Boutique créée avec succès",
          merchant_id: merchantId,
          shop_id: shop.meta.last_row_id,
          session_token: await issueSession(env,Number(merchantId)),
          slug: body.slug,
        }, 201);
      } catch (error) {
        return json({
          success: false,
          message: "Impossible de créer la boutique",
          error: String(error),
        }, 500);
      }
    }

    // Connexion du commerçant
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const body = await request.json() as {
          email?: string;
          password?: string;
        };

        if (!body.email || !body.password) {
          return json({
            success: false,
            message: "E-mail et mot de passe obligatoires",
          }, 400);
        }

        const email = body.email.toLowerCase().trim();
        const passwordHash = await hashPassword(body.password);

        const merchant = await env.DB.prepare(`
          SELECT id, email, name, phone, country
          FROM merchants
          WHERE email = ? AND password_hash = ?
        `).bind(email, passwordHash).first<any>();

        if (!merchant) {
          return json({
            success: false,
            message: "Identifiants incorrects",
          }, 401);
        }

        const shop = await env.DB.prepare(`
          SELECT id, merchant_id, name, slug, logo_url,
                 whatsapp, country, currency, language
          FROM shops
          WHERE merchant_id = ?
          ORDER BY id DESC
          LIMIT 1
        `).bind(merchant.id).first<any>();

        if (!shop) {
          return json({
            success: false,
            message: "Aucune boutique liée à ce compte",
          }, 404);
        }

        return json({
          success: true,
          merchant,
          shop,
          session_token: await issueSession(env,Number(merchant.id)),
        });
      } catch (error) {
        return json({
          success: false,
          message: "Connexion impossible",
          error: String(error),
        }, 500);
      }
    }

    // Articles et galerie, dans la table product_images existante.
    if (url.pathname === "/api/products" && request.method === "GET") {
      const shopId = Number(url.searchParams.get("shop_id"));
      if (!Number.isSafeInteger(shopId) || shopId <= 0)
        return json({success:false,message:"shop_id obligatoire"},400);
      try {
        await ensureProductDiscountSupport(env);
        const results = await env.DB.batch([
          env.DB.prepare(`SELECT p.id, p.shop_id, p.name, p.description, p.price, p.old_price,
            p.stock, p.category, p.active, COALESCE(ps.allow_discount,1) AS allow_discount
            FROM products p LEFT JOIN mbl_product_settings ps ON ps.product_id=p.id
            WHERE p.shop_id=? AND p.active=1 ORDER BY p.id DESC`).bind(shopId),
          env.DB.prepare(`SELECT pi.product_id, pi.image_url, pi.position
            FROM product_images pi JOIN products p ON p.id=pi.product_id
            WHERE p.shop_id=? AND p.active=1 ORDER BY pi.position, pi.id`).bind(shopId)
        ]);
        const galleries = new Map<number,string[]>();
        for (const row of results[1].results as any[]) {
          const list = galleries.get(Number(row.product_id)) || [];
          if (list.length < 3) list.push(row.image_url);
          galleries.set(Number(row.product_id),list);
        }
        return json({success:true,products:(results[0].results as any[]).map(p=>({
          ...p, allow_discount:p.allow_discount!==0, images:galleries.get(Number(p.id)) || []
        }))});
      } catch(error) {
        return json({success:false,message:"Impossible de charger les articles"},500);
      }
    }

    if (url.pathname === "/api/products" && request.method === "DELETE") {
      try {
        const body = await request.json() as any;
        if (!Number.isSafeInteger(body.shop_id) || body.shop_id<=0 ||
            !Number.isSafeInteger(body.id) || body.id<=0)
          return json({success:false,message:"Article invalide"},400);
        if (!await ownsShop(env,request,body.shop_id))
          return json({success:false,message:"Reconnectez-vous à votre boutique."},401);
        const product=await env.DB.prepare("SELECT id FROM products WHERE id=? AND shop_id=?")
          .bind(body.id,body.shop_id).first();
        if(!product)return json({success:false,message:"Article introuvable dans cette boutique"},404);
        await env.DB.prepare("UPDATE products SET active=0 WHERE id=? AND shop_id=?")
          .bind(body.id,body.shop_id).run();
        return json({success:true,message:"Article retiré"});
      } catch(error) {
        return json({success:false,message:"Impossible de retirer l’article. Réessayez."},500);
      }
    }

    if (url.pathname === "/api/products" &&
        (request.method === "POST" || request.method === "PUT")) {
      try {
        const body = await request.json() as any;
        const editing = request.method === "PUT";
        if (!Number.isSafeInteger(body.shop_id) || body.shop_id <= 0 ||
            typeof body.name !== "string" || !body.name.trim() ||
            typeof body.category !== "string" || !body.category.trim() ||
            !Number.isFinite(body.price) || body.price <= 0 ||
            !Number.isSafeInteger(body.stock) || body.stock < 0 ||
            (body.old_price != null && (!Number.isFinite(body.old_price) || body.old_price < 0)) ||
            (body.allow_discount !== undefined && typeof body.allow_discount !== "boolean") ||
            (editing && (!Number.isSafeInteger(body.id) || body.id <= 0))) {
          return json({success:false,message:"Champs de l’article invalides"},400);
        }
        if (body.allow_discount !== undefined && !await ownsShop(env,request,body.shop_id))
          return json({success:false,message:"Reconnectez-vous à votre boutique."},401);
        const images = body.images;
        if (images !== undefined && (!Array.isArray(images) || images.length > 3 ||
          images.some((im:unknown)=>typeof im !== "string" || im.length > 350000 ||
            !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(im)))) {
          return json({success:false,message:"Photos invalides ou trop volumineuses (3 maximum)"},400);
        }
        if (editing) {
          const exists = await env.DB.prepare("SELECT id FROM products WHERE id=? AND shop_id=? AND active=1")
            .bind(body.id,body.shop_id).first();
          if (!exists) return json({success:false,message:"Article introuvable dans cette boutique"},404);
        }
        const values = [body.name.trim(),body.description || "",body.price,
          body.old_price ?? null,body.stock,body.category.trim()];
        const statements = [editing
          ? env.DB.prepare(`UPDATE products SET name=?,description=?,price=?,old_price=?,stock=?,category=?
              WHERE id=? AND shop_id=? AND active=1`).bind(...values,body.id,body.shop_id)
          : env.DB.prepare(`INSERT INTO products
              (name,description,price,old_price,stock,category,shop_id,active)
              VALUES (?,?,?,?,?,?,?,1)`).bind(...values,body.shop_id)];
        if (editing && images !== undefined)
          statements.push(env.DB.prepare("DELETE FROM product_images WHERE product_id=?").bind(body.id));
        for (let i=0;i<(images || []).length;i++) {
          // MAX(id) is read inside the same transaction as the product insert.
          statements.push(editing
            ? env.DB.prepare("INSERT INTO product_images (product_id,image_url,position) VALUES (?,?,?)")
                .bind(body.id,images[i],i+1)
            : env.DB.prepare(`INSERT INTO product_images (product_id,image_url,position)
                VALUES ((SELECT MAX(id) FROM products),?,?)`).bind(images[i],i+1));
        }
        if (body.allow_discount !== undefined) {
          await ensureProductDiscountSupport(env);
          statements.push(editing
            ? env.DB.prepare(`INSERT INTO mbl_product_settings (product_id,allow_discount) VALUES (?,?)
                ON CONFLICT(product_id) DO UPDATE SET allow_discount=excluded.allow_discount`)
                .bind(body.id,body.allow_discount?1:0)
            : env.DB.prepare(`INSERT INTO mbl_product_settings (product_id,allow_discount)
                VALUES ((SELECT MAX(id) FROM products),?)`).bind(body.allow_discount?1:0));
        }
        const results = await env.DB.batch(statements);
        return json({success:true,product_id:editing ? body.id : results[0].meta.last_row_id,
          message:editing ? "Article modifié avec ses photos" : "Article créé avec ses photos"},editing ? 200 : 201);
      } catch(error) {
        return json({success:false,message:"Impossible d’enregistrer l’article et ses photos"},500);
      }
    }

    if (url.pathname === "/api/orders" && request.method === "POST") {
      try {
        const b = await request.json() as any;
        if (!Number.isSafeInteger(b.shop_id) || b.shop_id<=0 ||
          typeof b.customer_name!=="string" || !b.customer_name.trim() || b.customer_name.length>150 ||
          typeof b.customer_phone!=="string" || !b.customer_phone.trim() || b.customer_phone.length>40 ||
          typeof b.customer_address!=="string" || !b.customer_address.trim() || b.customer_address.length>2000 ||
          typeof b.payment_method!=="string" || !b.payment_method.trim() || b.payment_method.length>100 ||
          typeof b.request_key!=="string" || !/^[a-f0-9-]{36}$/.test(b.request_key) ||
          !Array.isArray(b.items) || !b.items.length || b.items.length>50 ||
          b.items.some((i:any)=>!Number.isSafeInteger(i.product_id)||i.product_id<=0 ||
            !Number.isSafeInteger(i.quantity)||i.quantity<=0||i.quantity>100000))
          return json({success:false,message:"Informations de commande invalides"},400);
        const quantities = new Map<number,number>();
        for (const i of b.items) quantities.set(i.product_id,(quantities.get(i.product_id)||0)+i.quantity);
        const items = [...quantities].sort((a,b)=>a[0]-b[0]).map(([product_id,quantity])=>({product_id,quantity}));
        const normalized = {shop_id:b.shop_id,customer_name:b.customer_name.trim(),
          customer_phone:b.customer_phone.trim(),customer_address:b.customer_address.trim(),
          payment_method:b.payment_method.trim(),items};
        const fingerprint = await hashPassword(JSON.stringify(normalized));
        await ensureOrderSupport(env);
        const prior = await env.DB.prepare(`SELECT om.fingerprint,o.id,o.total FROM mbl_order_meta om
          JOIN orders o ON o.id=om.order_id WHERE om.request_key=?`).bind(b.request_key).first<any>();
        if (prior) {
          if (prior.fingerprint!==fingerprint) return json({success:false,message:"Référence de commande déjà utilisée"},409);
          return json({success:true,order_id:prior.id,total:prior.total,replayed:true});
        }
        const rows = await env.DB.prepare(`SELECT id,name,price,stock FROM products WHERE shop_id=? AND active=1
          AND id IN (${items.map(()=>"?").join(",")})`).bind(b.shop_id,...items.map(i=>i.product_id)).all<any>();
        const list = items.map(i=>({item:i,product:rows.results.find(p=>Number(p.id)===i.product_id)}));
        if (list.some(x=>!x.product || Number(x.product.stock)<x.item.quantity))
          return json({success:false,message:"Un article est indisponible ou sa quantité dépasse le stock"},409);
        const total = list.reduce((t,x)=>t+Number(x.product!.price)*x.item.quantity,0);
        if (!Number.isSafeInteger(total)||total<=0) return json({success:false,message:"Montant de commande invalide"},400);
        // Reject stale displayed prices, instead of silently changing the amount.
        if (b.expected_total!==total) return json({success:false,message:"Le prix a changé. Rechargez les articles avant de commander."},409);
        const statements = [env.DB.prepare(`INSERT INTO orders
          (shop_id,customer_name,customer_phone,customer_address,payment_method,total)
          VALUES (?,?,?,?,?,?)`).bind(b.shop_id,normalized.customer_name,normalized.customer_phone,
            normalized.customer_address,normalized.payment_method,total)];
        for(const x of list) statements.push(env.DB.prepare(`INSERT INTO order_items
          (order_id,product_id,product_name,unit_price,quantity,subtotal)
          VALUES ((SELECT MAX(id) FROM orders),?,?,?,?,?)`)
          .bind(x.item.product_id,x.product!.name,x.product!.price,x.item.quantity,Number(x.product!.price)*x.item.quantity));
        statements.push(env.DB.prepare(`INSERT INTO mbl_order_meta (order_id,request_key,fingerprint)
          VALUES ((SELECT MAX(id) FROM orders),?,?)`).bind(b.request_key,fingerprint));
        let results;
        try { results=await env.DB.batch(statements); }
        catch(error) {
          const duplicate=await env.DB.prepare(`SELECT om.fingerprint,o.id,o.total FROM mbl_order_meta om
            JOIN orders o ON o.id=om.order_id WHERE om.request_key=?`).bind(b.request_key).first<any>();
          if(duplicate?.fingerprint===fingerprint) return json({success:true,order_id:duplicate.id,total:duplicate.total,replayed:true});
          throw error;
        }
        return json({success:true,order_id:results[0].meta.last_row_id,total},201);
      } catch(error) {return json({success:false,message:"Impossible d’enregistrer la commande. Vos informations sont conservées pour réessayer."},500);}
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      try {
        const sid=Number(url.searchParams.get("shop_id"));
        if(!await ownsShop(env,request,sid)) return json({success:false,message:"Reconnectez-vous à votre espace commerçant pour consulter les commandes."},401);
        const result=await env.DB.batch([
          env.DB.prepare(`SELECT o.*,COALESCE(om.validated,0) AS sale_validated,oc.cancelled_at AS sale_cancelled_at FROM orders o
            LEFT JOIN mbl_order_meta om ON om.order_id=o.id LEFT JOIN mbl_order_cancellations oc ON oc.order_id=o.id WHERE o.shop_id=? ORDER BY o.id DESC`).bind(sid),
          env.DB.prepare(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.shop_id=? ORDER BY oi.id`).bind(sid)
        ]);
        return json({success:true,orders:(result[0].results as any[]).map(o=>({...o,
          order_items:(result[1].results as any[]).filter(i=>i.order_id===o.id)}))});
      }catch(error){return json({success:false,message:"Impossible de charger les commandes"},500);}
    }
    if(url.pathname==="/api/orders/cancel" && request.method==="POST") {
      try {
        const b=await request.json() as any;
        if(!Number.isSafeInteger(b.order_id)||!Number.isSafeInteger(b.shop_id)) return json({success:false,message:"Commande invalide"},400);
        if(!await ownsShop(env,request,b.shop_id)) return json({success:false,message:"Reconnectez-vous à votre espace commerçant."},401);
        const order=await env.DB.prepare("SELECT id FROM orders WHERE id=? AND shop_id=?").bind(b.order_id,b.shop_id).first();
        if(!order) return json({success:false,message:"Commande introuvable"},404);
        await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO mbl_order_cancellations (order_id)
            SELECT id FROM orders WHERE id=? AND shop_id=? AND NOT EXISTS (
              SELECT 1 FROM mbl_order_meta WHERE order_id=? AND validated=1)`)
            .bind(b.order_id,b.shop_id,b.order_id)
        ]);
        const cancelled=await env.DB.prepare("SELECT order_id FROM mbl_order_cancellations WHERE order_id=?").bind(b.order_id).first();
        if(!cancelled) return json({success:false,message:"Cette vente est déjà validée et ne peut pas être annulée."},409);
        return json({success:true,message:"Commande annulée"});
      }catch(error){return json({success:false,message:"Impossible d’annuler la commande. Réessayez."},500);}
    }
    if(url.pathname==="/api/orders/validate" && request.method==="POST") {
      try {
        const b=await request.json() as any;
        if(!Number.isSafeInteger(b.order_id)||!Number.isSafeInteger(b.shop_id)) return json({success:false,message:"Commande invalide"},400);
        if(!await ownsShop(env,request,b.shop_id)) return json({success:false,message:"Reconnectez-vous à votre espace commerçant."},401);
        const order=await env.DB.prepare("SELECT id FROM orders WHERE id=? AND shop_id=?").bind(b.order_id,b.shop_id).first();
        if(!order) return json({success:false,message:"Commande introuvable"},404);
        const key=crypto.randomUUID();
        const statements=[
          env.DB.prepare("INSERT OR IGNORE INTO mbl_order_meta (order_id) VALUES (?)").bind(b.order_id),
          env.DB.prepare(`UPDATE mbl_order_meta SET validated=CASE WHEN EXISTS (
            SELECT 1 FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id
            WHERE oi.order_id=? AND (p.id IS NULL OR p.shop_id<>? OR p.active<>1 OR
              p.stock<(SELECT SUM(quantity) FROM order_items WHERE order_id=? AND product_id=p.id))
          ) THEN -1 ELSE 1 END,validation_key=? WHERE order_id=? AND validated=0
            AND NOT EXISTS (SELECT 1 FROM mbl_order_cancellations WHERE order_id=mbl_order_meta.order_id)`)
          .bind(b.order_id,b.shop_id,b.order_id,key,b.order_id),
          env.DB.prepare(`UPDATE products SET stock=stock-(SELECT SUM(quantity) FROM order_items
            WHERE order_id=? AND product_id=products.id)
            WHERE shop_id=? AND id IN (SELECT product_id FROM order_items WHERE order_id=?)
            AND EXISTS (SELECT 1 FROM mbl_order_meta WHERE order_id=? AND validation_key=?)`)
            .bind(b.order_id,b.shop_id,b.order_id,b.order_id,key)
        ];
        await env.DB.batch(statements);
        const cancelled=await env.DB.prepare("SELECT order_id FROM mbl_order_cancellations WHERE order_id=?").bind(b.order_id).first();
        if(cancelled) return json({success:false,message:"Cette commande est annulée et ne peut plus être validée."},409);
        return json({success:true,message:"Vente validée et stock mis à jour"});
      }catch(error){return json({success:false,message:"Vente non validée. Vérifiez le stock des articles et réessayez."},409);}
    }

    return json({
      success: false,
      message: "Route introuvable",
    }, 404);
  },
};
