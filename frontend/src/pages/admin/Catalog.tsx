import { useState } from "react";
import { LuPencil, LuPlus } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { invalidate, useQuery } from "../../lib/query";
import { useSearchParams } from "../../lib/router";
import type { Brand, Category, Variant } from "../../lib/types";
import { useToast } from "../../state/app";
import { Badge, Button, Card, Dialog, ErrorState, Field, PageHeader, Skeleton, Tabs } from "../../ui/core";

interface MakeNode { id: number; name: string; slug: string; country: string | null; is_active: boolean; models: { id: number; make_id: number; name: string; body_type: string; is_active: boolean; variants: Variant[] }[] }

const BODY = ["hatchback", "sedan", "suv", "muv", "pickup", "coupe", "van"];
const FUEL = ["petrol", "diesel", "cng", "electric", "hybrid"];
const TRANS = ["manual", "automatic", "amt", "cvt", "dct"];

type Editing =
  | { kind: "make"; id?: number; name: string; country: string; is_active: boolean }
  | { kind: "model"; id?: number; make_id: number; name: string; body_type: string; is_active: boolean }
  | { kind: "variant"; id?: number; model_id: number; name: string; generation: string; year_from: string; year_to: string; fuel: string; transmission: string; engine_cc: string; engine_code: string; is_active: boolean };

function Vehicles() {
  const q = useQuery<MakeNode[]>("/api/admin/vehicles");
  const toast = useToast();
  const [edit, setEdit] = useState<Editing | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    setErrors({});
    try {
      if (edit.kind === "make") {
        const body = { name: edit.name, country: edit.country || null, is_active: edit.is_active };
        await (edit.id ? api.patch(`/api/admin/makes/${edit.id}`, body) : api.post("/api/admin/makes", body));
      } else if (edit.kind === "model") {
        const body = { make_id: edit.make_id, name: edit.name, body_type: edit.body_type, is_active: edit.is_active };
        await (edit.id ? api.patch(`/api/admin/models/${edit.id}`, body) : api.post("/api/admin/models", body));
      } else {
        const body = {
          model_id: edit.model_id, name: edit.name, generation: edit.generation || null, year_from: Number(edit.year_from),
          year_to: edit.year_to ? Number(edit.year_to) : null, fuel: edit.fuel, transmission: edit.transmission,
          engine_cc: edit.engine_cc ? Number(edit.engine_cc) : null, engine_code: edit.engine_code || null, is_active: edit.is_active,
        };
        await (edit.id ? api.patch(`/api/admin/variants/${edit.id}`, body) : api.post("/api/admin/variants", body));
      }
      invalidate("/api/vehicles");
      q.reload();
      toast("Saved.");
      setEdit(null);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields);
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };

  const variantEdit = (model_id: number, v?: Variant): Editing => ({
    kind: "variant", id: v?.id, model_id, name: v?.name ?? "", generation: v?.generation ?? "", year_from: String(v?.year_from ?? new Date().getFullYear()),
    year_to: v?.year_to ? String(v.year_to) : "", fuel: v?.fuel ?? "petrol", transmission: v?.transmission ?? "manual",
    engine_cc: v?.engine_cc ? String(v.engine_cc) : "", engine_code: v?.engine_code ?? "", is_active: v?.is_active ?? true,
  });

  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  return (
    <div className="stack">
      <div className="row row--between"><p className="small muted">Sellers attach parts to these variants. Deactivate rather than delete — existing fitment keeps working.</p><Button variant="primary" icon={LuPlus} onClick={() => setEdit({ kind: "make", name: "", country: "", is_active: true })}>Add make</Button></div>
      {!q.data && <Skeleton height={240} />}
      <div className="vehicle-tree">
        {q.data?.map((mk) => (
          <details key={mk.id} className="card tree-make">
            <summary>
              <span className="grow">{mk.name} <span className="small muted">· {mk.models.length} models · {mk.models.reduce((s, m) => s + m.variants.length, 0)} variants</span></span>
              {!mk.is_active && <Badge>Inactive</Badge>}
              <span className="row" style={{ "--gap": "4px" }} onClick={(e: { preventDefault: () => void }) => e.preventDefault()}>
                <Button size="sm" variant="ghost" icon={LuPencil} onClick={() => setEdit({ kind: "make", id: mk.id, name: mk.name, country: mk.country ?? "", is_active: mk.is_active })}>Edit</Button>
                <Button size="sm" icon={LuPlus} onClick={() => setEdit({ kind: "model", make_id: mk.id, name: "", body_type: "hatchback", is_active: true })}>Model</Button>
              </span>
            </summary>
            {mk.models.map((mo) => (
              <div key={mo.id} className="tree-model">
                <div className="row row--between" style={{ marginBottom: 8 }}>
                  <span><strong>{mo.name}</strong> <span className="small muted">{mo.body_type}</span> {!mo.is_active && <Badge>Inactive</Badge>}</span>
                  <span className="row" style={{ "--gap": "4px" }}>
                    <Button size="sm" variant="ghost" icon={LuPencil} onClick={() => setEdit({ kind: "model", id: mo.id, make_id: mk.id, name: mo.name, body_type: mo.body_type, is_active: mo.is_active })}>Edit</Button>
                    <Button size="sm" icon={LuPlus} onClick={() => setEdit(variantEdit(mo.id))}>Variant</Button>
                  </span>
                </div>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Variant</th><th>Code</th><th>Years</th><th>Engine</th><th>Fuel / gearbox</th><th className="right">Listings</th><th /></tr></thead>
                  <tbody>{mo.variants.map((v) => (
                    <tr key={v.id}>
                      <td className="strong">{v.name}<span className="cell-sub">{v.generation}</span></td><td className="pn xs">{v.code}</td><td className="nowrap">{v.years}</td>
                      <td>{v.engine_cc ? `${v.engine_cc} cc` : "—"}<span className="cell-sub">{v.engine_code}</span></td><td>{v.fuel_label} · {v.transmission_label}</td>
                      <td className="right">{v.fitment_count}</td>
                      <td>{!v.is_active && <Badge>Inactive</Badge>} <Button size="sm" variant="ghost" icon={LuPencil} aria-label={`Edit ${v.name}`} onClick={() => setEdit(variantEdit(mo.id, v))} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            ))}
          </details>
        ))}
      </div>
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title={edit ? `${edit.id ? "Edit" : "Add"} ${edit.kind}` : ""} wide footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
        {edit && (
          <div className="form-grid">
            <Field label="Name" error={errors.name}>{(p) => <input className="input" {...p} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            {edit.kind === "make" && <Field label="Country" optional error={errors.country}>{(p) => <input className="input" {...p} value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })} />}</Field>}
            {edit.kind === "model" && <Field label="Body type" error={errors.body_type}>{(p) => <select className="select" {...p} value={edit.body_type} onChange={(e) => setEdit({ ...edit, body_type: e.target.value })}>{BODY.map((b) => <option key={b}>{b}</option>)}</select>}</Field>}
            {edit.kind === "variant" && (
              <>
                <Field label="Generation" optional error={errors.generation}>{(p) => <input className="input" {...p} placeholder="e.g. 3rd gen" value={edit.generation} onChange={(e) => setEdit({ ...edit, generation: e.target.value })} />}</Field>
                <Field label="From year" error={errors.year_from}>{(p) => <input className="input" {...p} inputMode="numeric" value={edit.year_from} onChange={(e) => setEdit({ ...edit, year_from: e.target.value.replace(/\D/g, "") })} />}</Field>
                <Field label="To year" optional hint="Blank if still on sale" error={errors.year_to}>{(p) => <input className="input" {...p} inputMode="numeric" value={edit.year_to} onChange={(e) => setEdit({ ...edit, year_to: e.target.value.replace(/\D/g, "") })} />}</Field>
                <Field label="Fuel" error={errors.fuel}>{(p) => <select className="select" {...p} value={edit.fuel} onChange={(e) => setEdit({ ...edit, fuel: e.target.value })}>{FUEL.map((f) => <option key={f}>{f}</option>)}</select>}</Field>
                <Field label="Transmission" error={errors.transmission}>{(p) => <select className="select" {...p} value={edit.transmission} onChange={(e) => setEdit({ ...edit, transmission: e.target.value })}>{TRANS.map((t) => <option key={t}>{t}</option>)}</select>}</Field>
                <Field label="Engine (cc)" optional error={errors.engine_cc}>{(p) => <input className="input" {...p} inputMode="numeric" value={edit.engine_cc} onChange={(e) => setEdit({ ...edit, engine_cc: e.target.value.replace(/\D/g, "") })} />}</Field>
                <Field label="Engine code" optional error={errors.engine_code}>{(p) => <input className="input" {...p} value={edit.engine_code} onChange={(e) => setEdit({ ...edit, engine_code: e.target.value })} />}</Field>
              </>
            )}
            <label className="toggle span-2"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />Active (visible in the car selector)</label>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Categories() {
  const q = useQuery<Category[]>("/api/admin/categories");
  const toast = useToast();
  const [edit, setEdit] = useState<{ id?: number; name: string; parent_id: string; position: string; is_active: boolean; icon: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = async () => {
    if (!edit) return;
    setErrors({});
    const body = { name: edit.name, parent_id: edit.parent_id ? Number(edit.parent_id) : null, position: Number(edit.position) || 0, is_active: edit.is_active, icon: edit.icon };
    try { await (edit.id ? api.patch(`/api/admin/categories/${edit.id}`, body) : api.post("/api/admin/categories", body)); invalidate("/api/categories"); q.reload(); toast("Saved."); setEdit(null); }
    catch (err) { if (err instanceof ApiError) setErrors(err.fields); toast(errorMessage(err), "bad"); }
  };
  const open = (c?: Category, parent?: number) => setEdit({ id: c?.id, name: c?.name ?? "", parent_id: String(c?.parent_id ?? parent ?? ""), position: String(c?.position ?? 0), is_active: c?.is_active ?? true, icon: c?.icon ?? "box" });
  return (
    <div className="stack">
      <div className="row row--between"><p className="small muted">Two levels: a group (Brakes) and its part types (Brake Pads).</p><Button variant="primary" icon={LuPlus} onClick={() => open()}>Add group</Button></div>
      {!q.data && <Skeleton height={240} />}
      <div className="grid-2 grid-2--even">
        {q.data?.map((c) => (
          <Card key={c.id} title={<h2>{c.name} {!c.is_active && <Badge>Inactive</Badge>}</h2>} actions={<><Button size="sm" variant="ghost" icon={LuPencil} onClick={() => open(c)}>Edit</Button><Button size="sm" icon={LuPlus} onClick={() => open(undefined, c.id)}>Type</Button></>}>
            <ul className="queue">{c.children.map((ch) => <li key={ch.id}><a href="#edit" onClick={(e) => { e.preventDefault(); open(ch); }}><span className="grow">{ch.name} {!ch.is_active && <Badge>Inactive</Badge>}</span><span className="small muted">{ch.product_count} live</span><LuPencil size={14} aria-hidden="true" /></a></li>)}</ul>
          </Card>
        ))}
      </div>
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? "Edit category" : "Add category"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        {edit && (
          <div className="stack">
            <Field label="Name" error={errors.name}>{(p) => <input className="input" {...p} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Group" error={errors.parent_id}>{(p) => <select className="select" {...p} value={edit.parent_id} onChange={(e) => setEdit({ ...edit, parent_id: e.target.value })}><option value="">Top-level group</option>{q.data?.filter((c) => c.id !== edit.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
            <Field label="Sort position" error={errors.position}>{(p) => <input className="input" {...p} inputMode="numeric" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value.replace(/\D/g, "") })} />}</Field>
            <label className="toggle"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />Active</label>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Brands() {
  const q = useQuery<Brand[]>("/api/admin/brands");
  const toast = useToast();
  const [edit, setEdit] = useState<{ id?: number; name: string; is_oem: boolean; is_active: boolean } | null>(null);
  const [error, setError] = useState<string | undefined>();
  const save = async () => {
    if (!edit) return;
    setError(undefined);
    const body = { name: edit.name, is_oem: edit.is_oem, is_active: edit.is_active };
    try { await (edit.id ? api.patch(`/api/admin/brands/${edit.id}`, body) : api.post("/api/admin/brands", body)); invalidate("/api/brands"); q.reload(); toast("Saved."); setEdit(null); }
    catch (err) { setError(err instanceof ApiError ? err.fields.name ?? err.message : errorMessage(err)); }
  };
  return (
    <div className="stack">
      <div className="row row--between"><p className="small muted">Only vehicle-maker (OEM) brands can be listed as “OEM genuine”.</p><Button variant="primary" icon={LuPlus} onClick={() => setEdit({ name: "", is_oem: false, is_active: true })}>Add brand</Button></div>
      <Card>
        {!q.data && <div className="card__body"><Skeleton height={200} /></div>}
        {q.data && <div className="table-wrap"><table className="table">
          <thead><tr><th>Brand</th><th>Type</th><th className="right">Listings</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.map((b) => <tr key={b.id}><td className="strong">{b.name}</td><td>{b.is_oem ? <Badge kind="oem">OEM</Badge> : "Aftermarket"}</td><td className="right">{b.product_count}</td><td>{b.is_active ? <Badge kind="ok">Active</Badge> : <Badge>Inactive</Badge>}</td><td><Button size="sm" variant="ghost" icon={LuPencil} onClick={() => setEdit({ id: b.id, name: b.name, is_oem: b.is_oem, is_active: b.is_active ?? true })}>Edit</Button></td></tr>)}</tbody>
        </table></div>}
      </Card>
      <Dialog open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? "Edit brand" : "Add brand"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        {edit && <div className="stack">
          <Field label="Name" error={error}>{(p) => <input className="input" {...p} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
          <label className="toggle"><input type="checkbox" checked={edit.is_oem} onChange={(e) => setEdit({ ...edit, is_oem: e.target.checked })} />Vehicle maker (OEM)</label>
          <label className="toggle"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} />Active</label>
        </div>}
      </Dialog>
    </div>
  );
}

export function CatalogPage() {
  const [params, update] = useSearchParams();
  const tab = (params.get("tab") ?? "vehicles") as "vehicles" | "categories" | "brands";
  return (
    <>
      <PageHeader title="Vehicles &amp; catalogue" />
      <Tabs label="Catalogue" value={tab} onChange={(t) => update({ tab: t === "vehicles" ? null : t })} items={[{ value: "vehicles", label: "Vehicles" }, { value: "categories", label: "Categories" }, { value: "brands", label: "Brands" }]} />
      <div style={{ marginTop: 20 }}>
        {tab === "vehicles" && <Vehicles />}
        {tab === "categories" && <Categories />}
        {tab === "brands" && <Brands />}
      </div>
    </>
  );
}
