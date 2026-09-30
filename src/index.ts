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

    // Test général de l'API
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        app: "Ma Boutique en Ligne",
        message: "API opérationnelle",
      });
    }

    // Test de connexion à notre base D1
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

    return json(
      {
        success: false,
        message: "Route introuvable",
      },
      404
    );
  },
};
