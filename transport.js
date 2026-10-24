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
// Two kinds:
//   "mqtt"   public MQTT brokers over WebSockets. A page connects to EVERY
//            broker in its list at once and publishes to all of them; the host
//            de-duplicates (a vote is keyed by question and voter), so one
//            broker going down mid-talk changes nothing.
//   "local"  BroadcastChannel between tabs of one browser — rehearsals and
//            tests with no network. Retained messages are emulated: a tab that
//            joins asks, and every tab re-sends what it published retained.
//
// LivePollTransport.create(opts) → {publish(sub, obj, {retain}) → Promise<bool>,
//                                   close(), connected(), total()}
//   opts: {kind, room, prefix, brokers, clientId, subscribe: [sub patterns],
//          onMessage(sub, payload, {retained}), onStatus(connected, total), onConnect()}
// `retained` is true for a stored message replayed on subscribing, false for
// one published while we listen. Payloads are JSON objects; anything else is
// dropped here (an empty payload — a cleared retained message — arrives as null).
(function (global) {
  "use strict";

  const DEFAULT_BROKERS = ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"];
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
  function brokerList(list) {
    const ok = (list || []).map((s) => String(s).trim()).filter((u) => {
      try {
        const url = new URL(u);
        return url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname));
      } catch (e) {
        return false;
      }
    });
    return ok.length ? ok : DEFAULT_BROKERS.slice();
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

  global.LivePollTransport = {
    DEFAULT_BROKERS,
    DEFAULT_PREFIX,
    ROOM,
    matches,
    brokerList,
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
      const o = Object.assign({}, opts, { brokers: brokerList(opts.brokers) });
      return opts.kind === "local" ? createLocal(o, base) : createMqtt(o, base);
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
