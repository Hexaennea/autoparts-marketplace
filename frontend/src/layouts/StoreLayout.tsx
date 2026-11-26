import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { LuCar, LuChevronDown, LuLogOut, LuPackage, LuSearch, LuShieldCheck, LuShoppingCart, LuStore, LuUser } from "react-icons/lu";
import { rupees } from "../lib/format";
import { useDebounced, useQuery } from "../lib/query";
import { Link, useRouter } from "../lib/router";
import type { Category, ProductCard } from "../lib/types";
import { useAuth, useCart, useConfig, useToast, useVehicle } from "../state/app";
import { MyCarDialog } from "../ui/vehicle";
import { NotificationBell } from "../ui/notifications";

export function Logo({ inverse }: { inverse?: boolean }) {
  const { app_name } = useConfig();
  return (
    <Link to="/" className={`logo ${inverse ? "logo--inverse" : ""}`} aria-label={`${app_name} home`}>
      <svg className="logo__mark" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="0.5" y="0.5" width="31" height="31" rx="4" fill="none" stroke="currentColor" strokeOpacity="0.55" />
        <g fill="currentColor"><rect x="8" y="8" width="2" height="16" /><rect x="12" y="8" width="1" height="16" /><rect x="15" y="8" width="3" height="16" /><rect x="20" y="8" width="1" height="16" /><rect x="23" y="8" width="1.5" height="16" /></g>
      </svg>
      <span className="logo__word">{app_name}</span>
    </Link>
  );
}

interface Suggest {
  products: ProductCard[];
  categories: { slug: string; name: string; count: number }[];
  part_number: { query: string; matches: number } | null;
}

function SearchBox() {
  const { navigate, pathname, search } = useRouter();
  const { vehicle } = useVehicle();
  const initial = pathname === "/search" ? new URLSearchParams(search).get("q") ?? "" : "";
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const box = useRef<HTMLFormElement>(null);
  const debounced = useDebounced(text.trim(), 200);
  const suggest = useQuery<Suggest>(open && debounced.length >= 2 ? "/api/search/suggest" : null, { q: debounced, vehicle: vehicle?.variant.id });

  useEffect(() => setText(initial), [initial]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const options: { key: string; label: ReactNode; to: string }[] = [];
  const data = suggest.data;
  if (data?.part_number) options.push({ key: "pn", to: `/search?q=${encodeURIComponent(data.part_number.query)}`, label: <><span className="pn__tag">PART NO.</span> <strong>{data.part_number.query}</strong> <span className="muted">— {data.part_number.matches} listing{data.part_number.matches === 1 ? "" : "s"}</span></> });
  data?.categories.forEach((c) => options.push({ key: `c${c.slug}`, to: `/search?category=${c.slug}${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`, label: <>{debounced} <span className="muted">in</span> <strong>{c.name}</strong></> }));
  data?.products.slice(0, 5).forEach((p) => options.push({ key: `p${p.id}`, to: `/p/${p.id}/${p.slug}`, label: <span className="suggest__product"><img src={p.image ?? ""} alt="" /><span className="grow"><span className="clamp-2">{p.title}</span><span className="small muted">{p.brand} · {p.part_number}</span></span><span className="strong">{rupees(p.price_paise)}</span></span> }));

  const go = (to: string) => { setOpen(false); setActive(-1); navigate(to); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
    else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Enter" && active >= 0 && options[active]) { e.preventDefault(); go(options[active].to); }
  };

  return (
    <form ref={box} role="search" className="search" onSubmit={(e) => { e.preventDefault(); go(`/search?q=${encodeURIComponent(text.trim())}`); }}>
      <LuSearch className="search__icon" aria-hidden="true" />
      <input
        className="search__input"
        type="search"
        value={text}
        placeholder="Part name or number — e.g. brake pads, 16510M68K00"
        aria-label="Search parts"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        maxLength={120}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      <button type="submit" className="search__go">Search</button>
      {open && options.length > 0 && (
        <ul className="suggest" id={listId} role="listbox">
          {options.map((o, i) => (
            <li key={o.key} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""} onMouseDown={(e) => { e.preventDefault(); go(o.to); }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, []);
  if (!user) {
    return (
      <Link to="/login" className="hdr-action">
        <LuUser aria-hidden="true" />
        <span className="hdr-action__text"><span className="hdr-action__small">Hello</span>Sign in</span>
      </Link>
    );
  }
  const signOut = async () => {
    setOpen(false);
    await logout();
    toast("You're signed out.");
    navigate("/");
  };
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="hdr-action" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <LuUser aria-hidden="true" />
        <span className="hdr-action__text"><span className="hdr-action__small">Hello, {user.full_name.split(" ")[0]}</span>Account <LuChevronDown aria-hidden="true" size={14} /></span>
      </button>
      {open && (
        <div className="menu__pop" role="menu">
          <Link to="/orders" className="menu__item" onClick={() => setOpen(false)}><LuPackage aria-hidden="true" /> Orders</Link>
          <Link to="/account" className="menu__item" onClick={() => setOpen(false)}><LuUser aria-hidden="true" /> Account &amp; garage</Link>
          {user.role === "seller" && <Link to="/seller" className="menu__item" onClick={() => setOpen(false)}><LuStore aria-hidden="true" /> Seller portal</Link>}
          {user.role === "admin" && <Link to="/admin" className="menu__item" onClick={() => setOpen(false)}><LuShieldCheck aria-hidden="true" /> Admin portal</Link>}
          <button type="button" className="menu__item" role="menuitem" onClick={signOut}><LuLogOut aria-hidden="true" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export function StoreLayout({ children }: { children: ReactNode }) {
  const { demo_mode } = useConfig();
  const { vehicle } = useVehicle();
  const { count } = useCart();
  const [carOpen, setCarOpen] = useState(false);
  const categories = useQuery<Category[]>("/api/categories");

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      {demo_mode && (
        <div className="demo-strip"><strong>Demo catalogue.</strong> Sellers, parts, prices and orders are sample data for evaluation.</div>
      )}
      <header className="hdr">
        <div className="container hdr__row">
          <Logo />
          <SearchBox />
          <div className="hdr__actions">
            <button type="button" className={`plate ${vehicle ? "" : "plate--empty"}`} onClick={() => setCarOpen(true)} aria-label={vehicle ? `My car: ${vehicle.variant.label} ${vehicle.year}. Change` : "Select your car"}>
              <LuCar aria-hidden="true" />
              <span>{vehicle ? `${vehicle.variant.model} ${vehicle.variant.name.split(" ")[0]} · ${vehicle.year}` : <>My car<span className="plate__long"> — select</span></>}</span>
            </button>
            <NotificationBell />
            <AccountMenu />
            <Link to="/cart" className="hdr-action hdr-cart" aria-label={`Cart, ${count} item${count === 1 ? "" : "s"}`}>
              <LuShoppingCart aria-hidden="true" />
              {count > 0 && <span className="hdr-cart__count">{count > 99 ? "99+" : count}</span>}
              <span className="hdr-action__text">Cart</span>
            </Link>
          </div>
        </div>
        <nav className="catnav" aria-label="Categories">
          <div className="container catnav__row">
            {categories.data?.map((c) => (
              <Link key={c.id} to={`/search?category=${c.slug}`} className="catnav__link">{c.name}</Link>
            ))}
            <Link to="/sell" className="catnav__link catnav__sell">Sell on PartPilot</Link>
          </div>
        </nav>
      </header>
      <MyCarDialog open={carOpen} onClose={() => setCarOpen(false)} />
      <main id="main" className="store-main">{children}</main>
      <footer className="ftr carton">
        <div className="container ftr__grid">
          <div className="ftr__brand">
            <Logo inverse />
            <p>Car parts matched to your exact variant, from verified Indian sellers. GST invoice on every order.</p>
          </div>
          <nav aria-label="Shop">
            <div className="micro">Shop</div>
            <Link to="/search?category=brakes">Brakes</Link>
            <Link to="/search?category=filters">Filters</Link>
            <Link to="/search?category=oils-fluids">Oils &amp; fluids</Link>
            <Link to="/orders">Track an order</Link>
          </nav>
          <nav aria-label="Sell">
            <div className="micro">Sell</div>
            <Link to="/sell">Become a seller</Link>
            <Link to="/seller">Seller portal</Link>
          </nav>
          <div>
            <div className="micro">Buying with confidence</div>
            <p>Pay on delivery or online · 7-day returns on wrong-fit parts · Prices include GST</p>
          </div>
        </div>
        <div className="container ftr__base">© {new Date().getFullYear()} PartPilot (working name). All brand names belong to their owners.</div>
      </footer>
    </>
  );
}
