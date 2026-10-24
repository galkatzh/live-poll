// host.js — the host's side of the polls: the page on the projector.
//
// A host is the only authority. It tells the phones which question is up (a
// retained "state" message, so a phone that joins late or reloads lands on the
// current question) and counts what comes back. A vote is keyed by question
// and voter and the newest one wins, so voters can change their mind until
// the poll closes, and the same vote arriving from two brokers (or replayed as
// a retained message after a reconnect) is counted once.
//
// What a host counts is mirrored to localStorage under its room, so a reload
// mid-talk loses nothing; the retained votes on the brokers are a second copy.
//
//   const host = LivePollHost.create({room, prefix, kind, brokers, polls, meta, onChange})
//     kind      "mqtt" (default) | "local" | "none" (render only, never connect)
//     polls     [{id, prompt, options, kicker?, layout?, answer?, scored?}]
//     meta      {title?, scoreText?} sent to the phones with every state
//     mode      "host" (default) | "watch": a read-only mirror of a room that
//               another host runs — learns each question from its state
//               messages, counts the votes, publishes nothing
//     onChange(what)   what = a poll id, "show", "status", "joined" or "purge"
//
//   host.show(id | null)      the question phones should display (null: waiting screen)
//   host.toggleOpen() / reveal() / idle()
//   host.counts(id) / votes(id) / poll(id) / current() / joined() / status()
//   host.isOpen(id) / isRevealed(id) / exportJSON() / purge() / close()
(function (global) {
  "use strict";

  const VOTER = /^[A-Za-z0-9]{4,40}$/;
  const QID = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_OPTIONS = 12;
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

  function create(opts) {
    const mode = opts.mode === "watch" ? "watch" : "host";
    const prefix = opts.prefix || global.LivePollTransport.DEFAULT_PREFIX;
    const storeKey = `live-poll/${prefix}/${opts.room}/${mode}`;
    const onChange = opts.onChange || (() => {});
    const meta = opts.meta || {};
    let polls = {};
    let current = null;
    let transport = null;
    let link = { up: 0, total: 0 };
    let saveTimer = null;
    const watched = { open: {}, revealed: {} };   // watch mode: as the host last said

    (opts.polls || []).forEach((p) => (polls[p.id] = p));

    const empty = () => ({ votes: {}, open: {}, revealed: {}, joined: {} });
    function load() {
      if (mode === "watch") return empty();
      try {
        const v = JSON.parse(localStorage.getItem(storeKey) || "null");
        if (v && typeof v === "object") return Object.assign(empty(), v);
      } catch (e) { /* fall through */ }
      return empty();
    }
    let store = load();

    function write() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (mode === "watch") return;
      try { localStorage.setItem(storeKey, JSON.stringify(store)); } catch (e) { /* storage full or blocked */ }
    }
    // Votes can arrive in bursts, so their writes are batched; the presenter's
    // own actions are written at once. A pending batch is flushed on unload.
    function save(now) {
      if (now) return write();
      if (!saveTimer) saveTimer = setTimeout(write, 150);
    }
    const flush = () => { if (saveTimer) write(); };
    if (typeof window !== "undefined") window.addEventListener("pagehide", flush);

    function isOpen(id) {
      if (!id || !polls[id]) return false;
      if (mode === "watch") return !!watched.open[id];
      if (store.revealed[id]) return false;
      return store.open[id] !== false;               // open until closed or revealed
    }
    const isRevealed = (id) => (mode === "watch" ? !!watched.revealed[id] : !!store.revealed[id]);

    function stateFor(id) {
      const p = id && polls[id];
      const base = { v: 1, title: meta.title || "", scoreText: meta.scoreText || "" };
      if (!p) return Object.assign(base, { q: null });
      const revealed = isRevealed(id);
      return Object.assign(base, {
        q: id, prompt: p.prompt, kicker: p.kicker || "", options: p.options, layout: p.layout || "list",
        open: isOpen(id), revealed, answer: revealed && Number.isInteger(p.answer) ? p.answer : null, scored: !!p.scored,
      });
    }

    function publishState() {
      if (transport && mode === "host") transport.publish("state", stateFor(current), { retain: true });
    }

    // Watch mode: learn the question from the host's own state message.
    function onState(s) {
      if (!s || !s.q || !QID.test(String(s.q))) {
        current = null;
        onChange("show");
        return;
      }
      const id = String(s.q);
      polls[id] = {
        id, prompt: clip(s.prompt, 500), kicker: clip(s.kicker, 120),
        options: Array.isArray(s.options) ? s.options.slice(0, MAX_OPTIONS).map((o) => clip(o, 200)) : [],
        layout: s.layout === "pair" ? "pair" : "list",
        answer: Number.isInteger(s.answer) ? s.answer : null, scored: !!s.scored,
      };
      watched.open[id] = !!s.open;
      watched.revealed[id] = !!s.revealed;
      meta.title = clip(s.title, 80);
      current = id;
      onChange("show");
      onChange(id);
    }

    function onMessage(sub, payload, info) {
      const parts = sub.split("/");
      if (mode === "watch" && sub === "state") return onState(payload);
      if (parts[0] === "v" && parts.length === 3) {
        const [, q, voter] = parts;
        const p = polls[q];
        if (!QID.test(q) || !VOTER.test(voter) || !payload) return;
        if (mode === "host" && !p) return;               // a question this host never asked
        const choice = payload.choice, t = payload.t;
        const n = p ? p.options.length : MAX_OPTIONS;
        if (!Number.isInteger(choice) || choice < 0 || choice >= n || typeof t !== "number") return;
        const votes = (store.votes[q] = store.votes[q] || {});
        const old = votes[voter];
        if (old && old.t >= t) return;                  // a duplicate or an older copy
        // A vote that arrives live after the poll closed does not count. One
        // replayed from a broker's retained store (after a reload or reconnect)
        // was cast earlier, while phones could still vote, so it does.
        if (mode === "host" && !isOpen(q) && !(info && info.retained)) return;
        votes[voter] = { choice, t };
        store.joined[voter] = Math.max(store.joined[voter] || 0, t);
        save();
        onChange(q);
      } else if (parts[0] === "hello" && parts.length === 2 && VOTER.test(parts[1])) {
        if (!store.joined[parts[1]]) {
          store.joined[parts[1]] = Date.now();
          save();
          onChange("joined");
        }
      }
    }

    if (opts.kind !== "none") {
      transport = global.LivePollTransport.create({
        kind: opts.kind || "mqtt", room: opts.room, prefix, brokers: opts.brokers, clientId: mode,
        subscribe: mode === "watch" ? ["state", "v/#", "hello/#"] : ["v/#", "hello/#"],
        onMessage,
        onStatus(up, total) {
          link = { up, total };
          onChange("status");
        },
        // Re-assert the current question after every (re)connect: a broker
        // that restarted has lost its retained copy.
        onConnect: () => publishState(),
      });
    }

    return {
      mode,
      show(id) {
        if (mode === "watch") return;
        current = id && polls[id] ? id : null;
        publishState();
        onChange("show");
      },
      current: () => current,
      poll: (id) => polls[id] || null,
      polls: () => Object.values(polls),
      meta: () => Object.assign({}, meta),
      toggleOpen() {
        if (mode === "watch" || !current || store.revealed[current]) return;
        store.open[current] = !isOpen(current);
        save(true);
        publishState();
        onChange(current);
      },
      reveal() {
        if (mode === "watch" || !current) return;
        const was = !!store.revealed[current];
        store.revealed[current] = !was;
        if (!was) store.open[current] = false;
        save(true);
        publishState();
        onChange(current);
      },
      idle() {
        if (mode === "watch") return;
        current = null;
        publishState();
        onChange("show");
      },
      counts(id) {
        const p = polls[id];
        const c = p ? p.options.map(() => 0) : [];
        Object.values(store.votes[id] || {}).forEach((v) => { if (v.choice < c.length) c[v.choice]++; });
        return c;
      },
      votes(id) {
        const out = {};
        Object.entries(store.votes[id] || {}).forEach(([voter, v]) => (out[voter] = v.choice));
        return out;
      },
      joined: () => Object.keys(store.joined).length,
      status: () => link,
      isOpen,
      isRevealed,
      exportJSON(download = true) {
        const now = new Date().toISOString();
        const out = {
          room: opts.room, prefix, exported: now,
          polls: Object.values(polls).map((p) => ({ id: p.id, prompt: p.prompt, options: p.options, answer: p.answer ?? null, scored: !!p.scored })),
          votes: store.votes, joined: Object.keys(store.joined).length,
        };
        if (download && typeof document !== "undefined") {
          const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `live-poll-${opts.room}-${now.slice(0, 16).replace(/[:T]/g, "")}.json`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }
        return out;
      },
      // After a rehearsal: forget every vote here and on the brokers.
      purge() {
        if (mode === "watch") return;
        if (transport) {
          Object.entries(store.votes).forEach(([q, vs]) => Object.keys(vs).forEach((voter) => transport.publish(`v/${q}/${voter}`, null, { retain: true })));
          transport.publish("state", null, { retain: true });
        }
        store = empty();
        try { localStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
        onChange("purge");
      },
      close() {
        flush();
        if (transport) transport.close();
        if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
      },
    };
  }

  global.LivePollHost = { create };
})(typeof window !== "undefined" ? window : globalThis);
