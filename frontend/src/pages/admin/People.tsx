import { useEffect, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { date, dateTime, relative, rupees } from "../../lib/format";
import { invalidate, useDebounced, useQuery } from "../../lib/query";
import { Link, useSearchParams } from "../../lib/router";
import type { Paged } from "../../lib/types";
import { useAuth, useToast } from "../../state/app";
import { StatusBadge } from "../../ui/commerce";
import { Badge, Button, Card, Dialog, ErrorState, Field, PageHeader, Pagination, Skeleton, Tabs } from "../../ui/core";

/** Search box bound to ?q= with debounce. */
export function useSearchText(): [string, (v: string) => void, URLSearchParams, (n: Record<string, string | number | null>) => void] {
  const [params, update] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDebounced(text, 300);
  useEffect(() => { if ((params.get("q") ?? "") !== q) update({ q: q || null, page: null }); }, [q, params, update]);
  return [text, setText, params, update];
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="toolbar"><div className="input-group"><LuSearch aria-hidden="true" /><input className="input" type="search" placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div></div>;
}

/* ---------------- sellers ---------------- */

interface SellerRow { id: number; business_name: string; display_name: string; gstin: string; city: string; state: string; kyc_status: string; created_at: string; rating_avg: number; rating_count: number; email: string; active_listings: number }

export function SellersPage() {
  const [text, setText, params, update] = useSearchText();
  const status = params.get("status") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const q = useQuery<Paged<SellerRow> & { counts: Record<string, number> }>("/api/admin/sellers", { status, q: params.get("q") ?? "", page });
  const d = q.data;
  const c = d?.counts ?? {};
  return (
    <>
      <PageHeader title="Sellers" subtitle="Verify GSTIN, PAN and bank details before a seller can publish listings." />
      <Card>
        <Tabs label="Seller status" value={status} onChange={(s) => update({ status: s || null, page: null })}
          items={[{ value: "", label: "All" }, { value: "pending", label: "To verify", count: c.pending ?? 0 }, { value: "approved", label: "Approved", count: c.approved ?? 0 }, { value: "rejected", label: "Rejected", count: c.rejected ?? 0 }, { value: "suspended", label: "Suspended", count: c.suspended ?? 0 }]} />
        <SearchBar value={text} onChange={setText} placeholder="Search name, GSTIN or email" />
        {q.error && <ErrorState message={q.error.message} onRetry={q.reload} />}
        {!d && <div className="card__body"><Skeleton height={160} /></div>}
        {d && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Seller</th><th>GSTIN</th><th>Location</th><th className="right">Live listings</th><th>Rating</th><th>Status</th><th>Applied</th></tr></thead>
            <tbody>{d.items.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/admin/sellers/${s.id}`} className="table-title">{s.display_name}</Link><span className="cell-sub">{s.business_name} · {s.email}</span></td>
                <td className="pn">{s.gstin}</td><td>{s.city}<span className="cell-sub">{s.state}</span></td>
                <td className="right">{s.active_listings}</td><td>{s.rating_count ? `${s.rating_avg.toFixed(1)}★ (${s.rating_count})` : "—"}</td>
                <td><StatusBadge status={s.kyc_status} /></td><td className="nowrap">{date(s.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}

interface SellerDetail extends SellerRow {
  pan: string; phone: string; address_line: string; pincode: string; bank_account_name: string; bank_account_last4: string; bank_ifsc: string;
  kyc_note: string | null; reviewed_at: string | null; full_name: string; user_status: string;
  stats: { listings: number; active_listings: number; orders: number; delivered_paise: number; cancelled: number };
  history: { action: string; detail: string | null; created_at: string }[];
}

export function SellerReviewPage({ id }: { id: number }) {
  const q = useQuery<SellerDetail>(`/api/admin/sellers/${id}`);
  const toast = useToast();
  const [decision, setDecision] = useState<"" | "approve" | "reject" | "suspend" | "reinstate">("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const s = q.data;
  const decide = async () => {
    setBusy(true);
    setError(undefined);
    try {
      q.mutate(await api.post<SellerDetail>(`/api/admin/sellers/${id}/review`, { decision, note }));
      invalidate("/api/admin/");
      toast(`Seller ${decision === "approve" || decision === "reinstate" ? "approved" : decision === "reject" ? "rejected" : "suspended"}.`);
      setDecision("");
      setNote("");
    } catch (err) { setError(err instanceof ApiError ? err.fields.note ?? err.message : errorMessage(err)); } finally { setBusy(false); }
  };
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  if (!s) return <Skeleton height={400} />;
  return (
    <>
      <PageHeader title={s.display_name} subtitle={s.business_name} back={{ to: "/admin/sellers", label: "Sellers" }}
        actions={<>
          {s.kyc_status === "pending" && <><Button variant="primary" onClick={() => setDecision("approve")}>Approve</Button><Button variant="danger" onClick={() => setDecision("reject")}>Reject</Button></>}
          {s.kyc_status === "rejected" && <Button variant="primary" onClick={() => setDecision("approve")}>Approve</Button>}
          {s.kyc_status === "approved" && <Button variant="danger" onClick={() => setDecision("suspend")}>Suspend</Button>}
          {s.kyc_status === "suspended" && <Button variant="primary" onClick={() => setDecision("reinstate")}>Reinstate</Button>}
        </>} />
      <div className="grid-2">
        <Card title="Verification details" actions={<StatusBadge status={s.kyc_status} />} pad>
          <dl className="dl">
            <dt>GSTIN</dt><dd className="pn">{s.gstin}</dd>
            <dt>PAN</dt><dd className="pn">{s.pan} {s.gstin.slice(2, 12) === s.pan ? <Badge kind="ok">Matches GSTIN</Badge> : <Badge kind="bad">Mismatch</Badge>}</dd>
            <dt>Contact</dt><dd>{s.full_name} · {s.email} · {s.phone}</dd>
            <dt>Pickup address</dt><dd>{s.address_line}, {s.city}, {s.state} {s.pincode}</dd>
            <dt>Bank</dt><dd>{s.bank_account_name} · ••••{s.bank_account_last4} · <span className="pn">{s.bank_ifsc}</span></dd>
            <dt>Applied</dt><dd>{dateTime(s.created_at)}</dd>
            {s.reviewed_at && <><dt>Last reviewed</dt><dd>{dateTime(s.reviewed_at)}</dd></>}
            {s.kyc_note && <><dt>Note to seller</dt><dd>{s.kyc_note}</dd></>}
          </dl>
        </Card>
        <div className="stack-lg">
          <div className="kpis" style={{ "--n": 2 }}>
            <div className="kpi"><span className="micro">Listings</span><span className="kpi__value">{s.stats.active_listings}</span><span className="kpi__note">{s.stats.listings} total</span></div>
            <div className="kpi"><span className="micro">Delivered sales</span><span className="kpi__value">{rupees(s.stats.delivered_paise)}</span><span className="kpi__note">{s.stats.orders} orders · {s.stats.cancelled} cancelled</span></div>
          </div>
          <Card title="Decision history">
            {s.history.length === 0 ? <p className="card__body muted">No decisions recorded yet.</p> : (
              <ul className="events" style={{ padding: "8px 20px" }}>{s.history.map((h, i) => <li key={i}><span className="muted">{dateTime(h.created_at)}</span><span><strong>{h.action.replace("seller.", "")}</strong>{h.detail ? ` — ${JSON.parse(h.detail).note ?? ""}` : ""}</span></li>)}</ul>
            )}
          </Card>
        </div>
      </div>
      <Dialog open={decision !== ""} onClose={() => setDecision("")} title={`${decision.charAt(0).toUpperCase()}${decision.slice(1)} this seller?`}
        footer={<><Button variant="ghost" onClick={() => setDecision("")}>Back</Button><Button variant={decision === "reject" || decision === "suspend" ? "danger" : "primary"} busy={busy} onClick={() => void decide()}>Confirm</Button></>}>
        <Field label={decision === "reject" || decision === "suspend" ? "Note to the seller (required)" : "Note (optional)"} error={error}>{(p) => <textarea className="textarea" {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {decision === "suspend" && <p className="xs muted" style={{ marginTop: 8 }}>All of this seller's listings disappear from search immediately. Open orders stay visible to buyers.</p>}
      </Dialog>
    </>
  );
}

/* ---------------- users ---------------- */

interface UserRow { id: number; email: string; full_name: string; phone: string | null; role: string; status: string; created_at: string; orders: number; last_seen: string | null }

export function UsersPage() {
  const [text, setText, params, update] = useSearchText();
  const { user: me } = useAuth();
  const toast = useToast();
  const filter = params.get("status") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const q = useQuery<Paged<UserRow>>("/api/admin/users", { status: filter, q: params.get("q") ?? "", page });
  const d = q.data;
  const setStatus = async (u: UserRow, status: "active" | "suspended") => {
    try {
      await api.post(`/api/admin/users/${u.id}/status`, { status });
      q.mutate((prev) => ({ ...prev!, items: prev!.items.map((x) => (x.id === u.id ? { ...x, status } : x)) }));
      toast(status === "suspended" ? `${u.email} suspended and signed out.` : `${u.email} reactivated.`);
    } catch (err) { toast(errorMessage(err), "bad"); }
  };
  return (
    <>
      <PageHeader title="Users" />
      <Card>
        <Tabs label="User type" value={filter} onChange={(s) => update({ status: s || null, page: null })}
          items={[{ value: "", label: "All" }, { value: "buyer", label: "Shoppers" }, { value: "seller", label: "Sellers" }, { value: "admin", label: "Admins" }, { value: "suspended", label: "Suspended" }]} />
        <SearchBar value={text} onChange={setText} placeholder="Search name or email" />
        {!d && <div className="card__body"><Skeleton height={160} /></div>}
        {d && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>User</th><th>Role</th><th className="right">Orders</th><th>Joined</th><th>Last active</th><th>Status</th><th /></tr></thead>
            <tbody>{d.items.map((u) => (
              <tr key={u.id}>
                <td><span className="strong">{u.full_name}</span><span className="cell-sub">{u.email}{u.phone ? ` · ${u.phone}` : ""}</span></td>
                <td><Badge plain kind={u.role === "admin" ? "ink" : u.role === "seller" ? "info" : undefined}>{u.role}</Badge></td>
                <td className="right">{u.orders}</td><td className="nowrap">{date(u.created_at)}</td><td className="nowrap">{u.last_seen ? relative(u.last_seen) : "—"}</td>
                <td><StatusBadge status={u.status === "active" ? "active" : "suspended"} label={u.status === "active" ? "Active" : "Suspended"} /></td>
                <td>{u.role !== "admin" && u.id !== me?.id && (u.status === "active"
                  ? <Button size="sm" variant="danger" onClick={() => void setStatus(u, "suspended")}>Suspend</Button>
                  : <Button size="sm" onClick={() => void setStatus(u, "active")}>Reactivate</Button>)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}

/* ---------------- audit ---------------- */

interface AuditRow { id: number; action: string; entity: string; entity_id: string | null; detail: Record<string, unknown> | null; ip: string | null; created_at: string; actor_role: string | null; actor: string | null }

export function AuditPage() {
  const [text, setText, params, update] = useSearchText();
  const entity = params.get("entity") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;
  const q = useQuery<Paged<AuditRow> & { entities: string[] }>("/api/admin/audit", { entity, q: params.get("q") ?? "", page });
  const d = q.data;
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every change to money, stock, listings, sellers and settings — who, what and when." />
      <Card>
        <div className="toolbar">
          <div className="input-group"><LuSearch aria-hidden="true" /><input className="input" type="search" placeholder="Action, email or record ID" aria-label="Search audit log" value={text} onChange={(e) => setText(e.target.value)} /></div>
          <select className="select" style={{ width: "auto", height: 36 }} aria-label="Record type" value={entity} onChange={(e) => update({ entity: e.target.value || null, page: null })}>
            <option value="">All records</option>{d?.entities.map((e) => <option key={e}>{e}</option>)}
          </select>
        </div>
        {!d && <div className="card__body"><Skeleton height={200} /></div>}
        {d && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>{d.items.map((a) => (
              <tr key={a.id}>
                <td className="nowrap">{dateTime(a.created_at)}</td>
                <td>{a.actor ?? "system"}<span className="cell-sub">{a.actor_role}</span></td>
                <td className="pn">{a.action}</td>
                <td className="nowrap">{a.entity}{a.entity_id ? ` #${a.entity_id}` : ""}</td>
                <td className="xs" style={{ maxWidth: 320 }}>{a.detail ? Object.entries(a.detail).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ") : "—"}</td>
                <td className="xs muted">{a.ip}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
      </Card>
    </>
  );
}
