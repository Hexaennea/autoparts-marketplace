// Production / development entry point: `npm run dev` or `npm start`.

import { createApp } from "./app.js";
import { isTest, loadSettings } from "./config.js";
import { startJanitor } from "./jobs.js";

const settings = loadSettings();
const { express: app, state } = await createApp(settings);

const server = app.listen(settings.port, () => {
  console.log(`${settings.appName} API listening on http://localhost:${settings.port}`);
});

const stopJanitor = isTest(settings) ? () => undefined : startJanitor(state.database);

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopJanitor();
  server.close();
  await state.database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
