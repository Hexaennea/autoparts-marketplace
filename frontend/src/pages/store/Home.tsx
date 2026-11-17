import { useEffect, useRef, useState } from "react";
import { LuArrowRight, LuBadgeCheck, LuBanknote, LuCarFront, LuFileSpreadsheet, LuListChecks, LuPause, LuPlay, LuReceipt, LuRotateCcw, LuWallet } from "react-icons/lu";
import heroLarge from "../../assets/media/hero-1600.mp4";
import heroLargeWebm from "../../assets/media/hero-1600.webm";
import heroSmall from "../../assets/media/hero-960.mp4";
import heroSmallWebm from "../../assets/media/hero-960.webm";
import heroPoster from "../../assets/media/hero-poster.jpg";
import { rupees, warranty } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { Link, useRouter } from "../../lib/router";
import type { Category, ProductCard, ProductDetail, Variant } from "../../lib/types";
import { useVehicle } from "../../state/app";
import { CATEGORY_ART, FALLBACK_ART, FitStamp, PartNumber, ProductGrid, SpecLabel } from "../../ui/commerce";
import { Button, Skeleton } from "../../ui/core";
import { VehicleSelector } from "../../ui/vehicle";
import { useWishlist } from "./wishlist";

interface Home {
  categories: Category[];
  popular: ProductCard[];
  brands: { name: string; slug: string; is_oem: boolean; count: number }[];
  stats: { parts: number; sellers: number; variants: number };
  vehicle: Variant | null;
}

function ProofLabel({ product }: { product: ProductCard }) {
  const { vehicle } = useVehicle();
  const detail = useQuery<ProductDetail>(`/api/products/${product.id}`, { vehicle: vehicle?.variant.id });
  const d = detail.data;
  return (
    <aside className="proof" aria-label="Example listing">
      <Link to={`/p/${product.id}/${product.slug}`} className="proof__media">
        <img src={product.image ?? FALLBACK_ART} alt="" width={480} height={480} />
      </Link>
      <SpecLabel
        brand={product.brand}
        oem={product.brand_is_oem}
        cols={2}
        sku={d?.sku}
        cells={[
          { label: "Part no.", value: <PartNumber value={product.part_number} tag="" />, wide: true, pn: true },
          { label: "Part", value: <Link to={`/p/${product.id}/${product.slug}`} className="proof__title">{product.title}</Link>, wide: true },
          { label: "Fits", value: d ? (d.is_universal ? "Universal" : `${d.fitment_count} car variants`) : "…" },
          { label: "Warranty", value: warranty(product.warranty_months) },
          { label: "Price", value: rupees(product.price_paise) },
          { label: "Seller", value: product.seller.city },
        ]}
        footer={vehicle ? <FitStamp fits={d?.fits ?? null} universal={product.is_universal} label={`${vehicle.variant.model} ${vehicle.variant.name.split(" ")[0]}`} /> : <span className="small muted">Every listing carries its part number and the exact cars it fits.</span>}
      />
    </aside>
  );
}

/** Full-bleed background film. Muted, looped, never autoplays for people who ask for reduced motion, and always pausable. */
function HeroVideo() {
  const ref = useRef<HTMLVideoElement | null>(null);
  const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [playing, setPlaying] = useState(!reduce);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = true;
    if (playing) v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing]);
  return (
    <>
      <div className="vhero__media" aria-hidden="true">
        <video ref={ref} className="vhero__video" muted loop playsInline preload={reduce ? "none" : "auto"} poster={heroPoster}>
          <source src={heroSmallWebm} type="video/webm" media="(max-width: 760px)" />
          <source src={heroSmall} type="video/mp4" media="(max-width: 760px)" />
          <source src={heroLargeWebm} type="video/webm" />
          <source src={heroLarge} type="video/mp4" />
        </video>
        <div className="vhero__shade" />
      </div>
      <button type="button" className="vhero__pause" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause background video" : "Play background video"}>
        {playing ? <LuPause aria-hidden="true" /> : <LuPlay aria-hidden="true" />}
      </button>
    </>
  );
}

export function HomePage() {
  const { vehicle, setVehicle } = useVehicle();
  const { navigate } = useRouter();
  const home = useQuery<Home>("/api/home", { vehicle: vehicle?.variant.id });
  const wish = useWishlist();
  const data = home.data;
  const lead = data?.popular[0];
  const short = vehicle ? `${vehicle.variant.make} ${vehicle.variant.model} ${vehicle.variant.name}` : "";
  const scope = vehicle ? `&vehicle=${vehicle.variant.id}` : "";

  return (
    <>
      <section className="vhero" aria-labelledby="hero-title">
        <HeroVideo />
        <div className="container vhero__inner">
          <div className="vhero__copy">
            {vehicle && <span className="vhero__car"><LuCarFront aria-hidden="true" />{vehicle.variant.make} {vehicle.variant.model} · {vehicle.year}</span>}
            {vehicle ? (
              <>
                <h1 id="hero-title">Parts for your {vehicle.variant.model}.</h1>
                <p className="vhero__lede">
                  Checked against the <strong>{short}</strong> ({vehicle.year}, {vehicle.variant.fuel_label.toLowerCase()} {vehicle.variant.transmission_label}).
                </p>
              </>
            ) : (
              <>
                <h1 id="hero-title">Car parts that fit. Exactly.</h1>
                <p className="vhero__lede">Tell us your car once. Every part then says plainly whether it fits your variant — or search straight by part number.</p>
              </>
            )}
          </div>
          <VehicleSelector
            key={vehicle ? `${vehicle.variant.id}-${vehicle.year}` : "none"}
            initial={vehicle}
            onSelect={(v) => { setVehicle(v); navigate(`/search?vehicle=${v.variant.id}`); }}
            submitLabel={vehicle ? "Show parts" : "Find parts"}
          />
        </div>
      </section>

      <div className="container">
        <ul className="trust" aria-label="Why buy here">
          <li><span className="trust__icon"><LuBadgeCheck aria-hidden="true" /></span><div><strong>Verified sellers</strong><span>GSTIN and bank checked</span></div></li>
          <li><span className="trust__icon"><LuReceipt aria-hidden="true" /></span><div><strong>GST invoice</strong><span>On every order</span></div></li>
          <li><span className="trust__icon"><LuRotateCcw aria-hidden="true" /></span><div><strong>7-day wrong-fit returns</strong><span>If it doesn’t fit, send it back</span></div></li>
          <li><span className="trust__icon"><LuBanknote aria-hidden="true" /></span><div><strong>Cash on delivery</strong><span>Or pay online securely</span></div></li>
        </ul>
      </div>

      <section className="container section" aria-labelledby="cats">
        <div className="section__head">
          <h2 id="cats">{vehicle ? `${vehicle.variant.model} parts by category` : "Shop by category"}</h2>
        </div>
        <div className="cat-grid">
          {(data?.categories ?? []).map((c) => (
            <div key={c.id} className="cat-tile">
              <Link to={`/search?category=${c.slug}${scope}`} className="cat-tile__main">
                <span className="cat-tile__art"><img src={CATEGORY_ART[c.slug] ?? FALLBACK_ART} alt="" width={320} height={240} loading="lazy" /></span>
                <span>
                  <span className="cat-tile__name">{c.name}</span>
                  <span className="cat-tile__count">{c.total_count} parts</span>
                </span>
              </Link>
              {c.children.length > 0 && (
                <div className="cat-tile__links">
                  {c.children.slice(0, 3).map((child) => (
                    <Link key={child.id} to={`/search?category=${child.slug}${scope}`}>{child.name}</Link>
                  ))}
                </div>
              )}
            </div>
          ))}
          {!data && Array.from({ length: 10 }, (_, i) => <Skeleton key={i} height={240} />)}
        </div>
      </section>

      <section className="container section" aria-labelledby="popular">
        <div className="section__head">
          <h2 id="popular">{vehicle ? `Popular for your ${vehicle.variant.model}` : "Popular right now"}</h2>
          <Link to={`/search${vehicle ? `?vehicle=${vehicle.variant.id}` : ""}`} className="section__more">See all parts <LuArrowRight aria-hidden="true" /></Link>
        </div>
        <ProductGrid products={data?.popular} loading={home.loading} wishlist={wish.ids} onWish={wish.toggle} />
      </section>

      <section className="container section" aria-labelledby="story">
        <div className="story">
          <div className="story__copy">
            <h2 id="story">Every listing reads like the box it ships in.</h2>
            <p>Part number, the exact variants it fits, warranty and seller, set out the same way on every part. Hold it up against the old one in your hand.</p>
            <ol className="story__points">
              <li><b>01</b><span>Search by part name, or type the number printed on the old part.</span></li>
              <li><b>02</b><span>Choose your car once. Every result says whether it fits.</span></li>
              <li><b>03</b><span>Wrong fit after all? Send it back within 7 days.</span></li>
            </ol>
          </div>
          {lead ? <ProofLabel product={lead} /> : <Skeleton height={460} />}
        </div>
      </section>

      {data && data.brands.length > 0 && (
        <section className="container section" aria-labelledby="brands">
          <div className="section__head"><h2 id="brands">Genuine and branded parts</h2></div>
          <div className="brand-rows">
            <div>
              <div className="brand-rows__title">Vehicle-maker genuine</div>
              <div className="brand-rows__sub">Original parts from the brands that built your car.</div>
              <div className="chips">{data.brands.filter((b) => b.is_oem).map((b) => <Link key={b.slug} className="chip chip--link" to={`/search?brand=${b.slug}`}>{b.name}</Link>)}</div>
            </div>
            <div>
              <div className="brand-rows__title">Trusted aftermarket</div>
              <div className="brand-rows__sub">Established part makers, matched to the same variants.</div>
              <div className="chips">{data.brands.filter((b) => !b.is_oem).map((b) => <Link key={b.slug} className="chip chip--link" to={`/search?brand=${b.slug}`}>{b.name}</Link>)}</div>
            </div>
          </div>
        </section>
      )}

      <section className="sell-band" aria-labelledby="sell">
        <div className="sell-band__bg" aria-hidden="true" />
        <div className="container sell-band__inner">
          <div>
            <h2 id="sell">Sell parts to car owners and garages across India.</h2>
            <p>List once with exact fitment, get orders from buyers who already know it fits, and get paid after delivery.</p>
            <Button to="/sell" variant="sticker" size="lg" iconRight={LuArrowRight}>Start selling</Button>
          </div>
          <ul className="sell-band__facts">
            <li><LuListChecks aria-hidden="true" /><div><strong>Fitment picker</strong><span>Tick the variants a part fits — buyers see a clear yes or no.</span></div></li>
            <li><LuFileSpreadsheet aria-hidden="true" /><div><strong>Bulk upload</strong><span>Import hundreds of listings from one CSV and sync stock.</span></div></li>
            <li><LuWallet aria-hidden="true" /><div><strong>Clear payouts</strong><span>Commission and TCS shown on every order before you ship.</span></div></li>
          </ul>
        </div>
      </section>
    </>
  );
}
