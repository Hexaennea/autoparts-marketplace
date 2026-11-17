// Core UI primitives. Every interactive component has hover, focus, disabled and loading states.
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { LuChevronLeft, LuChevronRight, LuCircleAlert, LuCircleCheck, LuInfo, LuMinus, LuPlus, LuTriangleAlert, LuX } from "react-icons/lu";
import type { IconType } from "react-icons";
import { Link } from "../lib/router";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ink" | "sticker";

interface ButtonProps {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit" | "reset";
  block?: boolean;
  busy?: boolean;
  disabled?: boolean;
  icon?: IconType;
  iconRight?: IconType;
  onClick?: () => void;
  to?: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  form?: string;
}

export function Button({
  children, variant = "secondary", size = "md", type = "button", block, busy, disabled, icon: Icon, iconRight: IconRight,
  onClick, to, className = "", ...rest
}: ButtonProps) {
  const cls = `btn btn--${variant} ${size !== "md" ? `btn--${size}` : ""} ${block ? "btn--block" : ""} ${!children ? "btn--icon" : ""} ${className}`;
  const content = (
    <>
      {Icon && <Icon aria-hidden="true" />}
      {children}
      {IconRight && <IconRight aria-hidden="true" />}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls} {...rest}>
        {content}
      </Link>
    );
  }
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy ? "true" : undefined} onClick={onClick} {...rest}>
      {content}
    </button>
  );
}

/* ---------- form fields ---------- */

interface FieldProps {
  label: ReactNode;
  error?: string | undefined;
  hint?: ReactNode;
  optional?: boolean;
  className?: string;
  children: (props: { id: string; "aria-invalid"?: "true"; "aria-describedby"?: string }) => ReactNode;
}

export function Field({ label, error, hint, optional, className = "", children }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className}`}>
      <label className="field__label" htmlFor={id}>
        {label} {optional && <span className="opt">(optional)</span>}
      </label>
      {children({ id, "aria-invalid": error ? "true" : undefined, "aria-describedby": describedBy })}
      {hint && !error && <span className="field__hint" id={`${id}-hint`}>{hint}</span>}
      {error && (
        <span className="field__error" id={`${id}-err`} role="alert">
          <LuCircleAlert aria-hidden="true" size={14} /> {error}
        </span>
      )}
    </div>
  );
}

/* ---------- feedback ---------- */

const ALERT_ICON: Record<string, IconType> = { info: LuInfo, ok: LuCircleCheck, warn: LuTriangleAlert, bad: LuCircleAlert };

export function Alert({ kind = "info", title, children, action }: { kind?: "info" | "ok" | "warn" | "bad"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = ALERT_ICON[kind]!;
  return (
    <div className={`alert alert--${kind}`} role={kind === "bad" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div className="grow">
        {title && <div className="alert__title">{title}</div>}
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ kind, children, plain }: { kind?: "ok" | "warn" | "bad" | "info" | "ink" | "oem"; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${kind ? `badge--${kind}` : ""} ${plain ? "badge--plain" : ""}`}>{children}</span>;
}

export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number | string; style?: Record<string, string | number> }) {
  return <span className="skel" style={{ display: "block", width, height, ...style }} aria-hidden="true" />;
}

export function Empty({ art, title, children, action }: { art?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {art && <img className="empty__art" src={art} alt="" />}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <h2>That didn't load</h2>
      <p>{message}</p>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/* ---------- containers ---------- */

export function Card({ title, actions, children, footer, pad = false, className = "" }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; pad?: boolean; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__head">
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={pad ? "card__body" : ""}>{children}</div>
      {footer && <footer className="card__foot">{footer}</footer>}
    </section>
  );
}

/** Native <dialog>: focus trap, Esc to close and backdrop come from the platform. */
export function Dialog({ open, onClose, title, children, footer, wide, drawer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog--wide" : ""} ${drawer ? "drawer" : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e: { preventDefault: () => void }) => { e.preventDefault(); onClose(); }}
      onClick={(e: { target: EventTarget; currentTarget: EventTarget }) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {open && (
        <>
          <div className="dialog__head">
            <h2 id={titleId}>{title}</h2>
            <Button variant="ghost" size="sm" icon={LuX} onClick={onClose} aria-label="Close" />
          </div>
          <div className="dialog__body">{children}</div>
          {footer && <div className="dialog__foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: {
  value: T; onChange: (value: T) => void; items: { value: T; label: string; count?: number | undefined }[]; label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          role="tab"
          type="button"
          className="tab"
          aria-selected={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined && <span className="tab__count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pages, total, perPage, onPage }: { page: number; pages: number; total: number; perPage: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <nav className="pager" aria-label="Pagination">
      <span>
        {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
      </span>
      <div className="row">
        <Button size="sm" icon={LuChevronLeft} disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" iconRight={LuChevronRight} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </nav>
  );
}

export function Quantity({ value, max, onChange, small, label = "Quantity" }: { value: number; max: number; onChange: (n: number) => void; small?: boolean; label?: string }) {
  return (
    <div className={`qty ${small ? "qty--sm" : ""}`} role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label="Decrease quantity"><LuMinus /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Increase quantity"><LuPlus /></button>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-head">
      <div className="grow">
        {back && (
          <Link to={back.to} className="page-head__back">
            <LuChevronLeft aria-hidden="true" /> {back.label}
          </Link>
        )}
        <h1>{title}</h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}
