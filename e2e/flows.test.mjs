// End-to-end user journeys in a real browser against a freshly seeded server.
// Run with ./e2e/run.sh (seeds an isolated database, starts the app, runs this file).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8100";
let browser;
const consoleErrors = [];

before(async () => { browser = await chromium.launch(); });
after(async () => {
  await browser?.close();
  assert.deepEqual(consoleErrors, [], `browser console errors:\n${consoleErrors.join("\n")}`);
});

async function newPage(viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("401")) consoleErrors.push(m.text()); });
  return page;
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function pickCar(page) {
  const form = page.getByRole("form", { name: "Choose your car" }).first();
  await form.locator("select").nth(0).selectOption({ label: "Maruti Suzuki" });
  await form.locator("select").nth(1).selectOption({ label: "Swift" });
  await form.locator("select").nth(2).selectOption("2019");
  await form.locator("select").nth(3).selectOption({ index: 1 });
  await form.getByRole("button").click();
}

describe("buyer", () => {
  test("pick a car, see fitment, buy with cash on delivery", async () => {
    const page = await newPage();
    await page.goto(BASE);
    await assert.doesNotReject(page.getByRole("heading", { level: 1 }).waitFor());
    await pickCar(page);
    await page.waitForURL(/\/search\?vehicle=/);
    await page.getByText("Only parts that fit").waitFor();
    const stamps = await page.locator(".pcard .fit--yes, .pcard .fit--universal").count();
    const cards = await page.locator(".pcard").count();
    assert.ok(cards > 0 && stamps === cards, `every result should carry a fit stamp (${stamps}/${cards})`);

    await page.locator(".pcard__title").first().click();
    await page.locator(".pdp__fit .fit--yes, .pdp__fit .fit--universal").waitFor();
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.getByText(/Added 1 ×/).waitFor();
    await page.goto(`${BASE}/cart`);
    await page.getByRole("link", { name: "Sign in to checkout" }).click();
    await page.getByLabel("Email").fill("priya@partpilot.test");
    await page.getByLabel("Password", { exact: true }).fill("Demo@12345");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/checkout/);
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForURL(/\/orders\/\d+\?placed=1/);
    await page.getByText("Thanks — your order is in.").waitFor();
    assert.ok(await page.getByText("Pay on delivery").first().isVisible());
    await page.goto(`${BASE}/cart`);
    await page.getByText("Your cart is empty").waitFor();
  });

  test("online payment: failure, retry, success", async () => {
    const page = await newPage();
    await signIn(page, "arjun@partpilot.test", "Demo@12345");
    await page.goto(`${BASE}/search?q=oil%20filter`);
    await page.locator(".pcard__title").first().waitFor();
    await page.locator(".pcard button[aria-label^='Add']").first().click();
    await page.getByText(/Added to cart/).waitFor();
    await page.goto(`${BASE}/checkout`);
    await page.getByText("Pay online").click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.waitForURL(/\/pay$/);
    await page.getByRole("button", { name: "Simulate failure" }).click();
    await page.getByText("Payment didn't go through").waitFor();
    await page.getByRole("button", { name: "Try payment again" }).click();
    await page.getByRole("button", { name: "Simulate successful payment" }).click();
    await page.waitForURL(/placed=1/);
    await page.getByText("Paid online").waitFor();
  });

  test("guest cart is kept after signing in", async () => {
    const page = await newPage();
    await page.goto(`${BASE}/search?q=spark%20plug`);
    await page.locator(".pcard__title").first().waitFor();
    await page.locator(".pcard button[aria-label^='Add']").first().click();
    await page.getByText(/Added to cart/).waitFor();
    await signIn(page, "neha@partpilot.test", "Demo@12345");
    await page.goto(`${BASE}/cart`);
    await page.getByRole("heading", { name: "Cart", exact: true }).waitFor();
    assert.ok((await page.locator(".cart-line").count()) >= 1);
  });

  test("part-number search finds the genuine part", async () => {
    const page = await newPage();
    await page.goto(BASE);
    await page.getByRole("combobox", { name: "Search parts" }).fill("16510-M68K00");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/search\?q=/);
    await page.locator(".pcard__title").first().waitFor();
    assert.ok(await page.locator(".pcard__pn", { hasText: "16510M68K00" }).first().isVisible());
  });

  test("mobile: filters open in a drawer", async () => {
    const page = await newPage({ width: 390, height: 844 });
    await page.goto(`${BASE}/search?category=filters`);
    await page.getByRole("button", { name: "Filters" }).click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.waitFor();
    await dialog.getByText("In stock only").click();
    await page.waitForURL(/in_stock=1/);
  });
});

describe("seller", () => {
  test("update stock inline, pack and ship an order", async () => {
    const page = await newPage();
    await signIn(page, "lakshmi.autospares@partpilot.test", "Demo@12345");
    await page.waitForURL(/\/seller$/);
    await page.getByRole("link", { name: "Listings" }).first().click();
    const stock = page.getByLabel(/^Stock for /).first();
    await stock.fill("33");
    await page.getByRole("button", { name: "Save price and stock" }).first().click();
    await page.getByText("Price and stock updated").waitFor();

    await page.goto(`${BASE}/seller/orders`);
    await page.getByRole("link", { name: /^PP\d{2}-/ }).first().click();
    await page.getByRole("heading", { name: "Progress" }).waitFor();
    const pack = page.getByRole("button", { name: "Mark packed" });
    if (await pack.isVisible()) {
      await pack.click();
      await page.getByText("Marked as packed.").waitFor();
    }
    await page.getByRole("button", { name: "Ship order" }).click();
    const dialog = page.getByRole("dialog", { name: "Ship this order" });
    await dialog.getByLabel("Tracking / AWB number").fill("DL2026E2E001");
    await dialog.getByRole("button", { name: "Confirm shipment" }).click();
    await page.getByText("Shipped — the buyer can track it now.").waitFor();
    assert.ok(await page.getByText("DL2026E2E001").first().isVisible());
  });

  test("buyers cannot open the seller portal", async () => {
    const page = await newPage();
    await signIn(page, "rahul@partpilot.test", "Demo@12345");
    await page.goto(`${BASE}/seller`);
    await page.waitForURL(/\/sell$/);
  });
});

describe("admin", () => {
  test("approve a pending listing and find it in search", async () => {
    const page = await newPage();
    await signIn(page, "admin@partpilot.test", "Admin@12345");
    await page.waitForURL(/\/admin$/);
    await page.getByRole("link", { name: /Listing review/ }).click();
    await page.locator("table .table-title").first().click();
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText("Approved — the listing is live.").waitFor();
    const pn = (await page.locator("dd.pn.strong").first().textContent()).trim();
    await page.goto(`${BASE}/search?q=${encodeURIComponent(pn)}`);
    await page.locator(".pcard__title").first().waitFor();
  });

  test("audit log records the approval", async () => {
    const page = await newPage();
    await signIn(page, "admin@partpilot.test", "Admin@12345");
    await page.goto(`${BASE}/admin/audit`);
    await page.getByText("listing.approve").first().waitFor();
  });
});
