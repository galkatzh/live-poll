// The board and the phone page end to end, as tabs of one browser on the
// local transport. Every test uses its own room.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");

const ROOT = "file://" + path.join(__dirname, "..");
const BOARD = ROOT + "/board.html";
const PHONE = ROOT + "/index.html";

let room;
test.beforeEach(() => {
  room = "kit" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
});

const SET = "title: Kit test\n\nPick a colour\n- red\n* green\n- blue\n\nYes or no?\n- yes\n- no";

async function startBoard(context, text = SET) {
  const board = await context.newPage();
  const errors = [];
  board.on("pageerror", (e) => errors.push(e.message));
  await board.goto(`${BOARD}#t=local`);
  await board.fill("#room", room);
  await board.fill("#poll-title", "");
  await board.fill("#poll-text", text);
  await expect(board.locator("#parse-msg")).toHaveText(/2 questions, 1 with a right answer/);
  await board.click("#start");
  await expect(board.locator("#lobby")).toBeVisible();
  board.errors = errors;
  return board;
}

async function phone(context, voter, extra = "") {
  const p = await context.newPage();
  await p.setViewportSize({ width: 390, height: 800 });
  await p.goto(`${PHONE}#r=${room}&t=local&voter=${voter}${extra}`);
  return p;
}

test("the format: questions, options, the right answer, and errors", async ({ page }) => {
  await page.goto(BOARD);
  const r = await page.evaluate((t) => LivePollBoard.parse(t), SET);
  expect(r.errors).toEqual([]);
  expect(r.set.title).toBe("Kit test");
  expect(r.set.questions).toEqual([
    { prompt: "Pick a colour", options: ["red", "green", "blue"], answer: 1 },
    { prompt: "Yes or no?", options: ["yes", "no"], answer: null },
  ]);
  const bad = await page.evaluate(() => LivePollBoard.parse("Only one\n- a\n\n- orphan\n- b\n\nTwo right\n* a\n* b"));
  expect(bad.errors).toEqual(["Question 1: needs at least two options", "Question 2: no question text", "Question 3: more than one right answer"]);
  // A round trip through the text form and the link encoding changes nothing.
  const back = await page.evaluate((t) => {
    const s = LivePollBoard.parse(t).set;
    return LivePollBoard.parse(LivePollBoard.toText(LivePollBoard.b64.dec(LivePollBoard.b64.enc(s)))).set;
  }, SET);
  expect(back).toEqual(r.set);
  // Ids carry a hash of the questions, so an edited set starts fresh.
  const ids = await page.evaluate((t) => [LivePollBoard.toPolls(LivePollBoard.parse(t).set)[0].id, LivePollBoard.toPolls(LivePollBoard.parse(t + "\n- maybe").set)[0].id], SET);
  expect(ids[0]).not.toBe(ids[1]);
});

test("host a poll from the board: lobby, vote, close, reveal, score, export", async ({ context }) => {
  const board = await startBoard(context);
  const a = await phone(context, "phoneA1");
  const b = await phone(context, "phoneB2");
  await expect(a.locator("main")).toContainText("Waiting for the next question");
  await expect(a.locator("#title")).toHaveText("Kit test");
  await expect(board.locator("#lobby-joined")).toHaveText("2");

  await board.keyboard.press("ArrowRight");
  await expect(board.locator("#prompt")).toHaveText("Pick a colour");
  await expect(a.locator("#prompt")).toHaveText("Pick a colour");
  await expect(a.locator(".kicker")).toHaveText("Question 1 of 2");

  await a.getByRole("button", { name: "green" }).click();
  await b.getByRole("button", { name: "red" }).click();
  await b.getByRole("button", { name: "blue" }).click();          // changed her mind
  await expect(board.locator("#total")).toHaveText("2");
  await expect(board.locator(".bar .n").nth(2)).toContainText("1");

  await board.keyboard.press("o");
  await expect(a.locator("button.opt").first()).toBeDisabled();
  await expect(board.locator("#chip")).toHaveText("voting closed");

  await board.keyboard.press("r");
  await expect(board.locator(".bar.answer .lab span").first()).toHaveText("green");
  await expect(a.locator("#status")).toHaveText("✓ You got it.");
  await expect(b.locator("#status")).toHaveText("✗ Not this time.");
  await expect(a.locator("#score")).toHaveText("You got 1 of 1 right");

  // Two options: the pair layout. No right answer: no score change.
  await board.keyboard.press("ArrowRight");
  await expect(a.locator("#options.pair button")).toHaveCount(2);

  // The board remembers its place and its votes across a reload.
  await board.reload();
  await expect(board.locator("#prompt")).toHaveText("Yes or no?");
  await board.keyboard.press("ArrowLeft");
  await expect(board.locator("#total")).toHaveText("2");

  const download = board.waitForEvent("download");
  await board.keyboard.press("e");
  const out = JSON.parse(fs.readFileSync(await (await download).path(), "utf8"));
  const q1 = out.polls[0].id;
  expect(out.votes[q1].phoneA1.choice).toBe(1);
  expect(out.votes[q1].phoneB2.choice).toBe(2);
  expect(board.errors).toEqual([]);
});

test("a board link carries the questions", async ({ context }) => {
  const setup = await context.newPage();
  await setup.goto(`${BOARD}#t=local`);
  await setup.fill("#room", room);
  await setup.fill("#poll-text", SET);
  const link = await setup.evaluate(() => {
    // the same link "Copy board link" puts on the clipboard
    const s = LivePollBoard.parse(document.getElementById("poll-text").value).set;
    s.title = document.getElementById("poll-title").value || s.title;
    return location.href.split("#")[0] + "#" + new URLSearchParams({ r: document.getElementById("room").value, t: "local", s: LivePollBoard.b64.enc(s) });
  });
  const other = await (await context.browser().newContext()).newPage();   // fresh storage
  await other.goto(link);
  await expect(other.locator("#lobby")).toBeVisible();
  await other.keyboard.press("ArrowRight");
  await expect(other.locator("#prompt")).toHaveText("Pick a colour");
});

test("watch mode mirrors a room another host runs", async ({ context }) => {
  const board = await startBoard(context);
  const watcher = await context.newPage();
  await watcher.goto(`${BOARD}#r=${room}&t=local&watch=1`);
  const a = await phone(context, "phoneA1");
  await board.keyboard.press("ArrowRight");
  await expect(watcher.locator("#prompt")).toHaveText("Pick a colour");
  await a.getByRole("button", { name: "blue" }).click();
  await expect(watcher.locator("#total")).toHaveText("1");
  // Host keys do nothing on a watcher.
  await watcher.keyboard.press("ArrowRight");
  await watcher.keyboard.press("r");
  await expect(board.locator("#prompt")).toHaveText("Pick a colour");
  await expect(a.locator("button.opt").first()).toBeEnabled();
  await board.keyboard.press("r");
  await expect(watcher.locator(".bar.answer .lab span").first()).toHaveText("green");
});

test("the phone shows host text as text, and checks its link", async ({ context }) => {
  const host = await context.newPage();
  await host.goto(`${BOARD}#t=local`);
  const p = await phone(context, "phoneA1");
  await host.evaluate((room) => {
    const h = LivePollHost.create({ room, kind: "local", polls: [{ id: "x1", prompt: "<img src=x onerror=alert(1)>Hi", options: ["<b>a</b>", "b"] }], meta: { title: "<i>T</i>" } });
    setTimeout(() => h.show("x1"), 100);
  }, room);
  await expect(p.locator("#prompt")).toHaveText("<img src=x onerror=alert(1)>Hi");
  await expect(p.locator("#prompt img")).toHaveCount(0);
  await expect(p.locator("#title")).toHaveText("<i>T</i>");
  await expect(p.getByRole("button", { name: "<b>a</b>" })).toBeVisible();

  const bad = await context.newPage();
  await bad.goto(`${PHONE}#r=no`);
  await expect(bad.locator("main")).toContainText("missing its room code");
});

test("broker lists from a link: wss:// only, else the defaults", async ({ page }) => {
  await page.goto(PHONE + "#r=abcdefgh");
  const r = await page.evaluate(() => {
    const T = LivePollTransport;
    return {
      mixed: T.brokerList(["http://evil.example/mqtt", "wss://ok.example:8884/mqtt", "javascript:alert(1)", "ws://localhost:9001"]),
      none: T.brokerList(["ftp://x"]),
      undef: T.brokerList(undefined),
      defaults: T.DEFAULT_BROKERS,
    };
  });
  expect(r.mixed).toEqual(["wss://ok.example:8884/mqtt", "ws://localhost:9001"]);
  expect(r.none).toEqual(r.defaults);
  expect(r.undef).toEqual(r.defaults);
});

test("no callback before create() returns, on either transport", async ({ page }) => {
  // The board's render reads the host that create() returns; the MQTT
  // transport used to report its status before that, and the board crashed.
  await page.goto(BOARD + "#t=local");
  const early = await page.evaluate(async (room) => {
    const calls = [];
    for (const kind of ["mqtt", "local"]) {
      let returned = false;
      const h = LivePollHost.create({ room, kind, brokers: ["ws://localhost:9"], polls: [], onChange: (w) => calls.push([kind, w, returned]) });
      returned = true;
      await new Promise((r) => setTimeout(r, 50));
      h.close();
    }
    return calls.filter((c) => !c[2]);
  }, room);
  expect(early).toEqual([]);
});

test.describe("live", () => {
  test.skip(!process.env.LIVE, "set LIVE=1 to run against the public brokers");
  test("board and phone over the public brokers", async ({ context }) => {
    test.setTimeout(90000);
    const board = await context.newPage();
    await board.goto(BOARD);
    await board.fill("#room", room);
    await board.fill("#poll-text", SET);
    await board.click("#start");
    await expect(board.locator("#link")).toHaveText(/2\/2 brokers/, { timeout: 20000 });
    await board.keyboard.press("ArrowRight");
    const p = await context.newPage();
    await p.goto(`${PHONE}#r=${room}&voter=livephone1`);
    await expect(p.locator("#prompt")).toHaveText("Pick a colour", { timeout: 20000 });
    await p.getByRole("button", { name: "green" }).click();
    await expect(board.locator("#total")).toHaveText("1", { timeout: 20000 });
    await board.evaluate(() => LivePollBoard.host.purge());
    await board.waitForTimeout(1000);
  });
});
