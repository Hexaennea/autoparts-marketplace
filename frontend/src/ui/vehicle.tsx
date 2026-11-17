// "My car": the make → model → year → variant selector and the header plate that opens it.
import { useEffect, useState } from "react";
import { LuCar, LuCarFront, LuTrash2 } from "react-icons/lu";
import { api, errorMessage } from "../lib/api";
import { invalidate, useQuery } from "../lib/query";
import type { GarageEntry, Make, Model, Variant, Vehicle } from "../lib/types";
import { useAuth, useToast, useVehicle } from "../state/app";
import { Button, Dialog } from "./core";

export function VehicleSelector({ onSelect, submitLabel = "Find parts", layout = "row", initial }: {
  onSelect: (vehicle: Vehicle) => void; submitLabel?: string; layout?: "row" | "stack"; initial?: Vehicle | null;
}) {
  const [makeId, setMakeId] = useState<number | "">(initial?.variant.make_id ?? "");
  const [modelId, setModelId] = useState<number | "">(initial?.variant.model_id ?? "");
  const [year, setYear] = useState<number | "">(initial?.year ?? "");
  const [variantId, setVariantId] = useState<number | "">(initial?.variant.id ?? "");

  const makes = useQuery<Make[]>("/api/vehicles/makes");
  const models = useQuery<Model[]>(makeId ? `/api/vehicles/makes/${makeId}/models` : null);
  const years = useQuery<number[]>(modelId ? `/api/vehicles/models/${modelId}/years` : null);
  const variants = useQuery<Variant[]>(modelId && year ? `/api/vehicles/models/${modelId}/variants` : null, { year: year || undefined });

  useEffect(() => {
    if (variants.data && variants.data.length === 1 && !variantId) setVariantId(variants.data[0]!.id);
  }, [variants.data, variantId]);

  const variant = variants.data?.find((v) => v.id === variantId);
  const submit = () => {
    if (variant && year) onSelect({ variant, year });
  };

  return (
    <form
      className={`vsel vsel--${layout}`}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      aria-label="Choose your car"
    >
      <label className="vsel__cell">
        <span className="vsel__label"><span className="vsel__step" aria-hidden="true">1</span>Make</span>
        <select className="select" value={makeId} onChange={(e) => { setMakeId(Number(e.target.value) || ""); setModelId(""); setYear(""); setVariantId(""); }}>
          <option value="">{makes.loading ? "Loading…" : "Choose"}</option>
          {makes.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="vsel__cell">
        <span className="vsel__label"><span className="vsel__step" aria-hidden="true">2</span>Model</span>
        <select className="select" value={modelId} disabled={!makeId} onChange={(e) => { setModelId(Number(e.target.value) || ""); setYear(""); setVariantId(""); }}>
          <option value="">Choose</option>
          {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      <label className="vsel__cell">
        <span className="vsel__label"><span className="vsel__step" aria-hidden="true">3</span>Year</span>
        <select className="select" value={year} disabled={!modelId} onChange={(e) => { setYear(Number(e.target.value) || ""); setVariantId(""); }}>
          <option value="">Choose</option>
          {years.data?.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <label className="vsel__cell vsel__cell--wide">
        <span className="vsel__label"><span className="vsel__step" aria-hidden="true">4</span>Variant</span>
        <select className="select" value={variantId} disabled={!year} onChange={(e) => setVariantId(Number(e.target.value) || "")}>
          <option value="">Choose variant</option>
          {variants.data?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.fuel_label} {v.transmission_label}
            </option>
          ))}
        </select>
      </label>
      <div className="vsel__go">
        <Button type="submit" variant="primary" size={layout === "row" ? "lg" : "md"} block disabled={!variant} icon={LuCarFront}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function MyCarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { vehicle, setVehicle, label } = useVehicle();
  const { user } = useAuth();
  const toast = useToast();
  const garage = useQuery<GarageEntry[]>(user && open ? "/api/me/garage" : null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    if (open) setChanging(!vehicle);
  }, [open, vehicle]);

  const choose = async (next: Vehicle) => {
    setVehicle(next);
    setChanging(false);
    toast(`Showing parts for your ${next.variant.model}`);
    if (user) {
      try {
        garage.mutate(await api.post<GarageEntry[]>("/api/me/garage", { variant_id: next.variant.id, year: next.year }));
        invalidate("/api/me/garage");
      } catch (err) {
        toast(errorMessage(err), "bad");
      }
    }
    onClose();
  };

  const removeSaved = async (id: number) => {
    garage.mutate(await api.del<GarageEntry[]>(`/api/me/garage/${id}`));
  };

  return (
    <Dialog open={open} onClose={onClose} title="My car" drawer>
      <div className="stack" style={{ "--gap": "20px" }}>
        {vehicle && !changing && (
          <div className="mycar">
            <span className="plate"><LuCar aria-hidden="true" /><span>{vehicle.variant.make} {vehicle.variant.model}</span></span>
            <div className="mycar__name">{vehicle.variant.name}</div>
            <div className="small muted">{vehicle.year} · {vehicle.variant.fuel_label} · {vehicle.variant.transmission_label}{vehicle.variant.engine_cc ? ` · ${vehicle.variant.engine_cc} cc` : ""}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <Button size="sm" onClick={() => setChanging(true)}>Change car</Button>
              <Button size="sm" variant="ghost" onClick={() => { setVehicle(null); setChanging(true); }}>Clear</Button>
            </div>
          </div>
        )}
        {changing && (
          <div>
            <p className="small muted" style={{ marginBottom: 12 }}>We'll only show parts sellers have matched to this exact variant.</p>
            <VehicleSelector onSelect={choose} layout="stack" submitLabel="Use this car" />
          </div>
        )}
        {user && garage.data && garage.data.length > 0 && (
          <div>
            <div className="divider-label" style={{ marginBottom: 8 }}>Saved in your garage</div>
            <ul className="garage-list">
              {garage.data.map((g) => {
                const current = vehicle?.variant.id === g.variant.id && vehicle.year === g.year;
                return (
                  <li key={g.id} className={current ? "is-current" : ""}>
                    <button type="button" className="garage-list__pick" onClick={() => choose({ variant: g.variant, year: g.year })}>
                      <LuCar aria-hidden="true" />
                      <span>
                        <strong>{g.variant.make} {g.variant.model}</strong>
                        <span className="small muted"> {g.variant.name} · {g.year}</span>
                      </span>
                    </button>
                    <Button size="sm" variant="ghost" icon={LuTrash2} aria-label={`Remove ${g.label}`} onClick={() => removeSaved(g.id)} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {!user && label && <p className="small muted">Sign in to save this car to your garage.</p>}
      </div>
    </Dialog>
  );
}
