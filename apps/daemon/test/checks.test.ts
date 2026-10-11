import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks } from "../src/checks.ts";
import { isVerificationCommand } from "../src/permissions.ts";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "perzian-checks-"));
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

test("package.json scripts, in order, with the project's package manager", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { build: "tsc", lint: "eslint .", test: "node --test", typecheck: "tsc --noEmit", dev: "vite" } }) });
  try {
    assert.deepEqual(detectChecks(dir), ["npm test", "npm run typecheck", "npm run lint", "npm run build"]);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    assert.deepEqual(detectChecks(dir), ["pnpm test", "pnpm run typecheck", "pnpm run lint", "pnpm run build"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips npm's placeholder test script and keeps one typecheck", () => {
  const dir = project({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', "type-check": "tsc", "check-types": "tsc" } }) });
  try {
    assert.deepEqual(detectChecks(dir), ["npm run type-check"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python, rust and go markers", () => {
  const py = project({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n" });
  const rs = project({ "Cargo.toml": "[package]\nname='x'\n" });
  const go = project({ "go.mod": "module x\n" });
  const mk = project({ Makefile: "test:\n\techo ok\n" });
  try {
    assert.deepEqual(detectChecks(py), ["pytest", "ruff check"]);
    assert.deepEqual(detectChecks(rs), ["cargo test", "cargo clippy"]);
    assert.deepEqual(detectChecks(go), ["go test ./...", "go vet ./..."]);
    assert.deepEqual(detectChecks(mk), ["make test"]);
  } finally {
    for (const d of [py, rs, go, mk]) rmSync(d, { recursive: true, force: true });
  }
});

test("nothing detected: empty, and a broken package.json doesn't throw", () => {
  const dir = project({ "package.json": "{not json" });
  try {
    assert.deepEqual(detectChecks(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every detected command runs without a permission card", () => {
  for (const c of ["npm test", "pnpm run typecheck", "yarn run lint", "bun run build", "pytest", "mypy .", "ruff check", "cargo test", "cargo clippy", "go test ./...", "go vet ./...", "make test"]) {
    assert.equal(isVerificationCommand(c), true, c);
  }
});
