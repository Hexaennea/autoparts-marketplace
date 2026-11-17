import { useEffect, useMemo, useState } from "react";
import { LuBanknote, LuCircleCheck, LuCreditCard, LuFlaskConical, LuMapPin, LuPlus } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { rupees, rupeesRounded } from "../../lib/format";
import { invalidate, useQuery } from "../../lib/query";
import { Link, Redirect, useRouter } from "../../lib/router";
import type { Address, Order } from "../../lib/types";
import { useCart, useConfig, useToast, useVehicle } from "../../state/app";
import { SummaryRows } from "../../ui/commerce";
import { Alert, Button, Dialog, ErrorState, Skeleton } from "../../ui/core";
import { AddressForm } from "./AddressForm";

function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function CheckoutPage() {
  const { quote, reload } = useCart();
  const { vehicle } = useVehicle();
  const toast = useToast();
  const { navigate } = useRouter();
  const addresses = useQuery<Address[]>("/api/me/addresses");
  const [addressId, setAddressId] = useState<number | null>(null);
  const [method, setMethod] = useState<"cod" | "online">("cod");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per checkout visit: a double-click or retry can't create two orders.
  const key = useMemo(newKey, []);

  useEffect(() => {
    if (addressId === null && addresses.data?.length) setAddressId((addresses.data.find((a) => a.is_default) ?? addresses.data[0]!).id);
  }, [addresses.data, addressId]);

  if (quote && quote.groups.length === 0) return <Redirect to="/cart" />;

  const place = async () => {
    if (!addressId) { setError("Choose a delivery address."); return; }
    setBusy(true);
    setError(null);
    try {
      const order = await api.post<Order>("/api/orders", {
        address_id: addressId, payment_method: method, idempotency_key: key,
        vehicle_label: vehicle ? `${vehicle.variant.make} ${vehicle.variant.model} ${vehicle.variant.name} (${vehicle.year})` : undefined,
      });
      invalidate("/api/orders");
      await reload();
      if (order.payment) navigate(`/orders/${order.id}/pay`, { replace: true });
      else { toast(`Order ${order.number} placed.`); navigate(`/orders/${order.id}?placed=1`, { replace: true }); }
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.code === "cart_changed") await reload();
    } finally {
      setBusy(false);
    }
  };

  const s = quote?.summary;
  return (
    <div className="container page">
      <h1 className="page__title">Checkout</h1>
      <div className="cart-layout">
        <div className="stack" style={{ "--gap": "16px" }}>
          <section className="card">
            <header className="card__head"><h2><span className="step-n">1</span> Delivery address</h2><Button size="sm" icon={LuPlus} onClick={() => setAdding(true)}>Add address</Button></header>
            <div className="card__body">
              {addresses.loading && <Skeleton height={80} />}
              {addresses.error && <ErrorState message={addresses.error.message} onRetry={addresses.reload} />}
              {addresses.data?.length === 0 && (
                <div className="stack">
                  <p className="muted">Add the address where the parts should be delivered.</p>
                  <AddressForm onSaved={(a) => { addresses.reload(); setAddressId(a.id); }} submitLabel="Save and use this address" />
                </div>
              )}
              <div className="address-grid" role="radiogroup" aria-label="Delivery address">
                {addresses.data?.map((a) => (
                  <label key={a.id} className="radio-card">
                    <input type="radio" name="address" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                    <span className="small">
                      <strong className="row" style={{ "--gap": "6px" }}><LuMapPin aria-hidden="true" size={14} />{a.full_name}</strong>
                      {a.line1}{a.line2 ? `, ${a.line2}` : ""}<br />{a.city}, {a.state} {a.pincode}<br /><span className="muted">{a.phone}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <header className="card__head"><h2><span className="step-n">2</span> Payment</h2></header>
            <div className="card__body stack" style={{ "--gap": "10px" }} role="radiogroup" aria-label="Payment method">
              <label className="radio-card">
                <input type="radio" name="pay" checked={method === "cod"} onChange={() => setMethod("cod")} />
                <span><strong className="row" style={{ "--gap": "6px" }}><LuBanknote aria-hidden="true" size={16} /> Cash on delivery</strong><span className="small muted">Pay each seller's courier when your parts arrive.</span></span>
              </label>
              <label className="radio-card">
                <input type="radio" name="pay" checked={method === "online"} onChange={() => setMethod("online")} />
                <span><strong className="row" style={{ "--gap": "6px" }}><LuCreditCard aria-hidden="true" size={16} /> Pay online</strong><span className="small muted">UPI, cards and net banking. Refunds go back automatically if a seller cancels.</span></span>
              </label>
            </div>
          </section>

          <section className="card">
            <header className="card__head"><h2><span className="step-n">3</span> Review items</h2><Link to="/cart" className="small">Edit cart</Link></header>
            <ul className="review-lines">
              {quote?.groups.map((g) => g.lines.map((l) => (
                <li key={l.product_id}><span className="grow"><span className="strong">{l.title}</span><span className="small muted"> · {l.brand} {l.part_number} · {g.seller.name}</span></span><span className="nowrap">{l.quantity} × {rupees(l.price_paise)}</span></li>
              )))}
            </ul>
            {vehicle && <div className="card__foot small">Fitment checked for <strong>{vehicle.variant.make} {vehicle.variant.model} {vehicle.variant.name} ({vehicle.year})</strong> — sellers see this on your order.</div>}
          </section>
        </div>

        <aside className="card cart-summary" aria-label="Order total">
          <div className="card__body stack">
            <h2>Total to pay</h2>
            {s ? (
              <SummaryRows
                rows={[
                  { label: `Items (${s.item_count})`, value: rupees(s.items_paise) },
                  { label: "Delivery", value: s.shipping_paise ? rupees(s.shipping_paise) : "Free" },
                  { label: "Includes GST", value: rupeesRounded(s.gst_paise), muted: true },
                ]}
                total={{ label: method === "cod" ? "Pay on delivery" : "Pay now", value: rupees(s.total_paise) }}
              />
            ) : <Skeleton height={120} />}
            {error && <Alert kind="bad">{error}</Alert>}
            <Button variant="primary" size="lg" block busy={busy} disabled={!quote || !addressId} onClick={() => void place()}>
              {method === "cod" ? "Place order" : "Continue to payment"}
            </Button>
            <p className="xs muted">By placing the order you agree to the seller's 7-day wrong-fit return policy.</p>
          </div>
        </aside>
      </div>
      <Dialog open={adding} onClose={() => setAdding(false)} title="New address" wide>
        <AddressForm onSaved={(a) => { setAdding(false); addresses.reload(); setAddressId(a.id); }} submitLabel="Save address" />
      </Dialog>
    </div>
  );
}

/** Test-mode payment step. In production this screen hands over to the payment provider's checkout. */
export function PaymentPage({ id }: { id: number }) {
  const order = useQuery<Order>(`/api/orders/${id}`);
  const { payments_test_mode } = useConfig();
  const { navigate } = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<"" | "success" | "failure" | "retry">("");
  const o = order.data;

  if (order.error) return <div className="container page"><ErrorState message={order.error.message} /></div>;
  if (!o) return <div className="container page"><Skeleton height={300} /></div>;
  if (!o.payment) return <Redirect to={`/orders/${o.id}`} />;

  const settle = async (outcome: "success" | "failure") => {
    setBusy(outcome);
    try {
      const updated = await api.post<Order>(`/api/orders/${o.id}/payment/confirm`, { intent_id: o.payment!.intent_id, outcome });
      invalidate("/api/orders");
      if (outcome === "success") { toast(`Payment received for ${updated.number}.`); navigate(`/orders/${o.id}?placed=1`, { replace: true }); }
      else { order.mutate(updated); toast("Payment failed. You can try again.", "bad"); }
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally {
      setBusy("");
    }
  };
  const retry = async () => {
    setBusy("retry");
    try { order.mutate(await api.post<Order>(`/api/orders/${o.id}/payment/retry`)); } catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(""); }
  };

  return (
    <div className="container page page--narrow">
      <div className="card paybox">
        <div className="card__body stack" style={{ "--gap": "18px" }}>
          {payments_test_mode && <Alert kind="warn" title="Test payment gateway">No money moves. Choose an outcome to simulate the bank's response.</Alert>}
          <div>
            <div className="micro">Order {o.number}</div>
            <h1 className="paybox__amount">{rupees(o.total_paise)}</h1>
            <p className="small muted">Reference <span className="pn">{o.payment.intent_id.slice(0, 22)}…</span></p>
          </div>
          {o.payment_status === "failed" || o.payment.status !== "created" ? (
            <>
              <Alert kind="bad" title="Payment didn't go through">Your order is saved. Try again, or cancel it from your orders.</Alert>
              <Button variant="primary" busy={busy === "retry"} onClick={() => void retry()}>Try payment again</Button>
            </>
          ) : (
            <div className="row row--wrap">
              <Button variant="primary" icon={LuCircleCheck} busy={busy === "success"} onClick={() => void settle("success")}>Simulate successful payment</Button>
              <Button variant="danger" icon={LuFlaskConical} busy={busy === "failure"} onClick={() => void settle("failure")}>Simulate failure</Button>
            </div>
          )}
          <Link to={`/orders/${o.id}`} className="small">View order instead</Link>
        </div>
      </div>
    </div>
  );
}
