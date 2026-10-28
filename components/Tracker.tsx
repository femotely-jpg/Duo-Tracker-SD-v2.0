"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CENTER, COAST, MODELS, PLACES, POLL_MS, RINGS, TIME_ZONE, buyUrlFor, isConfigured,
} from "@/lib/config";
import { toMiles } from "@/lib/geo";
import type { Payload, Store } from "@/lib/types";

type Drop = { key: string; storeId: string; storeName: string; part: string; start: number; end?: number };

const DROPS_KEY = "duo-sd:drops";
const WANT_KEY = "duo-sd:want";
const RECENT_MS = 3 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const models = MODELS.filter(isConfigured);
const labelFor = (part: string) => MODELS.find((m) => m.part === part)?.label ?? part;
const urlFor = (part: string) => {
  const m = MODELS.find((x) => x.part === part);
  return m ? buyUrlFor(m) : "https://www.apple.com/shop/buy-iphone";
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const fmtTime = (t: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(t);
const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const pacificHour = (t: number) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(t));

async function notify(title: string, body: string, url: string, tag: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, { body, tag, data: { url }, icon: "/icon.svg" });
      return;
    }
    const n = new Notification(title, { body, tag });
    n.onclick = () => window.open(url, "_blank");
  } catch { /* ignore */ }
}

export default function Tracker() {
  const [data, setData] = useState<Payload | null>(null);
  const [failing, setFailing] = useState(false);
  const [drops, setDrops] = useState<Drop[]>([]);
  const [want, setWant] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [perm, setPerm] = useState<string>("default");
  const [now, setNow] = useState(() => Date.now());
  const prev = useRef<Map<string, boolean> | null>(null);
  const wantRef = useRef<string[]>([]);

  useEffect(() => {
    setDrops(readJSON<Drop[]>(DROPS_KEY, []));
    const w = readJSON<string[]>(WANT_KEY, models.map((m) => m.part));
    setWant(w);
    wantRef.current = w;
    if (typeof Notification !== "undefined") setPerm(Notification.permission);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  const handle = useCallback((p: Payload) => {
    setData(p);
    if (!p.configured) return;
    const next = new Map<string, boolean>();
    for (const s of p.stores) {
      for (const [part, a] of Object.entries(s.models)) next.set(`${s.id}|${part}`, a.available);
    }
    const before = prev.current;
    prev.current = next;
    if (!before) {
      // First load: open drops for anything already available, without alerting.
      setDrops((d) => {
        const openKeys = new Set(d.filter((x) => !x.end).map((x) => x.key));
        const added: Drop[] = [];
        for (const s of p.stores) for (const [part, a] of Object.entries(s.models)) {
          const key = `${s.id}|${part}`;
          if (a.available && !openKeys.has(key)) added.push({ key, storeId: s.id, storeName: s.name, part, start: p.checkedAt });
        }
        // Close stale open drops that are no longer available.
        const closed = d.map((x) => (!x.end && next.get(x.key) === false ? { ...x, end: p.checkedAt } : x));
        const out = [...added, ...closed];
        writeJSON(DROPS_KEY, out);
        return out;
      });
      return;
    }
    const started: Drop[] = [];
    const ended = new Set<string>();
    for (const s of p.stores) {
      for (const [part, a] of Object.entries(s.models)) {
        const key = `${s.id}|${part}`;
        const was = before.get(key) ?? false;
        if (a.available && !was) {
          started.push({ key, storeId: s.id, storeName: s.name, part, start: p.checkedAt });
          if (wantRef.current.includes(part)) {
            notify(`${labelFor(part)} at ${s.name}`, `Ready for pickup. ${a.quote}`.trim(), urlFor(part), key);
          }
        }
        if (!a.available && was) ended.add(key);
      }
    }
    if (!started.length && !ended.size) return;
    setDrops((d) => {
      const cutoff = Date.now() - 30 * DAY;
      const out = [
        ...started,
        ...d.map((x) => (!x.end && ended.has(x.key) ? { ...x, end: p.checkedAt } : x)),
      ].filter((x) => x.start > cutoff).slice(0, 1000);
      writeJSON(DROPS_KEY, out);
      return out;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch("/api/availability", { cache: "no-store" });
        const p = (await r.json()) as Payload;
        if (!alive) return;
        setFailing(!p.ok);
        if (p.ok) handle(p);
        else setData((d) => d ?? p);
      } catch {
        if (alive) setFailing(true);
      }
      if (alive) timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    tick();
    const clock = setInterval(() => setNow(Date.now()), 15000);
    return () => { alive = false; clearTimeout(timer); clearInterval(clock); };
  }, [handle]);

  const toggleWant = (part: string) => {
    setWant((w) => {
      const out = w.includes(part) ? w.filter((x) => x !== part) : [...w, part];
      wantRef.current = out;
      writeJSON(WANT_KEY, out);
      return out;
    });
  };

  const enableAlerts = async () => {
    if (typeof Notification === "undefined") { setPerm("unsupported"); return; }
    const r = await Notification.requestPermission();
    setPerm(r);
  };

  const stores = data?.stores ?? [];
  const statusOf = useCallback((s: Store): "on" | "recent" | "off" => {
    if (Object.values(s.models).some((a) => a.available)) return "on";
    if (drops.some((d) => d.storeId === s.id && (d.end ?? now) > now - RECENT_MS)) return "recent";
    return "off";
  }, [drops, now]);

  const live = stores.filter((s) => statusOf(s) === "on");
  const liveCount = live.reduce((n, s) => n + Object.values(s.models).filter((a) => a.available).length, 0);

  const stats = useMemo(() => {
    const week = drops.filter((d) => d.start > now - 7 * DAY);
    const lives = week.filter((d) => d.end).map((d) => d.end! - d.start).sort((a, b) => a - b);
    const median = lives.length ? lives[Math.floor(lives.length / 2)] : null;
    const hours = new Array(24).fill(0);
    drops.filter((d) => d.start > now - 30 * DAY).forEach((d) => hours[pacificHour(d.start)]++);
    return {
      count: week.length,
      stores: new Set(week.map((d) => d.storeId)).size,
      median,
      hours,
      max: Math.max(1, ...hours),
    };
  }, [drops, now]);

  // Map geometry
  const W = 360, H = 400, CX = 214, CY = 300, SCALE = 3.2;
  const proj = (lat: number, lng: number) => {
    const m = toMiles(CENTER, lat, lng);
    return { x: CX + m.x * SCALE, y: CY - m.y * SCALE };
  };
  const coastPts = COAST.map(([la, ln]) => proj(la, ln));
  const seaPath =
    `M -10 ${coastPts[0].y} ` + coastPts.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
    ` L -10 ${H + 10} Z`;
  const colorFor = (st: string) => (st === "on" ? "var(--kelp)" : st === "recent" ? "var(--marigold)" : "var(--surface)");

  const headline = !data
    ? "Reading the tide."
    : !data.configured
    ? "Add your models to start."
    : liveCount > 0
    ? `${live.length === 1 ? "One store has" : `${live.length} stores have`} it now.`
    : "Nothing on the shelves.";

  const sub = !data
    ? "Checking every Apple Store around San Diego."
    : !data.configured
    ? "Part numbers go in lib/config.ts. The setup note below walks through it."
    : liveCount > 0
    ? `${live.map((s) => s.name).join(", ")}. Tap a store below to buy.`
    : `Watching ${stores.length} stores from Orange County to the border.`;

  return (
    <main className="wrap">
      <div className="topbar">
        <div className="brand">Duo Tracker<small>San Diego</small></div>
        <div className={`pulse ${failing ? "down" : data ? "live" : ""}`} role="status">
          <i aria-hidden /> {failing ? "Apple not responding" : data?.checkedAt ? `Checked ${new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(data.checkedAt)}` : "Connecting"}
        </div>
      </div>

      <header className={`hero ${liveCount > 0 ? "hot" : ""}`}>
        <h1>{headline}</h1>
        <p>{sub}</p>
        <ul className="facts">
          <li><b>{stores.length || "--"}</b><span>stores watched</span></li>
          <li><b>{POLL_MS / 1000}s</b><span>between checks</span></li>
          <li><b>{stats.median ? fmtDur(stats.median) : "--"}</b><span>typical drop life</span></li>
        </ul>
      </header>

      {data && !data.configured && (
        <section className="panel setup">
          <h2>One setup step</h2>
          <p className="lede" style={{ margin: 0 }}>
            Open <code>lib/config.ts</code> and replace each <code>REPLACE_</code> entry with a real iPhone Duo part number, then redeploy. The README shows two quick ways to find them.
          </p>
        </section>
      )}

      <div className="mapbox">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Map of ${stores.length} Apple Stores around San Diego`}>
          <path className="sea" d={seaPath} />
          {RINGS.map((r) => (
            <g key={r}>
              <circle className="ring" cx={CX} cy={CY} r={r * SCALE} />
              <text className="ringlabel" x={CX + 4} y={CY - r * SCALE - 3}>{r} mi</text>
            </g>
          ))}
          {PLACES.map((p) => {
            const q = proj(p.lat, p.lng);
            return <text key={p.name} className="place" x={q.x} y={q.y} textAnchor="middle">{p.name}</text>;
          })}
          <circle className="home" cx={CX} cy={CY} r={3.5} />
          {stores.map((s) => {
            const q = proj(s.lat, s.lng);
            const st = statusOf(s);
            const right = q.x < W - 110;
            return (
              <g
                key={s.id}
                className="star"
                tabIndex={0}
                role="button"
                aria-label={`${s.name}, ${st === "on" ? "ready for pickup" : st === "recent" ? "dropped recently" : "sold out"}`}
                onClick={() => setOpen(s.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen(s.id); }}
              >
                {st === "on" && <circle className="glow" cx={q.x} cy={q.y} r={9} />}
                <circle className="hit" cx={q.x} cy={q.y} r={16} />
                <circle className="dot" cx={q.x} cy={q.y} r={6} fill={colorFor(st)} stroke={st === "off" ? "var(--muted)" : undefined} />
                <text x={right ? q.x + 10 : q.x - 10} y={q.y + 4} textAnchor={right ? "start" : "end"}>{s.name}</text>
              </g>
            );
          })}
        </svg>
        <div className="legend">
          <span className="on">Ready for pickup</span>
          <span className="recent">Dropped in last 3h</span>
          <span className="off">Sold out</span>
        </div>
      </div>

      <section aria-labelledby="stores-h">
        <h2 id="stores-h">Stores</h2>
        <p className="lede">Nearest first, measured from {CENTER.label}.</p>
        <ul className="stores">
          {stores.map((s) => {
            const st = statusOf(s);
            const isOpen = open === s.id;
            return (
              <li key={s.id}>
                <button className="storebtn" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)}>
                  <span className={`s ${st}`} aria-hidden />
                  <span><strong>{s.name}</strong><small>{s.city}</small></span>
                  <span className="mi">{s.distance.toFixed(0)} mi</span>
                </button>
                {isOpen && (
                  <div className="detail">
                    <ul>
                      {models.map((m) => {
                        const a = s.models[m.part];
                        return (
                          <li key={m.part}>
                            <span>{m.label}<br /><span className="q">{a?.quote || "No pickup data"}</span></span>
                            {a?.available ? <a className="buy" href={buyUrlFor(m)} target="_blank" rel="noreferrer">Buy now</a> : <span className="q">Sold out</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="alerts-h">
        <h2 id="alerts-h">Get pinged</h2>
        <p className="lede">A notification on this device the moment a model you pick turns up at a San Diego store. Keep this page open, or add it to your Home Screen on iPhone.</p>
        <div className="chips" role="group" aria-label="Models to alert on">
          {models.map((m) => (
            <button key={m.part} className="chip" aria-pressed={want.includes(m.part)} onClick={() => toggleWant(m.part)}>{m.label}</button>
          ))}
        </div>
        <div className="row">
          {perm === "granted" ? (
            <button className="secondary" onClick={() => notify("Test alert", "This is what a drop looks like.", "https://www.apple.com/shop/buy-iphone", "test")}>Send test alert</button>
          ) : (
            <button className="primary" onClick={enableAlerts}>Turn on alerts</button>
          )}
          {perm === "denied" && <span className="q">Alerts are blocked. Allow them in your browser settings.</span>}
          {perm === "unsupported" && <span className="q">This browser can’t show alerts. On iPhone, add this page to your Home Screen first.</span>}
        </div>
        <p className="note">Buy links open the exact model on apple.com. Pick the store, then check out with Apple Pay. Always confirm pickup availability at checkout.</p>
      </section>

      <section aria-labelledby="hist-h">
        <h2 id="hist-h">Every drop, logged</h2>
        <p className="lede">Each time a store flips to ready, it lands here with how long it lasted. This log lives on this device and fills in while the page is open.</p>
        <ul className="facts" style={{ marginTop: 0 }}>
          <li><b>{stats.count}</b><span>drops, 7 days</span></li>
          <li><b>{stats.stores}</b><span>stores hit</span></li>
          <li><b>{stats.median ? fmtDur(stats.median) : "--"}</b><span>median life</span></li>
        </ul>
        <div className="hist" aria-label="Drops by hour of day, Pacific time, last 30 days">
          {stats.hours.map((n, h) => (
            <div key={h} className={n ? "" : "zero"} style={{ height: `${Math.max(3, (n / stats.max) * 100)}%` }} title={`${h}:00, ${n} drops`} />
          ))}
        </div>
        <div className="histaxis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
        {drops.length > 0 && (
          <ul className="log">
            {drops.slice(0, 12).map((d) => (
              <li key={`${d.key}-${d.start}`}>
                <div>{labelFor(d.part)}<br /><span>{d.storeName}, {fmtTime(d.start)}</span></div>
                <span>{d.end ? fmtDur(d.end - d.start) : "Live"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>Not affiliated with Apple. Availability comes from Apple’s public pickup data and changes by the second.</footer>
    </main>
  );
}
