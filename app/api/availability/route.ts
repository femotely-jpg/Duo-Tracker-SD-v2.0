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

// Part numbers Apple refused on their own. Skipped until the server restarts.
const badParts = new Set<string>();

class AppleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchZip(zip: string, parts: string[]): Promise<any[]> {
  const params = new URLSearchParams({ fae: "true", little: "false", fts: "true", "mts.0": "regular", location: zip });
  parts.forEach((p, i) => params.set(`parts.${i}`, p));
  const res = await fetch(`https://www.apple.com/shop/fulfillment-messages?${params}`, {
    cache: "no-store",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      Referer: "https://www.apple.com/shop/buy-iphone/iphone-duo",
    },
    signal: AbortSignal.timeout(4500),
  });
  const text = await res.text();
  const snippet = text.slice(0, 160).replace(/\s+/g, " ");
  const label = `ZIP ${zip} [${parts.join(",")}]`;
  if (!res.ok) {
    console.error(`[apple] ${label}: HTTP ${res.status}. Body: ${snippet}`);
    throw new AppleError(res.status, `Apple returned ${res.status} for ${label}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[apple] ${label}: not JSON. Body: ${snippet}`);
    throw new AppleError(0, `Apple sent a web page instead of data for ${label}`);
  }
  const stores = json?.body?.content?.pickupMessage?.stores;
  if (!Array.isArray(stores)) {
    console.error(`[apple] ${label}: no store list. Body: ${snippet}`);
    throw new AppleError(0, `Apple's reply had no store list for ${label}`);
  }
  return stores;
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

// Ask about all parts at once. If Apple refuses (541 usually means it doesn't like one
// of the part numbers), ask about each part alone to find the bad one and skip it after.
async function checkZip(zip: string, parts: string[], merged: Map<string, Store>) {
  try {
    addStores(merged, await fetchZip(zip, parts), parts);
    return;
  } catch (e) {
    if (!(e instanceof AppleError) || e.status !== 541 || parts.length === 1) throw e;
  }
  const results = await Promise.allSettled(parts.map((p) => fetchZip(zip, [p])));
  let okCount = 0;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okCount++;
      addStores(merged, r.value, [parts[i]]);
    } else if (r.reason instanceof AppleError && r.reason.status === 541) {
      badParts.add(parts[i]);
    }
  });
  if (okCount === 0) {
    badParts.clear();
    throw new Error(`Apple refused every part on its own for ZIP ${zip}, so the part numbers aren't the problem`);
  }
  console.error(`[apple] Skipping part numbers Apple refused: ${[...badParts].join(", ")}`);
}

async function load(): Promise<Payload> {
  const configured = MODELS.filter(isConfigured);
  if (configured.length === 0) return { ok: true, configured: false, checkedAt: Date.now(), stores: [] };
  const parts = configured.map((m) => m.part).filter((p) => !badParts.has(p));
  const merged = new Map<string, Store>();
  const errors: string[] = [];

  // One ZIP at a time so a part-number probe on the first ZIP benefits the second.
  for (const zip of ZIPS) {
    try {
      await checkZip(zip, parts.filter((p) => !badParts.has(p)), merged);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error(`[apple] ${msg}`);
      errors.push(msg);
    }
  }

  const stores = [...merged.values()].sort((a, b) => a.distance - b.distance);
  if (stores.length) console.log(`[apple] OK: ${stores.map((s) => `${s.name} (${s.city})`).join(", ")}`);
  return {
    ok: errors.length < ZIPS.length,
    configured: true,
    checkedAt: Date.now(),
    stores,
    skipped: [...badParts],
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
