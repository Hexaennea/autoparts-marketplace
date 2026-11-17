// Renders the illustrations to WebP for demo listings (on the card ground colour) and a contact sheet.
import sharp from "sharp";
import { readdirSync, mkdirSync } from "node:fs";
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const files = readdirSync(".").filter((f) => f.endsWith(".svg"));
const tiles = [];
for (const f of files) {
  const name = f.replace(".svg", "");
  const base = sharp(f, { density: 144 }).resize(800, 800).flatten({ background: "#F3F4F6" });
  await base.clone().webp({ quality: 84 }).toFile(`${out}/${name}.webp`);
  await base.clone().resize(480, 480).webp({ quality: 80 }).toFile(`${out}/${name}_t.webp`);
  tiles.push(await sharp(f, { density: 72 }).resize(200, 200).flatten({ background: "#F3F4F6" }).png().toBuffer());
}
const cols = 7, rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * 210, height: rows * 210, channels: 3, background: "#ffffff" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 210 + 5, top: Math.floor(i / cols) * 210 + 5 })))
  .png().toFile("/tmp/contact.png");
console.log("rendered", files.length);
