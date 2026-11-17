import { useState } from "react";
import { LuChevronRight, LuCircleCheck, LuPackage, LuStore } from "react-icons/lu";
import emptyArt from "../../assets/art/battery.svg";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, dateTime, gstPercent, rupees, rupeesRounded } from "../../lib/format";
import { invalidate, useQuery } from "../../lib/query";
import { Link, useSearchParams } from "../../lib/router";
import type { Fulfilment, Order, Paged } from "../../lib/types";
import { useToast } from "../../state/app";
import { FALLBACK_ART, StatusBadge, SummaryRows, TrackingRoute } from "../../ui/commerce";
import { Alert, Button, Dialog, Empty, ErrorState, Field, PageHeader, Pagination, Skeleton } from "../../ui/core";

export function OrdersPage() {
  const [params, update] = useSearchParams();
  const page = Number(params.get("page") ?? 1) || 1;
  const orders = useQuery<Paged<Order>>("/api/orders", { page });
  const data = orders.data;
  return (
    <div className="container page">
      <PageHeader title="Your orders" />
      {orders.error && <ErrorState message={orders.error.message} onRetry={orders.reload} />}
      {!data && orders.loading && <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={120} />)}</div>}
      {data?.total === 0 && <Empty art={emptyArt} title="No orders yet" action={<Button to="/search" variant="primary">Find parts</Button>}>When you order parts, you'll track every shipment here.</Empty>}
      <div className="stack" style={{ "--gap": "12px" }}>
        {data?.items.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="order-row card">
            <div className="order-row__head">
              <div><div className="micro">Order</div><div className="strong pn">{o.number}</div></div>
              <div><div className="micro">Placed</div><div>{date(o.created_at)}</div></div>
              <div><div className="micro">Total</div><div className="strong">{rupees(o.total_paise)}</div></div>
              <div className="grow"><div className="micro">Payment</div><StatusBadge status={o.payment_status} /></div>
              <LuChevronRight aria-hidden="true" className="order-row__chev" />
            </div>
            <div className="order-row__ships">
              {o.fulfilments.map((f) => (
                <div key={f.id} className="order-row__ship">
                  <div className="order-row__thumbs">{f.items.slice(0, 3).map((i) => <img key={i.id} src={i.image ?? FALLBACK_ART} alt="" width={48} height={48} />)}</div>
                  <div className="grow small"><div className="strong clamp-2">{f.items.map((i) => i.title).join(", ")}</div><div className="muted">from {f.seller.name}</div></div>
                  <StatusBadge status={f.status} />
                </div>
              ))}
            </div>
          </Link>
        ))}
      </div>
      {data && <Pagination page={data.page} pages={data.pages} total={data.total} perPage={data.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
    </div>
  );
}

function ReasonDialog({ open, title, label, cta, onClose, onSubmit }: { open: boolean; title: string; label: string; cta: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try { await onSubmit(reason); setReason(""); } catch (err) { setError(err instanceof ApiError ? err.fields.reason ?? err.message : errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<><Button variant="ghost" onClick={onClose}>Keep order</Button><Button variant="danger" busy={busy} onClick={() => void submit()}>{cta}</Button></>}>
      <Field label={label} error={error}>{(p) => <textarea className="textarea" {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </Dialog>
  );
}

function Shipment({ order, f, onChange }: { order: Order; f: Fulfilment; onChange: (o: Order) => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<"" | "cancel" | "return">("");
  const unpaid = f.status === "pending_payment";
  const act = async (kind: "cancel" | "return", reason: string) => {
    const updated = await api.post<Order>(`/api/orders/${order.id}/fulfilments/${f.id}/${kind}`, { reason });
    onChange(updated);
    invalidate("/api/orders");
    setDialog("");
    toast(kind === "cancel" ? (unpaid ? "Order cancelled. Nothing was charged." : "Cancelled. Any online payment will be refunded.") : "Return requested. The seller will arrange pickup.");
  };
  const terminal = f.status === "cancelled" || f.status === "pending_payment";
  return (
    <section className="card shipment" aria-label={`Shipment from ${f.seller.name}`}>
      <header className="card__head">
        <div className="row"><LuStore aria-hidden="true" /><span><span className="small muted">Shipment from </span><strong>{f.seller.name}</strong></span></div>
        <StatusBadge status={f.status} />
      </header>
      <div className="card__body stack" style={{ "--gap": "20px" }}>
        {!terminal && <TrackingRoute status={f.status} events={f.events} />}
        {f.tracking_number && (
          <div className="tracking"><LuPackage aria-hidden="true" /><span className="small">{f.carrier} tracking <span className="pn strong">{f.tracking_number}</span></span></div>
        )}
        {f.status === "cancelled" && <Alert kind="bad" title="Cancelled">{f.cancel_reason}{f.refund_paise ? ` · ${rupees(f.refund_paise)} refunded` : ""}</Alert>}
        {f.status === "return_requested" && <Alert kind="warn" title="Return requested">{f.return_reason}</Alert>}
        {f.status === "returned" && <Alert kind="ok" title="Returned">{f.refund_paise ? `${rupees(f.refund_paise)} refunded.` : "Refund settled with the seller."}</Alert>}
        <ul className="cart-lines cart-lines--flat">
          {f.items.map((i) => (
            <li key={i.id} className="cart-line">
              <Link to={`/p/${i.product_id}`} className="cart-line__img"><img src={i.image ?? FALLBACK_ART} alt="" width={72} height={72} /></Link>
              <div className="cart-line__info">
                <div className="micro">{i.brand}</div>
                <Link to={`/p/${i.product_id}`} className="cart-line__title">{i.title}</Link>
                <div className="small muted"><span className="pn">{i.part_number}</span> · Qty {i.quantity} · GST {gstPercent(i.gst_rate_bps)}</div>
              </div>
              <div className="cart-line__price"><div className="price">{rupees(i.line_total_paise)}</div></div>
            </li>
          ))}
        </ul>
        {(f.can_cancel || f.can_return) && (
          <div className="row">
            {f.can_cancel && <Button variant="danger" size="sm" onClick={() => setDialog("cancel")}>{unpaid ? "Cancel order" : "Cancel this shipment"}</Button>}
            {f.can_return && <Button size="sm" onClick={() => setDialog("return")}>Return — doesn't fit</Button>}
          </div>
        )}
        {f.events.length > 0 && (
          <details className="history">
            <summary className="small">Shipment history</summary>
            <ul className="events">{f.events.map((e, i) => <li key={i}><span className="muted">{dateTime(e.created_at)}</span><span><strong>{e.label}</strong>{e.note ? ` — ${e.note}` : ""}</span></li>)}</ul>
          </details>
        )}
      </div>
      <ReasonDialog open={dialog === "cancel"} title={unpaid ? "Cancel this order?" : "Cancel this shipment?"} label="Why are you cancelling?" cta={unpaid ? "Cancel order" : "Cancel shipment"} onClose={() => setDialog("")} onSubmit={(r) => act("cancel", r)} />
      <ReasonDialog open={dialog === "return"} title="Return this shipment" label="What's wrong with the fit?" cta="Request return" onClose={() => setDialog("")} onSubmit={(r) => act("return", r)} />
    </section>
  );
}

export function OrderPage({ id }: { id: number }) {
  const [params] = useSearchParams();
  const order = useQuery<Order>(`/api/orders/${id}`);
  const o = order.data;
  if (order.error) return <div className="container page"><ErrorState message={order.error.message} onRetry={order.reload} /></div>;
  if (!o) return <div className="container page"><Skeleton height={36} width={260} /><div style={{ height: 16 }} /><Skeleton height={300} /></div>;
  return (
    <div className="container page">
      <PageHeader title={<>Order <span className="pn">{o.number}</span></>} subtitle={`Placed ${dateTime(o.created_at)}`} back={{ to: "/orders", label: "All orders" }} />
      {params.get("placed") && (
        <div className="placed card">
          <LuCircleCheck aria-hidden="true" />
          <div><h2>Thanks — your order is in.</h2><p className="muted">Each seller packs and ships their part of the order separately. We'll show tracking here as soon as it moves.</p></div>
        </div>
      )}
      {o.payment && <Alert kind="warn" title={o.payment_status === "failed" ? "Payment failed" : "Payment pending"} action={<Button size="sm" variant="primary" to={`/orders/${o.id}/pay`}>{o.payment_status === "failed" ? "Try again" : "Pay now"}</Button>}>Sellers start packing once payment is confirmed. You can also cancel the order.</Alert>}
      <div className="cart-layout">
        <div className="stack" style={{ "--gap": "16px" }}>
          {o.fulfilments.map((f) => <Shipment key={f.id} order={o} f={f} onChange={order.mutate} />)}
        </div>
        <aside className="stack" style={{ "--gap": "16px" }}>
          <section className="card"><div className="card__body stack">
            <h2>Payment</h2>
            <SummaryRows
              rows={[
                { label: "Items", value: rupees(o.items_paise) },
                { label: "Delivery", value: o.shipping_paise ? rupees(o.shipping_paise) : "Free" },
                { label: "Includes GST", value: rupeesRounded(o.gst_paise), muted: true },
              ]}
              total={{ label: o.payment_method === "cod" ? "Cash on delivery" : "Paid online", value: rupees(o.total_paise) }}
            />
            <StatusBadge status={o.payment_status} />
          </div></section>
          <section className="card"><div className="card__body stack" style={{ "--gap": "6px" }}>
            <h2>Delivering to</h2>
            <p className="small"><strong>{o.address.full_name}</strong><br />{o.address.line1}{o.address.line2 ? `, ${o.address.line2}` : ""}<br />{o.address.city}, {o.address.state} {o.address.pincode}<br /><span className="muted">{o.address.phone}</span></p>
            {o.vehicle_label && <p className="small muted">For {o.vehicle_label}</p>}
          </div></section>
        </aside>
      </div>
    </div>
  );
}
