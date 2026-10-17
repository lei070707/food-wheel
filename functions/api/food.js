/**
 * Cloudflare Pages Function: GET /api/food
 *
 * 文件路径 functions/api/food.js 会自动映射到 /api/food。
 * 高德 Key 从 Pages 环境变量/Secret AMAP_KEY 读取，不会下发到浏览器。
 *
 * 缓存：
 *   1. 当前 Worker 实例内，同一半径、坐标相距 100 米内、10 分钟内的请求复用内存缓存；
 *   2. 使用 Cache API 在 Cloudflare 边缘缓存 10 分钟（坐标按 3 位小数归一到约 100 米网格）。
 */

const AMAP_ENDPOINT = "https://restapi.amap.com/v3/place/around";
const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const MAX_RECORDS = 100;
const CACHE_TTL_SECONDS = 10 * 60;
const CACHE_TTL_MS = CACHE_TTL_SECONDS * 1000;
const CACHE_DISTANCE_METERS = 100;
const CACHE_MAX_ENTRIES = 120;
const AMAP_REQUEST_TIMEOUT_MS = 8000;
const BUSY_MESSAGE = "当前查询人数过多，请稍后再试。";
const QUOTA_INFOCODES = new Set(["10003", "10004", "10044"]);

const memoryCache = new Map();

class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function jsonResponse(statusCode, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      },
      extraHeaders || {}
    )
  });
}

function successHeaders(cacheStatus) {
  return {
    "Cache-Control": "public, max-age=600",
    "X-Food-Cache": cacheStatus
  };
}

function errorResponse(statusCode, code, message, extraHeaders) {
  return jsonResponse(
    statusCode,
    { error: { code, message } },
    Object.assign(
      {
        "Cache-Control": "no-store"
      },
      extraHeaders || {}
    )
  );
}

function cleanText(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (Array.isArray(value)) {
    if (!value.length) return null;
    value = value[0];
  }
  if (typeof value === "object" || typeof value === "boolean") return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[]" || text === "暂无" || text === "-" || text === "—") return null;
    value = text;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateParams(searchParams) {
  const lat = toNumber(searchParams.get("lat"));
  const lng = toNumber(searchParams.get("lng"));
  const rawRadius = searchParams.get("radius") === null || searchParams.get("radius") === ""
    ? 3000
    : toNumber(searchParams.get("radius"));

  if (lat === null || lat < -90 || lat > 90) {
    throw new AppError(400, "INVALID_LAT", "纬度参数无效，应为 -90 到 90 之间的数字。");
  }
  if (lng === null || lng < -180 || lng > 180) {
    throw new AppError(400, "INVALID_LNG", "经度参数无效，应为 -180 到 180 之间的数字。");
  }
  if (rawRadius === null || rawRadius < 500 || rawRadius > 5000) {
    throw new AppError(400, "INVALID_RADIUS", "半径参数无效，应为 500 到 5000 米之间的数字。");
  }

  return {
    lat: round(lat, 6),
    lng: round(lng, 6),
    radius: Math.round(rawRadius)
  };
}

function extractCategory(type) {
  const segments = cleanText(type)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const chineseSegments = segments.filter((part) => /[\u4e00-\u9fa5]/.test(part));
  const category = chineseSegments.length
    ? chineseSegments[chineseSegments.length - 1]
    : segments.length
      ? segments[segments.length - 1]
      : "其他";
  return category.slice(0, 12) || "其他";
}

function parsePoi(poi, index) {
  if (!poi) return null;
  const name = cleanText(poi.name);
  if (!name) return null;

  const biz =
    poi.biz_ext && typeof poi.biz_ext === "object" && !Array.isArray(poi.biz_ext)
      ? poi.biz_ext
      : {};
  const rawRating = toNumber(biz.rating);
  const rawCost = toNumber(biz.cost);
  const rawDistance = toNumber(poi.distance);
  const rating = rawRating !== null && rawRating > 0 && rawRating <= 5 ? round(rawRating, 1) : null;
  const cost = rawCost !== null && rawCost >= 0 ? Math.round(rawCost) : null;
  const distanceKm = rawDistance !== null && rawDistance >= 0 ? round(rawDistance / 1000, 2) : null;
  const amapId = cleanText(poi.id);

  return {
    id: amapId ? "amap:" + amapId : "amap:" + name + ":" + index,
    name,
    rating,
    distanceKm,
    cost,
    category: extractCategory(poi.type),
    source: "amap",
    address: cleanText(poi.address)
  };
}

function buildAmapError(data) {
  const infocode = cleanText(data && data.infocode);
  const info = cleanText(data && data.info) || "unknown";

  if (QUOTA_INFOCODES.has(infocode)) {
    return new AppError(429, "UPSTREAM_QUOTA", BUSY_MESSAGE);
  }

  console.error("[food] AMAP request rejected", { infocode, info });

  if (infocode === "10001") {
    return new AppError(500, "UPSTREAM_AUTH", "服务暂时不可用，请稍后再试。");
  }
  return new AppError(500, "UPSTREAM_ERROR", "服务暂时不可用，请稍后再试。");
}

async function fetchAmapPage(key, lat, lng, radius, page) {
  const params = new URLSearchParams({
    key,
    location: lng + "," + lat,
    types: "050000",
    radius: String(radius),
    offset: String(PAGE_SIZE),
    page: String(page),
    extensions: "all"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AMAP_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(AMAP_ENDPOINT + "?" + params.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      console.error("[food] AMAP HTTP error", response.status);
      throw new AppError(500, "UPSTREAM_HTTP", "服务暂时不可用，请稍后再试。");
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new AppError(500, "UPSTREAM_INVALID_JSON", "服务暂时不可用，请稍后再试。");
    }

    if (!data || String(data.status) !== "1") {
      throw buildAmapError(data);
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error && error.name === "AbortError") {
      console.error("[food] AMAP request timeout");
      throw new AppError(500, "UPSTREAM_TIMEOUT", "服务暂时不可用，请稍后再试。");
    }
    console.error("[food] AMAP request failed", error && (error.name || error.message));
    throw new AppError(500, "UPSTREAM_UNAVAILABLE", "服务暂时不可用，请稍后再试。");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRestaurantsFromAmap(key, lat, lng, radius) {
  const seen = new Set();
  const restaurants = [];
  let totalCount = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await fetchAmapPage(key, lat, lng, radius, page);
    const pois = Array.isArray(data.pois) ? data.pois : [];
    const pageTotal = toNumber(data.count);
    if (pageTotal !== null) totalCount = pageTotal;

    pois.forEach((poi, index) => {
      const record = parsePoi(poi, (page - 1) * PAGE_SIZE + index);
      if (!record || seen.has(record.id)) return;
      seen.add(record.id);
      restaurants.push(record);
    });

    if (pois.length < PAGE_SIZE) break;
    if (restaurants.length >= MAX_RECORDS) break;
    if (totalCount !== null && restaurants.length >= totalCount) break;
  }

  return {
    restaurants: restaurants.slice(0, MAX_RECORDS),
    totalCount
  };
}

function buildPayload(restaurants, totalCount, lat, lng, radius, cacheStatus, ageSeconds) {
  return {
    restaurants,
    meta: {
      source: "amap",
      cache: cacheStatus,
      ageSeconds: ageSeconds || 0,
      count: restaurants.length,
      amapCount: totalCount,
      radius,
      center: { lat, lng },
      fetchedAt: new Date().toISOString(),
      cacheTtlSeconds: CACHE_TTL_SECONDS
    }
  };
}

function findMemoryCache(lat, lng, radius) {
  const now = Date.now();
  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) {
      memoryCache.delete(key);
      continue;
    }
    if (entry.radius !== radius) continue;
    if (haversineMeters(lat, lng, entry.lat, entry.lng) <= CACHE_DISTANCE_METERS) {
      return entry;
    }
  }
  return null;
}

function storeMemoryCache(lat, lng, radius, payload) {
  if (memoryCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) memoryCache.delete(oldestKey);
  }
  const now = Date.now();
  memoryCache.set(
    radius + ":" + lat.toFixed(5) + ":" + lng.toFixed(5) + ":" + now.toString(36),
    {
      lat,
      lng,
      radius,
      createdAt: now,
      expiresAt: now + CACHE_TTL_MS,
      payload
    }
  );
}

function buildEdgeCacheKey(requestUrl, lat, lng, radius) {
  const url = new URL(requestUrl);
  url.search = "";
  // 3 位小数约等于 100 米网格，用于边缘缓存键；精确的 100 米判断由内存缓存完成。
  url.searchParams.set("lat", lat.toFixed(3));
  url.searchParams.set("lng", lng.toFixed(3));
  url.searchParams.set("radius", String(radius));
  return new Request(url.toString(), { method: "GET" });
}

function getEdgeCache() {
  if (typeof caches === "undefined" || !caches.default) return null;
  return caches.default;
}

function getApiKey(env) {
  const fromEnv = env && env.AMAP_KEY ? cleanText(env.AMAP_KEY) : "";
  if (fromEnv) return fromEnv;
  // 仅用于本地 Node 测试/本地开发兜底，Cloudflare 生产环境使用 env.AMAP_KEY。
  if (typeof process !== "undefined" && process.env && process.env.AMAP_KEY) {
    return cleanText(process.env.AMAP_KEY);
  }
  return "";
}

function cacheHitResponse(entry, lat, lng, radius) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - entry.createdAt) / 1000));
  const payload = buildPayload(
    entry.payload.restaurants,
    entry.payload.meta.amapCount,
    lat,
    lng,
    radius,
    "HIT",
    ageSeconds
  );
  return jsonResponse(200, payload, successHeaders("HIT"));
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return errorResponse(405, "METHOD_NOT_ALLOWED", "只支持 GET 请求。", { Allow: "GET" });
  }

  let params;
  try {
    params = validateParams(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof AppError) {
      return errorResponse(error.statusCode, error.code, error.message);
    }
    return errorResponse(400, "INVALID_PARAMS", "请求参数无效。");
  }

  const { lat, lng, radius } = params;

  const memoryHit = findMemoryCache(lat, lng, radius);
  if (memoryHit) {
    return cacheHitResponse(memoryHit, lat, lng, radius);
  }

  const edgeCache = getEdgeCache();
  const edgeCacheKey = edgeCache ? buildEdgeCacheKey(request.url, lat, lng, radius) : null;

  if (edgeCache && edgeCacheKey) {
    const cachedResponse = await edgeCache.match(edgeCacheKey);
    if (cachedResponse) {
      try {
        const cachedPayload = await cachedResponse.json();
        if (cachedPayload && Array.isArray(cachedPayload.restaurants)) {
          cachedPayload.meta = Object.assign({}, cachedPayload.meta, {
            cache: "HIT",
            ageSeconds: CACHE_TTL_SECONDS
          });
          return jsonResponse(200, cachedPayload, successHeaders("HIT"));
        }
      } catch (error) {
        // 缓存内容异常时忽略，继续回源。
      }
    }
  }

  const apiKey = getApiKey(env);
  if (!apiKey) {
    console.error("[food] AMAP_KEY environment variable is not set");
    return errorResponse(500, "CONFIG_ERROR", "服务暂时不可用，请稍后再试。");
  }

  try {
    const result = await fetchRestaurantsFromAmap(apiKey, lat, lng, radius);
    const payload = buildPayload(
      result.restaurants,
      result.totalCount,
      lat,
      lng,
      radius,
      "MISS",
      0
    );

    storeMemoryCache(lat, lng, radius, {
      restaurants: result.restaurants,
      meta: {
        amapCount: result.totalCount
      }
    });

    const response = jsonResponse(200, payload, successHeaders("MISS"));
    if (edgeCache && edgeCacheKey) {
      context.waitUntil(edgeCache.put(edgeCacheKey, response.clone()));
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) {
      const headers = {};
      if (error.statusCode === 429) headers["Retry-After"] = "60";
      return errorResponse(error.statusCode, error.code, error.message, headers);
    }
    console.error("[food] unexpected error", error && (error.name || error.message));
    return errorResponse(500, "INTERNAL_ERROR", "服务暂时不可用，请稍后再试。");
  }
}
