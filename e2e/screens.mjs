// Captures key screens for visual review: node e2e/screens.mjs [baseUrl] [outDir]
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:8000";
const out = process.argv[3] ?? "screens";
const accounts = {
  buyer: ["priya@partpilot.test", "Demo@12345"],
  seller: ["lakshmi.autospares@partpilot.test", "Demo@12345"],
  admin: ["admin@partpilot.test", "Admin@12345"],
};

async function login(context, role) {
  if (!role) return;
  const s = await (await context.request.get(`${base}/api/auth/session`)).json();
  const [email, password] = accounts[role];
  const r = await context.request.post(`${base}/api/auth/login`, { data: { email, password }, headers: { "X-CSRF-Token": s.data.csrf } });
  if (!r.ok()) throw new Error(`login failed ${role}: ${await r.text()}`);
}

const screens = (process.env.SCREENS ?? "").split(",").filter(Boolean);
const plan = JSON.parse(process.env.PLAN ?? "[]");
const browser = await chromium.launch();
const errors = [];
for (const item of plan) {
  if (screens.length && !screens.includes(item.name)) continue;
  for (const vp of item.viewports ?? ["desktop"]) {
    const size = vp === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
    await login(context, item.role);
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.push(`${item.name}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push(`${item.name}: ${e.message}`));
    if (item.car) {
      await page.goto(`${base}/api/health`);
      await page.evaluate((car) => localStorage.setItem("pp.vehicle", JSON.stringify(car)), item.car);
    }
    await page.goto(base + item.path, { waitUntil: "networkidle" });
    if (item.click) { await page.click(item.click); await page.waitForTimeout(400); }
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${item.name}-${vp}.png`, fullPage: item.full !== false });
    await context.close();
  }
}
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
