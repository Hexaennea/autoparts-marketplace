// Production build: bundles the SPA with esbuild, fingerprints assets, writes dist/index.html.
// `node build.mjs --watch` rebuilds on change (the API server serves dist/).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist";

const writeIndex = (result) => {
  const outputs = Object.entries(result.metafile.outputs);
  const entry = outputs.find(([, o]) => o.entryPoint === "src/main.tsx");
  if (!entry) throw new Error("entry output missing");
  const [jsPath, meta] = entry;
  const css = meta.cssBundle;
  const template = readFileSync("index.html", "utf8")
    .replace("<!--CSS-->", css ? `<link rel="stylesheet" href="/assets/${basename(css)}">` : "")
    .replace("<!--JS-->", `<script type="module" src="/assets/${basename(jsPath)}"></script>`);
  writeFileSync(`${outdir}/index.html`, template);
  cpSync("public", outdir, { recursive: true });
};

const options = {
  entryPoints: ["src/main.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: `${outdir}/assets`,
  entryNames: "[name]-[hash]",
  chunkNames: "chunk-[hash]",
  assetNames: "[name]-[hash]",
  publicPath: "/assets",
  target: ["es2020", "chrome100", "safari15", "firefox100"],
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch ? "inline" : "linked",
  legalComments: "linked",
  metafile: true,
  loader: { ".woff": "file", ".svg": "file", ".webp": "file", ".png": "file", ".jpg": "file", ".mp4": "file", ".webm": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
};

rmSync(outdir, { recursive: true, force: true });
mkdirSync(`${outdir}/assets`, { recursive: true });

// Web push service worker: its own classic script at the site root (a worker's scope is the folder
// it is served from, so it must be /firebase-messaging-sw.js to receive pushes for every page).
const swOptions = {
  entryPoints: ["src/sw/firebase-messaging-sw.ts"],
  bundle: true,
  format: "iife",
  outfile: `${outdir}/firebase-messaging-sw.js`,
  target: ["es2020", "chrome100", "safari15", "firefox100"],
  minify: !watch,
  legalComments: "none",
  define: options.define,
  logLevel: "warning",
};

if (watch) {
  const url = `http://localhost:${process.env.PORT ?? 8000}`;
  const onEnd = (r) => {
    if (r.errors.length) return;
    writeIndex(r);
    console.log(`UI rebuilt - open ${url} (served by the API server: npm run dev in server/)`);
  };
  const ctx = await esbuild.context({ ...options, plugins: [{ name: "index", setup(b) { b.onEnd(onEnd); } }] });
  await ctx.watch();
  await (await esbuild.context(swOptions)).watch();
} else {
  const [result] = await Promise.all([esbuild.build(options), esbuild.build(swOptions)]);
  writeIndex(result);
  const sizes = Object.entries(result.metafile.outputs)
    .filter(([f]) => f.endsWith(".js") || f.endsWith(".css"))
    .map(([f, o]) => `${basename(f).padEnd(34)} ${(o.bytes / 1024).toFixed(1).padStart(7)} KB`);
  console.log(sizes.join("\n"));
}
