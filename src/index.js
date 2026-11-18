/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */


import { createRemoteJWKSet, jwtVerify } from "jose";

const PROJECT_ID = "furmate-b50c4";

const JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
);

function corsHeaders(origin) {
  const allowedOrigins = [
    "https://furmate-b50c4.web.app",
    "https://furmate-b50c4.firebaseapp.com",
  ];

  // Allow local Flutter development.
  const isLocalhost =
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

  return {
    "Access-Control-Allow-Origin":
      allowedOrigins.includes(origin) || isLocalhost
        ? origin
        : "https://furmate-b50c4.web.app",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type",
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function verifyUser(request) {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing authentication token");
  }

  const token = authorization.substring(7);

  const { payload } = await jwtVerify(token, JWKS, {
    algorithms: ["RS256"],
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });

  if (
    !payload.sub ||
    typeof payload.sub !== "string" ||
    payload.sub.length > 128 ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > Date.now() / 1000
  ) {
    throw new Error("Invalid Firebase token");
  }

  return payload.sub;
}

// USDA search results use nutrient values per 100 g.
// Return null if no reliable kcal value is available.
function getCalories(food) {
  const nutrients = food.foodNutrients ?? [];

  for (const id of [1008, 2048, 2047]) {
    const nutrient = nutrients.find((item) => {
      const nutrientId =
        item.nutrientId ?? item.nutrient?.id;
      const unit =
        item.unitName ?? item.nutrient?.unitName;

      return Number(nutrientId) === id &&
        String(unit ?? "").toUpperCase() === "KCAL";
    });

    const value = nutrient?.value ?? nutrient?.amount;

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request.headers.get("Origin") ?? "");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers,
      });
    }

    if (
      request.method !== "GET" ||
      url.pathname !== "/api/nutrition/search"
    ) {
      return jsonResponse(
        { error: "Not found" },
        404,
        headers
      );
    }

    try {
      await verifyUser(request);
    } catch {
      return jsonResponse(
        { error: "Unauthorized" },
        401,
        headers
      );
    }

    const query = (url.searchParams.get("q") ?? "").trim();

    if (query.length < 2 || query.length > 80) {
      return jsonResponse(
        { error: "Enter a food name between 2 and 80 characters" },
        400,
        headers
      );
    }

    if (!env.USDA_API_KEY) {
      return jsonResponse(
        { error: "USDA API key is not configured" },
        500,
        headers
      );
    }

    const usdaUrl = new URL(
      "https://api.nal.usda.gov/fdc/v1/foods/search"
    );

    usdaUrl.searchParams.set("api_key", env.USDA_API_KEY);

    try {
      const response = await fetch(usdaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          pageSize: 10,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return jsonResponse(
          { error: "Nutrition provider is temporarily unavailable" },
          502,
          headers
        );
      }

      const data = await response.json();

      const foods = (data.foods ?? []).map((food) => ({
        id: food.fdcId,
        name: food.description,
        brand: food.brandOwner ?? food.brandName ?? "",
        dataType: food.dataType ?? "",
        kcalPer100g: getCalories(food),
      }));

      return jsonResponse({ foods }, 200, headers);
    } catch {
      return jsonResponse(
        { error: "Unable to retrieve nutrition information" },
        502,
        headers
      );
    }
  },
};

