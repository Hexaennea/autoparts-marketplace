import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuExternalLink, LuLogOut, LuMenu, LuX } from "react-icons/lu";
import { Link, NavLink, useRouter } from "../lib/router";
import { useAuth, useToast } from "../state/app";
import { Logo } from "./StoreLayout";

export interface PortalNavItem { to: string; label: string; icon: IconType; exact?: boolean; badge?: number | undefined }

export function PortalLayout({ area, nav, children, banner }: { area: string; nav: PortalNavItem[]; children: ReactNode; banner?: ReactNode }) {
  const { user, logout } = useAuth();
  const { pathname, navigate } = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className={`portal ${open ? "is-open" : ""}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="portal__rail carton" aria-label={`${area} navigation`}>
        <div className="portal__brand">
          <Logo inverse />
          {user && <div className="portal__brand-user">{user.full_name}</div>}
          <span className="portal__area">{area}</span>
        </div>
        <nav className="portal__nav">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} exact={item.exact} className="portal__link">
              <item.icon aria-hidden="true" />
              <span className="grow">{item.label}</span>
              {item.badge ? <span className="portal__badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="portal__foot">
          <Link to="/" className="portal__link"><LuExternalLink aria-hidden="true" /> View storefront</Link>
          <div className="portal__user">
            <div className="grow">
              <div className="portal__user-name">{user?.full_name}</div>
              <div className="portal__user-mail">{user?.email}</div>
            </div>
            <button type="button" className="portal__icon-btn" aria-label="Sign out" onClick={async () => { await logout(); toast("You're signed out."); navigate("/"); }}>
              <LuLogOut />
            </button>
          </div>
        </div>
      </aside>
      <div className="portal__main">
        <div className="portal__topbar">
          <button type="button" className="portal__icon-btn portal__menu" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <LuX /> : <LuMenu />}
          </button>
          <Logo />
          <span className="portal__area portal__area--dark">{area}</span>
        </div>
        {banner}
        <main id="main" className="portal__content">{children}</main>
      </div>
      {open && <button type="button" className="portal__scrim" aria-label="Close menu" onClick={() => setOpen(false)} />}
    </div>
  );
}
