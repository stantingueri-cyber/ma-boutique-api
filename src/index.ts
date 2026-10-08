import { storefrontHtml } from "./renderHtml-3";

interface Env {
  DB: D1Database;
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
      fingerprint TEXT, validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN (0,1)), validation_key TEXT)`)
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
          env.DB.prepare(`SELECT o.*,COALESCE(om.validated,0) AS sale_validated FROM orders o
            LEFT JOIN mbl_order_meta om ON om.order_id=o.id WHERE o.shop_id=? ORDER BY o.id DESC`).bind(sid),
          env.DB.prepare(`SELECT oi.* FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.shop_id=? ORDER BY oi.id`).bind(sid)
        ]);
        return json({success:true,orders:(result[0].results as any[]).map(o=>({...o,
          order_items:(result[1].results as any[]).filter(i=>i.order_id===o.id)}))});
      }catch(error){return json({success:false,message:"Impossible de charger les commandes"},500);}
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
          ) THEN -1 ELSE 1 END,validation_key=? WHERE order_id=? AND validated=0`)
          .bind(b.order_id,b.shop_id,b.order_id,key,b.order_id),
          env.DB.prepare(`UPDATE products SET stock=stock-(SELECT SUM(quantity) FROM order_items
            WHERE order_id=? AND product_id=products.id)
            WHERE shop_id=? AND id IN (SELECT product_id FROM order_items WHERE order_id=?)
            AND EXISTS (SELECT 1 FROM mbl_order_meta WHERE order_id=? AND validation_key=?)`)
            .bind(b.order_id,b.shop_id,b.order_id,b.order_id,key)
        ];
        await env.DB.batch(statements);
        return json({success:true,message:"Vente validée et stock mis à jour"});
      }catch(error){return json({success:false,message:"Vente non validée. Vérifiez le stock des articles et réessayez."},409);}
    }

    return json({
      success: false,
      message: "Route introuvable",
    }, 404);
  },
};
