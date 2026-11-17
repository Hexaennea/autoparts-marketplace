// Marketplace building blocks in the "parts-box label" language.
import { useState } from "react";
import type { ReactNode } from "react";
import { LuBadgeCheck, LuCheck, LuCopy, LuHeart, LuShoppingCart, LuStar, LuTriangleAlert } from "react-icons/lu";
import airFilter from "../assets/art/air-filter.svg";
import battery from "../assets/art/battery.svg";
import brakeDisc from "../assets/art/brake-disc.svg";
import clutch from "../assets/art/clutch.svg";
import engineOil from "../assets/art/engine-oil.svg";
import headlight from "../assets/art/headlight.svg";
import mirror from "../assets/art/mirror.svg";
import radiator from "../assets/art/radiator.svg";
import shock from "../assets/art/shock.svg";
import sparkPlug from "../assets/art/spark-plug.svg";
import { barcodeWidth, code128 } from "../lib/barcode";
import { percentOff, rupees } from "../lib/format";
import { Link } from "../lib/router";
import type { FulfilmentStatus, ProductCard as Card } from "../lib/types";
import { useCart, useToast, useVehicle } from "../state/app";
import { Badge, Button, Skeleton } from "./core";

export const CATEGORY_ART: Record<string, string> = {
  brakes: brakeDisc, filters: airFilter, engine: sparkPlug, "suspension-steering": shock, "clutch-transmission": clutch,
  electricals: battery, lighting: headlight, cooling: radiator, "body-exterior": mirror, "oils-fluids": engineOil,
};
export const FALLBACK_ART = brakeDisc;

export function Price({ price, mrp, large }: { price: number; mrp?: number; large?: boolean }) {
  const off = mrp ? percentOff(price, mrp) : 0;
  return (
    <div className="price-row">
      <span className={`price ${large ? "price--lg" : ""}`}>{rupees(price)}</span>
      {off > 0 && mrp && (
        <>
          <span className="mrp"><span className="sr-only">MRP </span>{rupees(mrp)}</span>
          <span className="off">{off}% off</span>
        </>
      )}
    </div>
  );
}

export function Stars({ value, count }: { value: number; count?: number }) {
  const rounded = Math.round(value);
  return (
    <span className="stars" aria-label={`Rated ${value.toFixed(1)} out of 5${count !== undefined ? ` from ${count} reviews` : ""}`}>
      <span className="stars__icons" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <LuStar key={n} className={n <= rounded ? undefined : "stars__off"} fill={n <= rounded ? "currentColor" : "none"} />
        ))}
      </span>
      {count !== undefined && <span>({count})</span>}
    </span>
  );
}

/** The FITS stamp — black on label-yellow when fitment data says yes. */
export function FitStamp({ fits, universal, label, large }: { fits: boolean | null; universal?: boolean; label?: string | null; large?: boolean }) {
  const size = large ? "fit--lg" : "";
  if (universal && fits !== false) {
    return <span className={`fit fit--universal ${size}`}><LuCheck aria-hidden="true" /><span>Universal fit</span></span>;
  }
  if (fits === true) {
    return (
      <span className={`fit fit--yes ${size}`}>
        <LuBadgeCheck aria-hidden="true" />
        <span>{label ? `Fits your ${label}` : "Fits your car"}</span>
      </span>
    );
  }
  if (fits === false) {
    return (
      <span className={`fit fit--no ${size}`}>
        <LuTriangleAlert aria-hidden="true" />
        <span>{label ? `Doesn't fit your ${label}` : "Doesn't fit your car"}</span>
      </span>
    );
  }
  return <span className={`fit fit--unknown ${size}`}><span>Select your car to check fit</span></span>;
}

export function PartNumber({ value, tag = "PN", copy = true }: { value: string; tag?: string; copy?: boolean }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast(`Copied ${value}`);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Couldn't copy — select the number instead.", "bad");
    }
  };
  return (
    <span className="pn">
      <span className="pn__tag">{tag}</span>
      <span>{value}</span>
      {copy && (
        <button type="button" className="pn__copy" onClick={doCopy} aria-label={`Copy part number ${value}`}>
          {copied ? <LuCheck /> : <LuCopy />}
        </button>
      )}
    </span>
  );
}

export function Barcode({ value, height = 52, caption = true }: { value: string; height?: number; caption?: boolean }) {
  const modules = code128(value);
  const width = barcodeWidth(modules);
  let x = 0;
  const bars: ReactNode[] = [];
  modules.forEach((w, i) => {
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={height} />);
    x += w;
  });
  return (
    <div>
      <svg className="barcode" viewBox={`0 0 ${width} ${height}`} width={width * 1.6} height={height} preserveAspectRatio="none" role="img" aria-label={`Barcode ${value}`} fill="currentColor">
        {bars}
      </svg>
      {caption && <div className="barcode-caption">{value}</div>}
    </div>
  );
}

export interface SpecCell { label: string; value: ReactNode; wide?: boolean; pn?: boolean }

/** Signature component: the box-end label — ruled data cells, brand band and a real barcode. */
export function SpecLabel({ brand, oem, cells, sku, cols = 3, footer }: { brand: string; oem?: boolean; cells: SpecCell[]; sku?: string; cols?: number; footer?: ReactNode }) {
  return (
    <div className="spec-label">
      <div className="spec-label__head">
        <span className="spec-label__brand">{brand}</span>
        <span className="micro">{oem ? "Genuine part" : "Spare part"}</span>
      </div>
      <div className="spec-label__grid" style={{ "--cols": cols }}>
        {cells.map((cell) => (
          <div key={cell.label} className={`spec-label__cell ${cell.wide ? "spec-label__cell--wide" : ""}`}>
            <div className="micro">{cell.label}</div>
            <div className={`spec-label__value ${cell.pn ? "spec-label__value--pn pn" : ""}`}>{cell.value}</div>
          </div>
        ))}
      </div>
      {(sku || footer) && (
        <div className="spec-label__foot">
          <div className="grow">{footer}</div>
          {sku && <Barcode value={sku} />}
        </div>
      )}
    </div>
  );
}

export function ProductCard({ product, wished, onWish }: { product: Card; wished?: boolean; onWish?: (id: number, on: boolean) => void }) {
  const { vehicle } = useVehicle();
  const { add } = useCart();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const href = `/p/${product.id}/${product.slug}`;
  const shortLabel = vehicle ? `${vehicle.variant.model} ${vehicle.variant.name.split(" ")[0]}` : null;

  const addToCart = async () => {
    setBusy(true);
    if (await add(product.id)) toast(`Added to cart — ${product.title}`);
    setBusy(false);
  };

  return (
    <article className="pcard">
      <Link to={href} className="pcard__media" aria-label={product.title}>
        {product.image ? <img src={product.image} alt="" loading="lazy" width={480} height={480} /> : <img src={FALLBACK_ART} alt="" />}
        {product.brand_is_oem && <span className="pcard__oem">Genuine</span>}
      </Link>
      {onWish && (
        <button type="button" className={`pcard__wish ${wished ? "is-on" : ""}`} onClick={() => onWish(product.id, !wished)} aria-pressed={wished} aria-label={wished ? "Remove from wishlist" : "Save to wishlist"}>
          <LuHeart fill={wished ? "currentColor" : "none"} />
        </button>
      )}
      <div className="pcard__body">
        <div className="pcard__brand">{product.brand}</div>
        <Link to={href} className="pcard__title clamp-2">{product.title}</Link>
        <div className="pcard__pn pn"><span className="pn__tag">PN</span> {product.part_number}</div>
        {product.rating_count > 0 && <Stars value={product.rating_avg} count={product.rating_count} />}
        {vehicle && product.fits !== null && <FitStamp fits={product.fits} universal={product.is_universal} label={shortLabel} />}
        <div className="pcard__foot">
          <div>
            <Price price={product.price_paise} mrp={product.mrp_paise} />
            <div className="pcard__meta">
              {!product.in_stock ? <span className="bad-text">Out of stock</span> : product.low_stock ? <span className="warn-text">Few left</span> : null}
            </div>
          </div>
          <Button variant="primary" size="sm" icon={LuShoppingCart} busy={busy} disabled={!product.in_stock} onClick={addToCart} aria-label={`Add ${product.title} to cart`} />
        </div>
        <div className="pcard__seller small muted">Sold by {product.seller.name}, {product.seller.city}</div>
      </div>
    </article>
  );
}

export function ProductGrid({ products, loading, skeletons = 8, wishlist, onWish }: { products?: Card[]; loading?: boolean; skeletons?: number; wishlist?: Set<number>; onWish?: (id: number, on: boolean) => void }) {
  if (loading && !products) {
    return (
      <div className="pgrid" aria-busy="true">
        {Array.from({ length: skeletons }, (_, i) => (
          <div key={i} className="pcard">
            <Skeleton height="auto" style={{ aspectRatio: "1", borderRadius: 0 }} />
            <div className="pcard__body stack" style={{ "--gap": "10px" }}>
              <Skeleton width="40%" height={10} />
              <Skeleton height={16} />
              <Skeleton width="70%" height={12} />
              <Skeleton width="50%" height={22} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="pgrid">
      {products?.map((p) => <ProductCard key={p.id} product={p} wished={wishlist?.has(p.id)} onWish={onWish} />)}
    </div>
  );
}

const STATUS_KIND: Record<string, "ok" | "warn" | "bad" | "info" | undefined> = {
  pending_payment: "warn", placed: "info", packed: "info", shipped: "info", delivered: "ok", cancelled: "bad",
  return_requested: "warn", returned: undefined,
  draft: undefined, pending: "warn", active: "ok", rejected: "bad", archived: undefined,
  approved: "ok", suspended: "bad",
  paid: "ok", cod_due: "info", cod_collected: "ok", failed: "bad", refunded: undefined, partially_refunded: "warn",
  buyer: undefined, seller: "info", admin: "ink" as never,
};

const STATUS_TEXT: Record<string, string> = {
  pending_payment: "Awaiting payment", placed: "To pack", packed: "Packed", shipped: "Shipped", delivered: "Delivered",
  cancelled: "Cancelled", return_requested: "Return requested", returned: "Returned",
  draft: "Draft", pending: "In review", active: "Live", rejected: "Needs changes", archived: "Archived",
  approved: "Approved", suspended: "Suspended", paid: "Paid", cod_due: "Pay on delivery", cod_collected: "COD collected",
  failed: "Payment failed", refunded: "Refunded", partially_refunded: "Part refunded",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge kind={STATUS_KIND[status]}>{label ?? STATUS_TEXT[status] ?? status}</Badge>;
}

const ROUTE: { status: FulfilmentStatus; label: string }[] = [
  { status: "placed", label: "Ordered" },
  { status: "packed", label: "Packed" },
  { status: "shipped", label: "Shipped" },
  { status: "delivered", label: "Delivered" },
];

/** Order tracking drawn as a route with stops. */
export function TrackingRoute({ status, events }: { status: FulfilmentStatus; events: { status: string; created_at: string }[] }) {
  const order: FulfilmentStatus[] = ["placed", "packed", "shipped", "delivered"];
  const effective = status === "return_requested" || status === "returned" ? "delivered" : status;
  const reached = order.indexOf(effective as FulfilmentStatus);
  const when = (s: string) => events.filter((e) => e.status === s).at(-1)?.created_at;
  return (
    <ol className="route" style={{ "--stops": 4 }}>
      {ROUTE.map((stop, i) => {
        const done = i < reached || (i === reached && effective === "delivered");
        const current = i === reached && effective !== "delivered";
        const at = when(stop.status);
        return (
          <li key={stop.status} className={`route__stop ${done ? "is-done" : ""} ${current ? "is-current" : ""}`}>
            <span className="route__dot" aria-hidden="true" />
            <div className="route__label">{stop.label}</div>
            <div className="route__date">{at ? new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : current ? "In progress" : "—"}</div>
          </li>
        );
      })}
    </ol>
  );
}

export function SummaryRows({ rows, total }: { rows: { label: ReactNode; value: ReactNode; muted?: boolean }[]; total: { label: string; value: string } }) {
  return (
    <dl className="summary">
      {rows.map((r, i) => (
        <div key={i} className={`summary__row ${r.muted ? "muted" : ""}`}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
      <div className="summary__row summary__total">
        <dt>{total.label}</dt>
        <dd>{total.value}</dd>
      </div>
    </dl>
  );
}
