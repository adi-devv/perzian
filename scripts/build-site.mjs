// Builds perzian.dev into dist-site/: the static landing page plus the web UI as a live demo at /demo/.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "apps/site"), out, { recursive: true });
execFileSync("npx", ["vite", "build", "--outDir", join(out, "demo"), "--emptyOutDir", "--base", "./"], { cwd: join(root, "apps/web"), stdio: "inherit" });
writeFileSync(join(out, "CNAME"), "perzian.dev\n");
writeFileSync(join(out, ".nojekyll"), "");
console.log(`site built → ${out}`);
