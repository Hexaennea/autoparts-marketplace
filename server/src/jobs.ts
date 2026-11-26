// Background work.
//
// * Janitor (every 5 minutes): expires unpaid online orders, purges dead sessions and old
//   notifications, and sends any push notifications still due.
// * Push worker (every 15 seconds, and right after a request queues a push): sends due pushes.
//
// On Cloud Run an idle instance gets no CPU, so timers stop; a scheduler (Google Cloud Scheduler)
// should call GET /api/cron/janitor every minute or two to run sweep() (see app.ts).

import type { Database } from "./db.js";
import { purgeExpired } from "./security/sessions.js";
import { expireUnpaidOrders } from "./services/commerce.js";
import { setOutboxKicker } from "./services/notify.js";
import { processPushOutbox, purgeNotifications } from "./services/push.js";

/** One janitor pass. Also run on demand by serverless deployments, which have no timers. */
export async function sweep(database: Database): Promise<void> {
  // Each order is cancelled in its own transaction (see expireUnpaidOrders).
  const expired = await expireUnpaidOrders(database.reader());
  if (expired) console.log(`expired ${expired} unpaid orders`);
  await purgeExpired(database.reader());
  await purgeNotifications(database.reader());
  await processPushOutbox(database);
}

/** Run `fn` every `everyMs`, never overlapping itself. Returns [runNow, stop]. */
function loop(name: string, everyMs: number, fn: () => Promise<void>): [() => void, () => void] {
  let running = false;
  let again = false;
  const tick = async () => {
    if (running) {
      again = true; // run once more when the current pass ends
      return;
    }
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error(`${name} failed`, err); // keep the loop alive; the next pass retries
    } finally {
      running = false;
      if (again) {
        again = false;
        void tick();
      }
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return [() => void tick(), () => clearInterval(timer)];
}

export function startJanitor(database: Database, everyMs = 5 * 60_000): () => void {
  const [, stopJanitor] = loop("janitor sweep", everyMs, () => sweep(database));
  const [pushNow, stopPush] = loop("push worker", 15_000, async () => {
    await processPushOutbox(database);
  });
  setOutboxKicker(pushNow);
  return () => {
    setOutboxKicker(null);
    stopJanitor();
    stopPush();
  };
}
