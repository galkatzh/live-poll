# live-poll

Live audience polls with no server: a static phone page, a results board, and a small protocol between them over public MQTT brokers and Nostr relays. The audience scans one QR code. Their phones then follow the presenter from question to question, and the tallies build up on the projector.

- **`index.html`** is the phone page. It shows whatever the host sends, so you never edit it per talk.
- **`board.html`** is the results board:
  - **Host mode:** type your questions, start, and present it next to slides from PowerPoint, Google Slides or Keynote.
  - **Watch mode:** a read-only mirror of a room another host is running.
- **`host.js`** and **`transport.js`** put the host side into your own HTML deck, e.g. a reveal.js presentation that shows the live tally on its own slides.
- **[`PROTOCOL.md`](PROTOCOL.md)** describes the message format, so anything can host.

Votes travel over two free public MQTT brokers and four free public Nostr relays at once, so any one of them is enough. Everything the page needs is served from this repo, with no CDN.

- **Why both transports:** the free brokers are sometimes overloaded and refuse new connections, as both were in October 2026.
- **Why these relays:** Nostr relays use the HTTPS port, 443, which venue Wi-Fi seldom blocks. The four defaults each accepted 30 phones joining from one address.
- **Signed questions:** on Nostr the host signs what phones should show, and the QR code carries its public key. Phones take the question only from that key there.

## Run a poll from the board

1. Open `board.html` (on GitHub Pages: `https://<user>.github.io/live-poll/board.html`).
2. Write the questions, one block each:
   ```
   title: Lab meeting

   Which figure is hardest to copy?
   - circle
   - square
   * triangle

   Shall we keep the Friday slot?
   - yes
   - no
   ```
   `-` marks an option and `*` the right answer (optional). Questions with a right answer count towards each voter's score.
3. **Start.** The lobby shows a big QR code and how many phones have joined.

The keys, which work with a presentation clicker:

| Key | Action |
|---|---|
| → / Space / PgDn | next question |
| ← / PgUp | previous |
| Home | back to the lobby |
| O | open or close voting |
| R | reveal the answer |
| X | blank the phones |
| E | download all votes as JSON |
| Q | big QR code |
| F | fullscreen |
| S | back to setup |

The board saves its questions, its place and every vote in the browser, keyed by room, so a reload loses nothing. **Copy board link** puts the questions into the link itself, so you can open the same board on another computer.

## Host from your own deck

```html
<script src="mqtt.min.js"></script>
<script src="nostr.bundle.js"></script>
<script src="transport.js"></script>
<script src="host.js"></script>
<script>
  const host = LivePollHost.create({
    room: "pick-a-random-room",
    polls: [{ id: "q1", prompt: "Best colour?", options: ["red", "green"], answer: 1, scored: true }],
    meta: { title: "My talk" },
    onChange: (what) => render(host.counts("q1")),
  });
  host.show("q1");     // when the slide with that question appears
  host.reveal();       // when you press your reveal key
</script>
```

The QR code encodes `https://<user>.github.io/live-poll/#r=<room>&h=<host.pubkey()>`. The host's key is kept in localStorage per room (`LivePollHost.key({room})`), so it survives a reload. If storage is cleared, the key and the QR code change, and phones that joined before must scan again.

## Privacy

- **Nothing personal is collected.** Phones send option indexes under a random voter id, with no names and no accounts.
- **Rooms are not private.** The brokers and relays are public: anyone who knows a room code can read its votes or send fake ones. The host accepts only well-formed votes, one per voter id, but use a fresh random room per event and don't poll on anything sensitive.
- **Hijacking the phones' screen.** On Nostr it takes the host's key. MQTT has no signatures, so there it doesn't.
- **Don't put confidential material in the questions.** Question text passes through the public brokers and relays too. Nostr events carry a 24-hour expiry, but a relay may keep them longer or show them publicly.

## Development

```sh
npm install && npm run vendor        # refresh mqtt.min.js, nostr.bundle.js and qrcode.js (versions pinned in package.json)
npx playwright test                  # board + phones as tabs of one browser, offline (local transport, and a Nostr relay in tests/relay.js)
LIVE=1 npx playwright test           # adds runs against the real public brokers and relays
node tests/relay-check.mjs           # which relays accept these events and take 30 phones from one address
```

## Third-party code

- `mqtt.min.js` is [MQTT.js](https://github.com/mqttjs/MQTT.js) 5.16.0, MIT: see `licenses/mqtt.LICENSE.md`.
- `qrcode.js` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by Kazuhiko Arase, MIT: the notice is in the file's header.
- `nostr.bundle.js` is [nostr-tools](https://github.com/nbd-wtf/nostr-tools) 2.25.2, public domain (Unlicense): see `licenses/nostr-tools.LICENSE`. It has the MIT-licensed [noble](https://paulmillr.com/noble/) curves, hashes and ciphers and [scure-base](https://github.com/paulmillr/scure-base) built in: see `licenses/`.
