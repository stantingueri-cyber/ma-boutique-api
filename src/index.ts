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

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        app: "Ma Boutique en Ligne",
        message: "API opÃ©rationnelle",
      });
    }

    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const tables = await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).all();

        return json({
          success: true,
          message: "Connexion D1 rÃ©ussie",
          tables: tables.results,
        });
      } catch (error) {
        return json({
          success: false,
          message: "Erreur de connexion Ã  D1",
          error: String(error),
        }, 500);
      }
    }

    // CrÃ©ation du commerÃ§ant et de sa boutique
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
            message: "Cette adresse e-mail est dÃ©jÃ  utilisÃ©e",
          }, 409);
        }

        const existingShop = await env.DB.prepare(
          "SELECT id FROM shops WHERE slug = ?"
        ).bind(body.slug).first();

        if (existingShop) {
          return json({
            success: false,
            message: "Ce lien de boutique est dÃ©jÃ  utilisÃ©",
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
          message: "Boutique crÃ©Ã©e avec succÃ¨s",
          merchant_id: merchantId,
          shop_id: shop.meta.last_row_id,
          session_token: await issueSession(env,Number(merchantId)),
          slug: body.slug,
        }, 201);
      } catch (error) {
        return json({
          success: false,
          message: "Impossible de crÃ©er la boutique",
          error: String(error),
        }, 500);
      }
    }

    // Connexion du commerÃ§ant
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
            message: "Aucune boutique liÃ©e Ã  ce compte",
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
        const results = await env.DB.batch([
          env.DB.prepare(`SELECT id, shop_id, name, description, price, old_price,
            stock, category, active FROM products WHERE shop_id=? AND active=1
            ORDER BY id DESC`).bind(shopId),
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
          ...p, images:galleries.get(Number(p.id)) || []
        }))});
      } catch(error) {
        return json({success:false,message:"Impossible de charger les articles"},500);
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
            (editing && (!Number.isSafeInteger(body.id) || body.id <= 0))) {
          return json({success:false,message:"Champs de lâ€™article invalides"},400);
        }
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
        const results = await env.DB.batch(statements);
        return json({success:true,product_id:editing ? body.id : results[0].meta.last_row_id,
          message:editing ? "Article modifiÃ© avec ses photos" : "Article crÃ©Ã© avec ses photos"},editing ? 200 : 201);
      } catch(error) {
        return json({success:false,message:"Impossible dâ€™enregistrer lâ€™article et ses photos"},500);
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
          if (prior.fingerprint!==fingerprint) return json({success:false,message:"RÃ©fÃ©rence de commande dÃ©jÃ  utilisÃ©e"},409);
          return json({success:true,order_id:prior.id,total:prior.total,replayed:true});
        }
        const rows = await env.DB.prepare(`SELECT id,name,price,stock FROM products WHERE shop_id=? AND active=1
          AND id IN (${items.map(()=>"?").join(",")})`).bind(b.shop_id,...items.map(i=>i.product_id)).all<any>();
        const list = items.map(i=>({item:i,product:rows.results.find(p=>Number(p.id)===i.product_id)}));
        if (list.some(x=>!x.product || Number(x.product.stock)<x.item.quantity))
          return json({success:false,message:"Un article est indisponible ou sa quantitÃ© dÃ©passe le stock"},409);
        const total = list.reduce((t,x)=>t+Number(x.product!.price)*x.item.quantity,0);
        if (!Number.isSafeInteger(total)||total<=0) return json({success:false,message:"Montant de commande invalide"},400);
        // Reject stale displayed prices, instead of silently changing the amount.
        if (b.expected_total!==total) return json({success:false,message:"Le prix a changÃ©. Rechargez les articles avant de commander."},409);
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
      } catch(error) {return json({success:false,message:"Impossible dâ€™enregistrer la commande. Vos informations sont conservÃ©es pour rÃ©essayer."},500);}
    }
    if (url.pathname === "/api/orders" && request.method === "GET") {
      try {
        const sid=Number(url.searchParams.get("shop_id"));
        if(!await ownsShop(env,request,sid)) return json({success:false,message:"Reconnectez-vous Ã  votre espace commerÃ§ant pour consulter les commandes."},401);
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
        if(!await ownsShop(env,request,b.shop_id)) return json({success:false,message:"Reconnectez-vous Ã  votre espace commerÃ§ant."},401);
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
        return json({success:true,message:"Vente validÃ©e et stock mis Ã  jour"});
      }catch(error){return json({success:false,message:"Vente non validÃ©e. VÃ©rifiez le stock des articles et rÃ©essayez."},409);}
    }

    return json({
      success: false,
      message: "Route introuvable",
    }, 404);
  },
};
