// End-to-end tests: the board and several "phones" as tabs of one browser,
// talking over the local (BroadcastChannel) transport — no network.
//   npm test
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60000,
  expect: { timeout: 8000 },
  workers: 1,
  use: { acceptDownloads: true, viewport: { width: 1280, height: 720 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } }],
});
