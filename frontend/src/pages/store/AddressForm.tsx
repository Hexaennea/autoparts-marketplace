import { useState } from "react";
import { api, ApiError, errorMessage } from "../../lib/api";
import type { Address } from "../../lib/types";
import { useToast } from "../../state/app";
import { Button, Field } from "../../ui/core";

export const STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh", "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

type Form = Omit<Address, "id" | "line2" | "landmark"> & { line2: string; landmark: string };

export function AddressForm({ initial, onSaved, submitLabel = "Save address" }: { initial?: Address; onSaved: (a: Address) => void; submitLabel?: string }) {
  const [form, setForm] = useState<Form>({
    full_name: initial?.full_name ?? "", phone: initial?.phone ?? "", line1: initial?.line1 ?? "", line2: initial?.line2 ?? "",
    landmark: initial?.landmark ?? "", city: initial?.city ?? "", state: initial?.state ?? "", pincode: initial?.pincode ?? "",
    is_default: initial?.is_default ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setBusy(true);
    setErrors({});
    try {
      const body = { ...form, line2: form.line2 || null, landmark: form.landmark || null };
      const saved = initial ? await api.put<Address>(`/api/me/addresses/${initial.id}`, body) : await api.post<Address>("/api/me/addresses", body);
      toast("Address saved.");
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      if (!(err instanceof ApiError && Object.keys(err.fields).length)) toast(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <Field label="Full name" error={errors.full_name}>{(p) => <input className="input" {...p} autoComplete="name" maxLength={80} value={form.full_name} onChange={set("full_name")} required />}</Field>
      <Field label="Mobile number" error={errors.phone} hint="For the courier to reach you">{(p) => <input className="input" {...p} type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={14} value={form.phone} onChange={set("phone")} required />}</Field>
      <Field label="Flat, house, building" className="span-2" error={errors.line1}>{(p) => <input className="input" {...p} autoComplete="address-line1" maxLength={120} value={form.line1} onChange={set("line1")} required />}</Field>
      <Field label="Area, street" optional error={errors.line2}>{(p) => <input className="input" {...p} autoComplete="address-line2" maxLength={120} value={form.line2} onChange={set("line2")} />}</Field>
      <Field label="Landmark" optional error={errors.landmark}>{(p) => <input className="input" {...p} maxLength={80} value={form.landmark} onChange={set("landmark")} />}</Field>
      <Field label="City" error={errors.city}>{(p) => <input className="input" {...p} autoComplete="address-level2" maxLength={60} value={form.city} onChange={set("city")} required />}</Field>
      <Field label="PIN code" error={errors.pincode}>{(p) => <input className="input" {...p} inputMode="numeric" autoComplete="postal-code" maxLength={6} value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, "") })} required />}</Field>
      <Field label="State" className="span-2" error={errors.state}>
        {(p) => (
          <select className="select" {...p} autoComplete="address-level1" value={form.state} onChange={set("state")} required>
            <option value="">Choose state</option>
            {STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        )}
      </Field>
      <label className="check span-2"><input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} /> Make this my default address</label>
      <div className="span-2"><Button type="submit" variant="primary" busy={busy}>{submitLabel}</Button></div>
    </form>
  );
}
