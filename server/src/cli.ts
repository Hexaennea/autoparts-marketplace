// Operational commands:
//   npm run migrate                      apply pending SQL migrations
//   npm run seed [-- --reset]            demo data (refuses in production)
//   tsx src/cli.ts create-admin EMAIL    prompts for a password
//   tsx src/cli.ts purge-sessions
//   tsx src/cli.ts expire-unpaid

import { createInterface } from "node:readline/promises";
import { isProduction, loadSettings } from "./config.js";
import { Database, utcnow } from "./db.js";
import { hashPassword, passwordProblems } from "./security/passwords.js";
import { purgeExpired } from "./security/sessions.js";
import { expireUnpaidOrders } from "./services/commerce.js";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const settings = loadSettings();
  const database = new Database(settings.databaseUrl);
  try {
    switch (command) {
      case "migrate": {
        const applied = await database.migrate();
        console.log(`Applied: ${applied.join(", ") || "nothing new"}`);
        return 0;
      }
      case "seed": {
        if (isProduction(settings)) {
          console.error("Refusing to seed demo data in production.");
          return 1;
        }
        if (rest.includes("--if-empty")) {
          await database.migrate();
          if (Number(await database.reader().scalar("SELECT COUNT(*) FROM makes")) > 0) {
            console.log("Database already has data; skipping demo seed.");
            return 0;
          }
        }
        const { runSeed, ADMIN_EMAIL, ADMIN_PASSWORD, DEMO_PASSWORD } = await import("./seed.js");
        const result = await runSeed(database, settings, { reset: rest.includes("--reset") });
        console.log(`Seeded ${JSON.stringify(result)}`);
        console.log(`  admin:  ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
        console.log(`  seller: lakshmi.autospares@partpilot.test / ${DEMO_PASSWORD}`);
        console.log(`  buyer:  priya@partpilot.test / ${DEMO_PASSWORD}`);
        return 0;
      }
      case "create-admin": {
        const email = (rest[0] ?? "").toLowerCase();
        const nameIdx = rest.indexOf("--name");
        const name = nameIdx >= 0 ? (rest[nameIdx + 1] ?? "Platform Admin") : "Platform Admin";
        if (!email) {
          console.error("Usage: create-admin EMAIL [--name NAME]");
          return 1;
        }
        await database.migrate();
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const password = await rl.question("Password: ");
        const repeat = await rl.question("Repeat password: ");
        rl.close();
        const problems = passwordProblems(password, { email, name });
        if (problems.length) {
          console.error(problems.join("\n"));
          return 1;
        }
        if (password !== repeat) {
          console.error("Passwords don't match.");
          return 1;
        }
        const created = await database.writer(async (db) => {
          if (await db.scalar("SELECT 1 FROM users WHERE email = ?", [email])) return false;
          const now = utcnow();
          await db.execute(
            "INSERT INTO users (email, password_hash, full_name, role, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?)",
            [email, await hashPassword(password), name, now, now],
          );
          return true;
        });
        console.log(created ? "Admin created." : "A user with this email already exists.");
        return created ? 0 : 1;
      }
      case "expire-unpaid":
        console.log(`Expired ${await expireUnpaidOrders(database.reader())} unpaid orders.`);
        return 0;
      case "purge-sessions":
        console.log(`Removed ${await purgeExpired(database.reader())} expired sessions.`);
        return 0;
      default:
        console.error("Commands: migrate | seed [--reset] | create-admin EMAIL | purge-sessions | expire-unpaid");
        return 1;
    }
  } finally {
    await database.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
