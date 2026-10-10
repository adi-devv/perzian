// Bundles the daemon and the report MCP server into plain ESM that runs on Node 22 / Electron-as-node,
// with no tsx and no repo at runtime. Output (dist/):
//   dist/daemon/daemon.mjs        apps/daemon/src/index.ts, all pure-JS deps inlined
//   dist/daemon/report-mcp.mjs    packages/report-mcp/src/index.ts, all deps inlined
//   dist/daemon/node_modules/     packages that must stay real files: the ACP adapters (spawned as
//                                 separate processes, they ship native agent binaries) and
//                                 @vscode/tree-sitter-wasm (loads .wasm files next to itself),
//                                 copied with their full dependency closure
//   dist/web/                     apps/web/dist (the UI)
// Usage: node scripts/build-bundle.mjs [--skip-web]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const daemonOut = join(out, "daemon");
const skipWeb = process.argv.includes("--skip-web");

// Packages resolved at runtime via require.resolve / spawned as files; never inlined.
const RUNTIME_PACKAGES = ["@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp", "@vscode/tree-sitter-wasm"];
// Optional native accelerators that `ws` try/catch-requires; absent is fine.
const OPTIONAL_NATIVE = ["bufferutil", "utf-8-validate"];

const t0 = Date.now();
rmSync(daemonOut, { recursive: true, force: true });
rmSync(join(out, "web"), { recursive: true, force: true });
mkdirSync(daemonOut, { recursive: true });

// ---------- esbuild ----------

// CJS deps bundled into ESM call require() for node builtins; give them a real one. Named so it
// can't collide with module-level `const require = createRequire(...)` in our sources.
const banner = [
  `import { createRequire as __pzCreateRequire } from "node:module";`,
  `const require = __pzCreateRequire(import.meta.url);`,
].join("\n");

// Until the daemon resolves the report MCP from PERZIAN_REPORT_MCP itself (see the patch in the
// build report), rewrite its dev-only `tsx packages/report-mcp/src/index.ts` spawn at bundle time
// so the bundle runs the sibling report-mcp.mjs instead. No-op once the source handles the env var.
const reportMcpShim = {
  name: "perzian-report-mcp-path",
  setup(b) {
    b.onLoad({ filter: /apps[\\/]daemon[\\/]src[\\/]session\.ts$/ }, (args) => {
      let src = readFileSync(args.path, "utf8");
      if (src.includes("PERZIAN_REPORT_MCP")) return { contents: src, loader: "ts" };
      const entry = /const reportMcpEntry = join\(here, "\.\.\/\.\.\/\.\.\/packages\/report-mcp\/src\/index\.ts"\);/;
      const args_ = /args: \[tsxCli, reportMcpEntry\],/;
      if (!entry.test(src) || !args_.test(src)) {
        throw new Error("session.ts no longer matches the report-mcp shim; teach it PERZIAN_REPORT_MCP or update scripts/build-bundle.mjs");
      }
      src = src
        .replace(entry, `const reportMcpEntry = process.env.PERZIAN_REPORT_MCP ?? join(here, "report-mcp.mjs");`)
        .replace(args_, `args: [reportMcpEntry],`);
      return { contents: src, loader: "ts" };
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: banner },
  external: [...RUNTIME_PACKAGES, ...OPTIONAL_NATIVE],
  legalComments: "none",
  logLevel: "warning",
  sourcemap: false,
  minify: false,
};

await Promise.all([
  build({ ...common, entryPoints: [join(root, "apps/daemon/src/index.ts")], outfile: join(daemonOut, "daemon.mjs"), plugins: [reportMcpShim] }),
  build({ ...common, entryPoints: [join(root, "packages/report-mcp/src/index.ts")], outfile: join(daemonOut, "report-mcp.mjs") }),
]);
// Marks the folder as ESM for any tool that looks (the .mjs extension already does).
writeFileSync(join(daemonOut, "package.json"), JSON.stringify({ name: "perzian-daemon-bundle", private: true, type: "module" }, null, 2) + "\n");

// ---------- runtime packages + dependency closure ----------

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// Node resolution: <from>/node_modules/<name>, then each parent, up to the repo root.
function findPkg(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const cand = join(dir, "node_modules", name);
    if (existsSync(join(cand, "package.json"))) return cand;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

const copied = new Set();
let bytes = 0;
function duBytes(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const e of readdirSync(p)) n += duBytes(join(p, e));
  return n;
}

// Mirrors the package's path relative to the repo root (node_modules/x or node_modules/a/node_modules/x)
// so nested, non-hoisted versions resolve exactly as they do in the repo.
function copyPkg(name, from, optional = false) {
  const dir = findPkg(name, from);
  if (!dir) {
    if (optional) return;
    throw new Error(`cannot resolve ${name} from ${relative(root, from) || "."}`);
  }
  if (copied.has(dir)) return;
  copied.add(dir);
  const rel = relative(root, dir);
  if (!rel.startsWith("node_modules" + sep)) throw new Error(`${name} resolved outside node_modules: ${rel}`);
  const dest = join(daemonOut, rel);
  cpSync(dir, dest, {
    recursive: true,
    dereference: true,
    // Nested node_modules are copied on demand by the recursion below, only if actually depended on.
    filter: (src) => !relative(dir, src).split(sep).includes("node_modules"),
  });
  bytes += duBytes(dest);
  const pkg = readPkg(dir);
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPkg(dep, dir);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) copyPkg(dep, dir, true);
  // Peers are provided by whoever installed the package; take them when the repo has them.
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) copyPkg(dep, dir, true);
}

for (const name of RUNTIME_PACKAGES) copyPkg(name, join(root, "apps/daemon"));

// ---------- web UI ----------

if (!skipWeb) {
  execFileSync("npm", ["run", "build", "--workspace=@perzian/web"], { cwd: root, stdio: "inherit" });
}
const webDist = join(root, "apps/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("apps/web/dist/index.html missing; run the web build");
cpSync(webDist, join(out, "web"), { recursive: true });

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(
  `[build-bundle] daemon.mjs ${mb(statSync(join(daemonOut, "daemon.mjs")).size)}, report-mcp.mjs ${mb(statSync(join(daemonOut, "report-mcp.mjs")).size)}, ` +
    `${copied.size} runtime packages ${mb(bytes)}, web ${mb(duBytes(join(out, "web")))} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${relative(root, out)}${sep}`,
);
