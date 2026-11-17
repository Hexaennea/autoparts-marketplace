import { useEffect, useState } from "react";
import { LuArrowRight, LuPackageCheck, LuPrinter, LuSearch, LuTruck } from "react-icons/lu";
import emptyArt from "../../assets/art/timing-belt.svg";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, dateTime, gstPercent, rupees } from "../../lib/format";
import { invalidate, useDebounced, useQuery } from "../../lib/query";
import { Link, useSearchParams } from "../../lib/router";
import type { Fulfilment, Paged } from "../../lib/types";
import { useToast } from "../../state/app";
import { Barcode, FALLBACK_ART, StatusBadge, SummaryRows, TrackingRoute } from "../../ui/commerce";
import { Alert, Button, Card, Dialog, Empty, ErrorState, Field, PageHeader, Pagination, Skeleton, Tabs } from "../../ui/core";

interface Row {
  id: number; status: string; status_label: string; items_paise: number; shipping_paise: number; created_at: string;
  tracking_number: string | null; carrier: string | null; number: string; ship_city: string; ship_state: string;
  payment_method: string; units: number; first_item: string;
}

type Tab = "to_ship" | "shipped" | "delivered" | "return_requested" | "cancelled" | "";

export function SellerOrdersPage() {
  const [params, update] = useSearchParams();
  const status = (params.get("status") ?? "to_ship") as Tab;
  const page = Number(params.get("page") ?? 1) || 1;
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDebounced(text, 300);
  useEffect(() => { if ((params.get("q") ?? "") !== q) update({ q: q || null, page: null }); }, [q, params, update]);
  const list = useQuery<Paged<Row> & { counts: Record<string, number> }>("/api/seller/orders", { status: status || undefined, q: params.get("q") ?? "", page });
  const d = list.data;
  const c = d?.counts ?? {};
  return (
    <>
      <PageHeader title="Orders" subtitle="Pack within a day and ship within two. Buyers see every step." />
      <Card>
        <Tabs<Tab>
          label="Order status"
          value={status}
          onChange={(s) => update({ status: s === "to_ship" ? null : s || "", page: null })}
          items={[
            { value: "to_ship", label: "To ship", count: c.to_ship ?? 0 }, { value: "shipped", label: "Shipped", count: c.shipped ?? 0 },
            { value: "delivered", label: "Delivered", count: c.delivered ?? 0 }, { value: "return_requested", label: "Returns", count: c.return_requested ?? 0 },
            { value: "cancelled", label: "Cancelled", count: c.cancelled ?? 0 }, { value: "", label: "All" },
          ]}
        />
        <div className="toolbar"><div className="input-group"><LuSearch aria-hidden="true" /><input className="input" type="search" placeholder="Order number" aria-label="Search by order number" value={text} onChange={(e) => setText(e.target.value)} /></div></div>
        {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}
        {!d && <div className="card__body stack">{[0, 1, 2].map((i) => <Skeleton key={i} height={48} />)}</div>}
        {d?.total === 0 && <Empty art={emptyArt} title={status === "to_ship" ? "Nothing to ship right now" : "No orders here"}>{status === "to_ship" ? "New orders appear here the moment they're paid or placed on COD." : "Try another tab."}</Empty>}
        {d && d.total > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Order</th><th>Items</th><th>Ship to</th><th>Payment</th><th className="right">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/seller/orders/${r.id}`} className="table-title pn">{r.number}</Link><span className="cell-sub">{dateTime(r.created_at)}</span></td>
                    <td><span className="clamp-2" style={{ maxWidth: 280 }}>{r.first_item}</span><span className="cell-sub">{r.units} unit{r.units === 1 ? "" : "s"}</span></td>
                    <td>{r.ship_city}<span className="cell-sub">{r.ship_state}</span></td>
                    <td>{r.payment_method === "cod" ? "COD" : "Prepaid"}</td>
                    <td className="right strong">{rupees(r.items_paise + r.shipping_paise)}</td>
                    <td><StatusBadge status={r.status} />{r.tracking_number && <span className="cell-sub pn">{r.tracking_number}</span>}</td>
                    <td><Button size="sm" variant="ghost" to={`/seller/orders/${r.id}`} iconRight={LuArrowRight}>Open</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}

interface Detail extends Fulfilment {
  order: { id: number; number: string; created_at: string; payment_method: string; payment_status: string; vehicle_label: string | null };
  ship_to: { full_name: string; phone: string; line1: string; line2: string | null; landmark: string | null; city: string; state: string; pincode: string };
  ship_from: { display_name: string; business_name: string; gstin: string; address_line: string; city: string; state: string; pincode: string; phone: string };
  commission_paise: number; commission_bps: number; tcs_paise: number; net_paise: number; cod_amount_paise: number; actions: string[];
}

const CARRIERS = ["Delhivery", "Blue Dart", "DTDC", "Ekart", "Xpressbees", "Shadowfax", "India Post"];

export function SellerOrderPage({ id }: { id: number }) {
  const q = useQuery<Detail>(`/api/seller/orders/${id}`);
  const toast = useToast();
  const [dialog, setDialog] = useState<"" | "ship" | "cancel" | "reject_return" | "slip">("");
  const [form, setForm] = useState({ carrier: "Delhivery", tracking_number: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const d = q.data;

  const act = async (action: string, body: Record<string, string> = {}) => {
    setBusy(action);
    setErrors({});
    try {
      q.mutate(await api.post<Detail>(`/api/seller/orders/${id}/${action}`, body));
      invalidate("/api/seller/");
      setDialog("");
      toast({ pack: "Marked as packed.", ship: "Shipped — the buyer can track it now.", deliver: "Marked as delivered.", cancel: "Order cancelled and stock restored.", accept_return: "Return accepted. Refund recorded and stock restored.", reject_return: "Return declined." }[action] ?? "Updated.");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(""); }
  };

  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  if (!d) return <Skeleton height={480} />;
  const a = d.ship_to;
  const has = (x: string) => d.actions.includes(x);

  return (
    <>
      <PageHeader
        title={<>Order <span className="pn">{d.order.number}</span></>}
        subtitle={`Placed ${dateTime(d.order.created_at)} · ${d.order.payment_method === "cod" ? "Cash on delivery" : "Prepaid"}`}
        back={{ to: "/seller/orders", label: "Orders" }}
        actions={
          <>
            <Button icon={LuPrinter} onClick={() => setDialog("slip")}>Packing slip</Button>
            {has("pack") && <Button variant="primary" icon={LuPackageCheck} busy={busy === "pack"} onClick={() => void act("pack")}>Mark packed</Button>}
            {has("ship") && <Button variant="primary" icon={LuTruck} onClick={() => setDialog("ship")}>Ship order</Button>}
            {has("deliver") && <Button variant="primary" busy={busy === "deliver"} onClick={() => void act("deliver")}>Mark delivered</Button>}
            {has("accept_return") && <Button variant="primary" busy={busy === "accept_return"} onClick={() => void act("accept_return")}>Accept return</Button>}
            {has("reject_return") && <Button onClick={() => setDialog("reject_return")}>Decline return</Button>}
            {has("cancel") && <Button variant="danger" onClick={() => setDialog("cancel")}>Cancel</Button>}
          </>
        }
      />
      {d.status === "return_requested" && <div style={{ marginBottom: 16 }}><Alert kind="warn" title="The buyer wants to return this">{d.return_reason}</Alert></div>}
      {d.order.vehicle_label && <div style={{ marginBottom: 16 }}><Alert kind="info">Buyer's car: <strong>{d.order.vehicle_label}</strong></Alert></div>}
      <div className="grid-2">
        <div className="stack-lg">
          <Card title="Progress" actions={<StatusBadge status={d.status} />} pad>
            {d.status === "cancelled" ? <Alert kind="bad" title="Cancelled">{d.cancel_reason}</Alert> : <TrackingRoute status={d.status} events={d.events} />}
            {d.tracking_number && <p className="small" style={{ marginTop: 16 }}>{d.carrier} · <span className="pn strong">{d.tracking_number}</span></p>}
          </Card>
          <Card title={`Items (${d.items.reduce((s, i) => s + i.quantity, 0)})`}>
            <ul className="cart-lines">
              {d.items.map((i) => (
                <li key={i.id} className="cart-line">
                  <span className="cart-line__img"><img src={i.image ?? FALLBACK_ART} alt="" width={72} height={72} /></span>
                  <div className="cart-line__info"><div className="micro">{i.brand}</div><Link to={`/seller/listings/${i.product_id}`} className="cart-line__title">{i.title}</Link><div className="small muted"><span className="pn">{i.part_number}</span> · SKU {i.sku} · HSN {i.hsn_code} · GST {gstPercent(i.gst_rate_bps)}</div></div>
                  <div className="cart-line__price"><div className="strong">{i.quantity} × {rupees(i.unit_price_paise)}</div><div className="small">{rupees(i.line_total_paise)}</div></div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="History" pad>
            <ul className="events">{d.events.map((e, i) => <li key={i}><span className="muted">{dateTime(e.created_at)}</span><span><strong>{e.label}</strong>{e.note ? ` — ${e.note}` : ""}</span></li>)}</ul>
          </Card>
        </div>
        <div className="stack-lg">
          <Card title="Ship to" pad>
            <p className="small"><strong>{a.full_name}</strong><br />{a.line1}{a.line2 ? `, ${a.line2}` : ""}{a.landmark ? ` (near ${a.landmark})` : ""}<br />{a.city}, {a.state} <span className="pn">{a.pincode}</span><br />{a.phone}</p>
            {d.cod_amount_paise > 0 && <p className="small" style={{ marginTop: 10 }}>Collect <strong>{rupees(d.cod_amount_paise)}</strong> in cash on delivery.</p>}
          </Card>
          <Card title="Your earnings" pad>
            <SummaryRows
              rows={[
                { label: "Items", value: rupees(d.items_paise) },
                { label: "Delivery charged", value: rupees(d.shipping_paise) },
                { label: `Commission (${d.commission_bps / 100}%)`, value: `− ${rupees(d.commission_paise)}` },
                { label: "TCS (1% under GST)", value: `− ${rupees(d.tcs_paise)}` },
                ...(d.refund_paise ? [{ label: "Refunded to buyer", value: rupees(d.refund_paise), muted: true }] : []),
              ]}
              total={{ label: "You receive", value: rupees(d.status === "cancelled" || d.status === "returned" ? 0 : d.net_paise) }}
            />
            <p className="xs muted" style={{ marginTop: 10 }}>Paid out after delivery and the 7-day return window.</p>
          </Card>
        </div>
      </div>

      <Dialog open={dialog === "ship"} onClose={() => setDialog("")} title="Ship this order" footer={<><Button variant="ghost" onClick={() => setDialog("")}>Not yet</Button><Button variant="primary" busy={busy === "ship"} onClick={() => void act("ship", { carrier: form.carrier, tracking_number: form.tracking_number })}>Confirm shipment</Button></>}>
        <div className="stack">
          <Field label="Courier" error={errors.carrier}>{(p) => <select className="select" {...p} value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })}>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</select>}</Field>
          <Field label="Tracking / AWB number" error={errors.tracking_number} hint="6–40 letters or numbers">{(p) => <input className="input pn" {...p} value={form.tracking_number} maxLength={40} onChange={(e) => setForm({ ...form, tracking_number: e.target.value.replace(/[^A-Za-z0-9-]/g, "") })} />}</Field>
        </div>
      </Dialog>
      <Dialog open={dialog === "cancel" || dialog === "reject_return"} onClose={() => setDialog("")} title={dialog === "cancel" ? "Cancel this order?" : "Decline the return?"} footer={<><Button variant="ghost" onClick={() => setDialog("")}>Back</Button><Button variant="danger" busy={busy === dialog} onClick={() => void act(dialog, { reason: form.reason })}>{dialog === "cancel" ? "Cancel order" : "Decline return"}</Button></>}>
        <Field label={dialog === "cancel" ? "Reason the buyer will see" : "Why is the return declined?"} error={errors.reason}>{(p) => <textarea className="textarea" {...p} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
        {dialog === "cancel" && <p className="xs muted" style={{ marginTop: 8 }}>Stock is restored and any online payment is refunded. Frequent cancellations lower your seller rating.</p>}
      </Dialog>
      <Dialog open={dialog === "slip"} onClose={() => setDialog("")} title="Packing slip" wide footer={<Button variant="primary" icon={LuPrinter} onClick={() => window.print()}>Print</Button>}>
        <div className="packing-slip spec-label">
          <div className="spec-label__head"><span className="spec-label__brand">{d.ship_from.display_name}</span><span className="micro">GSTIN {d.ship_from.gstin}</span></div>
          <div className="spec-label__grid" style={{ "--cols": 2 }}>
            <div className="spec-label__cell"><div className="micro">From</div><div className="small">{d.ship_from.business_name}<br />{d.ship_from.address_line}<br />{d.ship_from.city}, {d.ship_from.state} {d.ship_from.pincode}<br />{d.ship_from.phone}</div></div>
            <div className="spec-label__cell"><div className="micro">Ship to</div><div className="small strong">{a.full_name}<br />{a.line1}{a.line2 ? `, ${a.line2}` : ""}<br />{a.city}, {a.state} {a.pincode}<br />{a.phone}</div></div>
            <div className="spec-label__cell"><div className="micro">Order</div><div className="spec-label__value pn">{d.order.number}</div></div>
            <div className="spec-label__cell"><div className="micro">{d.cod_amount_paise ? "Collect on delivery" : "Payment"}</div><div className="spec-label__value">{d.cod_amount_paise ? rupees(d.cod_amount_paise) : "Prepaid"}</div></div>
            {d.items.map((i) => (
              <div key={i.id} className="spec-label__cell spec-label__cell--wide row row--between">
                <div><div className="small strong">{i.quantity} × {i.title}</div><div className="xs pn">{i.part_number} · SKU {i.sku}</div></div>
                <Barcode value={i.sku} height={36} />
              </div>
            ))}
          </div>
          <div className="spec-label__foot"><span className="xs muted">Placed {date(d.order.created_at)}</span><Barcode value={d.order.number} /></div>
        </div>
      </Dialog>
    </>
  );
}
