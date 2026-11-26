// GST tax invoices: numbering, access control, PDF download and the amounts on the invoice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { indianWords, loadInvoice, rupeesInWords, splitTax } from "../src/services/invoice.js";
import { ADMIN, BUYER, BUYER_2, type Client, SELLER_A, SELLER_B, type TestEnv, checkout, productFor, setup } from "./helpers.js";

async function withEnv(fn: (env: TestEnv) => Promise<void>) {
  const env = await setup();
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

/** GET that keeps a binary body (supertest only buffers text/JSON by default). */
function download(client: Client, url: string) {
  return client
    .get(url)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
}

/** Buyer orders one unit from SELLER_A; returns the order and its fulfilment id. */
async function orderFromSellerA(env: TestEnv, buyer: Client) {
  const product = await productFor(env.db, SELLER_A[0]);
  await buyer.put(`/api/cart/items/${product.id}`, { quantity: 1 });
  const res = await checkout(buyer, "cod", `inv-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  assert.equal(res.status, 201, res.text);
  return { order: res.body.data, fid: res.body.data.fulfilments[0].id as number };
}

async function ship(seller: Client, fid: number) {
  assert.equal((await seller.post(`/api/seller/orders/${fid}/pack`, {})).status, 200);
  const res = await seller.post(`/api/seller/orders/${fid}/ship`, { carrier: "Delhivery", tracking_number: `DL${fid}0000001` });
  assert.equal(res.status, 200, res.text);
  return res.body.data;
}

test("amounts in words use Indian grouping", () => {
  assert.equal(indianWords(123456), "One Lakh Twenty Three Thousand Four Hundred Fifty Six");
  assert.equal(indianWords(10_000_000), "One Crore");
  assert.equal(rupeesInWords(100050), "Rupees One Thousand and Fifty Paise Only");
  assert.equal(rupeesInWords(99900), "Rupees Nine Hundred Ninety Nine Only");
  assert.deepEqual(splitTax(101), [51, 50]);
});

test("shipping issues a consecutive invoice number and the PDF downloads", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const seller = await env.client(SELLER_A);
    const first = await orderFromSellerA(env, buyer);

    // No invoice before the goods ship.
    assert.equal(first.order.fulfilments[0].invoice_number, null);
    assert.equal((await buyer.get(`/api/orders/${first.order.id}/fulfilments/${first.fid}/invoice.pdf`)).status, 404);

    const shipped = await ship(seller, first.fid);
    assert.match(shipped.invoice_number, /^S\d+\/\d{4}\/\d{5}$/);
    assert.ok(shipped.invoice_number.length <= 16);

    const second = await orderFromSellerA(env, buyer);
    const shipped2 = await ship(seller, second.fid);
    const serial = (n: string) => Number(n.split("/")[2]);
    assert.equal(serial(shipped2.invoice_number), serial(shipped.invoice_number) + 1);

    // Shipping again (same shipped_at column touched) never renumbers.
    await env.db.execute("UPDATE fulfilments SET shipped_at = shipped_at WHERE id = ?", [first.fid]);
    assert.equal(await env.db.scalar("SELECT invoice_number FROM fulfilments WHERE id = ?", [first.fid]), shipped.invoice_number);

    const pdf = await download(buyer, `/api/orders/${first.order.id}/fulfilments/${first.fid}/invoice.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.match(pdf.headers["content-disposition"], /attachment; filename="Invoice-S\d+-\d{4}-\d{5}\.pdf"/);
    assert.equal((pdf.body as Buffer).subarray(0, 5).toString(), "%PDF-");

    const viaSeller = await download(seller, `/api/seller/orders/${first.fid}/invoice.pdf`);
    assert.equal(viaSeller.status, 200);
    const admin = await env.client(ADMIN);
    assert.equal((await download(admin, `/api/admin/fulfilments/${first.fid}/invoice.pdf`)).status, 200);
  }));

test("only the buyer, the selling seller and admins can get an invoice", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const { order, fid } = await orderFromSellerA(env, buyer);
    await ship(await env.client(SELLER_A), fid);

    const otherBuyer = await env.client(BUYER_2);
    assert.equal((await otherBuyer.get(`/api/orders/${order.id}/fulfilments/${fid}/invoice.pdf`)).status, 404);
    const otherSeller = await env.client(SELLER_B);
    assert.equal((await otherSeller.get(`/api/seller/orders/${fid}/invoice.pdf`)).status, 404);
    assert.equal((await buyer.get(`/api/admin/fulfilments/${fid}/invoice.pdf`)).status, 403);
    const anonymous = await env.client();
    assert.equal((await anonymous.get(`/api/orders/${order.id}/fulfilments/${fid}/invoice.pdf`)).status, 401);
  }));

test("invoice amounts add up and keep the seller details from shipping time", () =>
  withEnv(async (env) => {
    const buyer = await env.client(BUYER);
    const { fid } = await orderFromSellerA(env, buyer);
    await ship(await env.client(SELLER_A), fid);

    const f = (await env.db.one("SELECT * FROM fulfilments WHERE id = ?", [fid]))!;
    const seller = (await env.db.one("SELECT * FROM sellers WHERE id = ?", [f.seller_id]))!;
    const order = (await env.db.one("SELECT * FROM orders WHERE id = ?", [f.order_id]))!;
    await env.db.execute("UPDATE sellers SET business_name = 'Renamed Later Pvt Ltd' WHERE id = ?", [seller.id]);

    const inv = (await loadInvoice(env.db, f, "PartPilot"))!;
    assert.equal(inv.seller.business_name, seller.business_name);
    assert.equal(inv.seller.gstin, seller.gstin);
    assert.equal(inv.totalPaise, f.items_paise + f.shipping_paise);
    assert.equal(inv.taxablePaise + inv.taxPaise, inv.totalPaise);
    for (const l of inv.lines) assert.equal(l.taxablePaise + l.taxPaise, l.totalPaise);
    assert.equal(inv.intraState, String(seller.state).toLowerCase() === String(order.ship_state).toLowerCase());
    assert.match(inv.date, /^\d{2}-\d{2}-\d{4}$/);
  }));

test("shipments that shipped before invoices existed have numbers too", () =>
  withEnv(async (env) => {
    const missing = await env.db.scalar("SELECT COUNT(*) FROM fulfilments WHERE shipped_at IS NOT NULL AND invoice_number IS NULL");
    assert.equal(missing, 0);
    const unshipped = await env.db.scalar("SELECT COUNT(*) FROM fulfilments WHERE shipped_at IS NULL AND invoice_number IS NOT NULL");
    assert.equal(unshipped, 0);
  }));
