// Admin accounts (super admins only) and the first-login "choose your own password" screen.
import { useState } from "react";
import { LuUserPlus } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, relative } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { useAuth, useToast } from "../../state/app";
import { Logo } from "../../layouts/StoreLayout";
import { Alert, Badge, Button, Card, Dialog, ErrorState, Field, PageHeader, Skeleton } from "../../ui/core";
import { StatusBadge } from "../../ui/commerce";

interface AdminRow {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  status: "active" | "suspended";
  is_super_admin: boolean;
  must_change_password: boolean;
  created_at: string;
  created_by: string | null;
  last_seen: string | null;
}

const PASSWORD_HINT = "10+ characters with a mix of letters, numbers and symbols. Share it with them privately; they must change it when they first sign in.";

const EMPTY = { full_name: "", email: "", phone: "", password: "", super_admin: false };

function AddAdminDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (a: AdminRow) => void }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const close = () => { setForm(EMPTY); setErrors({}); onClose(); };
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const created = await api.post<AdminRow>("/api/admin/admins", { ...form, phone: form.phone.trim() || null });
      onCreated(created);
      toast(`${created.full_name} can now sign in as ${created.is_super_admin ? "a super admin" : "an admin"}.`);
      close();
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={close} title="Add admin"
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Create admin</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Full name" error={errors.full_name}>{(p) => <input className="input" {...p} autoComplete="off" maxLength={80} value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />}</Field>
        <Field label="Email (used to sign in)" error={errors.email}>{(p) => <input className="input" {...p} type="email" autoComplete="off" maxLength={254} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Phone" optional error={errors.phone}>{(p) => <input className="input" {...p} type="tel" autoComplete="off" maxLength={15} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        <Field label="Temporary password" error={errors.password} hint={PASSWORD_HINT}>{(p) => <input className="input" {...p} type="text" autoComplete="new-password" spellCheck={false} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}</Field>
        <label className="check">
          <input type="checkbox" checked={form.super_admin} onChange={(e) => setForm({ ...form, super_admin: e.target.checked })} />
          <span><strong>Super admin</strong><span className="small muted"> · can also add, block and reset other admins. Give this only to people you fully trust.</span></span>
        </label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ admin, onClose, onDone }: { admin: AdminRow | null; onClose: () => void; onDone: (a: AdminRow) => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const close = () => { setPassword(""); setError(undefined); onClose(); };
  const save = async () => {
    if (!admin) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.post<AdminRow>(`/api/admin/admins/${admin.id}/password`, { password }));
      toast(`Password reset. ${admin.full_name} was signed out and must choose a new one.`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.fields.password ?? err.message : errorMessage(err));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={admin !== null} onClose={close} title={`Reset password · ${admin?.full_name ?? ""}`}
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Reset password</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="New temporary password" error={error} hint={PASSWORD_HINT}>{(p) => <input className="input" {...p} type="text" autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

export function AdminsPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const q = useQuery<{ items: AdminRow[] }>("/api/admin/admins");
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<AdminRow | null>(null);
  const [confirm, setConfirm] = useState<{ admin: AdminRow; kind: "block" | "demote" | "promote" } | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = q.data?.items;
  const replace = (a: AdminRow) => q.mutate((prev) => ({ items: (prev?.items ?? []).some((x) => x.id === a.id) ? prev!.items.map((x) => (x.id === a.id ? a : x)) : [...(prev?.items ?? []), a] }));

  const act = async (a: AdminRow, kind: "block" | "unblock" | "demote" | "promote") => {
    setBusy(true);
    try {
      const updated = kind === "block" || kind === "unblock"
        ? await api.post<AdminRow>(`/api/admin/admins/${a.id}/status`, { status: kind === "block" ? "suspended" : "active" })
        : await api.post<AdminRow>(`/api/admin/admins/${a.id}/role`, { super_admin: kind === "promote" });
      replace(updated);
      toast({ block: `${a.full_name} is blocked and signed out.`, unblock: `${a.full_name} can sign in again.`, promote: `${a.full_name} is now a super admin.`, demote: `${a.full_name} is now an admin.` }[kind]);
      setConfirm(null);
    } catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(false); }
  };

  const supers = rows?.filter((r) => r.is_super_admin && r.status === "active").length ?? 0;
  return (
    <>
      <PageHeader title="Admins" subtitle="People who run the marketplace. Only super admins see this page."
        actions={<Button variant="primary" icon={LuUserPlus} onClick={() => setAdding(true)}>Add admin</Button>} />
      {supers === 1 && <Alert kind="warn" title="Only one super admin">Consider making a second, trusted person a super admin so the marketplace is never locked out.</Alert>}
      <Card>
        {q.error && <ErrorState message={q.error.message} onRetry={q.reload} />}
        {!rows && !q.error && <div className="card__body"><Skeleton height={160} /></div>}
        {rows && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Admin</th><th>Role</th><th>Status</th><th>Added</th><th>Last active</th><th /></tr></thead>
            <tbody>{rows.map((a) => {
              const self = a.id === me?.id;
              return (
                <tr key={a.id}>
                  <td><span className="strong">{a.full_name}{self ? " (you)" : ""}</span><span className="cell-sub">{a.email}{a.phone ? ` · ${a.phone}` : ""}</span></td>
                  <td>{a.is_super_admin ? <Badge kind="ink">Super admin</Badge> : <Badge plain>Admin</Badge>}</td>
                  <td>
                    <StatusBadge status={a.status === "active" ? "active" : "suspended"} label={a.status === "active" ? "Active" : "Blocked"} />
                    {a.must_change_password && a.status === "active" && <span className="cell-sub">Hasn't set own password yet</span>}
                  </td>
                  <td className="nowrap">{date(a.created_at)}{a.created_by && <span className="cell-sub">by {a.created_by}</span>}</td>
                  <td className="nowrap">{a.last_seen ? relative(a.last_seen) : "Never"}</td>
                  <td>
                    {!self && (
                      <div className="row row--wrap" style={{ "--gap": "6px", justifyContent: "flex-end" }}>
                        <Button size="sm" variant="ghost" onClick={() => setResetting(a)}>Reset password</Button>
                        {a.is_super_admin
                          ? <Button size="sm" variant="ghost" onClick={() => setConfirm({ admin: a, kind: "demote" })}>Make admin</Button>
                          : <Button size="sm" variant="ghost" onClick={() => setConfirm({ admin: a, kind: "promote" })}>Make super admin</Button>}
                        {a.status === "active"
                          ? <Button size="sm" variant="danger" onClick={() => setConfirm({ admin: a, kind: "block" })}>Block</Button>
                          : <Button size="sm" onClick={() => void act(a, "unblock")}>Unblock</Button>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      <AddAdminDialog open={adding} onClose={() => setAdding(false)} onCreated={replace} />
      <ResetPasswordDialog admin={resetting} onClose={() => setResetting(null)} onDone={replace} />
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}
        title={confirm ? { block: `Block ${confirm.admin.full_name}?`, demote: `Make ${confirm.admin.full_name} an admin?`, promote: `Make ${confirm.admin.full_name} a super admin?` }[confirm.kind] : ""}
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
          <Button variant={confirm?.kind === "block" ? "danger" : "primary"} busy={busy} onClick={() => confirm && void act(confirm.admin, confirm.kind)}>
            {confirm ? { block: "Block", demote: "Make admin", promote: "Make super admin" }[confirm.kind] : ""}
          </Button></>}>
        <p className="muted">{confirm && {
          block: "They are signed out on every device right away and can't sign in until you unblock them.",
          demote: "They keep running orders, sellers and listings, but can no longer add, block or reset admins.",
          promote: "They will be able to add, block and reset every admin, including you.",
        }[confirm.kind]}</p>
      </Dialog>
    </>
  );
}

/** Shown instead of the admin portal until an admin replaces the password someone else chose. */
export function ChoosePasswordPage() {
  const { user, refresh, logout } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ current_password: "", new_password: "", repeat: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (form.new_password !== form.repeat) {
      setErrors({ repeat: "Passwords don't match." });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.post("/api/auth/password", { current_password: form.current_password, new_password: form.new_password });
      await refresh();
      toast("Password set. Welcome to the admin portal.");
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <div className="choose-pw">
      <div className="choose-pw__card card">
        <div className="card__body stack" style={{ "--gap": "18px" }}>
          <div className="choose-pw__logo"><Logo /></div>
          <div>
            <h1 className="choose-pw__title">Choose your password</h1>
            <p className="muted small">Hi {user?.full_name.split(" ")[0]}, your account was set up by a super admin. Pick a password only you know before you continue.</p>
          </div>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <Field label="Temporary password" error={errors.current_password}>{(p) => <input className="input" {...p} type="password" autoComplete="current-password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} />}</Field>
            <Field label="New password" error={errors.new_password} hint="10+ characters with a mix of letters, numbers and symbols.">{(p) => <input className="input" {...p} type="password" autoComplete="new-password" value={form.new_password} onChange={(e) => setForm({ ...form, new_password: e.target.value })} />}</Field>
            <Field label="Repeat new password" error={errors.repeat}>{(p) => <input className="input" {...p} type="password" autoComplete="new-password" value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })} />}</Field>
            <Button type="submit" variant="primary" block busy={busy}>Set password and continue</Button>
          </form>
          <button type="button" className="link-btn small" onClick={() => void logout()}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
