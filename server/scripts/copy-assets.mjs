// Copies non-TypeScript runtime files (SQL migrations, seed images) next to the compiled output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["migrations", "seed_assets", "fonts"]) {
  const from = path.join(root, "src", dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(root, "dist", dir), { recursive: true });
}
