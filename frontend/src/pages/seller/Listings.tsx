import { useEffect, useState } from "react";
import { LuCheck, LuPlus, LuSearch } from "react-icons/lu";
import emptyArt from "../../assets/art/spark-plug.svg";
import { api, errorMessage } from "../../lib/api";
import { paiseToInput, parseRupees, relative, rupees } from "../../lib/format";
import { useDebounced, useQuery } from "../../lib/query";
import { Link, useSearchParams } from "../../lib/router";
import type { Paged } from "../../lib/types";
import { useToast } from "../../state/app";
import { FALLBACK_ART, StatusBadge } from "../../ui/commerce";
import { Button, Card, Empty, ErrorState, PageHeader, Pagination, Skeleton, Tabs } from "../../ui/core";

interface Row {
  id: number; sku: string; title: string; part_number: string; price_paise: number; mrp_paise: number; stock: number; status: string;
  moderation_note: string | null; sold_count: number; updated_at: string; brand: string; category: string; fitment_count: number;
  image: string | null; is_universal: boolean;
}

type Status = "" | "active" | "pending" | "draft" | "rejected" | "low_stock" | "archived";

function InlineInventory({ row, onSaved }: { row: Row; onSaved: (r: Partial<Row>) => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(paiseToInput(row.price_paise));
  const [stock, setStock] = useState(String(row.stock));
  const [busy, setBusy] = useState(false);
  const dirty = price !== paiseToInput(row.price_paise) || stock !== String(row.stock);
  const save = async () => {
    const paise = parseRupees(price);
    const qty = Number(stock);
    if (paise === null || !Number.isInteger(qty) || qty < 0) { toast("Enter a valid price and stock.", "bad"); return; }
    setBusy(true);
    try {
      const r = await api.patch<{ price_paise: number; stock: number }>(`/api/seller/products/${row.id}/inventory`, { price_paise: paise, stock: qty });
      onSaved(r);
      toast("Price and stock updated — live immediately.");
    } catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(false); }
  };
  return (
    <form className="inline-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <span className="input-prefix"><span>₹</span><input className="input" aria-label={`Price for ${row.title}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></span>
      <input className="input" style={{ width: 64 }} aria-label={`Stock for ${row.title}`} inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value.replace(/\D/g, ""))} />
      {dirty && <Button type="submit" size="sm" variant="primary" icon={LuCheck} busy={busy} aria-label="Save price and stock" />}
    </form>
  );
}

export function ListingsPage() {
  const [params, update] = useSearchParams();
  const status = (params.get("status") ?? "") as Status;
  const page = Number(params.get("page") ?? 1) || 1;
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDebounced(text, 300);
  useEffect(() => { if ((params.get("q") ?? "") !== q) update({ q: q || null, page: null }); }, [q, params, update]);
  const list = useQuery<Paged<Row> & { counts: Record<string, number> }>("/api/seller/products", { status, q: params.get("q") ?? "", page });
  const d = list.data;
  const c = d?.counts ?? {};
  const all = (c.active ?? 0) + (c.pending ?? 0) + (c.draft ?? 0) + (c.rejected ?? 0);

  return (
    <>
      <PageHeader title="Listings" subtitle="Price and stock changes go live instantly. Changes to title, fitment or part numbers are re-reviewed." actions={<><Button to="/seller/import">Bulk import</Button><Button to="/seller/listings/new" variant="primary" icon={LuPlus}>New listing</Button></>} />
      <Card>
        <Tabs<Status>
          label="Listing status"
          value={status}
          onChange={(s) => update({ status: s || null, page: null })}
          items={[
            { value: "", label: "All", count: all }, { value: "active", label: "Live", count: c.active ?? 0 },
            { value: "pending", label: "In review", count: c.pending ?? 0 }, { value: "rejected", label: "Needs changes", count: c.rejected ?? 0 },
            { value: "draft", label: "Drafts", count: c.draft ?? 0 }, { value: "low_stock", label: "Low stock", count: c.low_stock ?? 0 },
            { value: "archived", label: "Archived", count: c.archived ?? 0 },
          ]}
        />
        <div className="toolbar">
          <div className="input-group"><LuSearch aria-hidden="true" /><input className="input" type="search" placeholder="Search title, SKU or part number" aria-label="Search listings" value={text} onChange={(e) => setText(e.target.value)} /></div>
        </div>
        {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}
        {!d && <div className="card__body stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={52} />)}</div>}
        {d?.total === 0 && (
          <Empty art={emptyArt} title={status || q ? "No listings match" : "List your first part"} action={<Button to="/seller/listings/new" variant="primary" icon={LuPlus}>New listing</Button>}>
            {status || q ? "Try another tab or search." : "Add the part number and tick the cars it fits — buyers then see a clear fit check."}
          </Empty>
        )}
        {d && d.total > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Part</th><th>Status</th><th>Fits</th><th>Price &amp; stock</th><th className="right">Sold</th><th>Updated</th></tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="row" style={{ "--gap": "12px" }}>
                        <img className="thumb" src={r.image ?? FALLBACK_ART} alt="" />
                        <div style={{ minWidth: 0 }}>
                          <Link to={`/seller/listings/${r.id}`} className="table-title clamp-2">{r.title}</Link>
                          <span className="cell-sub"><span className="pn">{r.part_number}</span> · {r.brand} · SKU {r.sku}</span>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} />{r.moderation_note && r.status === "rejected" && <span className="cell-sub bad-text clamp-2" title={r.moderation_note}>{r.moderation_note}</span>}</td>
                    <td className="nowrap">{r.is_universal ? "Universal" : `${r.fitment_count} variants`}</td>
                    <td>{r.status === "archived" ? <span className="muted">{rupees(r.price_paise)} · {r.stock}</span> : <InlineInventory row={r} onSaved={(u) => list.mutate((prev) => ({ ...prev!, items: prev!.items.map((x) => (x.id === r.id ? { ...x, ...u } : x)) }))} />}</td>
                    <td className="right">{r.sold_count}</td>
                    <td className="nowrap muted">{relative(r.updated_at)}</td>
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
