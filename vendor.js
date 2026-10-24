#!/usr/bin/env node
// Copy the two browser bundles the pages load, pinned in package.json, next
// to them, with their licences. GitHub Pages then serves everything from one
// origin and the pages need no CDN.
//   npm install && npm run vendor
const fs = require("fs");
const path = require("path");
const nm = path.join(__dirname, "node_modules");
const copies = [
  ["mqtt/dist/mqtt.min.js", "mqtt.min.js"],
  ["qrcode-generator/dist/qrcode.js", "qrcode.js"],
  ["mqtt/LICENSE.md", "licenses/mqtt.LICENSE.md"],
];
for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(path.join(__dirname, to)), { recursive: true });
  fs.copyFileSync(path.join(nm, from), path.join(__dirname, to));
  console.log(`${from} -> ${to}`);
}
const v = (p) => require(path.join(nm, p, "package.json")).version;
fs.writeFileSync(path.join(__dirname, "licenses", "VERSIONS.json"),
  JSON.stringify({ mqtt: v("mqtt"), "qrcode-generator": v("qrcode-generator") }, null, 2) + "\n");
