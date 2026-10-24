# live-poll protocol, version 1

The protocol connects a **host** (a slide deck, or `board.html`) to **phones** (`index.html`) over MQTT. The host publishes what the phones should show. The phones publish votes. The phone page has no questions of its own, so any host that speaks this protocol can drive it.

`transport.js` and `host.js` implement both sides. Use them if you can, or write your own client from this page.

## Topics

All topics hang off a base of `<prefix>/<room>/`.
- `<prefix>` defaults to `live-poll` and matches `[A-Za-z0-9_-]{1,40}`.
- `<room>` matches `[A-Za-z0-9_-]{6,64}`. Pick it at random: anyone who knows it can read and write the room.

| Topic | Publisher | Retained | Payload |
|---|---|---|---|
| `state` | host | yes | The current question, or the waiting screen. See below. |
| `v/<q>/<voter>` | phone | yes | `{"choice": <option index>, "t": <ms since epoch>}` |
| `hello/<voter>` | phone | no | `{"t": <ms>}`, sent on every (re)connect, for a "joined" count |

Payloads are JSON objects, published with QoS 1. An empty payload clears a retained message.

- `<q>` is a question id matching `[A-Za-z0-9_-]{1,64}`. Change the id whenever the question changes; phones remember their vote per id.
- `<voter>` matches `[A-Za-z0-9]{4,40}`. A phone picks it at random once and keeps it in localStorage.

## `state`

```json
{
  "v": 1,
  "title": "Lab meeting",
  "scoreText": "You got {right} of {total} right",
  "q": "a1b2c3-2",
  "kicker": "Question 2 of 5",
  "prompt": "Which figure is hardest to copy?",
  "options": ["circle", "square", "triangle"],
  "layout": "list",
  "open": true,
  "revealed": false,
  "answer": null,
  "scored": true
}
```

| Field | Meaning |
|---|---|
| `v` | Protocol version. Always `1` for now. |
| `title` | Shown in the phone's header and tab title (≤ 80 characters). |
| `scoreText` | The running-score line. `{right}` and `{total}` are filled in from the phone's own record of `scored` questions. Empty means `"{right} of {total} right"`. |
| `q` | The question id. `null` (or a `state` with no `q`) shows the waiting screen; the other fields are then ignored. |
| `kicker` | A small line above the question (≤ 120 characters). |
| `prompt` | The question (≤ 500 characters). Newlines are kept. |
| `options` | 2–12 strings, ≤ 200 characters each. Votes are indexes into this list. |
| `layout` | `"list"` (stacked buttons) or `"pair"` (two big side-by-side buttons). In `"pair"`, an option written `"0 — not acceptable"` shows `0` large with the label beneath. |
| `open` | Whether phones may vote. Buttons are disabled when `false`. |
| `revealed` | Phones mark the right answer and tell the voter whether they matched it. |
| `answer` | The index of the right answer. Send it only once `revealed` is true; until then it is `null`. |
| `scored` | Whether this question counts towards the running score. |

All text is rendered as plain text, never HTML. Longer strings are clipped.

## Rules a host should follow

- **Keep `state` retained, and re-publish it after every (re)connect.** A phone that joins or reloads then lands on the current question at once.
- **Count each voter once per question, by `(q, voter)`.** Keep the vote with the largest `t`: a duplicate or an older copy (from a second broker, or a retained replay) must not overwrite a newer one.
- **Ignore malformed votes:** `choice` not an integer index of `options`, `t` not a number, an unknown `q`, or a bad voter id.
- **After closing a poll, ignore live votes but accept retained replays.** A replayed vote (the MQTT retain flag is set on delivery) was cast while voting was open.
- **Clean up after a rehearsal** by publishing empty retained payloads to the vote topics and to `state`. `host.purge()` does this.

## Transport

Phones and hosts connect to **every** broker in their list at once:
- publish to all of them;
- subscribe on all of them;
- de-duplicate as above.

One broker going down then changes nothing.

The default brokers are free public ones:

```
wss://broker.hivemq.com:8884/mqtt
wss://broker.emqx.io:8084/mqtt
```

A link may name others with `b=` (comma-separated). Only `wss://` URLs are accepted, plus `ws://localhost` / `ws://127.0.0.1` for testing against a local broker.

For rehearsals with no network, `t=local` swaps MQTT for a BroadcastChannel between tabs of one browser. Retained messages are emulated.

## Phone page URL

```
index.html#r=<room>[&b=<broker,broker>][&p=<prefix>][&t=local][&voter=<id>]
```

Everything is in the fragment, so none of it reaches the web server. `voter=` pins the voter id; it is for tests that run several "phones" as tabs of one browser.
