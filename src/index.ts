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

    return json({
      success: false,
      message: "Route introuvable",
    }, 404);
  },
};
