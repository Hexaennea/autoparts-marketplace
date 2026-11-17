// App-wide state: session, selected car, cart, toasts, runtime config.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from "react-icons/lu";
import { api, errorMessage, onSessionExpired, setCsrf } from "../lib/api";
import { invalidate } from "../lib/query";
import type { AppConfig, Quote, Session, User, Vehicle } from "../lib/types";

/* ---------------- toasts ---------------- */

type ToastKind = "ok" | "bad" | "info";
interface Toast { id: number; kind: ToastKind; text: string }
const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (text: string, kind: ToastKind = "ok") => {
      const id = next.current++;
      setToasts((all) => [...all.slice(-2), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "bad" ? 7000 : 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.kind === "ok" ? <LuCircleCheck /> : t.kind === "bad" ? <LuCircleAlert /> : <LuInfo />}
            <span>{t.text}</span>
            <button className="toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <LuX />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ---------------- session ---------------- */

interface AuthValue {
  user: User | null;
  ready: boolean;
  setSession: (session: Session) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue>({
  user: null, ready: false, setSession: () => undefined, refresh: async () => undefined, logout: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const setSession = useCallback((session: Session) => {
    setCsrf(session.csrf);
    setUser(session.user);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSession(await api.get<Session>("/api/auth/session"));
    } finally {
      setReady(true);
    }
  }, [setSession]);

  const logout = useCallback(async () => {
    const session = await api.post<Session>("/api/auth/logout");
    invalidate("/api/");
    setSession(session);
  }, [setSession]);

  useEffect(() => {
    void refresh();
    onSessionExpired(() => setUser(null));
  }, [refresh]);

  const value = useMemo(() => ({ user, ready, setSession, refresh, logout }), [user, ready, setSession, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/* ---------------- runtime config ---------------- */

const ConfigContext = createContext<AppConfig>({ app_name: "PartPilot", demo_mode: false, payments_test_mode: false });

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>({ app_name: "PartPilot", demo_mode: false, payments_test_mode: false });
  useEffect(() => {
    api.get<AppConfig>("/api/config").then(setConfig).catch(() => undefined);
  }, []);
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export const useConfig = () => useContext(ConfigContext);

/* ---------------- my car ---------------- */

const VEHICLE_KEY = "pp.vehicle";

interface VehicleValue {
  vehicle: Vehicle | null;
  setVehicle: (vehicle: Vehicle | null) => void;
  label: string | null;
}

const VehicleContext = createContext<VehicleValue>({ vehicle: null, setVehicle: () => undefined, label: null });

function loadVehicle(): Vehicle | null {
  try {
    const raw = window.localStorage.getItem(VEHICLE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Vehicle;
    return parsed?.variant?.id && parsed.year ? parsed : null;
  } catch {
    return null;
  }
}

export function vehicleLabel(v: Vehicle): string {
  return `${v.variant.make} ${v.variant.model} ${v.variant.name} · ${v.year}`;
}

export function VehicleProvider({ children }: { children: ReactNode }) {
  const [vehicle, setVehicleState] = useState<Vehicle | null>(loadVehicle);
  const setVehicle = useCallback((next: Vehicle | null) => {
    setVehicleState(next);
    try {
      if (next) window.localStorage.setItem(VEHICLE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(VEHICLE_KEY);
    } catch {
      /* storage unavailable (private mode) — keep in memory */
    }
  }, []);
  const value = useMemo(() => ({ vehicle, setVehicle, label: vehicle ? vehicleLabel(vehicle) : null }), [vehicle, setVehicle]);
  return <VehicleContext.Provider value={value}>{children}</VehicleContext.Provider>;
}

export const useVehicle = () => useContext(VehicleContext);

/* ---------------- cart ---------------- */

const CART_KEY = "pp.cart";
interface LocalLine { product_id: number; quantity: number }

interface CartValue {
  quote: Quote | null;
  count: number;
  loading: boolean;
  add: (productId: number, quantity?: number) => Promise<boolean>;
  setQuantity: (productId: number, quantity: number) => Promise<void>;
  remove: (productId: number) => Promise<void>;
  reload: () => Promise<void>;
}

const CartContext = createContext<CartValue>({
  quote: null, count: 0, loading: false, add: async () => false, setQuantity: async () => undefined,
  remove: async () => undefined, reload: async () => undefined,
});

function readLocal(): LocalLine[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CART_KEY) ?? "[]") as LocalLine[];
    return Array.isArray(parsed) ? parsed.filter((l) => Number.isInteger(l.product_id) && l.quantity > 0).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function writeLocal(lines: LocalLine[]): void {
  try {
    window.localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    /* ignore */
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const toast = useToast();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true); // true until the first load settles: no empty-cart flash

  const reload = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      if (user) {
        const local = readLocal();
        if (local.length) {
          setQuote(await api.post<Quote>("/api/cart/merge", { items: local }));
          writeLocal([]);
        } else setQuote(await api.get<Quote>("/api/cart"));
      } else {
        const local = readLocal();
        setQuote(local.length ? await api.post<Quote>("/api/cart/preview", { items: local }) : null);
      }
    } catch {
      /* keep last known cart */
    } finally {
      setLoading(false);
    }
  }, [user, ready]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setQuantity = useCallback(
    async (productId: number, quantity: number) => {
      const q = Math.max(1, Math.min(20, quantity));
      if (user) {
        try {
          setQuote(await api.put<Quote>(`/api/cart/items/${productId}`, { quantity: q }));
        } catch (err) {
          toast(errorMessage(err), "bad");
        }
        return;
      }
      const lines = readLocal();
      const existing = lines.find((l) => l.product_id === productId);
      if (existing) existing.quantity = q;
      else lines.push({ product_id: productId, quantity: q });
      writeLocal(lines);
      await reload();
    },
    [user, reload, toast],
  );

  const add = useCallback(
    async (productId: number, quantity = 1) => {
      const current = quote?.groups.flatMap((g) => g.lines).find((l) => l.product_id === productId)?.quantity ?? 0;
      try {
        if (user) setQuote(await api.put<Quote>(`/api/cart/items/${productId}`, { quantity: Math.min(20, current + quantity) }));
        else {
          const lines = readLocal();
          const existing = lines.find((l) => l.product_id === productId);
          if (existing) existing.quantity = Math.min(20, existing.quantity + quantity);
          else lines.push({ product_id: productId, quantity });
          writeLocal(lines);
          await reload();
        }
        return true;
      } catch (err) {
        toast(errorMessage(err), "bad");
        return false;
      }
    },
    [user, quote, reload, toast],
  );

  const remove = useCallback(
    async (productId: number) => {
      if (user) {
        setQuote(await api.del<Quote>(`/api/cart/items/${productId}`));
        return;
      }
      writeLocal(readLocal().filter((l) => l.product_id !== productId));
      await reload();
    },
    [user, reload],
  );

  const value = useMemo(
    () => ({ quote, count: quote?.summary.item_count ?? 0, loading, add, setQuantity, remove, reload }),
    [quote, loading, add, setQuantity, remove, reload],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
