import { useEffect, useState } from "react";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { useToast } from "../../state/app";
import { StatusBadge } from "../../ui/commerce";
import { Button, Card, ErrorState, Field, PageHeader, Skeleton } from "../../ui/core";
import { STATES } from "../store/AddressForm";

interface Profile {
  id: number; business_name: string; display_name: string; gstin: string; pan: string; phone: string; address_line: string; city: string;
  state: string; pincode: string; bank_account_name: string; bank_account_last4: string; bank_ifsc: string; kyc_status: string;
  kyc_note: string | null; rating_avg: number; rating_count: number; created_at: string; reviewed_at: string | null;
}

export function SellerSettings() {
  const q = useQuery<Profile>("/api/seller/profile");
  const toast = useToast();
  const [form, setForm] = useState({ display_name: "", phone: "", address_line: "", city: "", state: "", pincode: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const p = q.data;
  useEffect(() => { if (p) setForm({ display_name: p.display_name, phone: p.phone, address_line: p.address_line, city: p.city, state: p.state, pincode: p.pincode }); }, [p]);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try { q.mutate(await api.patch<Profile>("/api/seller/profile", form)); toast("Shop details saved."); }
    catch (err) { if (err instanceof ApiError) setErrors(err.fields); toast(errorMessage(err), "bad"); } finally { setBusy(false); }
  };
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  if (!p) return <Skeleton height={400} />;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Shop settings" />
      <div className="grid-2">
        <Card title="Shop and pickup address" pad>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="Shop name shown to buyers" error={errors.display_name}>{(x) => <input className="input" {...x} maxLength={60} value={form.display_name} onChange={set("display_name")} />}</Field>
            <Field label="Business mobile" error={errors.phone}>{(x) => <input className="input" {...x} type="tel" maxLength={14} value={form.phone} onChange={set("phone")} />}</Field>
            <Field label="Address" className="span-2" error={errors.address_line}>{(x) => <input className="input" {...x} maxLength={200} value={form.address_line} onChange={set("address_line")} />}</Field>
            <Field label="City" error={errors.city}>{(x) => <input className="input" {...x} maxLength={60} value={form.city} onChange={set("city")} />}</Field>
            <Field label="PIN code" error={errors.pincode}>{(x) => <input className="input" {...x} maxLength={6} inputMode="numeric" value={form.pincode} onChange={set("pincode")} />}</Field>
            <Field label="State" className="span-2" error={errors.state}>{(x) => <select className="select" {...x} value={form.state} onChange={set("state")}>{STATES.map((s) => <option key={s}>{s}</option>)}</select>}</Field>
            <div className="span-2"><Button type="submit" variant="primary" busy={busy}>Save</Button></div>
          </form>
        </Card>
        <Card title="Verification" pad>
          <dl className="dl">
            <dt>Status</dt><dd><StatusBadge status={p.kyc_status} /></dd>
            <dt>Business</dt><dd>{p.business_name}</dd>
            <dt>GSTIN</dt><dd className="pn">{p.gstin}</dd>
            <dt>PAN</dt><dd className="pn">{p.pan}</dd>
            <dt>Bank</dt><dd>{p.bank_account_name} · ••••{p.bank_account_last4} · <span className="pn">{p.bank_ifsc}</span></dd>
            <dt>Seller since</dt><dd>{date(p.created_at)}</dd>
            {p.reviewed_at && <><dt>Verified</dt><dd>{date(p.reviewed_at)}</dd></>}
          </dl>
          <p className="xs muted" style={{ marginTop: 16 }}>To change GSTIN or bank details, contact seller support — changes are re-verified before the next payout.</p>
        </Card>
      </div>
    </>
  );
}
