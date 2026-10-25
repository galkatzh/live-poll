// transport.js — the message channel between a poll host (a slide deck, or
// board.html) and the audience's phones (index.html). See PROTOCOL.md.
//
// All topics hang off one base, "<prefix>/<room>/"; the room is a random id,
// so two talks never meet.
//
//   state            host → phones   retained   what the phones should show
//   v/<q>/<voter>    phone → host    retained   {choice, t}
//   hello/<voter>    phone → host               {t}
//
// Kinds, combinable with "+" ("mqtt+nostr", the default, runs both at once:
// publish on each, hear from each; the host de-duplicates):
//   "mqtt"   public MQTT brokers over WebSockets. A page connects to EVERY
//            broker in its list at once and publishes to all of them; the host
//            de-duplicates (a vote is keyed by question and voter), so one
//            broker going down mid-talk changes nothing.
//   "nostr"  public Nostr relays (NIP-01), likewise all at once. A message is a
//            signed event. A retained one is addressable (kind 30078, NIP-78)
//            with the topic as its "d" tag, so a relay keeps only its latest
//            version per signer, as an MQTT broker keeps one retained message
//            per topic, and it carries an "expiration" tag (NIP-40) so relays
//            drop it after `ttl`. A non-retained one is ephemeral (kind 20078):
//            relayed to whoever listens, never stored. Subscriptions filter on
//            a "y" tag holding the topic's first level.
//   "local"  BroadcastChannel between tabs of one browser — rehearsals and
//            tests with no network. Retained messages are emulated: a tab that
//            joins asks, and every tab re-sends what it published retained.
//
// LivePollTransport.create(opts) → {publish(sub, obj, {retain}) → Promise<bool>,
//                                   close(), connected(), total(), links()}
//   opts: {kind, room, prefix, brokers, relays, clientId, subscribe: [sub patterns],
//          onMessage(sub, payload, {retained}), onStatus(connected, total, links), onConnect()}
//   Nostr only: nostrKey (hex secret key; default a fresh one per page load),
//          trusted: {<first topic level>: <hex public key>} (messages there count
//          only if that key signed them), ttl (seconds a retained event lives).
// `retained` is true for a stored message replayed on subscribing, false for
// one published while we listen. Payloads are JSON objects; anything else is
// dropped here (an empty payload — a cleared retained message — arrives as null).
(function (global) {
  "use strict";

  const DEFAULT_BROKERS = ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"];
  // Free public relays that took 30 phones joining from one address (a venue's
  // router) without refusing any (tests/relay-check.mjs, Oct 2026). Re-check
  // before a talk: relay policies change.
  const DEFAULT_RELAYS = ["wss://relay.primal.net", "wss://relay.nostr.net", "wss://nostr.oxtr.dev", "wss://nostr-pub.wellorder.net"];
  const DEFAULT_KIND = "mqtt+nostr";
  const KINDS = ["mqtt", "nostr", "local"];
  const DEFAULT_PREFIX = "live-poll";
  const ROOM = /^[A-Za-z0-9_-]{6,64}$/;
  const PREFIX = /^[A-Za-z0-9_-]{1,40}$/;

  // MQTT topic matching: "+" one level, "#" the rest.
  function matches(pattern, topic) {
    const p = pattern.split("/");
    const t = topic.split("/");
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "#") return true;
      if (i >= t.length) return false;
      if (p[i] !== "+" && p[i] !== t[i]) return false;
    }
    return p.length === t.length;
  }

  function parse(text) {
    if (text === "" || text == null) return null;
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // Broker URLs that may come from a link: secure WebSockets only (an https
  // page can open nothing else), plus plain ws:// to this machine for testing
  // a local broker. Anything else is dropped; none left means the defaults.
  function socketList(list, defaults) {
    const ok = (list || []).map((s) => String(s).trim()).filter((u) => {
      try {
        const url = new URL(u);
        return url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname));
      } catch (e) {
        return false;
      }
    });
    return ok.length ? ok : defaults.slice();
  }
  const brokerList = (list) => socketList(list, DEFAULT_BROKERS);
  const relayList = (list) => socketList(list, DEFAULT_RELAYS);

  // "mqtt+nostr" → ["mqtt", "nostr"]; unknown kinds are an error. A link's
  // "t=mqtt+nostr" reads back as "mqtt nostr", so spaces and commas also separate.
  function kindList(kind) {
    const ks = String(kind || DEFAULT_KIND).split(/[+\s,]+/).map((k) => k.trim()).filter(Boolean);
    if (!ks.length || ks.some((k) => !KINDS.includes(k))) throw new Error("unknown transport " + kind);
    return [...new Set(ks)];
  }

  function createMqtt(opts, base) {
    if (!global.mqtt) throw new Error("mqtt.min.js is not loaded");
    const clients = opts.brokers.map((url) =>
      global.mqtt.connect(url, {
        clientId: opts.clientId + "-" + Math.random().toString(36).slice(2, 8),
        clean: true,
        keepalive: 30,
        reconnectPeriod: 2000,
        connectTimeout: 8000,
        // Never queue while offline: a stale "open" state replayed minutes
        // later would be worse than nothing — callers re-publish on reconnect.
        queueQoSZero: false,
      }),
    );
    const up = clients.map(() => false);
    const status = () => opts.onStatus && opts.onStatus(up.filter(Boolean).length, clients.length);

    clients.forEach((c, i) => {
      c.on("connect", () => {
        up[i] = true;
        status();
        (opts.subscribe || []).forEach((s) => c.subscribe(base + s, { qos: 1 }));
        opts.onConnect && opts.onConnect(i);
      });
      const down = () => {
        if (up[i]) {
          up[i] = false;
          status();
        }
      };
      c.on("close", down);
      c.on("offline", down);
      c.on("error", down);
      c.on("message", (topic, buf, packet) => {
        if (topic.indexOf(base) !== 0) return;
        const payload = parse(buf.toString());
        if (payload === undefined) return;
        opts.onMessage(topic.slice(base.length), payload, { retained: !!(packet && packet.retain) });
      });
    });
    // Never call back before create() has returned: the caller is still
    // assigning what it returns.
    setTimeout(status, 0);

    return {
      // Resolves true once at least one broker has acknowledged the message.
      publish(sub, obj, { retain = false } = {}) {
        const body = obj == null ? "" : JSON.stringify(obj);
        const live = clients.filter((c, i) => up[i]);
        if (!live.length) return Promise.resolve(false);
        return new Promise((resolve) => {
          let pending = live.length;
          let done = false;
          live.forEach((c) =>
            c.publish(base + sub, body, { qos: 1, retain }, (err) => {
              if (!err && !done) {
                done = true;
                resolve(true);
              }
              if (--pending === 0 && !done) resolve(false);
            }),
          );
        });
      },
      connected: () => up.filter(Boolean).length,
      total: () => clients.length,
      close() {
        clients.forEach((c) => c.end(true));
      },
    };
  }

  function createLocal(opts, base) {
    const ch = new BroadcastChannel(base);
    const retained = new Map();   // what THIS tab published retained
    const deliver = (sub, body, wasRetained) => {
      if (!(opts.subscribe || []).some((p) => matches(p, sub))) return;
      const payload = parse(body);
      if (payload === undefined) return;
      opts.onMessage(sub, payload, { retained: wasRetained });
    };
    ch.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "sync") {
        retained.forEach((body, sub) => ch.postMessage({ type: "msg", sub, body, retained: true }));
      } else if (m.type === "msg") {
        deliver(m.sub, m.body, !!m.retained);
      }
    };
    setTimeout(() => {
      opts.onStatus && opts.onStatus(1, 1);
      opts.onConnect && opts.onConnect(0);
      ch.postMessage({ type: "sync" });
    }, 0);
    return {
      publish(sub, obj, { retain = false } = {}) {
        const body = obj == null ? "" : JSON.stringify(obj);
        if (retain) {
          if (body === "") retained.delete(sub);
          else retained.set(sub, body);
        }
        ch.postMessage({ type: "msg", sub, body });
        return Promise.resolve(true);
      },
      connected: () => 1,
      total: () => 1,
      close() {
        ch.close();
      },
    };
  }

  // ── Nostr ──────────────────────────────────────────────────────────────
  const KEEP = 30078;      // addressable: the relay keeps the latest per (signer, d)
  const LIVE = 20078;      // ephemeral: forwarded, never stored
  const PAGE = 500;        // events asked for per request
  const FULL = 100;        // a stored backlog this long may have been cut short by the relay
  const MAX_CONTENT = 8192;
  const hex = /^[0-9a-f]{64}$/;

  function nostrLib() {
    if (!global.NostrTools) throw new Error("nostr.bundle.js is not loaded");
    return global.NostrTools;
  }

  // A key pair as hex. With a storage key it is kept in localStorage, so a
  // host keeps its identity (and the phones' trust) across reloads.
  function keypair(storageKey) {
    const N = global.NostrTools;
    if (!N) return null;
    let secret = null;
    try { secret = storageKey ? localStorage.getItem(storageKey) : null; } catch (e) { /* blocked */ }
    if (!hex.test(secret || "")) {
      secret = N.utils.bytesToHex(N.generateSecretKey());
      try { if (storageKey) localStorage.setItem(storageKey, secret); } catch (e) { /* blocked */ }
    }
    return { secret, pubkey: N.getPublicKey(N.utils.hexToBytes(secret)) };
  }

  function createNostr(opts, base) {
    const N = nostrLib();
    const sk = N.utils.hexToBytes(hex.test(opts.nostrKey || "") ? opts.nostrKey : N.utils.bytesToHex(N.generateSecretKey()));
    const pk = N.getPublicKey(sk);
    const ttl = opts.ttl > 0 ? Math.round(opts.ttl) : 86400;
    const trusted = opts.trusted || {};
    const patterns = opts.subscribe || [];
    // One subscription per first topic level; the rest is matched here.
    const subs = [...new Set(patterns.map((p) => p.split("/")[0]))].map((first, i) => {
      if (first === "+" || first === "#") throw new Error("nostr: a subscription's first level must be literal");
      const filter = { kinds: [KEEP, LIVE], "#y": [base + first], limit: PAGE };
      if (hex.test(trusted[first] || "")) filter.authors = [trusted[first]];
      return { id: "lp" + i, filter };
    });
    const relays = opts.relays.map((url) => ({ url, ws: null, up: false, backoff: 2000, pages: {}, warned: {} }));
    const seen = new Set();        // event ids already handled (each relay sends its own copy)
    const newest = new Map();      // signer + topic → the latest retained version handled
    const waiters = new Map();     // event id → callback for the relays' OK replies
    let closed = false;
    let connectTimer = null;

    // created_at is in whole seconds and a relay keeps the newer of two
    // versions, so every retained topic's clock only moves forward, across
    // reloads too.
    const clockKey = "live-poll/nostr-clock/" + pk;
    let clock = {};
    try { clock = JSON.parse(localStorage.getItem(clockKey) || "{}") || {}; } catch (e) { /* none yet */ }
    function tick(d) {
      const now = Math.floor(Date.now() / 1000);
      const at = Math.max(now, (clock[d] || 0) + 1);
      clock[d] = at;
      Object.keys(clock).forEach((k) => { if (clock[k] < now - ttl) delete clock[k]; });
      try { localStorage.setItem(clockKey, JSON.stringify(clock)); } catch (e) { /* blocked */ }
      return at;
    }

    const status = () => opts.onStatus && opts.onStatus(relays.filter((r) => r.up).length, relays.length);
    const send = (r, msg) => { try { r.ws.send(JSON.stringify(msg)); } catch (e) { /* closing */ } };
    function warn(r, what) {
      const k = what.split(":")[0];
      if (r.warned[k]) return;
      r.warned[k] = true;
      console.warn(`live-poll: ${r.url}: ${what}`);
    }

    function accept(ev, stored) {
      if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || seen.has(ev.id)) return false;
      if ((ev.kind !== KEEP && ev.kind !== LIVE) || !Array.isArray(ev.tags) || typeof ev.content !== "string") return false;
      if (ev.content.length > MAX_CONTENT) return false;
      const tag = (name) => { const t = ev.tags.find((x) => Array.isArray(x) && x[0] === name); return t ? String(t[1]) : null; };
      const d = tag("d");
      if (!d || d.indexOf(base) !== 0) return false;
      const sub = d.slice(base.length);
      if (!patterns.some((p) => matches(p, sub))) return false;
      const first = sub.split("/")[0];
      // A trusted level is checked here, not left to the relays.
      if (trusted[first] && (ev.pubkey !== trusted[first] || !N.verifyEvent(ev))) return false;
      seen.add(ev.id);
      if (seen.size > 50000) seen.clear();
      const exp = Number(tag("expiration"));
      if (exp && exp < Date.now() / 1000) return true;
      if (ev.kind === KEEP) {
        const key = ev.pubkey + " " + sub;
        const prev = newest.get(key);
        if (prev && (ev.created_at < prev.at || (ev.created_at === prev.at && ev.id > prev.id))) return true;
        newest.set(key, { at: ev.created_at, id: ev.id });
      }
      const payload = parse(ev.content);
      if (payload === undefined) return true;
      opts.onMessage(sub, payload, { retained: stored });
      return true;
    }

    function request(r, id, filter) {
      r.pages[id] = { count: 0, fresh: 0, oldest: Infinity, eose: false };
      send(r, ["REQ", id, filter]);
    }

    function onFrame(r, data) {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (!Array.isArray(m)) return;
      const [type, a, b, c] = m;
      if (type === "EVENT") {
        const pg = r.pages[a];
        if (!pg) return;
        if (!pg.eose && b && typeof b.created_at === "number") {
          pg.count++;
          pg.oldest = Math.min(pg.oldest, b.created_at);
        }
        if (accept(b, !pg.eose) && !pg.eose) pg.fresh++;
      } else if (type === "EOSE") {
        const pg = r.pages[a];
        if (!pg) return;
        pg.eose = true;
        // A relay caps how many stored events one request returns: ask for the
        // next older page while pages come back full of events not seen yet.
        const [sid, n] = String(a).split(":");
        const s = subs.find((x) => x.id === sid);
        if (n) send(r, ["CLOSE", a]);
        if (s && pg.count >= FULL && (!n || pg.fresh > 0) && Number(n || 0) < 20) {
          request(r, `${sid}:${Number(n || 0) + 1}`, Object.assign({}, s.filter, { until: pg.oldest }));
        }
      } else if (type === "OK") {
        const w = waiters.get(a);
        if (w) w(b === true);
        if (b !== true && typeof c === "string" && !/^duplicate:/.test(c)) warn(r, "rejected an event: " + c);
      } else if (type === "CLOSED") {
        if (typeof b === "string") warn(r, "closed a subscription: " + b);
      } else if (type === "NOTICE") {
        if (typeof a === "string") warn(r, "notice: " + a);
      }
    }

    function open(r) {
      if (closed) return;
      let ws;
      try { ws = new WebSocket(r.url); } catch (e) { return retry(r); }
      r.ws = ws;
      const timeout = setTimeout(() => { if (!r.up) { try { ws.close(); } catch (e) { /* gone */ } } }, 8000);
      ws.onopen = () => {
        clearTimeout(timeout);
        if (closed) return ws.close();
        r.up = true;
        r.backoff = 2000;
        r.pages = {};
        status();
        subs.forEach((s) => request(r, s.id, s.filter));
        // One call after a burst of relays connecting, not one per relay.
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => opts.onConnect && opts.onConnect(), 250);
      };
      ws.onmessage = (e) => onFrame(r, e.data);
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        clearTimeout(timeout);
        if (r.ws !== ws) return;
        r.ws = null;
        if (r.up) { r.up = false; status(); }
        retry(r);
      };
    }
    function retry(r) {
      if (closed) return;
      setTimeout(() => open(r), r.backoff);
      r.backoff = Math.min(r.backoff * 2, 30000);
    }

    relays.forEach(open);
    setTimeout(status, 0);

    return {
      // Resolves true once at least one relay has accepted the event.
      publish(sub, obj, { retain = false } = {}) {
        const live = relays.filter((r) => r.up);
        if (!live.length) return Promise.resolve(false);
        const d = base + sub;
        const created_at = retain ? tick(d) : Math.floor(Date.now() / 1000);
        const tags = [["d", d], ["y", base + sub.split("/")[0]]];
        if (retain) tags.push(["expiration", String(created_at + ttl)]);
        const ev = N.finalizeEvent({ kind: retain ? KEEP : LIVE, created_at, tags, content: obj == null ? "" : JSON.stringify(obj) }, sk);
        return new Promise((resolve) => {
          let pending = live.length;
          let done = false;
          const finish = (ok) => {
            if (done) return;
            if (ok || --pending === 0) {
              done = true;
              waiters.delete(ev.id);
              resolve(ok);
            }
          };
          waiters.set(ev.id, finish);
          live.forEach((r) => send(r, ["EVENT", ev]));
          setTimeout(() => { if (!done) { done = true; waiters.delete(ev.id); resolve(false); } }, 8000);
        });
      },
      connected: () => relays.filter((r) => r.up).length,
      total: () => relays.length,
      pubkey: pk,
      close() {
        closed = true;
        clearTimeout(connectTimer);
        relays.forEach((r) => { if (r.ws) { try { r.ws.close(); } catch (e) { /* gone */ } } });
      },
    };
  }

  // ── several kinds at once ─────────────────────────────────────────────────
  const FACTORY = { mqtt: createMqtt, nostr: createNostr, local: createLocal };

  function createMulti(kinds, opts, base) {
    const parts = [];
    let connectTimer = null;
    const links = () => parts.map((p) => ({ kind: p.kind, up: p.up, total: p.total }));
    const report = () => {
      const ls = links();
      opts.onStatus && opts.onStatus(ls.reduce((n, l) => n + l.up, 0), ls.reduce((n, l) => n + l.total, 0), ls);
    };
    kinds.forEach((kind) => {
      const part = { kind, up: 0, total: 0, t: null };
      try {
        part.t = FACTORY[kind](Object.assign({}, opts, {
          onStatus(up, total) { part.up = up; part.total = total; report(); },
          // Coalesced: the caller re-asserts its state once per burst.
          onConnect() {
            clearTimeout(connectTimer);
            connectTimer = setTimeout(() => opts.onConnect && opts.onConnect(), 200);
          },
        }), base);
        parts.push(part);
      } catch (e) {
        // One kind failing to start (a script that did not load) leaves the others.
        if (kinds.length === 1) throw e;
        console.warn(`live-poll: no ${kind} transport: ${e.message}`);
      }
    });
    if (!parts.length) throw new Error("no transport could start");
    return {
      // Resolves true as soon as any kind has delivered.
      publish(sub, obj, o) {
        return new Promise((resolve) => {
          let pending = parts.length;
          parts.forEach((p) => {
            let sent;
            try { sent = p.t.publish(sub, obj, o); } catch (e) { sent = Promise.resolve(false); }
            sent.then((ok) => {
              if (ok) { pending = -1; resolve(true); } else if (--pending === 0) resolve(false);
            });
          });
        });
      },
      connected: () => parts.reduce((n, p) => n + p.t.connected(), 0),
      total: () => parts.reduce((n, p) => n + p.t.total(), 0),
      links,
      close() {
        clearTimeout(connectTimer);
        parts.forEach((p) => p.t.close());
      },
    };
  }

  global.LivePollTransport = {
    DEFAULT_BROKERS,
    DEFAULT_RELAYS,
    DEFAULT_KIND,
    DEFAULT_PREFIX,
    ROOM,
    matches,
    brokerList,
    relayList,
    kindList,
    keypair,
    randomRoom() {
      const a = "abcdefghijkmnpqrstuvwxyz23456789";
      const r = new Uint32Array(12);
      crypto.getRandomValues(r);
      return Array.from(r, (x) => a[x % a.length]).join("");
    },
    create(opts) {
      const prefix = opts.prefix || DEFAULT_PREFIX;
      if (!ROOM.test(opts.room || "")) throw new Error("bad room id");
      if (!PREFIX.test(prefix)) throw new Error("bad topic prefix");
      const base = prefix + "/" + opts.room + "/";
      // An absent or empty list means the defaults (Object.assign would copy
      // an explicit `brokers: undefined` over them).
      const o = Object.assign({}, opts, { brokers: brokerList(opts.brokers), relays: relayList(opts.relays) });
      return createMulti(kindList(opts.kind), o, base);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
