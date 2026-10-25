// Check public Nostr relays for what live-poll needs, from this machine:
//   node tests/relay-check.mjs [wss://relay ...]     (default: the candidates below)
// For each relay: are the addressable (30078) and ephemeral (20078) events
// accepted, is a newer version kept in place of the older, do subscriptions on
// the "y" tag deliver live, and how does it take PHONES connections from one
// address — a room full of phones behind one venue router — joining over a
// few seconds, then voting over SPREAD_MS, as a real room would.
// Test events carry a random room id and expire within the hour.
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import WebSocket from "ws";

// live-poll's defaults (transport.js DEFAULT_RELAYS), then alternatives that
// worked but refused connections beyond about 12 and 8 from one address.
const CANDIDATES = ["wss://relay.primal.net", "wss://relay.nostr.net", "wss://nostr.oxtr.dev", "wss://nostr-pub.wellorder.net",
  "wss://nos.lol", "wss://nostr.mom"];
const PHONES = 30;
const SPREAD_MS = 10000;
const relays = process.argv.slice(2).length ? process.argv.slice(2) : CANDIDATES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: "https://galk.cc" } });
    const c = { ws, ok: new Map(), events: [], eose: new Set(), notes: [] };
    const t = setTimeout(() => resolve({ refused: "timeout" }), 10000);
    ws.on("open", () => { clearTimeout(t); resolve(c); });
    ws.on("unexpected-response", (q, r) => { clearTimeout(t); resolve({ refused: "HTTP " + r.statusCode }); });
    ws.on("error", (e) => { clearTimeout(t); resolve({ refused: e.message.slice(0, 40) }); });
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(d); } catch (e) { return; }
      if (m[0] === "OK") c.ok.set(m[1], { ok: m[2], msg: m[3] });
      else if (m[0] === "EVENT") c.events.push({ sub: m[1], ev: m[2], at: Date.now() });
      else if (m[0] === "EOSE") c.eose.add(m[1]);
      else if (m[0] === "CLOSED" || m[0] === "NOTICE") c.notes.push(m.slice(1).join(" "));
    });
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  return null;
}
function event(sk, kind, base, sub, content, at) {
  const tags = [["d", base + sub], ["y", base + sub.split("/")[0]]];
  if (kind === 30078) tags.push(["expiration", String(at + 3600)]);
  return finalizeEvent({ kind, created_at: at, tags, content: JSON.stringify(content) }, sk);
}
async function publish(c, ev) {
  const t0 = Date.now();
  send(c, ["EVENT", ev]);
  const r = await until(() => c.ok.get(ev.id));
  return r ? { ok: r.ok, msg: r.msg, ms: Date.now() - t0 } : { ok: false, msg: "no OK", ms: null };
}

async function check(url) {
  const out = { url };
  const room = "chk" + Math.random().toString(36).slice(2, 12);
  const base = `live-poll/${room}/`;
  const host = await client(url), pub = await client(url);
  if (!host.ws || !pub.ws) return Object.assign(out, { error: "no connection: " + (host.refused || pub.refused) });
  send(host, ["REQ", "h", { kinds: [30078, 20078], "#y": [base + "state", base + "hello", base + "v"], limit: 500 }]);
  await until(() => host.eose.has("h"));
  const sk = generateSecretKey();
  const now = Math.floor(Date.now() / 1000);

  const keep1 = event(sk, 30078, base, "state", { n: 1 }, now);
  out.keep = await publish(pub, keep1);
  out.keepLiveMs = (await until(() => host.events.find((e) => e.ev.id === keep1.id))) ? Date.now() - Date.now() : null;
  const live = event(sk, 20078, base, "hello/x", { t: 1 }, now);
  out.ephemeral = await publish(pub, live);
  out.ephemeralDelivered = !!(await until(() => host.events.find((e) => e.ev.id === live.id), 5000));
  const keep2 = event(sk, 30078, base, "state", { n: 2 }, now + 1);
  out.keep2 = await publish(pub, keep2);

  const late = await client(url);
  if (!late.ws) return Object.assign(out, { error: "third connection refused: " + late.refused });
  send(late, ["REQ", "l", { kinds: [30078], "#y": [base + "state"] }]);
  await until(() => late.eose.has("l"));
  const stored = late.events.filter((e) => e.sub === "l").map((e) => JSON.parse(e.ev.content).n);
  out.replaced = stored.length === 1 && stored[0] === 2 ? "yes" : `no (${JSON.stringify(stored)})`;
  late.ws.close();

  // A roomful of phones: joining 100 ms apart, saying hello, then voting
  // at random moments over SPREAD_MS.
  const phones = [];
  const hellos = [];
  for (let i = 0; i < PHONES; i++) {
    const c = await client(url);
    phones.push(c);
    if (c.ws) hellos.push(publish(c, event(generateSecretKey(), 20078, base, `hello/p${i}`, { t: Date.now() }, now)));
    await sleep(100);
  }
  const up = phones.filter((c) => c.ws);
  out.phonesConnected = up.length;
  out.refused = [...new Set(phones.filter((c) => !c.ws).map((c) => c.refused))];
  const t0 = Date.now();
  const votes = up.map(async (c, i) => {
    await sleep(Math.random() * SPREAD_MS);
    return publish(c, event(generateSecretKey(), 30078, base, `v/q1/p${i}`, { choice: i % 2, t: Date.now() }, now));
  });
  const flat = (await Promise.all(hellos)).concat(await Promise.all(votes));
  out.phoneEventsOk = `${flat.filter((r) => r.ok).length}/${flat.length}`;
  out.phoneRejects = [...new Set(flat.filter((r) => !r.ok).map((r) => r.msg))].slice(0, 3);
  out.phoneSeconds = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(1500);
  out.votesHostSaw = host.events.filter((e) => e.ev.kind === 30078 && e.ev.tags.some((t) => t[0] === "d" && t[1].startsWith(base + "v/"))).length;
  out.notes = [...new Set(host.notes.concat(pub.notes))].slice(0, 3);
  [host, pub, ...phones].forEach((c) => c && c.ws && c.ws.close());
  return out;
}

for (const url of relays) {
  const r = await check(url).catch((e) => ({ url, error: e.message }));
  delete r.keepLiveMs;
  console.log(JSON.stringify(r));
}
process.exit(0);
