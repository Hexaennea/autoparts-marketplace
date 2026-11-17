// Cart (server-side for signed-in shoppers; guests get priced previews of a local cart).

import { z } from "zod";
import { utcnow } from "../db.js";
import { type Ctx, api, badRequest, notFound, pathInt } from "../http.js";
import { buildQuote, getSettings, quoteOut } from "../services/commerce.js";

const MAX_LINES = 50;

/** Integer field (accepts numeric strings like pydantic's lax mode; missing → "Field required"). */
const IntField = () =>
  z.preprocess(
    (v) => (typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v),
    z.number({ invalid_type_error: "Input should be a valid integer" }).int("Input should be a valid integer"),
  );

const Quantity = () => IntField().pipe(z.number().gte(1).lte(20));

const QuantityIn = z.object({
  quantity: Quantity(),
});

const LineIn = z.object({
  product_id: IntField().pipe(z.number().gt(0)),
  quantity: Quantity(),
});

const LinesIn = z.object({
  items: z.array(LineIn).max(MAX_LINES),
});

async function cartPayload(ctx: Ctx) {
  const user = ctx.requireUser();
  const rows = await ctx.db.all("SELECT product_id, quantity FROM cart_items WHERE user_id = ? ORDER BY added_at", [
    user.id,
  ]);
  const quote = await buildQuote(
    ctx.db,
    ctx.settings,
    rows.map((r) => [r.product_id as number, r.quantity as number]),
  );
  return quoteOut(quote, await getSettings(ctx.db, ctx.settings));
}

api.route("GET", "/api/cart", { auth: "user" }, async (ctx) => cartPayload(ctx));

api.route("POST", "/api/cart/preview", { body: LinesIn, rate: "write" }, async (ctx) => {
  const merged = new Map<number, number>();
  for (const line of ctx.body.items) {
    merged.set(line.product_id, Math.min(20, (merged.get(line.product_id) ?? 0) + line.quantity));
  }
  const quote = await buildQuote(ctx.db, ctx.settings, [...merged.entries()]);
  return quoteOut(quote, await getSettings(ctx.db, ctx.settings));
});

async function purchasable(ctx: Ctx, productId: number) {
  const row = await ctx.db.one(
    `SELECT p.id, p.stock, s.user_id AS seller_user_id FROM products p JOIN sellers s ON s.id = p.seller_id
     WHERE p.id = ? AND p.status = 'active' AND s.kyc_status = 'approved'`,
    [productId],
  );
  if (!row) throw notFound("Product");
  if (ctx.user !== null && row.seller_user_id === ctx.user.id) {
    throw badRequest("You can't buy your own listing.", "own_listing");
  }
  return row;
}

api.route("PUT", "/api/cart/items/{product_id:int}", { auth: "user", body: QuantityIn, rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  const productId = pathInt(ctx, "product_id");
  const row = await purchasable(ctx, productId);
  if (row.stock <= 0) throw badRequest("This part is out of stock.", "out_of_stock");
  const quantity = Math.min(ctx.body.quantity, row.stock);
  const lines = Number(await ctx.db.scalar("SELECT COUNT(*) FROM cart_items WHERE user_id = ?", [user.id]));
  const exists = await ctx.db.scalar("SELECT 1 FROM cart_items WHERE user_id = ? AND product_id = ?", [
    user.id,
    productId,
  ]);
  if (!exists && lines >= MAX_LINES) {
    throw badRequest(`Your cart can hold up to ${MAX_LINES} different parts.`, "limit_reached");
  }
  await ctx.db.execute(
    `INSERT INTO cart_items (user_id, product_id, quantity, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
    [user.id, productId, quantity, utcnow()],
  );
  return cartPayload(ctx);
});

api.route("DELETE", "/api/cart/items/{product_id:int}", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  await ctx.db.execute("DELETE FROM cart_items WHERE user_id = ? AND product_id = ?", [
    user.id,
    pathInt(ctx, "product_id"),
  ]);
  return cartPayload(ctx);
});

/** Fold a guest's local cart into the account cart after sign-in (quantities add, capped). */
api.route("POST", "/api/cart/merge", { auth: "user", body: LinesIn, rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  for (const line of ctx.body.items) {
    const row = await ctx.db.one(
      `SELECT p.stock, s.user_id AS seller_user_id FROM products p JOIN sellers s ON s.id = p.seller_id
       WHERE p.id = ? AND p.status = 'active' AND s.kyc_status = 'approved'`,
      [line.product_id],
    );
    if (!row || row.stock <= 0 || row.seller_user_id === user.id) continue;
    const current =
      Number(
        await ctx.db.scalar("SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?", [
          user.id,
          line.product_id,
        ]),
      ) || 0;
    const count = Number(await ctx.db.scalar("SELECT COUNT(*) FROM cart_items WHERE user_id = ?", [user.id]));
    if (!current && count >= MAX_LINES) break;
    const quantity = Math.min(20, row.stock, current + line.quantity);
    await ctx.db.execute(
      `INSERT INTO cart_items (user_id, product_id, quantity, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
      [user.id, line.product_id, quantity, utcnow()],
    );
  }
  return cartPayload(ctx);
});
