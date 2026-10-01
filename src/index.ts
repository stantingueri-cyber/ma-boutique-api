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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Autoriser les requêtes venant de la boutique
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

    // Accueil API
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        app: "Ma Boutique en Ligne",
        message: "API opérationnelle",
      });
    }

    // Test D1
    if (url.pathname === "/api/test" && request.method === "GET") {
      try {
        const tables = await env.DB
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          )
          .all();

        return json({
          success: true,
          message: "Connexion D1 réussie",
          tables: tables.results,
        });
      } catch (error) {
        return json(
          {
            success: false,
            message: "Erreur de connexion à D1",
            error: String(error),
          },
          500
        );
      }
    }

    // Créer un commerçant + sa boutique
    if (url.pathname === "/api/shops" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          email?: string;
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
          !body.password_hash ||
          !body.merchant_name ||
          !body.shop_name ||
          !body.slug
        ) {
          return json(
            {
              success: false,
              message: "Informations obligatoires manquantes",
            },
            400
          );
        }

        const country = body.country || "BF";
        const currency = body.currency || "XOF";
        const language = body.language || "fr";
        const now = new Date().toISOString();

        // Vérifier si l'e-mail existe déjà
        const existingMerchant = await env.DB
          .prepare("SELECT id FROM merchants WHERE email = ?")
          .bind(body.email)
          .first();

        if (existingMerchant) {
          return json(
            {
              success: false,
              message: "Cette adresse e-mail est déjà utilisée",
            },
            409
          );
        }

        // Vérifier si le lien public existe déjà
        const existingShop = await env.DB
          .prepare("SELECT id FROM shops WHERE slug = ?")
          .bind(body.slug)
          .first();

        if (existingShop) {
          return json(
            {
              success: false,
              message: "Ce lien de boutique est déjà utilisé",
            },
            409
          );
        }

        // Enregistrer le commerçant
        const merchant = await env.DB
          .prepare(
            `INSERT INTO merchants
            (email, password_hash, name, phone, country, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            body.email,
            body.password_hash,
            body.merchant_name,
            body.phone || null,
            country,
            now,
            now
          )
          .run();

        const merchantId = merchant.meta.last_row_id;

        // Enregistrer la boutique
        const shop = await env.DB
          .prepare(
            `INSERT INTO shops
            (merchant_id, name, slug, logo_url, whatsapp, country, currency, language, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
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
          )
          .run();

        return json(
          {
            success: true,
            message: "Boutique créée avec succès",
            merchant_id: merchantId,
            shop_id: shop.meta.last_row_id,
            slug: body.slug,
          },
          201
        );
      } catch (error) {
        return json(
          {
            success: false,
            message: "Impossible de créer la boutique",
            error: String(error),
          },
          500
        );
      }}
    if (url.pathname === "/api/products" && request.method === "POST") {
      try {
        const body = (await request.json()) as {
          shop_id?: number;
          name?: string;
          description?: string;
          price?: number;
          old_price?: number | null;
          stock?: number;
          category?: string;
        };

        if (
          !body.shop_id ||
          !body.name ||
          body.price === undefined ||
          body.stock === undefined ||
          !body.category
        ) {
          return json(
            {
              success: false,
              message: "Champs obligatoires manquants",
            },
            400
          );
        }

        const product = await env.DB.prepare(
          `INSERT INTO products
          (shop_id, name, description, price, old_price, stock, category, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
        )
          .bind(
            body.shop_id,
            body.name,
            body.description ?? "",
            body.price,
            body.old_price ?? null,
            body.stock,
            body.category
          )
          .run();

        return json(
          {
            success: true,
            message: "Article créé avec succès",
            product_id: product.meta.last_row_id,
          },
          201
        );
      } catch (error) {
        return json(
          {
            success: false,
            message: "Impossible de créer l'article",
            error: String(error),
          },
          500
        );
      }
    }    }
    return json(
      {
        success: false,
        message: "Route introuvable",
      },
      404
    );
  },
};
