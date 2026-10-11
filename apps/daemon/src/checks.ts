// The project's real check commands (tests, typecheck, lint, build), detected from its manifests so a
// worker's brief can name them and the lead can see them in list_sessions/get_session.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT_ORDER = ["test", "typecheck", "type-check", "check-types", "lint", "build"];
// npm init's placeholder, which always fails.
const PLACEHOLDER = /no test specified/;

function read(dir: string, file: string): string | undefined {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Check commands for the project at `dir`, most important first. Empty when nothing is detected. */
export function detectChecks(dir: string): string[] {
  const out: string[] = [];
  const pkg = read(dir, "package.json");
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(dir);
      let typecheck = false;
      for (const name of SCRIPT_ORDER) {
        const body = scripts[name];
        if (typeof body !== "string" || !body.trim() || (name === "test" && PLACEHOLDER.test(body))) continue;
        if (name !== "test" && name !== "lint" && name !== "build") {
          if (typecheck) continue;
          typecheck = true;
        }
        out.push(name === "test" ? `${pm} test` : `${pm} run ${name}`);
      }
    } catch {}
  }
  const pyproject = read(dir, "pyproject.toml") ?? "";
  if (/\bpytest\b/.test(pyproject) || existsSync(join(dir, "pytest.ini")) || /\[(tool:)?pytest\]/.test(read(dir, "setup.cfg") ?? "") || /\bpytest\b/.test(read(dir, "tox.ini") ?? "")) out.push("pytest");
  if (/\[tool\.mypy\]/.test(pyproject) || existsSync(join(dir, "mypy.ini"))) out.push("mypy .");
  if (/\[tool\.ruff/.test(pyproject) || existsSync(join(dir, "ruff.toml"))) out.push("ruff check");
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cargo test", "cargo clippy");
  if (existsSync(join(dir, "go.mod"))) out.push("go test ./...", "go vet ./...");
  // A Makefile test target, when nothing above already covers tests.
  if (!out.some((c) => / test\b|^pytest|^cargo test|^go test/.test(c)) && /^test:/m.test(read(dir, "Makefile") ?? "")) out.push("make test");
  return out;
}
