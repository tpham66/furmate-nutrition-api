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



async function handleImage(request, env, key) {
  if (request.method === "PUT") {
    const maxSize = 5 * 1024 * 1024;

    const contentLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (contentLength > maxSize) {
      return Response.json(
        { error: "Image exceeds 5 MB" },
        { status: 413 }
      );
    }

    const bytes = await request.arrayBuffer();

    if (bytes.byteLength === 0 ||
        bytes.byteLength > maxSize) {
      return Response.json(
        { error: "Image must be between 1 byte and 5 MB" },
        { status: 413 }
      );
    }

    const b = new Uint8Array(bytes);

    const isJpeg =
      b.length >= 3 &&
      b[0] === 0xff &&
      b[1] === 0xd8 &&
      b[2] === 0xff;

    const isPng =
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a;

    const isWebp =
      b.length >= 12 &&
      String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP";

    const contentType = isJpeg
      ? "image/jpeg"
      : isPng
        ? "image/png"
        : isWebp
          ? "image/webp"
          : null;

    if (!contentType) {
      return Response.json(
        { error: "Only JPEG, PNG and WebP are supported" },
        { status: 415 }
      );
    }

    await env.PET_IMAGES.put(key, bytes, {
      httpMetadata: { contentType },
    });

    return Response.json({
      imagePath: key,
      message: "Image saved successfully",
    });
  }

  if (request.method === "GET") {
    const object = await env.PET_IMAGES.get(key);

    if (!object) {
      return Response.json(
        { error: "Image not found" },
        { status: 404 }
      );
    }

    return new Response(object.body, {
      headers: {
        "Content-Type":
          object.httpMetadata?.contentType ||
          "application/octet-stream",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return Response.json(
    { error: "Method not allowed" },
    {
      status: 405,
      headers: { Allow: "GET, PUT" },
    }
  );
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

		
		const url = new URL(request.url);
		
		const petMatch = url.pathname.match(
		  /^\/api\/pets\/([A-Za-z0-9_-]{1,128})\/image$/
		);
		
		const isUserProfile =
		  url.pathname === "/api/users/me/image";
		
		if (petMatch || isUserProfile) {
		  let uid;
		
		  try {
		    uid = await verifyUser(request);
		  } catch {
		    return withCors(
		      Response.json(
		        { error: "Unauthorized" },
		        { status: 401 }
		      ),
		      request
		    );
		  }
		
		  const key = isUserProfile
		    ? `users/${uid}/profile/avatar`
		    : `users/${uid}/pets/${petMatch[1]}/profile`;
		
		  try {
		    const response = await handleImage(
		      request,
		      env,
		      key
		    );
		
		    return withCors(response, request);
		  } catch (error) {
		    console.error("Image request failed:", error);
		
		    return withCors(
		      Response.json(
		        { error: "Image service unavailable" },
		        { status: 500 }
		      ),
		      request
		    );
		  }
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

