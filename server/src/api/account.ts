// Signed-in account: profile, addresses, garage (saved cars), wishlist.

import { z } from "zod";
import { type Row, utcnow } from "../db.js";
import { ApiError, type Ctx, api, badRequest, notFound, pathInt } from "../http.js";
import { PRODUCT_CARD_SELECT, cardOut, getVariant, vehicleLabel } from "../services/catalog.js";
import { Phone, Pincode, QueryBool, State, Text, optional } from "../util.js";
import { userPayload } from "./auth.js";

const MAX_ADDRESSES = 10;
const MAX_GARAGE = 8;

/** Integer field (accepts numeric strings like pydantic's lax mode; missing → "Field required"). */
const IntField = () =>
  z.preprocess(
    (v) => (typeof v === "string" && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v),
    z.number({ invalid_type_error: "Input should be a valid integer" }).int("Input should be a valid integer"),
  );

const ProfileIn = z.object({
  full_name: Text(2, 80),
  phone: optional(Phone),
});

const AddressIn = z.object({
  full_name: Text(2, 80),
  phone: Phone,
  line1: Text(3, 120),
  line2: optional(Text(0, 120)),
  landmark: optional(Text(0, 80)),
  city: Text(2, 60),
  state: State,
  pincode: Pincode,
  is_default: QueryBool.default(false),
});

const GarageIn = z.object({
  variant_id: IntField().pipe(z.number().gt(0)),
  year: IntField().pipe(z.number().gte(1950).lte(2100)),
  nickname: optional(Text(0, 40)),
});

api.route("PATCH", "/api/me", { auth: "user", body: ProfileIn }, async (ctx) => {
  const user = ctx.requireUser();
  const body = ctx.body;
  await ctx.db.execute("UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?", [
    body.full_name,
    body.phone,
    utcnow(),
    user.id,
  ]);
  return userPayload(ctx.db, user.id);
});

// ---- addresses ----------------------------------------------------------------------------------

const ADDRESS_COLUMNS = "id, full_name, phone, line1, line2, landmark, city, state, pincode, is_default";

function addressOut(row: Row) {
  return { ...row, is_default: Boolean(row.is_default) };
}

/**
 * Serialise address writes per user (SQLite's single writer did this implicitly) so two concurrent
 * requests can never leave a user with two default addresses.
 */
async function lockUserAddresses(ctx: Ctx, userId: number): Promise<void> {
  await ctx.db.query("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
}

api.route("GET", "/api/me/addresses", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  const rows = await ctx.db.all(
    `SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC`,
    [user.id],
  );
  return rows.map(addressOut);
});

async function saveAddress(ctx: Ctx<z.output<typeof AddressIn>>, addressId: number | null) {
  const user = ctx.requireUser();
  const body = ctx.body;
  await lockUserAddresses(ctx, user.id);
  const count = Number(await ctx.db.scalar("SELECT COUNT(*) FROM addresses WHERE user_id = ?", [user.id]));
  const makeDefault = body.is_default || count === 0;
  if (addressId === null && count >= MAX_ADDRESSES) {
    throw badRequest(`You can save up to ${MAX_ADDRESSES} addresses.`, "limit_reached");
  }
  if (makeDefault) {
    await ctx.db.execute("UPDATE addresses SET is_default = false WHERE user_id = ?", [user.id]);
  }
  const values = [
    body.full_name,
    body.phone,
    body.line1,
    body.line2 || null,
    body.landmark || null,
    body.city,
    body.state,
    body.pincode,
    makeDefault,
  ];
  if (addressId === null) {
    addressId = await ctx.db.insert(
      `INSERT INTO addresses (full_name, phone, line1, line2, landmark, city, state, pincode, is_default,
           user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, user.id, utcnow()],
    );
    ctx.status = 201;
  } else {
    const updated = await ctx.db.execute(
      `UPDATE addresses SET full_name = ?, phone = ?, line1 = ?, line2 = ?, landmark = ?, city = ?, state = ?,
           pincode = ?, is_default = (is_default OR ?::boolean) WHERE id = ? AND user_id = ?`,
      [...values, addressId, user.id],
    );
    if (!updated) throw notFound("Address");
  }
  const row = await ctx.db.one(`SELECT ${ADDRESS_COLUMNS} FROM addresses WHERE id = ? AND user_id = ?`, [
    addressId,
    user.id,
  ]);
  if (!row) throw new Error("address missing after save");
  return addressOut(row);
}

api.route("POST", "/api/me/addresses", { auth: "user", body: AddressIn, rate: "write" }, async (ctx) =>
  saveAddress(ctx, null),
);

api.route("PUT", "/api/me/addresses/{address_id:int}", { auth: "user", body: AddressIn, rate: "write" }, async (ctx) =>
  saveAddress(ctx, pathInt(ctx, "address_id")),
);

api.route("DELETE", "/api/me/addresses/{address_id:int}", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  const addressId = pathInt(ctx, "address_id");
  await lockUserAddresses(ctx, user.id);
  const row = await ctx.db.one("SELECT is_default FROM addresses WHERE id = ? AND user_id = ?", [addressId, user.id]);
  if (!row) throw notFound("Address");
  await ctx.db.execute("DELETE FROM addresses WHERE id = ? AND user_id = ?", [addressId, user.id]);
  if (row.is_default) {
    await ctx.db.execute(
      `UPDATE addresses SET is_default = true
       WHERE id = (SELECT id FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1)`,
      [user.id],
    );
  }
  return { ok: true };
});

// ---- garage ---------------------------------------------------------------------------------------

async function garageList(ctx: Ctx) {
  const user = ctx.requireUser();
  const rows = await ctx.db.all(
    "SELECT id, variant_id, year, nickname FROM garage_vehicles WHERE user_id = ? ORDER BY id DESC",
    [user.id],
  );
  const out = [];
  for (const r of rows) {
    const variant = await getVariant(ctx.db, r.variant_id);
    if (variant) {
      out.push({
        id: r.id,
        year: r.year,
        nickname: r.nickname,
        variant,
        label: vehicleLabel(variant, r.year),
      });
    }
  }
  return out;
}

api.route("GET", "/api/me/garage", { auth: "user" }, async (ctx) => garageList(ctx));

api.route("POST", "/api/me/garage", { auth: "user", body: GarageIn, rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  const body = ctx.body;
  const variant = await getVariant(ctx.db, body.variant_id);
  if (!variant || !variant.is_active) throw notFound("Vehicle");
  const upper = variant.year_to || 2100;
  if (!(variant.year_from <= body.year && body.year <= upper)) {
    throw new ApiError(422, "validation_error", "That year isn't available for this variant.", {
      fields: { year: `Choose a year between ${variant.years}.` },
    });
  }
  const existing = Number(await ctx.db.scalar("SELECT COUNT(*) FROM garage_vehicles WHERE user_id = ?", [user.id]));
  if (
    existing >= MAX_GARAGE &&
    !(await ctx.db.scalar("SELECT 1 FROM garage_vehicles WHERE user_id = ? AND variant_id = ? AND year = ?", [
      user.id,
      body.variant_id,
      body.year,
    ]))
  ) {
    throw badRequest(`Your garage holds up to ${MAX_GARAGE} cars. Remove one first.`, "limit_reached");
  }
  await ctx.db.execute(
    `INSERT INTO garage_vehicles (user_id, variant_id, year, nickname, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, variant_id, year) DO UPDATE SET nickname = excluded.nickname`,
    [user.id, body.variant_id, body.year, body.nickname || null, utcnow()],
  );
  return garageList(ctx);
});

api.route("DELETE", "/api/me/garage/{garage_id:int}", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  const deleted = await ctx.db.execute("DELETE FROM garage_vehicles WHERE id = ? AND user_id = ?", [
    pathInt(ctx, "garage_id"),
    user.id,
  ]);
  if (!deleted) throw notFound("Vehicle");
  return garageList(ctx);
});

// ---- wishlist -------------------------------------------------------------------------------------

api.route("GET", "/api/me/wishlist", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  const rows = await ctx.db.all(
    `${PRODUCT_CARD_SELECT} JOIN wishlist_items w ON w.product_id = p.id
     WHERE w.user_id = ? AND p.status = 'active' ORDER BY w.added_at DESC`,
    [user.id],
  );
  return rows.map((r) => cardOut(r));
});

api.route("PUT", "/api/me/wishlist/{product_id:int}", { auth: "user", rate: "write" }, async (ctx) => {
  const user = ctx.requireUser();
  const productId = pathInt(ctx, "product_id");
  if (!(await ctx.db.scalar("SELECT 1 FROM products WHERE id = ? AND status = 'active'", [productId]))) {
    throw notFound("Product");
  }
  const count = Number(await ctx.db.scalar("SELECT COUNT(*) FROM wishlist_items WHERE user_id = ?", [user.id]));
  if (count >= 200) throw badRequest("Your wishlist is full.", "limit_reached");
  await ctx.db.execute(
    "INSERT INTO wishlist_items (user_id, product_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [user.id, productId, utcnow()],
  );
  return { saved: true };
});

api.route("DELETE", "/api/me/wishlist/{product_id:int}", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  await ctx.db.execute("DELETE FROM wishlist_items WHERE user_id = ? AND product_id = ?", [
    user.id,
    pathInt(ctx, "product_id"),
  ]);
  return { saved: false };
});

api.route("GET", "/api/me/wishlist/ids", { auth: "user" }, async (ctx) => {
  const user = ctx.requireUser();
  const rows = await ctx.db.all("SELECT product_id FROM wishlist_items WHERE user_id = ?", [user.id]);
  return rows.map((r) => r.product_id as number);
});
