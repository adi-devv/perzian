// Packages Perzian as an unsigned (ad-hoc signed) macOS arm64 app:
//   slim (default, `npm run dist`): release/Perzian-darwin-arm64/Perzian.app and
//     release/Perzian-<version>-mac-arm64.zip; runs the installed `claude` / `codex` CLIs
//   --full (unadvertised; e.g. offline installs): release/full/..., Perzian-<version>-mac-arm64-full.zip; also bundles
//     the native agent CLIs, so it runs with nothing installed (~4x larger)
// Steps: bundle daemon/report-mcp/web (scripts/build-bundle.mjs), render the icon to .icns,
// stage the Electron shell, run @electron/packager offline from the local Electron zip cache,
// ad-hoc sign, zip with ditto.
// Usage: node scripts/build-app.mjs [--full] [--skip-bundle] [--no-zip]
import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { iconRGBA } from "../apps/desktop/icon-pixels.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const release = join(root, "release", ...(full ? ["full"] : []));
const desktop = join(root, "apps/desktop");
const ARCH = "arm64";
const NAME = "Perzian";

if (process.platform !== "darwin") throw new Error("build-app targets macOS and needs iconutil/codesign/ditto");
const t0 = Date.now();
const step = (msg) => console.log(`[build-app] ${msg} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ---------- 1. bundle ----------

if (!args.has("--skip-bundle")) execFileSync(process.execPath, [join(root, "scripts/build-bundle.mjs"), ...(full ? ["--full"] : [])], { stdio: "inherit" });
for (const p of ["daemon/daemon.mjs", "daemon/report-mcp.mjs", "web/index.html"]) {
  if (!existsSync(join(dist, p))) throw new Error(`dist/${p} missing; run scripts/build-bundle.mjs`);
}
const bundleMode = JSON.parse(readFileSync(join(dist, "daemon/package.json"), "utf8")).perzianBundle ?? "full";
if (bundleMode !== (full ? "full" : "slim")) throw new Error(`dist/ holds a ${bundleMode} bundle; rebuild it without --skip-bundle`);
step(`${bundleMode} bundle ready`);

// ---------- 2. icon (.icns from icon-pixels.js) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const rgba = iconRGBA(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); // filter 0 per row
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const iconset = join(dist, `${NAME}.iconset`);
const icns = join(dist, `${NAME}.icns`);
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${base}x${base}.png`), png(base));
  writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), png(base * 2));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
writeFileSync(join(dist, `${NAME}.png`), png(1024));
rmSync(iconset, { recursive: true, force: true });
step("icon rendered");

// ---------- 3. stage the Electron shell ----------

const desktopPkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const electronVersion = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version;
const version = desktopPkg.version;
const stage = join(dist, "app");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// Everything main.js imports; it has no npm dependencies (Electron + node builtins only).
for (const f of readdirSync(desktop)) if (/\.c?js$/.test(f)) copyFileSync(join(desktop, f), join(stage, f));
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify({ name: "perzian", productName: NAME, version, description: "Visual-first agentic development environment", type: "module", main: "main.js" }, null, 2) + "\n",
);

// ---------- 4. package ----------

// npm install scripts are blocked on some machines, so prefer the zip Electron's own installer cached.
function findElectronZip() {
  const cache = process.env.electron_config_cache ?? join(homedir(), "Library/Caches/electron");
  const want = `electron-v${electronVersion}-darwin-${ARCH}.zip`;
  if (!existsSync(cache)) return undefined;
  for (const d of [cache, ...readdirSync(cache).map((x) => join(cache, x))]) {
    if (existsSync(join(d, want)) && statSync(join(d, want)).size > 0) return d;
  }
  return undefined;
}
const electronZipDir = findElectronZip();
step(electronZipDir ? `using cached Electron ${electronVersion} zip from ${electronZipDir}` : `Electron ${electronVersion} zip not cached; packager will download it`);

const appDir = join(release, `${NAME}-darwin-${ARCH}`);
rmSync(appDir, { recursive: true, force: true });
const [outDir] = await packager({
  dir: stage,
  out: release,
  name: NAME,
  executableName: NAME,
  platform: "darwin",
  arch: ARCH,
  electronVersion,
  ...(electronZipDir ? { electronZipDir } : {}),
  appVersion: version,
  appBundleId: "dev.perzian.app",
  appCategoryType: "public.app-category.developer-tools",
  icon: icns,
  asar: true,
  prune: false, // the staged shell has no dependencies
  overwrite: true,
  junk: true,
  darwinDarkModeSupport: true,
  // Contents/Resources/daemon and Contents/Resources/web, outside the asar: the daemon is spawned as
  // a file, adapters spawn native binaries, tree-sitter reads .wasm from disk.
  extraResource: [join(dist, "daemon"), join(dist, "web")],
  quiet: true,
});
const appPath = join(outDir, `${NAME}.app`);
step(`packaged ${relative(root, appPath)}`);

// ---------- 5. ad-hoc sign ----------

// Packager rewrites Info.plist and renames the binary, which breaks Electron's signature; Apple
// Silicon refuses to run arm64 code with no/invalid signature, so re-sign ad-hoc. Not notarized.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
step("ad-hoc signed");

// ---------- 6. zip ----------

const du = (p) => Number(execFileSync("du", ["-sk", p]).toString().split("\t")[0]) * 1024;
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
let zipPath;
if (!args.has("--no-zip")) {
  zipPath = join(release, `${NAME}-${version}-mac-${ARCH}${full ? "-full" : ""}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  step(`zipped ${relative(root, zipPath)}`);
}
console.log(`[build-app] done: ${relative(root, appPath)} ${mb(du(appPath))}${zipPath ? `, ${relative(root, zipPath)} ${mb(statSync(zipPath).size)}` : ""}`);
