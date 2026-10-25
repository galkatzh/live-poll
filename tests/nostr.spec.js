// The Nostr transport end to end, against a relay on this machine
// (tests/relay.js): board and phones as tabs of one browser. Every test uses
// its own room.
const path = require("path");
const { test, expect } = require("@playwright/test");
const { startRelay } = require("./relay");

const ROOT = "file://" + path.join(__dirname, "..");
const BOARD = ROOT + "/board.html";
const SET = "title: Nostr test\n\nPick a colour\n- red\n* green\n- blue\n\nYes or no?\n- yes\n- no";

let relay;
let room;
test.beforeAll(async () => { relay = await startRelay(); });
test.afterAll(async () => { await relay.close(); });
test.beforeEach(() => {
  room = "nos" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
});

async function startBoard(context, kind = "nostr", url = relay.url) {
  const board = await context.newPage();
  const errors = [];
  board.on("pageerror", (e) => errors.push(e.message));
  await board.goto(`${BOARD}#t=${kind}&n=${url}`);
  await board.fill("#room", room);
  await board.fill("#poll-title", "");
  await board.fill("#poll-text", SET);
  await board.click("#start");
  await expect(board.locator("#lobby")).toBeVisible();
  board.errors = errors;
  board.joinUrl = await board.evaluate(() => LivePollBoard.joinUrl);
  expect(await board.locator("#lobby [data-join-url]").textContent()).not.toContain("&h=");
  return board;
}

async function phone(context, url, voter) {
  const p = await context.newPage();
  await p.setViewportSize({ width: 390, height: 800 });
  await p.goto(`${url}&voter=${voter}`);
  return p;
}

test("board and phones over Nostr: vote, change, close, reveal; a fresh board replays the votes", async ({ context, browser }) => {
  const board = await startBoard(context);
  expect(board.joinUrl).toMatch(/[#&]h=[0-9a-f]{64}/);
  expect(board.joinUrl).toContain("t=nostr");
  await expect(board.locator("#link")).toHaveText("Nostr 1/1");
  const a = await phone(context, board.joinUrl, "phoneA1");
  const b = await phone(context, board.joinUrl, "phoneB2");
  await expect(a.locator("main")).toContainText("Waiting for the next question");
  await expect(board.locator("#lobby-joined")).toHaveText("2");

  await board.keyboard.press("ArrowRight");
  await expect(a.locator("#prompt")).toHaveText("Pick a colour");
  await a.getByRole("button", { name: "green" }).click();
  await b.getByRole("button", { name: "red" }).click();
  await b.getByRole("button", { name: "blue" }).click();
  await expect(board.locator("#total")).toHaveText("2");
  await expect(board.locator(".bar .n").nth(2)).toContainText("1");
  await expect(a.locator("#status")).toContainText("Vote recorded");

  await board.keyboard.press("o");
  await expect(a.locator("button.opt").first()).toBeDisabled();
  await board.keyboard.press("r");
  await expect(a.locator("#status")).toHaveText("✓ You got it.");
  await expect(b.locator("#status")).toHaveText("✗ Not this time.");

  // A board with no local copy (another computer) gets the votes back from the relay.
  const link = await board.evaluate(({ room, url, text }) =>
    `${location.href.split("#")[0]}#r=${room}&t=nostr&n=${url}&s=${LivePollBoard.b64.enc(LivePollBoard.parse(text).set)}`,
  { room, url: relay.url, text: SET });
  const other = await (await browser.newContext()).newPage();
  await other.goto(link);
  await other.keyboard.press("ArrowRight");
  await expect(other.locator("#prompt")).toHaveText("Pick a colour");
  await expect(other.locator("#total")).toHaveText("2");
  expect(board.errors).toEqual([]);
});

test("phones take the question only from the host's key", async ({ context }) => {
  const board = await startBoard(context);
  const pinned = await phone(context, board.joinUrl, "phoneP1");
  const unpinned = await phone(context, board.joinUrl.replace(/&h=[0-9a-f]{64}/, ""), "phoneU2");
  await expect(pinned.locator("main")).toContainText("Waiting");
  await expect(unpinned.locator("main")).toContainText("Waiting");

  // Someone who knows the room publishes a state under their own key.
  await board.evaluate(({ room, url }) => new Promise((resolve) => {
    const t = LivePollTransport.create({
      kind: "nostr", room, relays: [url], subscribe: [], onMessage() {},
      onConnect: () => t.publish("state", { v: 1, t: Date.now() + 1e6, q: "evil", prompt: "FORGED", options: ["x", "y"], open: true }, { retain: true }).then(resolve),
    });
  }), { room, url: relay.url });
  await expect(unpinned.locator("#prompt")).toHaveText("FORGED");
  await pinned.waitForTimeout(800);
  await expect(pinned.locator("main")).not.toContainText("FORGED");
  await board.keyboard.press("ArrowRight");
  await expect(pinned.locator("#prompt")).toHaveText("Pick a colour");
});

test("the phone checks the host's signature itself, whatever the relay sends", async ({ context }) => {
  const careless = await startRelay({ careless: true });
  try {
    const board = await startBoard(context, "nostr", careless.url);
    const host = board.joinUrl.match(/h=([0-9a-f]{64})/)[1];
    const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
    const now = Math.floor(Date.now() / 1000) + 60;
    const state = (prompt) => ({ kind: 30078, created_at: now,
      tags: [["d", `live-poll/${room}/state`], ["y", `live-poll/${room}/state`]],
      content: JSON.stringify({ v: 1, t: Date.now() + 1e6, q: "evil", prompt, options: ["x", "y"], open: true }) });
    // Signed by someone else, and served despite the authors filter;
    const other = finalizeEvent(state("FORGED BY KEY"), generateSecretKey());
    // claiming the host's key, with a signature that does not check out.
    const fake = finalizeEvent(state("FORGED SIGNATURE"), generateSecretKey());
    fake.pubkey = host;
    careless.seed([other, fake]);
    const p = await phone(context, board.joinUrl, "phoneS1");
    await expect(p.locator("main")).toContainText("Waiting");
    await p.waitForTimeout(800);
    await expect(p.locator("main")).not.toContainText("FORGED");
    await board.keyboard.press("ArrowRight");
    await expect(p.locator("#prompt")).toHaveText("Pick a colour");
  } finally {
    await careless.close();
  }
});

test("a relay keeps one version per topic, newest last, across a reload", async ({ page }) => {
  await page.goto(BOARD + "#t=local");
  const key = await page.evaluate(() => LivePollTransport.keypair("test-key"));
  const publish = (n) => page.evaluate(({ room, url, key, n }) => new Promise((resolve) => {
    const t = LivePollTransport.create({
      kind: "nostr", room, relays: [url], nostrKey: key.secret, subscribe: [], onMessage() {},
      async onConnect() {
        for (let i = 0; i < n; i++) await t.publish("state", { v: 1, n: i }, { retain: true });
        t.close();
        resolve();
      },
    });
  }), { room, url: relay.url, key, n });
  const mine = () => relay.events().filter((e) => e.tags.some((t) => t[0] === "d" && t[1] === `live-poll/${room}/state`));

  await publish(3);                       // three versions inside one second
  expect(mine()).toHaveLength(1);
  expect(JSON.parse(mine()[0].content).n).toBe(2);
  const first = mine()[0].created_at;
  expect(first).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  expect(mine()[0].tags.find((t) => t[0] === "expiration")).toBeTruthy();

  await page.reload();                    // same key, clock kept in storage
  await publish(1);
  expect(mine()).toHaveLength(1);
  expect(JSON.parse(mine()[0].content).n).toBe(0);
  expect(mine()[0].created_at).toBeGreaterThan(first);
});

test("stored votes past a relay's cap arrive in pages", async ({ page }) => {
  const capped = await startRelay({ cap: 100 });
  try {
    const { finalizeEvent, generateSecretKey } = await import("nostr-tools/pure");
    const now = Math.floor(Date.now() / 1000);
    const events = [];
    for (let i = 0; i < 260; i++) {
      events.push(finalizeEvent({
        kind: 30078, created_at: now - i * 3,
        tags: [["d", `live-poll/${room}/v/q1/voter${i}`], ["y", `live-poll/${room}/v`], ["expiration", String(now + 3600)]],
        content: JSON.stringify({ choice: i % 2, t: (now - i * 3) * 1000 }),
      }, generateSecretKey()));
    }
    capped.seed(events);
    await page.goto(BOARD + "#t=local");
    await page.evaluate(({ room, url }) => {
      window.h = LivePollHost.create({ room, kind: "nostr", relays: [url], polls: [{ id: "q1", prompt: "x", options: ["a", "b"] }] });
    }, { room, url: capped.url });
    await expect.poll(() => page.evaluate(() => h.counts("q1"))).toEqual([130, 130]);
  } finally {
    await capped.close();
  }
});

test("a relay that drops every connection: both sides reconnect and carry on", async ({ context }) => {
  const board = await startBoard(context);
  const a = await phone(context, board.joinUrl, "phoneA1");
  await board.keyboard.press("ArrowRight");
  await expect(a.locator("#prompt")).toHaveText("Pick a colour");
  relay.dropAll();
  await expect(board.locator("#link")).toHaveText("Nostr 0/1");
  await expect(board.locator("#link")).toHaveText("Nostr 1/1", { timeout: 10000 });
  await expect(a.locator("#conn")).toHaveText("connected", { timeout: 10000 });
  await a.getByRole("button", { name: "blue" }).click();
  await expect(board.locator("#total")).toHaveText("1");
});

test("two transports at once: one vote counts once, and an older state arriving late is ignored", async ({ context }) => {
  const board = await startBoard(context, "local+nostr");
  expect(board.joinUrl).toContain("t=local+nostr");
  await expect(board.locator("#link")).toHaveText("local 1/1 · Nostr 1/1");
  const a = await phone(context, board.joinUrl, "phoneA1");
  await board.keyboard.press("ArrowRight");
  await expect(a.locator("#prompt")).toHaveText("Pick a colour");
  await a.getByRole("button", { name: "green" }).click();
  await expect(board.locator("#total")).toHaveText("1");
  await board.waitForTimeout(500);                       // the second copy has arrived by now
  await expect(board.locator("#total")).toHaveText("1");

  const q1 = await board.evaluate(() => LivePollBoard.host.current());
  await board.keyboard.press("ArrowRight");
  await expect(a.locator("#prompt")).toHaveText("Yes or no?");
  // The first question's state again, as a slow route might deliver it now.
  await board.evaluate(({ room, q1 }) => {
    const t = LivePollTransport.create({ kind: "local", room, subscribe: [], onMessage() {} });
    setTimeout(() => t.publish("state", { v: 1, t: 1, q: q1, prompt: "Pick a colour", options: ["red", "green", "blue"], open: true }, { retain: true }), 50);
  }, { room, q1 });
  await a.waitForTimeout(600);
  await expect(a.locator("#prompt")).toHaveText("Yes or no?");
  expect(board.errors).toEqual([]);
});

test("purge after a rehearsal: the relay's copies of the votes stay purged; new votes count", async ({ context }) => {
  const board = await startBoard(context);
  const a = await phone(context, board.joinUrl, "phoneA1");
  await board.keyboard.press("ArrowRight");
  await a.getByRole("button", { name: "green" }).click();
  await expect(board.locator("#total")).toHaveText("1");
  await board.evaluate(() => LivePollBoard.host.purge());
  await expect(board.locator("#total")).toHaveText("0");
  // The relay still holds the phone's vote, signed by the phone: a reload replays it.
  await board.reload();
  await expect(board.locator("#prompt")).toHaveText("Pick a colour");
  await board.waitForTimeout(800);
  await expect(board.locator("#total")).toHaveText("0");
  await a.getByRole("button", { name: "blue" }).click();
  await expect(board.locator("#total")).toHaveText("1");
});
