import { useEffect, useState } from "react";
import { LuCar, LuInfo, LuSlidersHorizontal, LuX } from "react-icons/lu";
import searchArt from "../../assets/art/oil-filter.svg";
import { rupees } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { useSearchParams } from "../../lib/router";
import type { Category, SearchResult } from "../../lib/types";
import { useVehicle } from "../../state/app";
import { ProductGrid } from "../../ui/commerce";
import { Button, Dialog, Empty, ErrorState, Pagination } from "../../ui/core";
import { MyCarDialog } from "../../ui/vehicle";
import { useWishlist } from "./wishlist";

const SORTS = [
  { value: "relevance", label: "Best match" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "rating", label: "Top rated" },
  { value: "newest", label: "Newest" },
];

function Filters({ result, params, update }: { result: SearchResult | undefined; params: URLSearchParams; update: (n: Record<string, string | null>) => void }) {
  const brands = (params.get("brand") ?? "").split(",").filter(Boolean);
  const [min, setMin] = useState(params.get("min_price") ?? "");
  const [max, setMax] = useState(params.get("max_price") ?? "");
  useEffect(() => { setMin(params.get("min_price") ?? ""); setMax(params.get("max_price") ?? ""); }, [params]);
  const toggleBrand = (slug: string) => {
    const next = brands.includes(slug) ? brands.filter((b) => b !== slug) : [...brands, slug];
    update({ brand: next.join(",") || null, page: null });
  };
  const current = params.get("category");
  const facets = result?.facets;
  const anyFilter = ["category", "brand", "min_price", "max_price", "in_stock", "condition"].some((k) => params.get(k));

  return (
    <div className="filters">
      {anyFilter && (
        <button type="button" className="link-btn small filters__clear" onClick={() => update({ category: null, brand: null, min_price: null, max_price: null, in_stock: null, condition: null, page: null })}>
          Clear all filters
        </button>
      )}
      <fieldset className="filters__group">
        <legend className="micro">Category</legend>
        {current && <button type="button" className="filters__cat" onClick={() => update({ category: null, page: null })}>All categories</button>}
        {facets?.categories.map((c) => (
          <button key={c.slug} type="button" className={`filters__cat ${current === c.slug ? "is-active" : ""}`} aria-pressed={current === c.slug} onClick={() => update({ category: c.slug, page: null })}>
            <span className="grow">{c.name}</span>
            <span className="filters__count">{c.count}</span>
          </button>
        ))}
      </fieldset>
      <fieldset className="filters__group">
        <legend className="micro">Brand</legend>
        {facets?.brands.length === 0 && <span className="small muted">No brands match.</span>}
        {facets?.brands.map((b) => (
          <label key={b.slug} className="check check--row">
            <span className="row" style={{ "--gap": "8px" }}>
              <input type="checkbox" checked={brands.includes(b.slug)} onChange={() => toggleBrand(b.slug)} />
              <span>{b.name}</span>
            </span>
            <span className="filters__count">{b.count}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="filters__group">
        <legend className="micro">Price (₹)</legend>
        <form className="filters__price" onSubmit={(e) => { e.preventDefault(); update({ min_price: min || null, max_price: max || null, page: null }); }}>
          <input className="input" inputMode="numeric" pattern="[0-9]*" aria-label="Minimum price" placeholder={facets?.price.min ? String(Math.floor(facets.price.min / 100)) : "Min"} value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} />
          <span aria-hidden="true">–</span>
          <input className="input" inputMode="numeric" pattern="[0-9]*" aria-label="Maximum price" placeholder={facets?.price.max ? String(Math.ceil(facets.price.max / 100)) : "Max"} value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} />
          <Button type="submit" size="sm">Go</Button>
        </form>
      </fieldset>
      <fieldset className="filters__group">
        <legend className="micro">Part type</legend>
        {[{ v: "", l: "All parts" }, { v: "oem_genuine", l: "Genuine (vehicle maker)" }, { v: "new", l: "Branded aftermarket" }].map((o) => (
          <label key={o.v} className="check">
            <input type="radio" name="condition" checked={(params.get("condition") ?? "") === o.v} onChange={() => update({ condition: o.v || null, page: null })} />
            {o.l}
          </label>
        ))}
      </fieldset>
      <fieldset className="filters__group">
        <legend className="micro">Availability</legend>
        <label className="toggle">
          <input type="checkbox" checked={params.get("in_stock") === "1"} onChange={(e) => update({ in_stock: e.target.checked ? "1" : null, page: null })} />
          In stock only
        </label>
      </fieldset>
    </div>
  );
}

export function SearchPage() {
  const [params, update] = useSearchParams();
  const { vehicle } = useVehicle();
  const [carOpen, setCarOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const wish = useWishlist();
  const vehicleId = vehicle?.variant.id ?? (params.get("vehicle") ? Number(params.get("vehicle")) : undefined);
  const page = Number(params.get("page") ?? 1) || 1;
  const query = {
    q: params.get("q") ?? undefined, category: params.get("category") ?? undefined, brand: params.get("brand") ?? undefined,
    vehicle: vehicleId, fit: params.get("fit") ?? undefined, min_price: params.get("min_price") ?? undefined,
    max_price: params.get("max_price") ?? undefined, in_stock: params.get("in_stock") === "1" ? "true" : undefined,
    condition: params.get("condition") ?? undefined, sort: params.get("sort") ?? undefined, page,
  };
  const result = useQuery<SearchResult>("/api/search", query);
  const categories = useQuery<Category[]>("/api/categories");
  const data = result.data;
  const q = params.get("q");
  const catSlug = params.get("category");
  const catName = categories.data?.flatMap((c) => [c, ...c.children]).find((c) => c.slug === catSlug)?.name;
  const title = q ? `“${q}”` : catName ?? "All parts";
  const fitAll = params.get("fit") === "all";

  useEffect(() => {
    if (data && page > data.pages) update({ page: null });
  }, [data, page, update]);

  return (
    <div className="container search-layout">
      <aside className="search-layout__filters" aria-label="Filters">
        <Filters result={data} params={params} update={update} />
      </aside>
      <section className="search-layout__results">
        <div className="results-head">
          <div className="grow">
            <h1 className="results-head__title">{title}</h1>
            <p className="small muted" aria-live="polite">
              {data ? `${data.total.toLocaleString("en-IN")} part${data.total === 1 ? "" : "s"}` : "Searching…"}
              {catName && q ? ` in ${catName}` : ""}
            </p>
          </div>
          <Button className="results-head__filters" icon={LuSlidersHorizontal} onClick={() => setFiltersOpen(true)}>Filters</Button>
          <label className="results-head__sort">
            <span className="sr-only">Sort by</span>
            <select className="select" value={params.get("sort") ?? "relevance"} onChange={(e) => update({ sort: e.target.value === "relevance" ? null : e.target.value, page: null })}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>

        {vehicle ? (
          <div className="fitbar fitbar--set">
            <LuCar aria-hidden="true" />
            <div className="grow">
              <span className="small muted">{fitAll ? "Checking every part against" : "Only parts that fit"}</span>
              <div className="strong">{vehicle.variant.make} {vehicle.variant.model} {vehicle.variant.name} · {vehicle.year}</div>
            </div>
            <label className="toggle small">
              <input type="checkbox" checked={!fitAll} onChange={(e) => update({ fit: e.target.checked ? null : "all", page: null })} />
              Fitting only
            </label>
            <Button size="sm" variant="ghost" onClick={() => setCarOpen(true)}>Change</Button>
          </div>
        ) : (
          <div className="fitbar">
            <LuCar aria-hidden="true" />
            <div className="grow">
              <div className="strong">Add your car to see what fits</div>
              <span className="small muted">Each result will be marked with a clear fit check for your variant.</span>
            </div>
            <Button size="sm" variant="sticker" onClick={() => setCarOpen(true)}>Select your car</Button>
          </div>
        )}

        {data?.detected_model && !vehicle && (
          <div className="alert alert--info" role="status">
            <LuInfo aria-hidden="true" />
            <p>Showing parts listed for any <strong>{data.detected_model.make} {data.detected_model.name}</strong>. Pick your exact variant for a guaranteed fit.</p>
          </div>
        )}
        {data?.relaxed && (
          <div className="alert alert--warn" role="status">
            <LuInfo aria-hidden="true" />
            <p>No part matched every word, so we're showing close matches.</p>
          </div>
        )}

        {result.error ? (
          <ErrorState message={result.error.message} onRetry={result.reload} />
        ) : data && data.total === 0 ? (
          <Empty art={searchArt} title="No parts match yet" action={<Button onClick={() => update({ q: null, brand: null, category: null, min_price: null, max_price: null, in_stock: null, condition: null, fit: vehicle ? "all" : null })}>Clear search and filters</Button>}>
            {vehicle && !fitAll ? "Nothing listed for your exact variant matches these filters. Try showing all parts, or check the part number." : "Check the spelling or part number, or remove a filter."}
          </Empty>
        ) : (
          <>
            <ProductGrid products={data?.items} loading={result.loading} wishlist={wish.ids} onWish={wish.toggle} skeletons={12} />
            {data && <Pagination page={data.page} pages={data.pages} total={data.total} perPage={data.per_page} onPage={(p) => { update({ page: p > 1 ? p : null }); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}
          </>
        )}
        {data && data.facets.price.min !== null && data.total > 0 && (
          <p className="xs muted results-foot">Prices from {rupees(data.facets.price.min ?? 0)} to {rupees(data.facets.price.max ?? 0)}, GST included.</p>
        )}
      </section>
      <MyCarDialog open={carOpen} onClose={() => setCarOpen(false)} />
      <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters" drawer footer={<Button variant="primary" icon={LuX} onClick={() => setFiltersOpen(false)}>Show {data?.total ?? ""} parts</Button>}>
        <Filters result={data} params={params} update={update} />
      </Dialog>
    </div>
  );
}
