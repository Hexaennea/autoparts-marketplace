import { LuArrowRight, LuLock, LuStore, LuTrash2, LuTriangleAlert } from "react-icons/lu";
import emptyArt from "../../assets/art/brake-pad.svg";
import { rupees, rupeesRounded } from "../../lib/format";
import { Link } from "../../lib/router";
import { useAuth, useCart } from "../../state/app";
import { FALLBACK_ART, SummaryRows } from "../../ui/commerce";
import { Button, Empty, Quantity, Skeleton } from "../../ui/core";

export function CartPage() {
  const { quote, loading, setQuantity, remove } = useCart();
  const { user } = useAuth();

  if (!quote && loading) {
    return <div className="container page"><Skeleton height={32} width={200} /><div style={{ height: 16 }} /><Skeleton height={320} /></div>;
  }
  if (!quote || (quote.groups.length === 0 && quote.issues.length === 0)) {
    return (
      <div className="container page">
        <Empty art={emptyArt} title="Your cart is empty" action={<Button to="/search" variant="primary">Browse parts</Button>}>
          Find parts by your car or by part number — they'll wait here while you compare.
        </Empty>
      </div>
    );
  }
  const s = quote.summary;
  return (
    <div className="container page">
      <h1 className="page__title">Cart</h1>
      <div className="cart-layout">
        <div className="stack" style={{ "--gap": "16px" }}>
          {quote.issues.map((issue) => (
            <div key={issue.product_id} className="alert alert--warn" role="status">
              <LuTriangleAlert aria-hidden="true" />
              <div className="grow"><div className="alert__title">{issue.title ?? "A part in your cart"}</div><p>{issue.message}</p></div>
              {issue.code !== "quantity_reduced" && <Button size="sm" variant="ghost" onClick={() => void remove(issue.product_id)}>Remove</Button>}
            </div>
          ))}
          {quote.groups.map((g) => (
            <section key={g.seller.id} className="card shipment" aria-label={`Shipment from ${g.seller.name}`}>
              <header className="card__head">
                <div className="row"><LuStore aria-hidden="true" /><span><span className="small muted">Ships from </span><strong>{g.seller.name}</strong></span></div>
                <span className="small">{g.shipping_paise === 0 ? <span className="ok-text strong">Free delivery</span> : <>Delivery {rupees(g.shipping_paise)}</>}</span>
              </header>
              <ul className="cart-lines">
                {g.lines.map((line) => (
                  <li key={line.product_id} className="cart-line">
                    <Link to={`/p/${line.product_id}/${line.slug}`} className="cart-line__img"><img src={line.image ?? FALLBACK_ART} alt="" width={96} height={96} /></Link>
                    <div className="cart-line__info">
                      <div className="micro">{line.brand}</div>
                      <Link to={`/p/${line.product_id}/${line.slug}`} className="cart-line__title">{line.title}</Link>
                      <div className="pn small"><span className="pn__tag">PN</span> {line.part_number}</div>
                      <div className="row cart-line__actions">
                        <Quantity small value={line.quantity} max={line.max_quantity} onChange={(n) => void setQuantity(line.product_id, n)} />
                        <Button size="sm" variant="ghost" icon={LuTrash2} onClick={() => void remove(line.product_id)}>Remove</Button>
                      </div>
                    </div>
                    <div className="cart-line__price">
                      <div className="price">{rupees(line.line_total_paise)}</div>
                      {line.quantity > 1 && <div className="xs muted">{rupees(line.price_paise)} each</div>}
                    </div>
                  </li>
                ))}
              </ul>
              {g.free_shipping_remaining_paise > 0 && (
                <div className="card__foot shipment__hint">
                  <span className="small">Add <strong>{rupees(g.free_shipping_remaining_paise)}</strong> more from {g.seller.name} for free delivery.</span>
                  <div className="progress"><span style={{ width: `${Math.min(100, (g.items_paise / quote.rules.free_shipping_threshold_paise) * 100)}%` }} /></div>
                </div>
              )}
            </section>
          ))}
        </div>
        <aside className="card cart-summary" aria-label="Order summary">
          <div className="card__body stack">
            <h2>Order summary</h2>
            <SummaryRows
              rows={[
                { label: `Items (${s.item_count})`, value: rupees(s.items_paise) },
                { label: `Delivery (${quote.groups.length} shipment${quote.groups.length === 1 ? "" : "s"})`, value: s.shipping_paise ? rupees(s.shipping_paise) : "Free" },
                ...(s.savings_paise ? [{ label: "You save vs MRP", value: <span className="ok-text">{rupees(s.savings_paise)}</span> }] : []),
                { label: "Includes GST", value: rupeesRounded(s.gst_paise), muted: true },
              ]}
              total={{ label: "Total", value: rupees(s.total_paise) }}
            />
            <Button to={user ? "/checkout" : "/login?next=/checkout"} variant="primary" size="lg" block iconRight={LuArrowRight} className={quote.groups.length ? "" : "is-disabled"}>
              {user ? "Checkout" : "Sign in to checkout"}
            </Button>
            <p className="xs muted row"><LuLock aria-hidden="true" size={14} /> Prices are confirmed again when you place the order.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
