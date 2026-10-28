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

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchZip(zip: string, parts: string[]): Promise<any[]> {
  const params = new URLSearchParams({ fae: "true", pl: "true", "mts.0": "regular", "mts.1": "compact", location: zip });
  parts.forEach((p, i) => params.set(`parts.${i}`, p));
  const res = await fetch(`https://www.apple.com/shop/fulfillment-messages?${params}`, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      Referer: "https://www.apple.com/shop/buy-iphone",
    },
    signal: AbortSignal.timeout(4500),
  });
  const text = await res.text();
  const snippet = text.slice(0, 160).replace(/\s+/g, " ");
  if (!res.ok) {
    console.error(`[apple] ZIP ${zip}: HTTP ${res.status} ${res.statusText}. Body: ${snippet}`);
    throw new Error(`Apple returned ${res.status} for ZIP ${zip}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`[apple] ZIP ${zip}: not JSON (HTTP ${res.status}). Body: ${snippet}`);
    throw new Error(`Apple sent a web page instead of data for ZIP ${zip}`);
  }
  const stores = json?.body?.content?.pickupMessage?.stores;
  if (!Array.isArray(stores)) {
    console.error(`[apple] ZIP ${zip}: unexpected shape. Body: ${snippet}`);
    throw new Error(`Apple's reply had no store list for ZIP ${zip}`);
  }
  const cities = stores.map((s: any) => `${s.storeName} (${s.city})`).join(", ");
  console.log(`[apple] ZIP ${zip}: ${stores.length} stores: ${cities}`);
  return stores;
}

async function load(): Promise<Payload> {
  const models = MODELS.filter(isConfigured);
  if (models.length === 0) {
    return { ok: true, configured: false, checkedAt: Date.now(), stores: [] };
  }
  const parts = models.map((m) => m.part);
  const results = await Promise.allSettled(ZIPS.map((z) => fetchZip(z, parts)));
  const merged = new Map<string, Store>();
  const errors: string[] = [];

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = String(r.reason?.message ?? r.reason);
      if (!errors.length) console.error(`[apple] request failed: ${msg}`);
      errors.push(msg);
      continue;
    }
    for (const s of r.value) {
      const lat = Number(s.storelatitude);
      const lng = Number(s.storelongitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const distance = milesBetween(CENTER, { lat, lng });
      if (distance > RADIUS_MILES || !inCounty(String(s.city ?? ""))) continue;
      const id = String(s.storeNumber);
      const store: Store = merged.get(id) ?? {
        id,
        name: String(s.storeName ?? id),
        city: String(s.city ?? ""),
        lat,
        lng,
        distance,
        models: {},
      };
      for (const part of parts) {
        const pa = s.partsAvailability?.[part];
        if (!pa) continue;
        const available = pa.pickupDisplay === "available";
        const prev = store.models[part];
        store.models[part] = {
          available: available || Boolean(prev?.available),
          quote: String(pa.pickupSearchQuote ?? pa.storePickupQuote ?? ""),
        };
      }
      merged.set(id, store);
    }
  }

  const stores = [...merged.values()].sort((a, b) => a.distance - b.distance);
  const allFailed = errors.length === ZIPS.length;
  return {
    ok: !allFailed,
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
      .finally(() => {
        inflight = null;
      });
  }
  const payload = await inflight;
  return NextResponse.json(payload, { status: payload.ok ? 200 : 502, headers: { "Cache-Control": "no-store" } });
}
