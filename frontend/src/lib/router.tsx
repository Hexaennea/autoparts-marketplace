// Tiny History-API router: path matching, links that respect modifier keys, scroll + focus reset.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

interface Location { pathname: string; search: string }
interface RouterValue extends Location { navigate: (to: string, opts?: { replace?: boolean; keepScroll?: boolean }) => void }

const RouterContext = createContext<RouterValue>({ pathname: "/", search: "", navigate: () => undefined });

function current(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((target: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) => {
    const navigateHome = () => {
      window.history.replaceState(null, "", "/");
      setLocation({ pathname: "/", search: "" });
    };
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) {
      // The router only ever navigates within PartPilot; anything else is treated as a bad link.
      return navigateHome();
    }
    const same = url.pathname === window.location.pathname;
    if (opts.replace) window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    else window.history.pushState(null, "", url.pathname + url.search + url.hash);
    setLocation({ pathname: url.pathname, search: url.search });
    if (!opts.keepScroll && !(same && opts.replace)) {
      window.scrollTo({ top: 0 });
      requestAnimationFrame(() => {
        const heading = document.querySelector<HTMLElement>("main h1");
        if (heading && !same) {
          heading.setAttribute("tabindex", "-1");
          heading.focus({ preventScroll: true });
        }
      });
    }
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function useSearchParams(): [URLSearchParams, (next: Record<string, string | number | null | undefined>, replace?: boolean) => void] {
  const { search, pathname, navigate } = useRouter();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const update = useCallback(
    (next: Record<string, string | number | null | undefined>, replace = true) => {
      const merged = new URLSearchParams(search);
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === undefined || value === "") merged.delete(key);
        else merged.set(key, String(value));
      }
      const text = merged.toString();
      navigate(pathname + (text ? `?${text}` : ""), { replace, keepScroll: true });
    },
    [search, pathname, navigate],
  );
  return [params, update];
}

/** Match "/p/:id" against "/p/42" → { id: "42" }. Trailing "*" matches the rest. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = pathname.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i]!;
    if (seg === "*") return params;
    const value = b[i];
    if (value === undefined) return null;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(value);
    else if (seg !== value) return null;
  }
  return a.length === b.length ? params : null;
}

export interface RouteDef { path: string; render: (params: Record<string, string>) => ReactNode }

export function Routes({ routes, fallback }: { routes: RouteDef[]; fallback: ReactNode }) {
  const { pathname } = useRouter();
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) return <>{route.render(params)}</>;
  }
  return <>{fallback}</>;
}

interface LinkProps {
  to: string;
  children: ReactNode;
  className?: string;
  replace?: boolean;
  title?: string;
  "aria-current"?: "page" | undefined;
  "aria-label"?: string;
  onClick?: () => void;
}

export function Link({ to, children, className, replace, onClick, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.();
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, { replace });
  };
  return (
    <a href={to} className={className} onClick={handle} {...rest}>
      {children}
    </a>
  );
}

export function NavLink({ to, children, className = "", exact = false, ...rest }: LinkProps & { exact?: boolean }) {
  const { pathname } = useRouter();
  const active = exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
  return (
    <Link to={to} className={`${className}${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} {...rest}>
      {children}
    </Link>
  );
}

export function Redirect({ to }: { to: string }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace: true }), [to, navigate]);
  return null;
}
