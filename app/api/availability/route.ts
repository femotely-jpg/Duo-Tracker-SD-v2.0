import { NextResponse } from "next/server";
import { CENTER, MODELS, RADIUS_MILES, ZIPS, inCounty, isConfigured } from "@/lib/config";
import { milesBetween } from "@/lib/geo";
import type { Payload, Store } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "sfo1";

const CACHE_MS = 4000;
let cache: { at: number; payload: Payload } | null = null;
let inflight: Promise<Payload> | null = null;

class AppleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Apple's pickup lookup has been called several ways over the years. Apple answers a
// request it doesn't accept with HTTP 541 "Page Not Found", so the route tries each
// recipe once with one part number, then sticks with the first one Apple answers.
type Recipe = { name: string; path: string; params: Record<string, string>; parts: "indexed" };
const RECIPES: Recipe[] = [
  { name: "unlocked-compact", path: "/shop/fulfillment-messages", params: { pl: "true", "mts.0": "regular", "mts.1": "compact", cppart: "UNLOCKED/US", searchNearby: "true" }, parts: "indexed" },
  { name: "unlocked-plain", path: "/shop/fulfillment-messages", params: { pl: "true", mt: "compact", cppart: "UNLOCKED/US" }, parts: "indexed" },
  { name: "fae-compact", path: "/shop/fulfillment-messages", params: { fae: "true", pl: "true", "mts.0": "regular", "mts.1": "compact" }, parts: "indexed" },
  { name: "fae-little", path: "/shop/fulfillment-messages", params: { fae: "true", little: "false", fts: "true", "mts.0": "regular" }, parts: "indexed" },
  { name: "retail-pickup", path: "/shop/retail/pickup-message", params: { pl: "true", cppart: "UNLOCKED/US" }, parts: "indexed" },
];
let recipe: Recipe | null = null;
let lastProbe = 0;
const PROBE_EVERY_MS = 60_000; // while nothing works, retry the recipes once a minute

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchZip(r: Recipe, zip: string, parts: string[]): Promise<any[]> {
  const params = new URLSearchParams({ ...r.params, location: zip });
  parts.forEach((p, i) => params.set(`parts.${i}`, p));
  const res = await fetch(`https://www.apple.com${r.path}?${params}`, {
    cache: "no-store",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": UA_DESKTOP,
      Referer: "https://www.apple.com/shop/buy-iphone/iphone-duo",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(4500),
  });
  const text = await res.text();
  const snippet = text.slice(0, 120).replace(/\s+/g, " ");
  const label = `${r.name} ZIP ${zip} [${parts.length} part${parts.length > 1 ? "s" : ""}]`;
  if (!res.ok) throw new AppleError(res.status, `HTTP ${res.status} on ${label}. Body: ${snippet}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppleError(0, `Web page instead of data on ${label}. Body: ${snippet}`);
  }
  const stores = json?.body?.content?.pickupMessage?.stores ?? json?.body?.stores;
  if (!Array.isArray(stores)) throw new AppleError(0, `No store list on ${label}. Body: ${snippet}`);
  return stores;
}

async function findRecipe(zip: string, part: string): Promise<Recipe | null> {
  const failures: string[] = [];
  for (const r of RECIPES) {
    try {
      const stores = await fetchZip(r, zip, [part]);
      console.log(`[apple] Recipe "${r.name}" works (${stores.length} stores). Using it from now on.`);
      return r;
    } catch (e: any) {
      failures.push(`${r.name}: ${e instanceof AppleError ? (e.status || "bad reply") : "network error"}`);
    }
  }
  console.error(`[apple] Every request recipe was refused (${failures.join("; ")}). Apple is most likely blocking this server.`);
  return null;
}

function addStores(merged: Map<string, Store>, raw: any[], parts: string[]) {
  for (const s of raw) {
    const lat = Number(s.storelatitude);
    const lng = Number(s.storelongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const distance = milesBetween(CENTER, { lat, lng });
    if (distance > RADIUS_MILES || !inCounty(String(s.city ?? ""))) continue;
    const id = String(s.storeNumber);
    const store: Store = merged.get(id) ?? {
      id, name: String(s.storeName ?? id), city: String(s.city ?? ""), lat, lng, distance, models: {},
    };
    for (const part of parts) {
      const pa = s.partsAvailability?.[part];
      if (!pa) continue;
      const prev = store.models[part];
      store.models[part] = {
        available: pa.pickupDisplay === "available" || Boolean(prev?.available),
        quote: String(pa.pickupSearchQuote ?? pa.storePickupQuote ?? ""),
      };
    }
    merged.set(id, store);
  }
}

async function load(): Promise<Payload> {
  const configured = MODELS.filter(isConfigured);
  if (configured.length === 0) return { ok: true, configured: false, checkedAt: Date.now(), stores: [] };
  const parts = configured.map((m) => m.part);

  if (!recipe) {
    if (Date.now() - lastProbe < PROBE_EVERY_MS) {
      return { ok: false, configured: true, checkedAt: Date.now(), stores: [], error: "Apple is refusing requests from this server. Retrying every minute." };
    }
    lastProbe = Date.now();
    recipe = await findRecipe(ZIPS[0], parts[0]);
    if (!recipe) {
      return { ok: false, configured: true, checkedAt: Date.now(), stores: [], error: "Apple is refusing requests from this server. Retrying every minute." };
    }
  }

  const merged = new Map<string, Store>();
  const errors: string[] = [];
  const results = await Promise.allSettled(ZIPS.map((z) => fetchZip(recipe!, z, parts)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") addStores(merged, r.value, parts);
    else {
      const msg = String(r.reason?.message ?? r.reason);
      console.error(`[apple] ${msg}`);
      errors.push(`ZIP ${ZIPS[i]}: ${msg}`);
    }
  });
  if (errors.length === ZIPS.length) {
    console.error(`[apple] Recipe "${recipe.name}" stopped working; will look for another.`);
    recipe = null;
  }

  const stores = [...merged.values()].sort((a, b) => a.distance - b.distance);
  return {
    ok: errors.length < ZIPS.length,
    configured: true,
    checkedAt: Date.now(),
    stores,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.payload, { headers: { "Cache-Control": "no-store" } });
  }
  if (!inflight) {
    inflight = load()
      .then((payload) => {
        if (payload.ok) cache = { at: Date.now(), payload };
        return payload;
      })
      .catch((e) => ({ ok: false, configured: true, checkedAt: Date.now(), stores: [], error: String(e?.message ?? e) }))
      .finally(() => { inflight = null; });
  }
  const payload = await inflight;
  return NextResponse.json(payload, { status: payload.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } });
}
