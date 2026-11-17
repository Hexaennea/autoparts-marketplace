// Background janitor: expires unpaid online orders every 5 minutes and purges dead sessions.

import type { Database } from "./db.js";
import { purgeExpired } from "./security/sessions.js";
import { expireUnpaidOrders } from "./services/commerce.js";

export function startJanitor(database: Database, everyMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Each order is cancelled in its own transaction (see expireUnpaidOrders).
      const expired = await expireUnpaidOrders(database.reader());
      if (expired) console.log(`expired ${expired} unpaid orders`);
      await purgeExpired(database.reader());
    } catch (err) {
      console.error("janitor sweep failed", err); // keep the loop alive; the next sweep retries
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
