import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { LuArchive, LuArrowLeft, LuArrowRight, LuCheck, LuCircle, LuExternalLink, LuImagePlus, LuPlus, LuRotateCcw, LuSend, LuTrash2, LuX } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { paiseToInput, parseRupees, percentOff, rupees, warranty } from "../../lib/format";
import { invalidate, useQuery } from "../../lib/query";
import { Link, useRouter } from "../../lib/router";
import type { Brand, Category, Make, Model, Variant } from "../../lib/types";
import { useAuth, useToast } from "../../state/app";
import { SpecLabel, StatusBadge } from "../../ui/commerce";
import { Alert, Button, Card, ErrorState, Field, PageHeader, Skeleton } from "../../ui/core";

interface Listing {
  id: number; sku: string; title: string; description: string; category_id: number; brand_id: number; part_number: string;
  condition: "new" | "oem_genuine"; price_paise: number; mrp_paise: number; stock: number; gst_rate_bps: number; hsn_code: string;
  warranty_months: number; weight_grams: number; status: string; moderation_note: string | null; is_universal: boolean;
  oem_numbers: string[]; specs: { label: string; value: string }[]; fitment: Variant[];
  images: { id: number; url: string; thumb: string }[]; brand: string; category: string;
}

interface FormState {
  title: string; sku: string; category_id: string; brand_id: string; part_number: string; oem_numbers: string[];
  condition: "new" | "oem_genuine"; price: string; mrp: string; stock: string; gst_rate_bps: string; hsn_code: string;
  warranty_months: string; weight_grams: string; description: string; specs: { label: string; value: string }[];
  is_universal: boolean; images: { id: number; url: string; thumb: string }[];
}

const EMPTY: FormState = {
  title: "", sku: "", category_id: "", brand_id: "", part_number: "", oem_numbers: [], condition: "new", price: "", mrp: "",
  stock: "10", gst_rate_bps: "1800", hsn_code: "8708", warranty_months: "6", weight_grams: "500", description: "", specs: [],
  is_universal: false, images: [],
};

/* ---------------- fitment picker ---------------- */

function ModelVariants({ model, selected, toggle, setMany }: { model: Model; selected: Map<number, Variant>; toggle: (v: Variant) => void; setMany: (vs: Variant[], on: boolean) => void }) {
  const variants = useQuery<Variant[]>(`/api/vehicles/models/${model.id}/variants`);
  const list = variants.data ?? [];
  const chosen = list.filter((v) => selected.has(v.id)).length;
  const all = list.length > 0 && chosen === list.length;
  const generations = Array.from(new Set(list.map((v) => v.generation ?? "")));
  return (
    <div className="fitpick__model">
      <div className="fitpick__model-head">
        <label className="check grow">
          <input type="checkbox" checked={all} ref={(el: HTMLInputElement | null) => { if (el) el.indeterminate = chosen > 0 && !all; }} onChange={() => setMany(list, !all)} disabled={!list.length} />
          <strong>{model.name}</strong>
        </label>
        <span className="xs muted">{chosen ? `${chosen} of ${list.length}` : `${list.length} variants`}</span>
      </div>
      {variants.loading && <div style={{ padding: 12 }}><Skeleton height={14} /></div>}
      {generations.map((gen) => (
        <div key={gen}>
          {generations.length > 1 && <div className="micro" style={{ padding: "8px 12px 0" }}>{gen || "Other"}</div>}
          <div className="fitpick__variants">
            {list.filter((v) => (v.generation ?? "") === gen).map((v) => (
              <label key={v.id} className="check">
                <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v)} />
                <span>{v.name} <span className="muted">· {v.years} · {v.fuel_label} {v.transmission_label}</span></span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FitmentPicker({ selected, onChange }: { selected: Map<number, Variant>; onChange: (m: Map<number, Variant>) => void }) {
  const makes = useQuery<Make[]>("/api/vehicles/makes");
  const [makeId, setMakeId] = useState<number | null>(null);
  useEffect(() => { if (makeId === null && makes.data?.length) setMakeId((selected.values().next().value as Variant | undefined)?.make_id ?? makes.data[0]!.id); }, [makes.data, makeId, selected]);
  const models = useQuery<Model[]>(makeId ? `/api/vehicles/makes/${makeId}/models` : null);
  const toggle = (v: Variant) => { const next = new Map(selected); if (next.has(v.id)) next.delete(v.id); else next.set(v.id, v); onChange(next); };
  const setMany = (vs: Variant[], on: boolean) => { const next = new Map(selected); vs.forEach((v) => (on ? next.set(v.id, v) : next.delete(v.id))); onChange(next); };
  const perMake = (id: number) => Array.from(selected.values()).filter((v) => v.make_id === id).length;
  const groups = useMemo(() => {
    const out = new Map<string, Variant[]>();
    selected.forEach((v) => { const key = `${v.make} ${v.model}`; out.set(key, [...(out.get(key) ?? []), v]); });
    return Array.from(out.entries());
  }, [selected]);

  return (
    <div>
      <div className="fitpick">
        <div className="fitpick__makes" role="tablist" aria-label="Makes">
          {makes.data?.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={m.id === makeId} className={`fitpick__make ${m.id === makeId ? "is-active" : ""}`} onClick={() => setMakeId(m.id)}>
              {m.name} {perMake(m.id) > 0 && <span className="tab__count">{perMake(m.id)}</span>}
            </button>
          ))}
        </div>
        <div className="fitpick__models">
          {models.loading && <Skeleton height={120} />}
          {models.data?.map((m) => <ModelVariants key={m.id} model={m} selected={selected} toggle={toggle} setMany={setMany} />)}
        </div>
      </div>
      {groups.length > 0 && (
        <div className="fitpick__summary" aria-label="Selected vehicles">
          {groups.map(([name, vs]) => (
            <span key={name} className="chip">
              <strong>{name}</strong> · {vs.length}
              <button type="button" aria-label={`Remove all ${name}`} onClick={() => setMany(vs, false)}><LuX /></button>
            </span>
          ))}
          <button type="button" className="link-btn small" onClick={() => onChange(new Map())}>Clear all</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- photos ---------------- */

function Photos({ images, onChange, error }: { images: FormState["images"]; onChange: (imgs: FormState["images"]) => void; error?: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).slice(0, 8 - images.length);
    let next = [...images];
    for (const file of list) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast(`${file.name}: use JPEG, PNG or WebP.`, "bad"); continue; }
      if (file.size > 5 * 1024 * 1024) { toast(`${file.name} is over 5 MB.`, "bad"); continue; }
      setBusy((n) => n + 1);
      try {
        const media = await api.upload<{ id: number; url: string; thumb: string }>("/api/seller/media", file);
        next = [...next, media];
        onChange(next);
      } catch (err) { toast(`${file.name}: ${errorMessage(err)}`, "bad"); } finally { setBusy((n) => n - 1); }
    }
  };
  const move = (i: number, d: -1 | 1) => { const next = [...images]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x!); onChange(next); };
  const onDrop = (e: DragEvent<HTMLButtonElement>) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files); };
  return (
    <div className="stack" style={{ "--gap": "10px" }}>
      <div className="photo-grid">
        {images.map((img, i) => (
          <div key={img.id} className="photo">
            <img src={img.thumb} alt={`Photo ${i + 1}`} />
            {i === 0 && <span className="photo__main">Main</span>}
            <div className="photo__tools">
              <span className="row" style={{ "--gap": "4px" }}>
                <button type="button" aria-label="Move left" disabled={i === 0} onClick={() => move(i, -1)}><LuArrowLeft /></button>
                <button type="button" aria-label="Move right" disabled={i === images.length - 1} onClick={() => move(i, 1)}><LuArrowRight /></button>
              </span>
              <button type="button" aria-label="Remove photo" onClick={() => onChange(images.filter((x) => x.id !== img.id))}><LuTrash2 /></button>
            </div>
          </div>
        ))}
        {images.length < 8 && (
          <button type="button" className={`dropzone ${over ? "is-over" : ""}`} onClick={() => input.current?.click()} onDragOver={(e: DragEvent<HTMLButtonElement>) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} aria-busy={busy > 0}>
            <LuImagePlus aria-hidden="true" />
            <span>{busy ? "Uploading…" : "Add photos"}</span>
            <span>JPEG, PNG, WebP · 5 MB</span>
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
      {error ? <span className="field__error">{error}</span> : <span className="field__hint">Up to 8 photos on a plain background. Show the part number stamped on the part where you can.</span>}
    </div>
  );
}

/* ---------------- cross-reference chips ---------------- */

function NumberChips({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState("");
  const commit = () => {
    const parts = text.split(/[,;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 40);
    if (parts.length) onChange(Array.from(new Set([...values, ...parts])).slice(0, 20));
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); } };
  return (
    <div className="stack" style={{ "--gap": "8px" }}>
      <input className="input pn" placeholder="Type a number and press Enter" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={commit} aria-label="Add cross-reference number" />
      {values.length > 0 && <div className="chips">{values.map((v) => <span key={v} className="chip pn">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><LuX /></button></span>)}</div>}
    </div>
  );
}

/* ---------------- editor ---------------- */

export function ListingEditor({ id }: { id?: number }) {
  const { navigate } = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const listing = useQuery<Listing>(id ? `/api/seller/products/${id}` : null);
  const categories = useQuery<Category[]>("/api/categories");
  const brands = useQuery<Brand[]>("/api/brands");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [fitment, setFitment] = useState<Map<number, Variant>>(new Map());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "save" | "submit" | "archive">("");
  const approved = user?.seller?.status === "approved";
  const l = listing.data;

  useEffect(() => {
    if (!l) return;
    setForm({
      title: l.title, sku: l.sku, category_id: String(l.category_id), brand_id: String(l.brand_id), part_number: l.part_number,
      oem_numbers: l.oem_numbers, condition: l.condition, price: paiseToInput(l.price_paise), mrp: paiseToInput(l.mrp_paise),
      stock: String(l.stock), gst_rate_bps: String(l.gst_rate_bps), hsn_code: l.hsn_code, warranty_months: String(l.warranty_months),
      weight_grams: String(l.weight_grams), description: l.description, specs: l.specs, is_universal: l.is_universal, images: l.images,
    });
    setFitment(new Map(l.fitment.map((v) => [v.id, v])));
  }, [l]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const brand = brands.data?.find((b) => String(b.id) === form.brand_id);
  const price = parseRupees(form.price);
  const mrp = parseRupees(form.mrp);
  const checklist = [
    { ok: form.title.trim().length >= 8 && form.part_number.trim().length >= 3, label: "Title and part number" },
    { ok: Boolean(form.category_id && form.brand_id), label: "Category and brand" },
    { ok: form.is_universal || fitment.size > 0, label: "Vehicles it fits" },
    { ok: form.images.length > 0, label: "At least one photo" },
    { ok: price !== null && mrp !== null && mrp >= price, label: "Price and MRP" },
  ];

  const save = async (submit: boolean) => {
    const fieldErrors: Record<string, string> = {};
    if (price === null) fieldErrors.price_paise = "Enter a price in rupees.";
    if (mrp === null) fieldErrors.mrp_paise = "Enter the MRP in rupees.";
    if (Object.keys(fieldErrors).length) { setErrors(fieldErrors); setBanner("Please check the highlighted fields."); return; }
    setBusy(submit ? "submit" : "save");
    setErrors({});
    setBanner(null);
    const body = {
      title: form.title, sku: form.sku.trim(), category_id: Number(form.category_id) || 0, brand_id: Number(form.brand_id) || 0,
      part_number: form.part_number, oem_numbers: form.oem_numbers, condition: brand?.is_oem ? form.condition : "new",
      price_paise: price, mrp_paise: mrp, stock: Number(form.stock) || 0, gst_rate_bps: Number(form.gst_rate_bps),
      hsn_code: form.hsn_code.trim(), warranty_months: Number(form.warranty_months) || 0, weight_grams: Number(form.weight_grams) || 1,
      description: form.description, specs: form.specs.filter((s) => s.label.trim() && s.value.trim()),
      is_universal: form.is_universal, variant_ids: form.is_universal ? [] : Array.from(fitment.keys()),
      image_ids: form.images.map((i) => i.id), submit,
    };
    try {
      const saved = id ? await api.put<Listing>(`/api/seller/products/${id}`, body) : await api.post<Listing>("/api/seller/products", body);
      invalidate("/api/seller/");
      listing.mutate(saved);
      toast(saved.status === "pending" ? "Submitted for review. We usually review within a day." : "Saved.");
      if (!id) navigate(`/seller/listings/${saved.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const [k, v] of Object.entries(err.fields)) mapped[k.split(".")[0]!] = v;
        setErrors(mapped);
      }
      setBanner(errorMessage(err));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally { setBusy(""); }
  };

  const archive = async (action: "archive" | "restore") => {
    setBusy("archive");
    try { listing.mutate(await api.post<Listing>(`/api/seller/products/${id}/${action}`)); invalidate("/api/seller/"); toast(action === "archive" ? "Listing archived." : "Restored as a draft."); }
    catch (err) { toast(errorMessage(err), "bad"); } finally { setBusy(""); }
  };

  if (id && listing.error) return <ErrorState message={listing.error.message} onRetry={listing.reload} />;
  if (id && !l) return <Skeleton height={480} />;

  const status = l?.status ?? "draft";
  const live = status === "active";
  const cat = categories.data?.flatMap((c) => c.children).find((c) => String(c.id) === form.category_id);

  return (
    <>
      <PageHeader
        title={id ? form.title || "Listing" : "New listing"}
        back={{ to: "/seller/listings", label: "Listings" }}
        actions={l && (status === "active" || status === "pending") ? <Button icon={LuExternalLink} to={`/p/${l.id}`}>View as buyer</Button> : undefined}
      />
      {banner && <div style={{ marginBottom: 16 }}><Alert kind="bad">{banner}</Alert></div>}
      {l?.status === "rejected" && l.moderation_note && <div style={{ marginBottom: 16 }}><Alert kind="warn" title="Changes requested by review">{l.moderation_note}</Alert></div>}
      {status === "archived" && <div style={{ marginBottom: 16 }}><Alert kind="info" title="Archived" action={<Button size="sm" icon={LuRotateCcw} busy={busy === "archive"} onClick={() => void archive("restore")}>Restore</Button>}>Archived listings are hidden from buyers. Restore to edit.</Alert></div>}

      <form className="editor" onSubmit={(e) => { e.preventDefault(); void save(!live && approved); }} noValidate>
        <div className="stack-lg">
          <Card title="The part" pad>
            <div className="form-grid">
              <Field label="Title" className="span-2" error={errors.title} hint="What it is and which cars, e.g. “Front brake pad set — ceramic, for Swift / Dzire”">{(p) => <input className="input" {...p} maxLength={150} value={form.title} onChange={(e) => set("title", e.target.value)} />}</Field>
              <Field label="Category" error={errors.category_id}>
                {(p) => (
                  <select className="select" {...p} value={form.category_id} onChange={(e) => set("category_id", e.target.value)}>
                    <option value="">Choose category</option>
                    {categories.data?.map((c) => <optgroup key={c.id} label={c.name}>{c.children.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}</optgroup>)}
                  </select>
                )}
              </Field>
              <Field label="Brand" error={errors.brand_id}>
                {(p) => (
                  <select className="select" {...p} value={form.brand_id} onChange={(e) => set("brand_id", e.target.value)}>
                    <option value="">Choose brand</option>
                    <optgroup label="Vehicle maker (OEM)">{brands.data?.filter((b) => b.is_oem).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>
                    <optgroup label="Aftermarket">{brands.data?.filter((b) => !b.is_oem).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>
                  </select>
                )}
              </Field>
              <Field label="Part number" error={errors.part_number} hint="Exactly as printed on the box">{(p) => <input className="input pn" {...p} maxLength={40} value={form.part_number} onChange={(e) => set("part_number", e.target.value)} />}</Field>
              <Field label="Your SKU" error={errors.sku} hint="Letters, numbers, dot, dash, underscore">{(p) => <input className="input pn" {...p} maxLength={40} value={form.sku} onChange={(e) => set("sku", e.target.value.replace(/[^A-Za-z0-9._-]/g, ""))} />}</Field>
              <Field label="OEM / cross-reference numbers" optional className="span-2" error={errors.oem_numbers} hint="Buyers searching any of these numbers will find this listing.">{() => <NumberChips values={form.oem_numbers} onChange={(v) => set("oem_numbers", v)} />}</Field>
              {brand?.is_oem && (
                <div className="span-2 row row--wrap" role="radiogroup" aria-label="Part type">
                  <label className="radio-card grow"><input type="radio" checked={form.condition === "oem_genuine"} onChange={() => set("condition", "oem_genuine")} /><span><strong>OEM genuine</strong><br /><span className="small muted">Sealed vehicle-maker packaging with hologram</span></span></label>
                  <label className="radio-card grow"><input type="radio" checked={form.condition === "new"} onChange={() => set("condition", "new")} /><span><strong>New, unboxed or loose</strong><br /><span className="small muted">Genuine part without original packaging</span></span></label>
                </div>
              )}
            </div>
          </Card>

          <Card title="Vehicles it fits" actions={<label className="toggle small"><input type="checkbox" checked={form.is_universal} onChange={(e) => set("is_universal", e.target.checked)} />Universal part</label>} pad>
            {form.is_universal ? (
              <p className="muted">Universal parts (oils, fluids, bulbs) show to every car. Buyers see a “Universal fit” note instead of a fit check.</p>
            ) : (
              <>
                <p className="small muted" style={{ marginBottom: 12 }}>Tick every variant this exact part number fits. Buyers who chose one of these cars see <span className="fit fit--yes"><span>Fits your car</span></span>.</p>
                <FitmentPicker selected={fitment} onChange={setFitment} />
                {errors.variant_ids && <span className="field__error" style={{ marginTop: 8 }}>{errors.variant_ids}</span>}
              </>
            )}
          </Card>

          <Card title="Photos" pad><Photos images={form.images} onChange={(v) => set("images", v)} error={errors.image_ids} /></Card>

          <Card title="Price, stock and tax" pad>
            <div className="form-grid">
              <Field label="Your price (incl. GST)" error={errors.price_paise}>{(p) => <span className="input-prefix"><span>₹</span><input className="input" {...p} inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} /></span>}</Field>
              <Field label="MRP" error={errors.mrp_paise} hint={price && mrp && mrp >= price ? `Shows as ${percentOff(price, mrp)}% off` : "Printed maximum retail price"}>{(p) => <span className="input-prefix"><span>₹</span><input className="input" {...p} inputMode="decimal" value={form.mrp} onChange={(e) => set("mrp", e.target.value)} /></span>}</Field>
              <Field label="Stock" error={errors.stock}>{(p) => <input className="input" {...p} inputMode="numeric" value={form.stock} onChange={(e) => set("stock", e.target.value.replace(/\D/g, ""))} />}</Field>
              <Field label="GST rate" error={errors.gst_rate_bps}>{(p) => <select className="select" {...p} value={form.gst_rate_bps} onChange={(e) => set("gst_rate_bps", e.target.value)}>{[0, 500, 1200, 1800, 2800].map((r) => <option key={r} value={r}>{r / 100}%</option>)}</select>}</Field>
              <Field label="HSN code" error={errors.hsn_code}>{(p) => <input className="input pn" {...p} inputMode="numeric" maxLength={8} value={form.hsn_code} onChange={(e) => set("hsn_code", e.target.value.replace(/\D/g, ""))} />}</Field>
              <Field label="Warranty (months)" error={errors.warranty_months}>{(p) => <input className="input" {...p} inputMode="numeric" value={form.warranty_months} onChange={(e) => set("warranty_months", e.target.value.replace(/\D/g, ""))} />}</Field>
              <Field label="Packed weight (grams)" error={errors.weight_grams}>{(p) => <input className="input" {...p} inputMode="numeric" value={form.weight_grams} onChange={(e) => set("weight_grams", e.target.value.replace(/\D/g, ""))} />}</Field>
            </div>
          </Card>

          <Card title="Details" pad>
            <div className="stack">
              <Field label="Description" optional error={errors.description}>{(p) => <textarea className="textarea" {...p} rows={5} maxLength={4000} value={form.description} onChange={(e) => set("description", e.target.value)} />}</Field>
              <div>
                <div className="field__label" style={{ marginBottom: 8 }}>Specifications</div>
                <div className="spec-rows">
                  {form.specs.map((s, i) => (
                    <div key={i} className="spec-rows__row">
                      <input className="input" aria-label="Specification name" placeholder="e.g. Position" maxLength={40} value={s.label} onChange={(e) => set("specs", form.specs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <input className="input" aria-label="Specification value" placeholder="e.g. Front axle" maxLength={120} value={s.value} onChange={(e) => set("specs", form.specs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                      <Button variant="ghost" icon={LuTrash2} aria-label="Remove specification" onClick={() => set("specs", form.specs.filter((_, j) => j !== i))} />
                    </div>
                  ))}
                  {form.specs.length < 20 && <div><Button size="sm" icon={LuPlus} onClick={() => set("specs", [...form.specs, { label: "", value: "" }])}>Add specification</Button></div>}
                </div>
              </div>
            </div>
          </Card>
        </div>

        <aside className="editor__side">
          <Card pad>
            <div className="stack" style={{ "--gap": "12px" }}>
              <div className="row row--between"><span className="micro">Status</span><StatusBadge status={status} /></div>
              <ul className="checklist">
                {checklist.map((c) => <li key={c.label} className={c.ok ? "is-ok" : ""}>{c.ok ? <LuCheck aria-hidden="true" /> : <LuCircle aria-hidden="true" />}{c.label}</li>)}
              </ul>
              {live && <p className="xs muted">Editing the title, part numbers, brand, category or fitment sends a live listing back to review. Price and stock edits stay live.</p>}
              {!approved && <p className="xs muted">Submitting unlocks once your seller account is approved.</p>}
            </div>
          </Card>
          <SpecLabel
            brand={brand?.name ?? "Brand"}
            oem={form.condition === "oem_genuine"}
            cols={2}
            sku={form.sku || undefined}
            cells={[
              { label: "Part no.", value: form.part_number || "—", pn: true, wide: true },
              { label: "Category", value: cat?.name ?? "—" },
              { label: "Price", value: price ? rupees(price) : "—" },
              { label: "Fits", value: form.is_universal ? "Universal" : `${fitment.size} variants` },
              { label: "Warranty", value: warranty(Number(form.warranty_months) || 0) },
            ]}
            footer={<span className="xs muted">Label preview</span>}
          />
          {l && status !== "archived" && <Button variant="ghost" icon={LuArchive} busy={busy === "archive"} onClick={() => void archive("archive")}>Archive listing</Button>}
          {l && <Link to="/seller/listings" className="small">Back to all listings</Link>}
        </aside>

        {status !== "archived" && (
          <div className="editor__bar" style={{ gridColumn: "1 / -1" }}>
            {live ? (
              <Button type="submit" variant="primary" busy={busy === "submit" || busy === "save"} icon={LuCheck}>Save changes</Button>
            ) : (
              <>
                <Button busy={busy === "save"} onClick={() => void save(false)}>Save draft</Button>
                <Button type="submit" variant="primary" icon={LuSend} busy={busy === "submit"} disabled={!approved} title={approved ? undefined : "Available after your seller account is approved"}>
                  {status === "pending" ? "Update and keep in review" : "Submit for review"}
                </Button>
              </>
            )}
          </div>
        )}
      </form>
    </>
  );
}
