/// <reference lib="webworker" />
// Service worker for web push (built to /firebase-messaging-sw.js by build.mjs).
//
// When the site is not open in a focused tab, Firebase shows the push as a system notification
// (title and body come from the server, see server/src/services/push.ts). Clicking it opens or
// focuses PartPilot at the notification's link, e.g. /orders/21 or /seller/orders/25.

import { initializeApp } from "firebase/app";
import { getMessaging } from "firebase/messaging/sw";
import { FIREBASE_WEB_CONFIG } from "../lib/firebase-config";

declare const self: ServiceWorkerGlobalScope;

// Registered before Firebase's own handler so ours decides where a click goes.
self.addEventListener("notificationclick", (event) => {
  const data = (event.notification.data ?? {}) as { FCM_MSG?: { data?: { link?: string } } };
  const link = data.FCM_MSG?.data?.link ?? "/";
  // Only ever open pages on this site.
  const url = new URL(link.startsWith("/") ? link : "/", self.location.origin).href;
  event.notification.close();
  event.stopImmediatePropagation();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        await open.navigate(url).catch(() => undefined);
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});

self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

getMessaging(initializeApp(FIREBASE_WEB_CONFIG));
