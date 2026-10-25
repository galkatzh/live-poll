// A small Nostr relay for the offline tests (NIP-01, with NIP-40 expiry):
// signatures checked, addressable events (30000–39999) replaced by
// (pubkey, kind, d), ephemeral ones (20000–29999) forwarded and never stored.
//
//   const relay = await startRelay({ cap, careless })
//     cap       most stored events one REQ returns
//     careless  ignore the authors filter, as a dishonest relay might
//   relay.url · relay.events() · relay.seed(events) · relay.dropAll() · relay.close()
const { WebSocketServer } = require("ws");

async function startRelay({ cap = 500, careless = false } = {}) {
  const { verifyEvent } = await import("nostr-tools/pure");
  const store = [];
  const clients = new Set();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));

  const tag = (ev, name) => (ev.tags.find((t) => t[0] === name) || [])[1];
  const expired = (ev) => { const x = Number(tag(ev, "expiration")); return x && x < Date.now() / 1000; };
  function matches(f, ev) {
    if (f.ids && !f.ids.includes(ev.id)) return false;
    if (f.kinds && !f.kinds.includes(ev.kind)) return false;
    if (f.authors && !careless && !f.authors.includes(ev.pubkey)) return false;
    if (f.since && ev.created_at < f.since) return false;
    if (f.until && ev.created_at > f.until) return false;
    for (const k of Object.keys(f)) {
      if (k[0] === "#" && !ev.tags.some((t) => t[0] === k.slice(1) && f[k].includes(t[1]))) return false;
    }
    return true;
  }
  function keep(ev) {
    if (ev.kind >= 20000 && ev.kind < 30000) return;
    if (ev.kind >= 30000 && ev.kind < 40000) {
      const d = tag(ev, "d") || "";
      const i = store.findIndex((e) => e.kind === ev.kind && e.pubkey === ev.pubkey && (tag(e, "d") || "") === d);
      if (i >= 0) {
        const old = store[i];
        if (old.created_at > ev.created_at || (old.created_at === ev.created_at && old.id < ev.id)) return;
        store.splice(i, 1);
      }
    }
    store.push(ev);
  }

  wss.on("connection", (ws) => {
    const subs = new Map();
    const client = { ws, subs };
    clients.add(client);
    ws.on("close", () => clients.delete(client));
    ws.on("message", (data) => {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (m[0] === "EVENT") {
        const ev = m[1];
        if (!verifyEvent(ev)) return ws.send(JSON.stringify(["OK", ev && ev.id, false, "invalid: bad signature"]));
        if (expired(ev)) return ws.send(JSON.stringify(["OK", ev.id, false, "invalid: event has expired"]));
        if (store.some((e) => e.id === ev.id)) return ws.send(JSON.stringify(["OK", ev.id, true, "duplicate: already have this event"]));
        keep(ev);
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        for (const c of clients) {
          for (const [id, filters] of c.subs) {
            if (filters.some((f) => matches(f, ev))) c.ws.send(JSON.stringify(["EVENT", id, ev]));
          }
        }
      } else if (m[0] === "REQ") {
        const [, id, ...filters] = m;
        subs.set(id, filters);
        const out = new Map();
        for (const f of filters) {
          store.filter((e) => !expired(e) && matches(f, e))
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
            .slice(0, Math.min(f.limit || cap, cap))
            .forEach((e) => out.set(e.id, e));
        }
        for (const e of out.values()) ws.send(JSON.stringify(["EVENT", id, e]));
        ws.send(JSON.stringify(["EOSE", id]));
      } else if (m[0] === "CLOSE") {
        subs.delete(m[1]);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${wss.address().port}`,
    events: () => store.slice(),
    seed: (events) => events.forEach(keep),
    dropAll: () => { for (const c of clients) c.ws.terminate(); },
    close: () => new Promise((r) => { for (const c of clients) c.ws.terminate(); wss.close(r); }),
  };
}

module.exports = { startRelay };
