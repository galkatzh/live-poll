#!/usr/bin/env node
// Copy the browser bundles the pages load, pinned in package.json, next to
// them, with their licences. GitHub Pages then serves everything from one
// origin and the pages need no CDN.
//   npm install && npm run vendor
const fs = require("fs");
const path = require("path");
const nm = path.join(__dirname, "node_modules");
// nostr.bundle.js has the noble/scure crypto code built in; their licences go with it.
const bundled = ["@noble/curves", "@noble/hashes", "@noble/ciphers", "@scure/base"];
const copies = [
  ["mqtt/dist/mqtt.min.js", "mqtt.min.js"],
  ["qrcode-generator/dist/qrcode.js", "qrcode.js"],
  ["nostr-tools/lib/nostr.bundle.js", "nostr.bundle.js"],
  ["mqtt/LICENSE.md", "licenses/mqtt.LICENSE.md"],
  ["nostr-tools/LICENSE", "licenses/nostr-tools.LICENSE"],
  ...bundled.map((p) => [`${p}/LICENSE`, `licenses/${p.replace("/", "-").replace("@", "")}.LICENSE`]),
];
for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(path.join(__dirname, to)), { recursive: true });
  fs.copyFileSync(path.join(nm, from), path.join(__dirname, to));
  console.log(`${from} -> ${to}`);
}
const v = (p) => require(path.join(nm, p, "package.json")).version;
const versions = { mqtt: v("mqtt"), "qrcode-generator": v("qrcode-generator"), "nostr-tools": v("nostr-tools") };
bundled.forEach((p) => (versions[p] = v(p)));
fs.writeFileSync(path.join(__dirname, "licenses", "VERSIONS.json"), JSON.stringify(versions, null, 2) + "\n");
