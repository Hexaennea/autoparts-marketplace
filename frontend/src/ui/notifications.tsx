// Notifications: the header bell (store), the unread badge (seller portal nav) and the full list.
//
// One shared unread counter for the whole page: it polls /api/notifications/unread once a minute
// while the tab is visible, and right away when the tab comes back into view. With thousands of
// people signed in that is a few cheap, indexed requests per second at most.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LuBell, LuBellRing, LuCheckCheck } from "react-icons/lu";
import emptyArt from "../assets/art/battery.svg";
import { api, errorMessage } from "../lib/api";
import { type IncomingPush, type PushState, enablePush, showSystemNotification, isNativeApp, listenForPushes, pushState, syncPushRegistration } from "../lib/push";
import { relative } from "../lib/format";
import { useQuery } from "../lib/query";
import { Link, useRouter, useSearchParams } from "../lib/router";
import type { AppNotification, Paged } from "../lib/types";
import { useAuth, useToast } from "../state/app";
import { Button, Empty, ErrorState, PageHeader, Pagination, Skeleton } from "./core";

const POLL_MS = 60_000;

// ---- shared unread counter -------------------------------------------------------------------

let unread = 0;
let subscribers = new Set<() => void>();
let timer: number | undefined;
let inFlight = false;

function setUnread(n: number) {
  if (n === unread) return;
  unread = n;
  subscribers.forEach((fn) => fn());
}

/** Fetch the unread count now (also called after marking things read elsewhere). */
export async function refreshUnread(): Promise<void> {
  if (inFlight || document.visibilityState === "hidden") return;
  inFlight = true;
  try {
    setUnread((await api.get<{ count: number }>("/api/notifications/unread")).count);
  } catch {
    /* signed out or offline: keep the last value; the next poll retries */
  } finally {
    inFlight = false;
  }
}

const onVisible = () => {
  if (document.visibilityState === "visible") void refreshUnread();
};

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (subscribers.size === 1) {
    void refreshUnread();
    timer = window.setInterval(() => void refreshUnread(), POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0) {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      subscribers = new Set();
    }
  };
}

/** Unread notification count for the signed-in user (0 when signed out). */
export function useUnreadCount(): number {
  const { user } = useAuth();
  const count = useSyncExternalStore(user ? subscribe : noopSubscribe, () => unread);
  return user ? count : 0;
}
const noopSubscribe = () => () => undefined;

async function markRead(ids?: number[]): Promise<void> {
  const res = await api.post<{ unread: number }>("/api/notifications/read", ids ? { ids } : {});
  setUnread(res.unread);
}

// ---- one notification --------------------------------------------------------------------------

function Item({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const content = (
    <>
      {!n.read && <span className="notice__dot" aria-label="Unread" />}
      <span className="notice__text">
        <span className="notice__title">{n.title}</span>
        <span className="notice__body">{n.body}</span>
        <span className="notice__time">{relative(n.created_at)}</span>
      </span>
    </>
  );
  const className = `notice ${n.read ? "" : "is-unread"}`;
  return n.link ? (
    <Link to={n.link} className={className} onClick={() => onOpen(n)}>{content}</Link>
  ) : (
    <button type="button" className={className} onClick={() => onOpen(n)}>{content}</button>
  );
}

// ---- push on this device ---------------------------------------------------------------------------

/**
 * "Get alerts on this device": asks the browser / phone for permission and registers it.
 * `compact` is the one-line version for the bell panel; otherwise a card for the notifications page.
 */
export function PushOptIn({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void pushState().then((s) => { if (alive) setState(s); }).catch(() => { if (alive) setState("unsupported"); });
    return () => { alive = false; };
  }, []);
  if (state === null || state === "unsupported") return null;
  if (state === "granted") return compact ? null : <PushTest where={isNativeApp() ? "phone" : "browser"} />;
  const where = isNativeApp() ? "phone" : "browser";
  const turnOn = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      setState(result);
      if (result === "granted") toast(`Notifications are on for this ${where}.`);
      else if (result === "denied") toast(`Notifications are blocked. Allow them in your ${where} settings.`, "bad");
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  if (state === "denied") {
    const text = `Notifications are blocked for this site. To get order alerts, allow notifications in your ${where} settings.`;
    return compact ? <p className="push-optin push-optin--compact small muted">{text}</p> : <div className="card push-optin"><div className="card__body small muted">{text}</div></div>;
  }
  if (compact) {
    return (
      <div className="push-optin push-optin--compact">
        <span className="small">Get order alerts on this {where}, even when the site is closed.</span>
        <Button size="sm" busy={busy} onClick={() => void turnOn()}>Turn on</Button>
      </div>
    );
  }
  return (
    <div className="card push-optin">
      <div className="card__body row row--wrap" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ "--gap": "12px" }}>
          <LuBellRing aria-hidden="true" className="push-optin__icon" />
          <div>
            <div className="strong">Get alerts on this {where}</div>
            <div className="small muted">New orders, shipping and returns pop up with a sound, even when PartPilot isn't open.</div>
          </div>
        </div>
        <Button variant="primary" busy={busy} onClick={() => void turnOn()}>Turn on notifications</Button>
      </div>
    </div>
  );
}

/** Notifications are on: let the user check that popups really appear on this device. */
function PushTest({ where }: { where: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true);
    try {
      // 1: straight from this page, no server involved. Missing => the device blocks popups.
      if (!isNativeApp()) {
        await showSystemNotification({ title: "Popup check 1 of 2", body: "This one comes straight from your browser.", link: "/notifications" }, { link: "/notifications" });
      }
      // 2: through the server and Firebase, like a real order alert.
      const res = await api.post<{ devices: number }>("/api/push/test");
      if (res.devices === 0) {
        toast(`This ${where} isn't registered for alerts. Turn notifications off and on again.`, "bad");
      } else {
        toast("Test sent. A second popup should appear within a few seconds.");
      }
    } catch (err) {
      toast(errorMessage(err), "bad");
    } finally { setBusy(false); }
  };
  return (
    <div className="card push-optin">
      <div className="card__body row row--wrap" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ "--gap": "12px" }}>
          <LuBellRing aria-hidden="true" className="push-optin__icon" />
          <div>
            <div className="strong">Notifications are on for this {where}</div>
            <div className="small muted">
              No popup? On Windows check Settings &rarr; System &rarr; Notifications (Chrome on, Do not disturb off).
            </div>
          </div>
        </div>
        <Button busy={busy} onClick={() => void test()}>Send test notification</Button>
      </div>
    </div>
  );
}

/**
 * Mounted once for the whole app: keeps this device's push registration with whoever is signed in,
 * refreshes the bell when a push arrives while the site is open, and (in the app) opens the page a
 * tapped notification points to.
 */
export function PushBridge() {
  const { user } = useAuth();
  const { navigate } = useRouter();
  const toast = useToast();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId === null) return;
    void syncPushRegistration();
    let cleanup: (() => void) | null = null;
    let alive = true;
    const onPush = (push: IncomingPush) => {
      void refreshUnread();
      toast(push.title);
    };
    void listenForPushes(onPush, (link) => { if (link.startsWith("/")) navigate(link); }).then((fn) => {
      if (alive) cleanup = fn; else fn();
    });
    return () => { alive = false; cleanup?.(); };
  }, [userId, navigate, toast]);
  return null;
}

// ---- header bell (store) -----------------------------------------------------------------------

export function NotificationBell() {
  const { user } = useAuth();
  const { pathname } = useRouter();
  const count = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const page = await api.get<Paged<AppNotification> & { unread: number }>("/api/notifications", { per_page: 8 });
      setItems(page.items);
      setUnread(page.unread);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!user) return null;
  const openItem = (n: AppNotification) => {
    setOpen(false);
    if (!n.read) void markRead([n.id]);
  };
  const label = count ? `Notifications, ${count} unread` : "Notifications";
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="hdr-action hdr-bell" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <LuBell aria-hidden="true" />
        {count > 0 && <span className="hdr-cart__count">{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div className="menu__pop notices-pop" role="dialog" aria-label="Notifications">
          <div className="notices-pop__head">
            <strong>Notifications</strong>
            {count > 0 && (
              <button type="button" className="link-btn" onClick={async () => { await markRead(); setItems((list) => list?.map((n) => ({ ...n, read: true })) ?? null); }}>
                <LuCheckCheck aria-hidden="true" /> Mark all read
              </button>
            )}
          </div>
          <div className="notices-pop__list">
            {failed && <p className="small muted notices-pop__empty">Couldn't load notifications. <button type="button" className="link-btn" onClick={() => void load()}>Try again</button></p>}
            {!failed && items === null && [0, 1, 2].map((i) => <div key={i} style={{ padding: "10px 12px" }}><Skeleton height={44} /></div>)}
            {items?.length === 0 && <p className="small muted notices-pop__empty">No notifications yet. Order updates will show up here.</p>}
            {items?.map((n) => <Item key={n.id} n={n} onOpen={openItem} />)}
          </div>
          <PushOptIn compact />
          <Link to="/notifications" className="notices-pop__all" onClick={() => setOpen(false)}>See all notifications</Link>
        </div>
      )}
    </div>
  );
}

// ---- full page (store and seller portal) ---------------------------------------------------------

export function NotificationsPage() {
  const [params, update] = useSearchParams();
  const page = Number(params.get("page") ?? 1) || 1;
  const list = useQuery<Paged<AppNotification> & { unread: number }>("/api/notifications", { page });
  const d = list.data;
  const count = useUnreadCount();
  const openItem = (n: AppNotification) => {
    if (!n.read) {
      list.mutate((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === n.id ? { ...x, read: true } : x)) } : prev!));
      void markRead([n.id]);
    }
  };
  const markAll = async () => {
    await markRead();
    list.mutate((prev) => (prev ? { ...prev, unread: 0, items: prev.items.map((x) => ({ ...x, read: true })) } : prev!));
  };
  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Order updates from the last 90 days."
        actions={count > 0 ? <Button size="sm" icon={LuCheckCheck} onClick={() => void markAll()}>Mark all read</Button> : undefined}
      />
      <PushOptIn />
      {list.error && <ErrorState message={list.error.message} onRetry={list.reload} />}
      {!d && list.loading && <div className="stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={72} />)}</div>}
      {d?.total === 0 && <Empty art={emptyArt} title="No notifications yet">When you order, ship or return parts, every update shows up here.</Empty>}
      {d && d.total > 0 && (
        <div className="card notices-page">
          {d.items.map((n) => <Item key={n.id} n={n} onOpen={openItem} />)}
        </div>
      )}
      {d && <Pagination page={d.page} pages={d.pages} total={d.total} perPage={d.per_page} onPage={(p) => update({ page: p > 1 ? p : null })} />}
    </>
  );
}
