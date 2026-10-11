// Root postinstall: make sure Electron's binary is really there so `npm run app` works on a fresh clone.
// npm 11 runs Electron's own postinstall only because package.json lists it in `allowScripts`; even then,
// on newer Node (26) its unzip step (extract-zip 2.0.1) stops silently after the first file. If the binary
// is still missing, fetch the zip the same way Electron does (cached, checksummed) and unzip it with the
// system tool. A no-op when Electron installed itself.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0);
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../apps/desktop/package.json"));
let dir;
try {
  dir = dirname(require.resolve("electron/package.json"));
} catch {
  process.exit(0); // not installed (e.g. --omit=dev)
}
const platformPath = { darwin: "Electron.app/Contents/MacOS/Electron", mas: "Electron.app/Contents/MacOS/Electron", win32: "electron.exe" }[process.platform] ?? "electron";
const dist = join(dir, "dist");
const installed = () => {
  try {
    return readFileSync(join(dir, "path.txt"), "utf8") === platformPath && existsSync(join(dist, platformPath));
  } catch {
    return false;
  }
};
if (installed()) process.exit(0);

console.log("[perzian] Electron's binary is missing after install; unpacking it…");
try {
  const { version } = require("electron/package.json");
  const { downloadArtifact } = require("@electron/get");
  const zip = await downloadArtifact({ version, artifactName: "electron", platform: process.platform, arch: process.arch, checksums: require("electron/checksums.json") });
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  if (process.platform === "win32") execFileSync("tar", ["-xf", zip, "-C", dist], { stdio: "inherit" });
  else execFileSync("unzip", ["-q", "-o", zip, "-d", dist], { stdio: "inherit" });
  if (existsSync(join(dist, "electron.d.ts"))) renameSync(join(dist, "electron.d.ts"), join(dir, "electron.d.ts"));
  writeFileSync(join(dir, "path.txt"), platformPath);
  console.log(installed() ? "[perzian] Electron ready." : "[perzian] Electron still missing; see README › Troubleshooting.");
} catch (e) {
  // Never fail the whole install over the desktop shell; `npm run dev` (browser) still works.
  console.warn(`[perzian] Couldn't unpack Electron: ${e?.message ?? e}. Delete node_modules/electron and run npm install again.`);
}
