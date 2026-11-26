import { useEffect, useState } from "react";
import { LuCircleCheck, LuDownload, LuExternalLink, LuWallet } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, dateTime, paiseToInput, parseRupees, percentOff, relative, rupees, warranty, rupeesRounded } from "../../lib/format";
import { invalidate, useQuery } from "../../lib/query";
import { Link } from "../../lib/router";
import type { Order, Paged, Variant } from "../../lib/types";
import { useToast } from "../../state/app";
import { FALLBACK_ART, StatusBadge, SummaryRows, TrackingRoute } from "../../ui/commerce";
import { Alert, Badge, Button, Card, Dialog, ErrorState, Field, PageHeader, Pagination, Skeleton, Tabs } from "../../ui/core";
import { RefreshButton } from "../../ui/refresh";
import { SearchBar, useSearchText } from "./People";

/* ---------------- listing moderation ---------------- */

interface ModRow {
  id: number; title: string; part_number: string; price_paise: number; mrp_paise: number; stock: number; status: string; updated_at: string;
  condition: string; is_universal: boolean; brand: string; brand_is_oem: boolean; category: string; seller_id: number; seller: string;
  fitment_count: number; image: string | null;
}

export function ModerationPage() {
  const [text, setText, params, update] = useSearchText();
  const status = params.get("status") ?? "pending";
  const page = Number(params.get("page") ?? 1) || 1;
  const q = useQuery<Paged<ModRow> & { counts: Record<string, number> }>("/api/admin/products", { status: status === "all" ? "" : status, q: params.get("q") ?? "", page });
  const d = q.data;
  const c = d?.counts ?? {};
  return (
    <>
      <PageHeader title="Listing review" subtitle="Check the part number, brand, photos and fitment before a listing goes live." />
      <Card>
        <Tabs label="Listing status" value={status} onChange={(s) => update({ status: s === "pending" ? null : s, page: null })}
          items={[{ value: "pending", label: "To review", count: c.pending ?? 0 }, { value: "active", label: "Live", count: c.active ?? 0 }, { value: "rejected", label: "Rejected", count: c.rejected ?? 0 }, { value: "draft", label: "Drafts", count: c.draft ?? 0 }, { value: "all", label: "All" }]} />
        <SearchBar value={text} onChange={setText} placeholder="Search title, part number or seller" />
        {!d && <div className="card__body"><Skeleton height={200} /></div>}
        {d?.total === 0 && <div className="empty"><LuCircleCheck size={40} aria-hidden="true" /><h2>Queue is clear</h2><p>New and edited listings land here for review.</p></div>}
        {d && d.total > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Listing</th><th>Seller</th><th>Type</th><th>Fits</th><th className="right">Price</th><th>Status</th><th>Waiting</th></tr></thead>
            <tbody>{d.items.map((r) => (
              <tr key={r.id}>
                <td><div className="row" style={{ "--gap": "12px" }}><img className="thumb" src={r.image ?? FALLBACK_ART} alt="" /><div><Link to={`/admin/listings/${r.id}`} className="table-title clamp-2">{r.title}</Link><span className="cell-sub"><span className="pn">{r.part_number}</span> · {r.brand} · {r.category}</span></div></div></td>
                <td><Link to={`/admin/sellers/${r.seller_id}`}>{r.seller}</Link></td>
                <td>{r.condition === "oem_genuine" ? <Badge kind="oem">OEM</Badge> : "Aftermarket"}</td>
                <td className="nowrap">{r.is_universal ? "Universal" : `${r.fitment_count} variants`}</td>
                <td className="right">{rupees(r.price_paise)}<span className="cell-sub">{percentOff(r.price_paise, r.mrp_paise)}% off MRP</span></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="nowrap muted">{relative(r.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}

interface AdminListing {
  id: number; sku: string; title: string; description: string; part_number: string; condition: string; price_paise: number; mrp_paise: number;
  stock: number; gst_rate_bps: number; hsn_code: string; warranty_months: number; weight_grams: number; status: string; moderation_note: string | null;
  is_universal: boolean; oem_numbers: string[]; specs: { label: string; value: string }[]; fitment: Variant[];
  images: { id: number; url: string; thumb: string }[]; brand: string; category: string; updated_at: string;
  seller: { id: number; display_name: string; kyc_status: string; city: string };
  same_part_number: { id: number; title: string; seller: string; status: string }[];
}

export function AdminListingPage({ id }: { id: number }) {
  const q = useQuery<AdminListing>(`/api/admin/products/${id}`);
  const toast = useToast();
  const [decision, setDecision] = useState<"" | "approve" | "reject" | "takedown">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const l = q.data;
  const decide = async (d: "approve" | "reject" | "takedown") => {
    setBusy(true);
    setError(undefined);
    try {
      q.mutate(await api.post<AdminListing>(`/api/admin/products/${id}/moderate`, { decision: d, note }));
      invalidate("/api/admin/");
      toast(d === "approve" ? "Approved — the listing is live." : d === "reject" ? "Sent back to the seller with your note." : "Taken down.");
      setDecision("");
      setNote("");
    } catch (err) { setError(err instanceof ApiError ? err.fields.note ?? err.message : errorMessage(err)); } finally { setBusy(false); }
  };
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  if (!l) return <Skeleton height={480} />;
  const groups = new Map<string, Variant[]>();
  l.fitment.forEach((v) => groups.set(`${v.make} ${v.model}`, [...(groups.get(`${v.make} ${v.model}`) ?? []), v]));
  return (
    <>
      <PageHeader title={l.title} subtitle={<>by <Link to={`/admin/sellers/${l.seller.id}`}>{l.seller.display_name}</Link> · {l.seller.city} · updated {relative(l.updated_at)}</>} back={{ to: "/admin/listings", label: "Listing review" }}
        actions={<>
          <Button icon={LuExternalLink} to={`/p/${l.id}`}>Preview</Button>
          {l.status === "pending" && <><Button variant="danger" onClick={() => setDecision("reject")}>Request changes</Button><Button variant="primary" busy={busy && decision === ""} onClick={() => void decide("approve")}>Approve</Button></>}
          {l.status === "active" && <Button variant="danger" onClick={() => setDecision("takedown")}>Take down</Button>}
        </>} />
      {l.seller.kyc_status !== "approved" && <div style={{ marginBottom: 16 }}><Alert kind="warn">This seller is <strong>{l.seller.kyc_status}</strong>; the listing stays hidden until the seller is approved.</Alert></div>}
      {l.moderation_note && <div style={{ marginBottom: 16 }}><Alert kind="info" title="Last review note">{l.moderation_note}</Alert></div>}
      <div className="grid-2">
        <div className="stack-lg">
          <Card title="Part" actions={<StatusBadge status={l.status} />} pad>
            <dl className="dl">
              <dt>Part number</dt><dd className="pn strong">{l.part_number}</dd>
              <dt>Cross-references</dt><dd className="pn">{l.oem_numbers.join(" · ") || "—"}</dd>
              <dt>Brand</dt><dd>{l.brand} {l.condition === "oem_genuine" && <Badge kind="oem">OEM genuine</Badge>}</dd>
              <dt>Category</dt><dd>{l.category}</dd>
              <dt>Price / MRP</dt><dd>{rupees(l.price_paise)} / {rupees(l.mrp_paise)} ({percentOff(l.price_paise, l.mrp_paise)}% off)</dd>
              <dt>Stock · SKU</dt><dd>{l.stock} · <span className="pn">{l.sku}</span></dd>
              <dt>Tax</dt><dd>HSN <span className="pn">{l.hsn_code}</span> · GST {l.gst_rate_bps / 100}%</dd>
              <dt>Warranty · weight</dt><dd>{warranty(l.warranty_months)} · {l.weight_grams} g</dd>
            </dl>
            {l.description && <p className="small" style={{ marginTop: 16, whiteSpace: "pre-line" }}>{l.description}</p>}
          </Card>
          <Card title={l.is_universal ? "Fitment: universal" : `Fitment (${l.fitment.length} variants)`} pad>
            {l.is_universal ? <p className="muted">Marked as universal — check that the category really is universal (oils, fluids, bulbs).</p> : (
              <div className="stack" style={{ "--gap": "12px" }}>
                {Array.from(groups.entries()).map(([name, vs]) => (
                  <div key={name}><strong>{name}</strong><div className="small muted">{vs.map((v) => `${v.name} (${v.years}, ${v.fuel_label} ${v.transmission_label})`).join(" · ")}</div></div>
                ))}
              </div>
            )}
          </Card>
        </div>
        <div className="stack-lg">
          <Card title={`Photos (${l.images.length})`} pad>
            {l.images.length === 0 ? <p className="muted">No photos.</p> : <><img className="thumb-lg" src={l.images[0]!.url} alt="Main photo" /><div className="thumbs-row" style={{ marginTop: 8 }}>{l.images.slice(1).map((i) => <img key={i.id} className="thumb-lg" src={i.thumb} alt="" />)}</div></>}
          </Card>
          <Card title="Same part number elsewhere">
            {l.same_part_number.length === 0 ? <p className="card__body muted">No other listing uses these numbers.</p> : (
              <ul className="queue">{l.same_part_number.map((x) => <li key={x.id}><Link to={`/admin/listings/${x.id}`}><span className="grow">{x.title}<span className="cell-sub">{x.seller}</span></span><StatusBadge status={x.status} /></Link></li>)}</ul>
            )}
          </Card>
        </div>
      </div>
      <Dialog open={decision === "reject" || decision === "takedown"} onClose={() => setDecision("")} title={decision === "reject" ? "Request changes" : "Take down this listing"}
        footer={<><Button variant="ghost" onClick={() => setDecision("")}>Back</Button><Button variant="danger" busy={busy} onClick={() => void decide(decision as "reject" | "takedown")}>{decision === "reject" ? "Send to seller" : "Take down"}</Button></>}>
        <Field label="What should the seller fix?" error={error} hint="The seller sees this note on the listing.">{(p) => <textarea className="textarea" {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

/* ---------------- orders ---------------- */

interface OrderRow { id: number; number: string; created_at: string; total_paise: number; payment_method: string; payment_status: string; ship_city: string; buyer_email: string; buyer_name: string; statuses: string[]; seller_count: number }

export function AdminOrdersPage() {
  const [text, setText, params, update] = useSearchText();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const q = useQuery<Paged<OrderRow> & { counts?: Record<string, number> }>("/api/admin/orders", { status, q: params.get("q") ?? "", page });
  const c = q.data?.counts ?? {};
  const d = q.data;
  return (
    <>
      <PageHeader title="Orders" actions={<RefreshButton onRefresh={async () => { await q.refresh(); invalidate("/api/admin/dashboard"); }} />} />
      <Card>
        <Tabs label="Shipment status" value={status} onChange={(s) => update({ status: s || null, page: null })}
          items={[{ value: "", label: "All", count: c.all }, { value: "to_ship", label: "To ship", count: c.to_ship }, { value: "shipped", label: "Shipped", count: c.shipped }, { value: "delivered", label: "Delivered", count: c.delivered }, { value: "returns", label: "Returns", count: c.returns }, { value: "cancelled", label: "Cancelled", count: c.cancelled }, { value: "unpaid", label: "Unpaid", count: c.unpaid }]} />
        <SearchBar value={text} onChange={setText} placeholder="Order number, buyer name or email" />
        {!d && <div className="card__body"><Skeleton height={200} /></div>}
        {d && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Order</th><th>Buyer</th><th>Sellers</th><th>Payment</th><th className="right">Total</th><th>Shipments</th></tr></thead>
            <tbody>{d.items.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/admin/orders/${o.id}`} className="table-title pn">{o.number}</Link><span className="cell-sub">{dateTime(o.created_at)}</span></td>
                <td>{o.buyer_name}<span className="cell-sub">{o.buyer_email} · {o.ship_city}</span></td>
                <td className="right">{o.seller_count}</td>
                <td><StatusBadge status={o.payment_status} /><span className="cell-sub">{o.payment_method === "cod" ? "COD" : "Online"}</span></td>
                <td className="right strong">{rupees(o.total_paise)}</td>
                <td><div className="row row--wrap" style={{ "--gap": "4px" }}>{o.statuses.map((s) => <StatusBadge key={s} status={s} />)}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}

export function AdminOrderPage({ id }: { id: number }) {
  const q = useQuery<Order>(`/api/admin/orders/${id}`);
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const [cancelId, setCancelId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const o = q.data;
  const act = async (fid: number, action: string, body: Record<string, string> = {}) => {
    setBusy(`${fid}-${action}`);
    try { await api.post(`/api/admin/fulfilments/${fid}/${action}`, body); q.reload(); invalidate("/api/admin/"); toast("Shipment updated."); setCancelId(null); setReason(""); }
    catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(""); }
  };
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  if (!o) return <Skeleton height={400} />;
  return (
    <>
      <PageHeader title={<>Order <span className="pn">{o.number}</span></>} subtitle={`${dateTime(o.created_at)} · ${o.buyer?.name} (${o.buyer?.email})`} back={{ to: "/admin/orders", label: "Orders" }} actions={<RefreshButton onRefresh={() => q.refresh()} />} />
      <div className="grid-2">
        <div className="stack-lg">
          {o.fulfilments.map((f) => (
            <Card key={f.id} title={<h2>{f.seller.name}</h2>} actions={<StatusBadge status={f.status} />} pad>
              <div className="stack" style={{ "--gap": "16px" }}>
                {f.status !== "cancelled" && f.status !== "pending_payment" && <TrackingRoute status={f.status} events={f.events} />}
                <ul className="review-lines" style={{ border: "1px solid var(--rule)", borderRadius: 6 }}>
                  {f.items.map((i) => <li key={i.id}><span className="grow"><span className="strong">{i.title}</span><span className="small muted"> · <span className="pn">{i.part_number}</span></span></span><span className="nowrap">{i.quantity} × {rupees(i.unit_price_paise)}</span></li>)}
                </ul>
                <div className="small muted">Items {rupees(f.items_paise)} · delivery {rupees(f.shipping_paise)} · commission {rupees(f.commission_paise ?? 0)} · TCS {rupees(f.tcs_paise ?? 0)}{f.payout_id ? ` · settled in payout #${f.payout_id}` : ""}{f.refund_paise ? ` · refunded ${rupees(f.refund_paise)}` : ""}</div>
                {f.cancel_reason && <Alert kind="bad" title="Cancelled">{f.cancel_reason}</Alert>}
                {f.return_reason && <Alert kind="warn" title="Return reason">{f.return_reason}</Alert>}
                <div className="row row--wrap">
                  {f.invoice_number && <a className="btn btn--secondary btn--sm" href={`/api/admin/fulfilments/${f.id}/invoice.pdf`} download><LuDownload aria-hidden="true" /> Invoice <span className="pn">{f.invoice_number}</span></a>}
                  {f.status === "shipped" && <Button size="sm" busy={busy === `${f.id}-deliver`} onClick={() => void act(f.id, "deliver")}>Mark delivered</Button>}
                  {f.status === "return_requested" && <><Button size="sm" variant="primary" busy={busy === `${f.id}-accept_return`} onClick={() => void act(f.id, "accept_return")}>Accept return</Button><Button size="sm" onClick={() => void act(f.id, "reject_return", { reason: "Declined after admin review." })}>Decline return</Button></>}
                  {(f.status === "placed" || f.status === "packed") && <Button size="sm" variant="danger" onClick={() => setCancelId(f.id)}>Cancel shipment</Button>}
                </div>
                <details className="history"><summary className="small">Event history</summary><ul className="events">{f.events.map((e, i) => <li key={i}><span className="muted">{dateTime(e.created_at)}</span><span><strong>{e.label}</strong>{e.note ? ` — ${e.note}` : ""}</span></li>)}</ul></details>
              </div>
            </Card>
          ))}
        </div>
        <div className="stack-lg">
          <Card title="Payment" pad>
            <SummaryRows rows={[{ label: "Items", value: rupees(o.items_paise) }, { label: "Delivery", value: rupees(o.shipping_paise) }, { label: "GST included", value: rupeesRounded(o.gst_paise), muted: true }]} total={{ label: "Total", value: rupees(o.total_paise) }} />
            <div style={{ marginTop: 12 }}><StatusBadge status={o.payment_status} /></div>
            {o.payments && o.payments.length > 0 && <ul className="events" style={{ marginTop: 12 }}>{o.payments.map((p) => <li key={p.intent_id}><span className="muted">{dateTime(p.created_at)}</span><span>{p.provider} · {rupees(p.amount_paise)} · <strong>{p.status}</strong></span></li>)}</ul>}
          </Card>
          <Card title="Ship to" pad><p className="small"><strong>{o.address.full_name}</strong><br />{o.address.line1}{o.address.line2 ? `, ${o.address.line2}` : ""}<br />{o.address.city}, {o.address.state} {o.address.pincode}<br />{o.address.phone}</p>{o.vehicle_label && <p className="small muted" style={{ marginTop: 8 }}>For {o.vehicle_label}</p>}</Card>
        </div>
      </div>
      <Dialog open={cancelId !== null} onClose={() => setCancelId(null)} title="Cancel shipment" footer={<><Button variant="ghost" onClick={() => setCancelId(null)}>Back</Button><Button variant="danger" busy={busy.endsWith("cancel")} onClick={() => cancelId && void act(cancelId, "cancel", { reason })}>Cancel shipment</Button></>}>
        <Field label="Reason (shown to buyer and seller)">{(p) => <textarea className="textarea" {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

/* ---------------- payouts ---------------- */

interface AdminPayouts {
  sellers: { id: number; display_name: string; bank_account_last4: string; bank_ifsc: string; eligible_paise: number; eligible_count: number; holding_paise: number }[];
  history: { id: number; reference: string; seller: string; gross_paise: number; commission_paise: number; tcs_paise: number; net_paise: number; fulfilment_count: number; created_at: string }[];
}

export function PayoutsAdminPage() {
  const q = useQuery<AdminPayouts>("/api/admin/payouts");
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const settle = async (sellerId: number) => {
    setBusy(sellerId);
    try { const r = await api.post<{ reference: string; net_paise: number }>("/api/admin/payouts", { seller_id: sellerId }); toast(`Payout ${r.reference} created for ${rupees(r.net_paise)}.`); q.reload(); }
    catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(null); }
  };
  const d = q.data;
  return (
    <>
      <PageHeader title="Payouts" subtitle="Settle delivered orders that are past the return window. Each settlement records commission and TCS for GSTR-8." />
      <div className="stack-lg">
        <Card title="Due to sellers">
          {!d && <div className="card__body"><Skeleton height={120} /></div>}
          {d && d.sellers.length === 0 && <p className="card__body muted">Nothing is due right now.</p>}
          {d && d.sellers.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Seller</th><th>Bank</th><th className="right">Orders ready</th><th className="right">Ready to pay</th><th className="right">In return window</th><th /></tr></thead>
              <tbody>{d.sellers.map((s) => (
                <tr key={s.id}><td><Link to={`/admin/sellers/${s.id}`} className="table-title">{s.display_name}</Link></td><td className="pn">••••{s.bank_account_last4} · {s.bank_ifsc}</td><td className="right">{s.eligible_count}</td><td className="right strong">{rupees(s.eligible_paise)}</td><td className="right muted">{rupees(s.holding_paise)}</td>
                  <td>{s.eligible_paise > 0 && <Button size="sm" variant="primary" icon={LuWallet} busy={busy === s.id} onClick={() => void settle(s.id)}>Settle</Button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card title="Settlement history">
          {d && d.history.length === 0 && <p className="card__body muted">No settlements yet.</p>}
          {d && d.history.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Reference</th><th>Seller</th><th>Date</th><th className="right">Orders</th><th className="right">Gross</th><th className="right">Commission</th><th className="right">TCS</th><th className="right">Net paid</th></tr></thead>
              <tbody>{d.history.map((p) => <tr key={p.id}><td className="pn strong">{p.reference}</td><td>{p.seller}</td><td>{date(p.created_at)}</td><td className="right">{p.fulfilment_count}</td><td className="right">{rupees(p.gross_paise)}</td><td className="right">{rupees(p.commission_paise)}</td><td className="right">{rupees(p.tcs_paise)}</td><td className="right strong">{rupees(p.net_paise)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}

/* ---------------- settings ---------------- */

interface Settings { commission_bps: number; shipping_fee_paise: number; free_shipping_threshold_paise: number; return_window_days: number }

export function SettingsPage() {
  const q = useQuery<Settings>("/api/admin/settings");
  const toast = useToast();
  const [form, setForm] = useState({ commission: "", fee: "", threshold: "", days: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setForm({ commission: String(q.data.commission_bps / 100), fee: paiseToInput(q.data.shipping_fee_paise), threshold: paiseToInput(q.data.free_shipping_threshold_paise), days: String(q.data.return_window_days) }); }, [q.data]);
  const save = async () => {
    const fee = parseRupees(form.fee);
    const threshold = parseRupees(form.threshold);
    const commission = Math.round(Number(form.commission) * 100);
    if (fee === null || threshold === null || !Number.isFinite(commission)) { toast("Enter valid numbers.", "bad"); return; }
    setBusy(true);
    setErrors({});
    try { q.mutate(await api.put<Settings>("/api/admin/settings", { commission_bps: commission, shipping_fee_paise: fee, free_shipping_threshold_paise: threshold, return_window_days: Number(form.days) })); toast("Settings saved. They apply to new orders."); }
    catch (err) { if (err instanceof ApiError) setErrors(err.fields); toast(errorMessage(err), "bad"); } finally { setBusy(false); }
  };
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  return (
    <>
      <PageHeader title="Marketplace settings" subtitle="Changes apply to orders placed after saving. Existing orders keep the rates they were placed with." />
      <Card pad>
        <form className="form-grid" style={{ maxWidth: 720 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Commission (%)" error={errors.commission_bps} hint="Charged on item value, per seller shipment. Max 30%.">{(p) => <input className="input" {...p} inputMode="decimal" value={form.commission} onChange={(e) => setForm({ ...form, commission: e.target.value })} />}</Field>
          <Field label="Return window (days)" error={errors.return_window_days} hint="Also the hold period before payout.">{(p) => <input className="input" {...p} inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value.replace(/\D/g, "") })} />}</Field>
          <Field label="Delivery fee per shipment (₹)" error={errors.shipping_fee_paise}>{(p) => <input className="input" {...p} inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} />}</Field>
          <Field label="Free delivery from (₹ per seller)" error={errors.free_shipping_threshold_paise}>{(p) => <input className="input" {...p} inputMode="decimal" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />}</Field>
          <div className="span-2"><Button type="submit" variant="primary" busy={busy}>Save settings</Button></div>
        </form>
      </Card>
    </>
  );
}
