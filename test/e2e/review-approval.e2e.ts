import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, webkit, type Browser, type BrowserType, type Page } from "playwright-core";
import { fixture, entered, setup } from "../paper-fixture.ts";

// Real browsers, not fetch(): fetch() lets a test hand-set the Origin header, which is how the
// Referrer-Policy bug (browsers sending `Origin: null`, so humans could never approve) went unseen.
// A missing browser FAILS with the install command; this suite never skips.
const installHint = "npx playwright-core install --only-shell chromium webkit";

async function launch(type: BrowserType, t: TestContext): Promise<Browser> {
  let browser: Browser;
  try { browser = await type.launch({ headless: true }); }
  catch (error) { throw new Error(`${type.name()} is unavailable for playwright-core. Run: ${installHint}\n${String(error).split("\n")[0]}`); }
  t.after(() => browser.close());
  return browser;
}
async function submit(page: Page, url: string, decision: "approve" | "reject") {
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url() === url && r.request().method() === "POST"),
    page.click(`button[value="${decision}"]`),
  ]);
  await page.waitForLoadState();
  return { status: response.status(), body: (await page.textContent("body"))?.trim() };
}

for (const type of [chromium, webkit]) {
  test(`${type.name()}: human reject, cross-site submit with the real token refused, then human approve`, async t => {
    const f = fixture(t); await entered(f);
    const context = await (await launch(type, t)).newContext(), page = await context.newPage();
    const quantity = () => f.service.paper.status(setup.runId).view.positions[0]?.quantity ?? 0;

    // Reject first: approving closes the position, after which nothing else can be proposed.
    const rejected = await f.service.reviews.propose(setup.runId, "DEMOA", "close");
    await page.goto(rejected.reviewUrl);
    assert.deepEqual(await submit(page, rejected.reviewUrl, "reject"), { status: 200, body: "Rejected. No position changed." });
    assert.equal(f.service.reviews.status(rejected.reviewId).status, "rejected");
    assert.equal(quantity(), 4);

    // Cross-site: loading the real page gives this browser the review cookie; the attack page on another
    // loopback port reuses the REAL form token. Other ports on 127.0.0.1 are the same site, so the
    // SameSite=Strict cookie is sent too — the exact-origin check is the only thing that can refuse it.
    const target = await f.service.reviews.propose(setup.runId, "DEMOA", "close");
    await page.goto(target.reviewUrl);
    const csrf = await page.inputValue('input[name="csrf"]');
    const attacker = createServer((_, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(
      `<form id="f" method="post" action="${target.reviewUrl}"><input name="csrf" value="${csrf}"><input name="decision" value="approve"></form>` +
      `<script>document.getElementById("f").submit()</script>`));
    await new Promise<void>(ok => attacker.listen(0, "127.0.0.1", ok)); t.after(() => attacker.close());
    const attackerOrigin = `http://127.0.0.1:${(attacker.address() as AddressInfo).port}`;
    const attackPage = await context.newPage();
    const [attack] = await Promise.all([
      attackPage.waitForResponse(r => r.url() === target.reviewUrl && r.request().method() === "POST"),
      attackPage.goto(attackerOrigin + "/"),
    ]);
    const sent = await attack.request().allHeaders();
    assert.equal(sent.origin, attackerOrigin, "browser must report the attacker's origin");
    assert.match(sent.cookie ?? "", /astra_review=/, "cookie must be sent, so the refusal is the origin check alone");
    assert.equal(attack.status(), 403);
    assert.equal(f.service.reviews.status(target.reviewId).status, "pending");
    assert.equal(quantity(), 4);

    // The human approves the same review from the real page: the origin was the only difference.
    assert.deepEqual(await submit(page, target.reviewUrl, "approve"), { status: 200, body: "Paper request executed. Return to your agent for status." });
    assert.equal(f.service.reviews.status(target.reviewId).status, "executed");
    assert.equal(f.service.paper.status(setup.runId).view.positions.length, 0);

    // A revisit or double submit says what happened instead of "expired".
    const again = await page.goto(target.reviewUrl);
    assert.equal(again?.status(), 410);
    assert.equal((await page.textContent("body"))?.trim(), "Review already executed.");
  });
}
