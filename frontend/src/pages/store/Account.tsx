import { useState } from "react";
import { LuCar, LuPencil, LuPlus, LuTrash2 } from "react-icons/lu";
import heartArt from "../../assets/art/headlight.svg";
import { api, ApiError, errorMessage } from "../../lib/api";
import { useQuery } from "../../lib/query";
import { useSearchParams } from "../../lib/router";
import type { Address, GarageEntry, ProductCard, User } from "../../lib/types";
import { useAuth, useToast, useVehicle } from "../../state/app";
import { ProductGrid } from "../../ui/commerce";
import { Badge, Button, Card, Dialog, Empty, Field, PageHeader, Tabs } from "../../ui/core";
import { MyCarDialog } from "../../ui/vehicle";
import { AddressForm } from "./AddressForm";
import { useWishlist } from "./wishlist";

type Tab = "profile" | "addresses" | "garage" | "wishlist" | "security";

function Profile() {
  const { user, setSession } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ full_name: user?.full_name ?? "", phone: user?.phone ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const updated = await api.patch<User>("/api/me", { full_name: form.full_name, phone: form.phone || null });
      const session = await api.get<{ csrf: string }>("/api/auth/session");
      setSession({ user: updated, csrf: session.csrf });
      toast("Profile saved.");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <Card title="Profile" pad>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Full name" error={errors.full_name}>{(p) => <input className="input" {...p} value={form.full_name} maxLength={80} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />}</Field>
        <Field label="Mobile number" optional error={errors.phone}>{(p) => <input className="input" {...p} type="tel" value={form.phone} maxLength={14} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        <Field label="Email" hint="Contact support to change your sign-in email.">{(p) => <input className="input" {...p} value={user?.email ?? ""} disabled />}</Field>
        <div className="span-2"><Button type="submit" variant="primary" busy={busy}>Save changes</Button></div>
      </form>
    </Card>
  );
}

function Addresses() {
  const list = useQuery<Address[]>("/api/me/addresses");
  const toast = useToast();
  const [editing, setEditing] = useState<Address | "new" | null>(null);
  const remove = async (a: Address) => {
    try { await api.del(`/api/me/addresses/${a.id}`); list.reload(); toast("Address removed."); } catch (err) { toast(errorMessage(err), "bad"); }
  };
  return (
    <Card title="Addresses" actions={<Button size="sm" icon={LuPlus} onClick={() => setEditing("new")}>Add address</Button>} pad>
      {list.data?.length === 0 && <p className="muted">No saved addresses yet.</p>}
      <div className="address-grid">
        {list.data?.map((a) => (
          <div key={a.id} className="address-card">
            <div className="row row--between"><strong>{a.full_name}</strong>{a.is_default && <Badge kind="info" plain>Default</Badge>}</div>
            <p className="small">{a.line1}{a.line2 ? `, ${a.line2}` : ""}{a.landmark ? ` (near ${a.landmark})` : ""}<br />{a.city}, {a.state} {a.pincode}<br /><span className="muted">{a.phone}</span></p>
            <div className="row">
              <Button size="sm" variant="ghost" icon={LuPencil} onClick={() => setEditing(a)}>Edit</Button>
              <Button size="sm" variant="ghost" icon={LuTrash2} onClick={() => void remove(a)}>Remove</Button>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New address" : "Edit address"} wide>
        {editing !== null && <AddressForm initial={editing === "new" ? undefined : editing} onSaved={() => { setEditing(null); list.reload(); }} />}
      </Dialog>
    </Card>
  );
}

function Garage() {
  const list = useQuery<GarageEntry[]>("/api/me/garage");
  const { vehicle, setVehicle } = useVehicle();
  const [open, setOpen] = useState(false);
  const remove = async (id: number) => list.mutate(await api.del<GarageEntry[]>(`/api/me/garage/${id}`));
  return (
    <Card title="My garage" actions={<Button size="sm" icon={LuPlus} onClick={() => setOpen(true)}>Add a car</Button>} pad>
      {list.data?.length === 0 && <p className="muted">Save the cars you buy parts for and switch between them in one tap.</p>}
      <ul className="garage-list garage-list--page">
        {list.data?.map((g) => {
          const current = vehicle?.variant.id === g.variant.id && vehicle.year === g.year;
          return (
            <li key={g.id} className={current ? "is-current" : ""}>
              <LuCar aria-hidden="true" />
              <div className="grow"><strong>{g.variant.make} {g.variant.model} {g.variant.name}</strong><div className="small muted">{g.year} · {g.variant.fuel_label} · {g.variant.transmission_label}{g.variant.engine_cc ? ` · ${g.variant.engine_cc} cc` : ""}</div></div>
              {current ? <Badge kind="ok">Shopping for this car</Badge> : <Button size="sm" onClick={() => setVehicle({ variant: g.variant, year: g.year })}>Shop for this car</Button>}
              <Button size="sm" variant="ghost" icon={LuTrash2} aria-label={`Remove ${g.label}`} onClick={() => void remove(g.id)} />
            </li>
          );
        })}
      </ul>
      <MyCarDialog open={open} onClose={() => { setOpen(false); list.reload(); }} />
    </Card>
  );
}

function Wishlist() {
  const list = useQuery<ProductCard[]>("/api/me/wishlist");
  const wish = useWishlist();
  if (list.data?.length === 0) return <Card pad><Empty art={heartArt} title="Nothing saved yet" action={<Button to="/search">Browse parts</Button>}>Tap the heart on any part to keep it here.</Empty></Card>;
  return <ProductGrid products={list.data?.filter((p) => wish.ids.has(p.id) || !wish.ids.size)} loading={list.loading} wishlist={wish.ids} onWish={wish.toggle} skeletons={4} />;
}

function Security() {
  const toast = useToast();
  const [form, setForm] = useState({ current_password: "", new_password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.post("/api/auth/password", form);
      setForm({ current_password: "", new_password: "" });
      toast("Password changed. Other devices have been signed out.");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <Card title="Password" pad>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Current password" error={errors.current_password}>{(p) => <input className="input" {...p} type="password" autoComplete="current-password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />}</Field>
        <Field label="New password" error={errors.new_password} hint="10+ characters with a mix of letters, numbers and symbols.">{(p) => <input className="input" {...p} type="password" autoComplete="new-password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />}</Field>
        <div className="span-2"><Button type="submit" variant="primary" busy={busy}>Change password</Button></div>
      </form>
    </Card>
  );
}

export function AccountPage() {
  const [params, update] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "profile";
  return (
    <div className="container page">
      <PageHeader title="Your account" />
      <Tabs<Tab>
        label="Account sections"
        value={tab}
        onChange={(t) => update({ tab: t === "profile" ? null : t })}
        items={[
          { value: "profile", label: "Profile" }, { value: "addresses", label: "Addresses" }, { value: "garage", label: "My garage" },
          { value: "wishlist", label: "Wishlist" }, { value: "security", label: "Security" },
        ]}
      />
      <div className="account-body">
        {tab === "profile" && <Profile />}
        {tab === "addresses" && <Addresses />}
        {tab === "garage" && <Garage />}
        {tab === "wishlist" && <Wishlist />}
        {tab === "security" && <Security />}
      </div>
    </div>
  );
}
