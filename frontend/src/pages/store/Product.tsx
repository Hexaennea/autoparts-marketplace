import { useEffect, useState } from "react";
import { LuChevronRight, LuHeart, LuRotateCcw, LuShieldCheck, LuShoppingCart, LuStore, LuTruck, LuZap } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, gstPercent, percentOff, rupees, warranty } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { Link, useRouter } from "../../lib/router";
import type { Paged, ProductDetail, Review } from "../../lib/types";
import { useCart, useConfig, useToast, useVehicle } from "../../state/app";
import { FALLBACK_ART, FitStamp, PartNumber, Price, ProductGrid, SpecLabel, Stars } from "../../ui/commerce";
import { Badge, Button, ErrorState, Field, Quantity, Skeleton } from "../../ui/core";
import { MyCarDialog } from "../../ui/vehicle";
import { NotFound } from "./NotFound";
import { useWishlist } from "./wishlist";

function Gallery({ product }: { product: ProductDetail }) {
  const [index, setIndex] = useState(0);
  const images = product.images.length ? product.images : [{ id: 0, url: FALLBACK_ART, thumb: FALLBACK_ART, width: 800, height: 800 }];
  const current = images[Math.min(index, images.length - 1)]!;
  return (
    <div className="gallery">
      <div className="gallery__main">
        <img src={current.url} alt={product.title} width={800} height={800} />
        {product.brand.is_oem && <span className="pcard__oem">Genuine</span>}
      </div>
      {images.length > 1 && (
        <div className="gallery__thumbs" role="tablist" aria-label="Photos">
          {images.map((img, i) => (
            <button key={img.id} type="button" role="tab" aria-selected={i === index} className={i === index ? "is-active" : ""} onClick={() => setIndex(i)}>
              <img src={img.thumb} alt={`Photo ${i + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Reviews({ product }: { product: ProductDetail }) {
  const [page, setPage] = useState(1);
  const reviews = useQuery<Paged<Review> & { can_review: boolean }>(`/api/products/${product.id}/reviews`, { page });
  const [items, setItems] = useState<Review[]>([]);
  const [form, setForm] = useState({ rating: 5, title: "", body: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (reviews.data) setItems((prev) => (page === 1 ? reviews.data!.items : [...prev, ...reviews.data!.items]));
  }, [reviews.data, page]);

  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post(`/api/products/${product.id}/reviews`, form);
      toast("Thanks — your review is live.");
      setPage(1);
      reviews.reload();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  };

  const total = product.rating_count;
  return (
    <section className="pdp-section" aria-labelledby="reviews">
      <h2 id="reviews">Reviews from buyers</h2>
      <div className={total > 0 ? "reviews" : "reviews reviews--empty"}>
        {total > 0 && <div className="reviews__summary">
          <div className="reviews__score">{total ? product.rating_avg.toFixed(1) : "–"}</div>
          <Stars value={product.rating_avg} />
          <div className="small muted">{total} verified review{total === 1 ? "" : "s"}</div>
          <div className="reviews__bars">
            {Object.entries(product.rating_distribution).map(([star, n]) => (
              <div key={star} className="reviews__bar">
                <span>{star}★</span>
                <span className="progress grow"><span style={{ width: `${total ? (n / total) * 100 : 0}%`, background: "var(--sticker-deep)" }} /></span>
                <span className="muted">{n}</span>
              </div>
            ))}
          </div>
        </div>}
        <div className="reviews__list">
          {reviews.data?.can_review && (
            <form className="card card--pad stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
              <h3>Review this part</h3>
              <div className="row" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} className="check"><input type="radio" name="rating" checked={form.rating === n} onChange={() => setForm({ ...form, rating: n })} />{n}★</label>
                ))}
              </div>
              <Field label="Headline" error={errors.title}>{(p) => <input className="input" {...p} maxLength={100} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
              <Field label="How did it fit and perform?" error={errors.body}>{(p) => <textarea className="textarea" {...p} maxLength={2000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />}</Field>
              <div><Button type="submit" variant="primary" busy={busy}>Post review</Button></div>
            </form>
          )}
          {items.length === 0 && !reviews.loading && <p className="muted">No reviews yet. Buyers can review a part after it's delivered.</p>}
          {items.map((r) => (
            <article key={r.id} className="review">
              <div className="row row--wrap"><Stars value={r.rating} /><strong>{r.title}</strong></div>
              <p>{r.body}</p>
              <div className="xs muted">{r.author} · {date(r.created_at)}{r.vehicle_label ? ` · ${r.vehicle_label}` : ""} · <span className="ok-text">Verified purchase</span></div>
            </article>
          ))}
          {reviews.data && reviews.data.page < reviews.data.pages && (
            <Button size="sm" onClick={() => setPage((p) => p + 1)} busy={reviews.loading}>More reviews</Button>
          )}
        </div>
      </div>
    </section>
  );
}

export function ProductPage({ id }: { id: number }) {
  const { vehicle } = useVehicle();
  const { add } = useCart();
  const toast = useToast();
  const { navigate } = useRouter();
  const { app_name } = useConfig();
  const wish = useWishlist();
  const product = useQuery<ProductDetail>(Number.isFinite(id) ? `/api/products/${id}` : null, { vehicle: vehicle?.variant.id });
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<"" | "add" | "buy">("");
  const [carOpen, setCarOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const p = product.data;

  useEffect(() => {
    if (p) document.title = `${p.title} · ${p.brand.name} ${p.part_number} — ${app_name}`;
    return () => { document.title = `${app_name} — car parts that fit`; };
  }, [p, app_name]);

  if (product.error?.status === 404) return <NotFound />;
  if (product.error) return <div className="container"><ErrorState message={product.error.message} onRetry={product.reload} /></div>;
  if (!p) {
    return (
      <div className="container pdp">
        <div className="pdp__top"><Skeleton height={520} /><div className="stack"><Skeleton height={20} width="40%" /><Skeleton height={64} /><Skeleton height={120} /><Skeleton height={200} /></div></div>
      </div>
    );
  }

  const short = vehicle ? `${vehicle.variant.model} ${vehicle.variant.name.split(" ")[0]} (${vehicle.year})` : null;
  const buy = async (now: boolean) => {
    setBusy(now ? "buy" : "add");
    const ok = await add(p.id, qty);
    setBusy("");
    if (!ok) return;
    if (now) navigate("/cart");
    else toast(`Added ${qty} × ${p.title} to your cart.`);
  };
  const oemRefs = p.part_numbers.filter((n) => n.kind !== "primary");
  const off = percentOff(p.price_paise, p.mrp_paise);

  return (
    <div className="container pdp">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link><LuChevronRight aria-hidden="true" />
        {p.category.parent && <><Link to={`/search?category=${p.category.parent.slug}`}>{p.category.parent.name}</Link><LuChevronRight aria-hidden="true" /></>}
        <Link to={`/search?category=${p.category.slug}`}>{p.category.name}</Link>
      </nav>
      {p.status !== "active" && <div className="alert alert--warn" role="status"><p>This listing is <strong>{p.status}</strong> and isn't visible to shoppers yet.</p></div>}

      <div className="pdp__top">
        <Gallery product={p} />
        <div className="pdp__info">
          <div className="row row--wrap">
            <Link to={`/search?brand=${p.brand.slug}`} className="micro pdp__brand">{p.brand.name}</Link>
            {p.brand.is_oem && <Badge kind="oem">OEM genuine</Badge>}
          </div>
          <h1 className="pdp__title">{p.title}</h1>
          <div className="row row--wrap pdp__ids">
            <PartNumber value={p.part_number} />
            {p.rating_count > 0 && <a href="#reviews"><Stars value={p.rating_avg} count={p.rating_count} /></a>}
          </div>

          <div className="pdp__fit">
            {vehicle ? <FitStamp fits={p.fits} universal={p.is_universal} label={short} large /> : <FitStamp fits={null} large />}
            <button type="button" className="link-btn small" onClick={() => setCarOpen(true)}>{vehicle ? "Change car" : "Select your car"}</button>
            {vehicle && p.fits === false && (
              <p className="small muted pdp__fit-note">The seller hasn't listed this part for your variant. Check the compatible vehicles below or search by your car.</p>
            )}
          </div>

          <div className="buybox card">
            <div className="card__body stack" style={{ "--gap": "14px" }}>
              <div>
                <Price price={p.price_paise} mrp={p.mrp_paise} large />
                <div className="xs muted">Inclusive of {gstPercent(p.gst_rate_bps)} GST{off ? ` · You save ${rupees(p.mrp_paise - p.price_paise)}` : ""}</div>
              </div>
              {p.in_stock ? (
                <div className={`small strong ${p.stock <= 3 ? "warn-text" : "ok-text"}`}>{p.stock <= 3 ? `Only ${p.stock} left in stock` : "In stock"}</div>
              ) : (
                <div className="small strong bad-text">Out of stock</div>
              )}
              <div className="buybox__actions">
                <Quantity value={qty} max={Math.max(1, Math.min(20, p.stock))} onChange={(n) => setQty(Math.max(1, n))} />
                <Button variant="primary" icon={LuShoppingCart} disabled={!p.in_stock} busy={busy === "add"} onClick={() => void buy(false)}>Add to cart</Button>
                <Button variant="ink" icon={LuZap} disabled={!p.in_stock} busy={busy === "buy"} onClick={() => void buy(true)}>Buy now</Button>
                <Button variant="ghost" icon={LuHeart} aria-label={wish.ids.has(p.id) ? "Remove from wishlist" : "Save to wishlist"} onClick={() => void wish.toggle(p.id, !wish.ids.has(p.id))} />
              </div>
            </div>
            <ul className="buybox__facts">
              <li><LuStore aria-hidden="true" /><span>Sold and shipped by <strong>{p.seller.name}</strong>, {p.seller.city}{p.seller.rating_count > 0 ? ` · ${p.seller.rating_avg.toFixed(1)}★ seller` : ""}</span></li>
              <li><LuTruck aria-hidden="true" /><span>Free delivery on orders from this seller over ₹999. Cash on delivery available.</span></li>
              <li><LuRotateCcw aria-hidden="true" /><span>7-day returns if it doesn't fit your listed car.</span></li>
              <li><LuShieldCheck aria-hidden="true" /><span>{warranty(p.warranty_months)} warranty · GST invoice included</span></li>
            </ul>
          </div>
        </div>
      </div>

      <div className="pdp__body">
        <section className="pdp-section" aria-labelledby="label-h">
          <h2 id="label-h">Part label</h2>
          <SpecLabel
            brand={p.brand.name}
            oem={p.brand.is_oem}
            sku={p.sku}
            cells={[
              { label: "Part number", value: p.part_number, pn: true, wide: true },
              { label: "Category", value: p.category.name },
              { label: "Type", value: p.condition === "oem_genuine" ? "OEM genuine" : "Branded aftermarket" },
              { label: "Warranty", value: warranty(p.warranty_months) },
              { label: "HSN", value: <span className="pn">{p.hsn_code}</span> },
              { label: "GST", value: gstPercent(p.gst_rate_bps) },
              { label: "Weight", value: `${(p.weight_grams / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg` },
              ...(oemRefs.length ? [{ label: "Cross-reference numbers", value: <span className="pn">{oemRefs.map((n) => n.number).join("  ·  ")}</span>, wide: true }] : []),
            ]}
            footer={<span className="xs muted">Scan or type the part number at any parts counter to double-check.</span>}
          />
        </section>

        <section className="pdp-section" aria-labelledby="fit-h">
          <div className="row row--between row--wrap">
            <h2 id="fit-h">Compatible vehicles</h2>
            <span className="small muted">{p.is_universal ? "Universal part" : `${p.fitment_count} variants`}</span>
          </div>
          {p.is_universal ? (
            <p className="muted">This is a universal part. Check the specification against your owner's manual before ordering.</p>
          ) : (
            <div className="fit-table">
              {p.fitment.map((g) => {
                const key = `${g.make}-${g.model}`;
                const mine = vehicle && g.variants.some((v) => v.id === vehicle.variant.id);
                const open = openGroup === key || (openGroup === null && Boolean(mine)) || p.fitment.length === 1;
                return (
                  <div key={key} className={`fit-table__group ${mine ? "is-mine" : ""}`}>
                    <button type="button" className="fit-table__head" aria-expanded={open} onClick={() => setOpenGroup(open ? "" : key)}>
                      <strong>{g.make} {g.model}</strong>
                      <span className="small muted">{g.variants.length} variant{g.variants.length === 1 ? "" : "s"}</span>
                      {mine && <span className="fit fit--yes"><span>Your car</span></span>}
                      <LuChevronRight aria-hidden="true" className="fit-table__chev" />
                    </button>
                    {open && (
                      <table className="table">
                        <thead><tr><th>Variant</th><th>Years</th><th>Engine</th><th>Fuel</th><th>Gearbox</th></tr></thead>
                        <tbody>
                          {g.variants.map((v) => (
                            <tr key={v.id} className={vehicle?.variant.id === v.id ? "is-mine" : ""}>
                              <td className="strong">{v.name}{v.generation ? <span className="muted"> · {v.generation}</span> : null}</td>
                              <td className="nowrap">{v.years}</td>
                              <td>{v.engine_cc ? `${v.engine_cc} cc` : "—"}{v.engine_code ? <span className="muted"> · {v.engine_code}</span> : null}</td>
                              <td>{v.fuel_label}</td>
                              <td>{v.transmission_label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="pdp-section pdp-2col" aria-labelledby="about-h">
          <div>
            <h2 id="about-h">About this part</h2>
            <p className="pdp__desc">{p.description || "The seller hasn't added a description."}</p>
          </div>
          {p.specs.length > 0 && (
            <div>
              <h3 className="micro" style={{ marginBottom: 8 }}>Specifications</h3>
              <dl className="specs">
                {p.specs.map((s) => <div key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>)}
              </dl>
            </div>
          )}
        </section>

        {p.other_sellers.length > 0 && (
          <section className="pdp-section" aria-labelledby="others-h">
            <h2 id="others-h">Same part number from other sellers</h2>
            <ProductGrid products={p.other_sellers} wishlist={wish.ids} onWish={wish.toggle} />
          </section>
        )}

        <Reviews product={p} />

        {p.related.length > 0 && (
          <section className="pdp-section" aria-labelledby="related-h">
            <h2 id="related-h">{vehicle ? `More ${p.category.name.toLowerCase()} for your ${vehicle.variant.model}` : `More ${p.category.name.toLowerCase()}`}</h2>
            <ProductGrid products={p.related} wishlist={wish.ids} onWish={wish.toggle} />
          </section>
        )}
      </div>
      <MyCarDialog open={carOpen} onClose={() => setCarOpen(false)} />
    </div>
  );
}
