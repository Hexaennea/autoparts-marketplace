import { useState } from "react";
import { LuArrowRight, LuClock, LuFileSpreadsheet, LuListChecks, LuWallet } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { Link } from "../../lib/router";
import type { User } from "../../lib/types";
import { useAuth, useToast } from "../../state/app";
import { Alert, Button, Field } from "../../ui/core";
import { STATES } from "./AddressForm";

const EMPTY = {
  business_name: "", display_name: "", gstin: "", pan: "", phone: "", address_line: "", city: "", state: "", pincode: "",
  bank_account_name: "", bank_account_number: "", bank_ifsc: "",
};

function Application({ onDone }: { onDone: (u: User) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k: keyof typeof EMPTY, upper = false) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: upper ? e.target.value.toUpperCase() : e.target.value });

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const user = await api.post<User>("/api/seller/apply", form);
      toast("Application received. We'll verify your GSTIN and bank details.");
      onDone(user);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        if (err.fields._) setError(err.fields._);
        else if (!Object.keys(err.fields).length) setError(err.message);
      } else setError(errorMessage(err));
    } finally { setBusy(false); }
  };

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <div className="card__body stack" style={{ "--gap": "24px" }}>
        {error && <Alert kind="bad">{error}</Alert>}
        <fieldset className="form-section">
          <legend>Business</legend>
          <div className="form-grid">
            <Field label="Registered business name" error={errors.business_name}>{(p) => <input className="input" {...p} value={form.business_name} maxLength={120} onChange={set("business_name")} />}</Field>
            <Field label="Shop name shown to buyers" error={errors.display_name}>{(p) => <input className="input" {...p} value={form.display_name} maxLength={60} onChange={set("display_name")} />}</Field>
            <Field label="GSTIN" error={errors.gstin} hint="15 characters, e.g. 27AAACT1234Q1Z5">{(p) => <input className="input pn" {...p} value={form.gstin} maxLength={15} onChange={set("gstin", true)} />}</Field>
            <Field label="PAN" error={errors.pan ?? (errors._?.includes("PAN") ? errors._ : undefined)} hint="Must match characters 3–12 of your GSTIN">{(p) => <input className="input pn" {...p} value={form.pan} maxLength={10} onChange={set("pan", true)} />}</Field>
            <Field label="Business mobile" error={errors.phone}>{(p) => <input className="input" {...p} type="tel" value={form.phone} maxLength={14} onChange={set("phone")} />}</Field>
          </div>
        </fieldset>
        <fieldset className="form-section">
          <legend>Pickup address</legend>
          <div className="form-grid">
            <Field label="Shop address" className="span-2" error={errors.address_line}>{(p) => <input className="input" {...p} value={form.address_line} maxLength={200} onChange={set("address_line")} />}</Field>
            <Field label="City" error={errors.city}>{(p) => <input className="input" {...p} value={form.city} maxLength={60} onChange={set("city")} />}</Field>
            <Field label="PIN code" error={errors.pincode}>{(p) => <input className="input" {...p} inputMode="numeric" value={form.pincode} maxLength={6} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, "") })} />}</Field>
            <Field label="State" className="span-2" error={errors.state}>{(p) => <select className="select" {...p} value={form.state} onChange={set("state")}><option value="">Choose state</option>{STATES.map((s) => <option key={s}>{s}</option>)}</select>}</Field>
          </div>
        </fieldset>
        <fieldset className="form-section">
          <legend>Payouts</legend>
          <div className="form-grid">
            <Field label="Account holder name" error={errors.bank_account_name}>{(p) => <input className="input" {...p} value={form.bank_account_name} maxLength={120} onChange={set("bank_account_name")} />}</Field>
            <Field label="Account number" error={errors.bank_account_number} hint="We store only the last 4 digits here.">{(p) => <input className="input pn" {...p} inputMode="numeric" autoComplete="off" value={form.bank_account_number} maxLength={18} onChange={(e) => setForm({ ...form, bank_account_number: e.target.value.replace(/\D/g, "") })} />}</Field>
            <Field label="IFSC" error={errors.bank_ifsc}>{(p) => <input className="input pn" {...p} value={form.bank_ifsc} maxLength={11} onChange={set("bank_ifsc", true)} />}</Field>
          </div>
        </fieldset>
      </div>
      <div className="card__foot row row--between row--wrap">
        <span className="small muted">Reviewed within 2 working days. You can create draft listings meanwhile.</span>
        <Button type="submit" variant="primary" busy={busy} iconRight={LuArrowRight}>Submit application</Button>
      </div>
    </form>
  );
}

export function SellPage() {
  const { user, refresh } = useAuth();
  return (
    <div className="container page sell">
      <div className="sell__intro">
        <h1>Sell car parts on PartPilot</h1>
        <p className="hero__lede">Reach buyers who already know the part fits. You list with exact fitment, ship with your own courier, and get paid after delivery.</p>
        <ul className="sell__points">
          <li><LuListChecks aria-hidden="true" /><span><strong>List with fitment</strong> — tick the variants each part fits; buyers see a clear fit check.</span></li>
          <li><LuFileSpreadsheet aria-hidden="true" /><span><strong>Bulk import</strong> — upload a CSV, fix row-level errors, sync price and stock.</span></li>
          <li><LuWallet aria-hidden="true" /><span><strong>Transparent payouts</strong> — commission and TCS shown on each order; paid after the return window.</span></li>
        </ul>
      </div>
      <div className="sell__form">
        {!user && (
          <div className="card card--pad stack">
            <h2>Start with an account</h2>
            <p className="muted">Create a PartPilot account (or sign in), then fill in your business details.</p>
            <div className="row"><Button to="/register?next=/sell" variant="primary">Create account</Button><Button to="/login?next=/sell">Sign in</Button></div>
          </div>
        )}
        {user?.role === "admin" && <Alert kind="info">Admin accounts can't sell. Use a separate account.</Alert>}
        {user?.role === "buyer" && <Application onDone={() => void refresh()} />}
        {user?.seller && (
          <div className="card card--pad stack">
            {user.seller.status === "approved" ? (
              <><h2>You're a verified seller</h2><Button to="/seller" variant="primary" iconRight={LuArrowRight}>Open seller portal</Button></>
            ) : (
              <>
                <div className="row"><LuClock aria-hidden="true" /><h2>Application {user.seller.status === "rejected" ? "needs changes" : "under review"}</h2></div>
                {user.seller.note && <Alert kind="warn">{user.seller.note}</Alert>}
                <p className="muted">You can already add draft listings. They go live once you're approved and each listing passes review.</p>
                <Link to="/seller">Open seller portal</Link>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
