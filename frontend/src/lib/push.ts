// Push notifications on this device: web browsers (Firebase Cloud Messaging web push) and the
// Android / iOS app (Capacitor, which loads this same site inside the app).
//
// The device gets a token from Firebase, and we register it with the server
// (POST /api/push/devices); the server's outbox worker pushes order updates to it.
// The Firebase SDK is loaded only when push is actually used, so other pages stay light.
//
// Web config and the VAPID key below are public by design: Firebase identifies the project with
// them; sending a push needs the server-side service-account key, which never reaches a browser.

import { api } from "./api";
import { FIREBASE_WEB_CONFIG } from "./firebase-config";

const VAPID_KEY = "BCRAswsHumvcIbOTgatBdzCHVBCZSjCTMHlysPcwrc8aGWt6i-FCRLP7UbeECtrp_P5g6WHb9XtXpTZqWbC_vlw";
const SW_URL = "/firebase-messaging-sw.js";
const TOKEN_KEY = "pp_push_token";

export type PushState = "unsupported" | "default" | "granted" | "denied";

interface CapacitorGlobal { isNativePlatform?: () => boolean; getPlatform?: () => string }
const capacitor = () => (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

/** True inside the Android / iOS app. */
export function isNativeApp(): boolean {
  return Boolean(capacitor()?.isNativePlatform?.());
}

function nativePlatform(): "android" | "ios" {
  return capacitor()?.getPlatform?.() === "ios" ? "ios" : "android";
}

const storage = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (t: string) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

// ---- web -------------------------------------------------------------------------------------

async function webMessaging() {
  const [{ initializeApp, getApps }, messaging] = await Promise.all([import("firebase/app"), import("firebase/messaging")]);
  if (!(await messaging.isSupported())) return null;
  const app = getApps()[0] ?? initializeApp(FIREBASE_WEB_CONFIG);
  return { messaging, instance: messaging.getMessaging(app) };
}

function webBasicsSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

async function webToken(): Promise<string | null> {
  const m = await webMessaging();
  if (!m) return null;
  const registration = await navigator.serviceWorker.register(SW_URL);
  return m.messaging.getToken(m.instance, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
}

// ---- native app --------------------------------------------------------------------------------

async function nativePush() {
  return (await import("@capacitor/push-notifications")).PushNotifications;
}

/** Ask Android/iOS for a token; resolves with it (or null if registration fails). */
async function nativeToken(): Promise<string | null> {
  const push = await nativePush();
  // Android 8+: an "Order updates" channel with sound and heads-up display.
  if (nativePlatform() === "android") {
    await push.createChannel({ id: "orders", name: "Order updates", description: "Orders, shipping and returns", importance: 5, visibility: 1, sound: "default", vibration: true });
  }
  let finish: (token: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => { finish = resolve; });
  const ok = await push.addListener("registration", (t) => finish(t.value));
  const failed = await push.addListener("registrationError", () => finish(null));
  const timer = setTimeout(() => finish(null), 20_000);
  await push.register();
  const token = await result;
  clearTimeout(timer);
  void ok.remove();
  void failed.remove();
  return token;
}

// ---- shared ----------------------------------------------------------------------------------

/** Current permission on this device (without asking). */
export async function pushState(): Promise<PushState> {
  if (isNativeApp()) {
    const p = await (await nativePush()).checkPermissions();
    return p.receive === "granted" ? "granted" : p.receive === "denied" ? "denied" : "default";
  }
  if (!webBasicsSupported()) return "unsupported";
  if (!(await webMessaging().catch(() => null))) return "unsupported";
  return Notification.permission === "default" ? "default" : Notification.permission;
}

async function registerToken(token: string): Promise<void> {
  await api.post("/api/push/devices", { token, platform: isNativeApp() ? nativePlatform() : "web" });
  storage.set(token);
}

/** Ask permission (a user click must call this), get a token and register it for the signed-in user. */
export async function enablePush(): Promise<PushState> {
  if (isNativeApp()) {
    const push = await nativePush();
    const p = await push.requestPermissions();
    if (p.receive !== "granted") return p.receive === "denied" ? "denied" : "default";
  } else {
    if (!webBasicsSupported()) return "unsupported";
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "default";
  }
  const token = isNativeApp() ? await nativeToken() : await webToken();
  if (!token) throw new Error("Couldn't turn on notifications on this device. Try again in a moment.");
  await registerToken(token);
  return "granted";
}

/**
 * After sign-in or on app start: if this device already allowed notifications, make sure its token
 * is registered to whoever is signed in now (tokens rotate, and phones are shared). Never prompts.
 */
export async function syncPushRegistration(): Promise<void> {
  try {
    if ((await pushState()) !== "granted") return;
    const token = isNativeApp() ? await nativeToken() : await webToken();
    if (token) await registerToken(token);
  } catch {
    /* offline or blocked: the next visit retries */
  }
}

/** Before signing out: stop pushes to this device for the account that is leaving. */
export async function unregisterPush(): Promise<void> {
  const token = storage.get();
  if (!token) return;
  try {
    await api.post("/api/push/devices/remove", { token });
  } catch {
    /* signed out already; the server drops dead tokens on its own */
  }
  storage.clear();
}

export interface IncomingPush {
  title: string;
  body: string;
  link: string | null;
}

/**
 * Listen for pushes that arrive while the site is open, and (in the app) for taps on a notification.
 *
 * Browsers do not show a push as a system notification when the site is open in front: Firebase
 * hands it to the page instead. So the page shows it itself (system popup with sound, plus the
 * caller's in-page message); otherwise a seller watching the portal would never see new orders pop up.
 * Returns a cleanup function.
 */
export async function listenForPushes(onMessage: (push: IncomingPush) => void, onOpen: (link: string) => void): Promise<() => void> {
  if (isNativeApp()) {
    const push = await nativePush();
    const a = await push.addListener("pushNotificationReceived", (n) => {
      const data = (n.data ?? {}) as Record<string, string>;
      onMessage({ title: n.title ?? "PartPilot", body: n.body ?? "", link: data.link ?? null });
    });
    const b = await push.addListener("pushNotificationActionPerformed", (e) => {
      const link = (e.notification.data as Record<string, string> | undefined)?.link;
      if (link) onOpen(link);
    });
    return () => { void a.remove(); void b.remove(); };
  }
  if (!webBasicsSupported() || Notification.permission !== "granted") return () => undefined;
  const m = await webMessaging().catch(() => null);
  if (!m) return () => undefined;
  return m.messaging.onMessage(m.instance, (payload) => {
    const incoming: IncomingPush = {
      title: payload.notification?.title ?? "PartPilot",
      body: payload.notification?.body ?? "",
      link: payload.data?.link ?? null,
    };
    void showSystemNotification(incoming, payload.data ?? {});
    onMessage(incoming);
  });
}

/** Show a push as a system notification from the page (the service worker handles its click). */
export async function showSystemNotification(push: IncomingPush, data: Record<string, string>): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_URL);
    if (!registration) return;
    await registration.showNotification(push.title, {
      body: push.body,
      icon: "/favicon.svg",
      tag: data.notification_id ? `pp-${data.notification_id}` : undefined,
      // Same shape Firebase uses, so the service worker's click handler opens the right page.
      data: { FCM_MSG: { data } },
    });
  } catch {
    /* the in-page message still shows */
  }
}
