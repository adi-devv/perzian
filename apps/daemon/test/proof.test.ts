import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Proof } from "@perzian/protocol";
import { classifyCommand, mergeProofs, parseSummary, ProofTracker, type ToolUpdateLike } from "../src/proof.ts";

// Fixtures follow what claude-agent-acp 0.89 actually sent in a live run (client without terminal_output).
const bashCall = (id: string): ToolUpdateLike => ({
  toolCallId: id,
  title: "Terminal",
  name: "Bash",
  kind: "execute",
  status: "pending",
  content: [],
  rawInput: {},
  _meta: { claudeCode: { toolName: "Bash" } },
  sessionUpdate: "tool_call",
});
const bashInput = (id: string, command: string): ToolUpdateLike => ({
  toolCallId: id,
  title: command,
  rawInput: { command },
  _meta: { claudeCode: { toolName: "Bash" } },
  sessionUpdate: "tool_call_update",
});
const bashDescribed = (id: string, command: string): ToolUpdateLike => ({
  toolCallId: id,
  content: [{ content: { text: "Run the tests", type: "text" }, type: "content" }],
  rawInput: { command, description: "Run the tests" },
  _meta: { claudeCode: { toolName: "Bash" } },
  sessionUpdate: "tool_call_update",
});
const bashResponse = (id: string, stdout: string, extra: Record<string, unknown> = {}): ToolUpdateLike => ({
  toolCallId: id,
  _meta: { claudeCode: { toolResponse: { stdout, stderr: "", interrupted: false, isImage: false, noOutputExpected: false, ...extra }, toolName: "Bash" } },
  sessionUpdate: "tool_call_update",
});
const bashCompleted = (id: string, stdout: string): ToolUpdateLike => ({
  toolCallId: id,
  status: "completed",
  content: stdout ? [{ content: { text: "```console\n" + stdout + "\n```", type: "text" }, type: "content" }] : [],
  rawOutput: stdout,
  _meta: { claudeCode: { toolName: "Bash" } },
  sessionUpdate: "tool_call_update",
});
const bashFailed = (id: string, text: string): ToolUpdateLike => ({
  toolCallId: id,
  status: "failed",
  content: [{ content: { text: "```\n" + text + "\n```", type: "text" }, type: "content" }],
  rawOutput: text,
  _meta: { claudeCode: { toolName: "Bash" } },
  sessionUpdate: "tool_call_update",
});

const NODE_OK = "✔ git helpers (492ms)\nℹ tests 45\nℹ suites 3\nℹ pass 45\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 586";
const NODE_FAIL = "✖ store folds events\nℹ tests 45\nℹ pass 43\nℹ fail 2\nℹ skipped 0";

function clock(start = 1000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

// Drives one command through the full sequence and returns the proof the final update produced.
function run(tr: ProofTracker, c: ReturnType<typeof clock>, id: string, command: string, result: { ok: string } | { fail: string }, ms = 100): Proof | undefined {
  tr.onToolCall(bashCall(id));
  c.tick(50); // model still streaming the input
  tr.onToolUpdate(bashInput(id, command));
  tr.onToolUpdate(bashDescribed(id, command));
  c.tick(ms);
  if ("ok" in result) {
    tr.onToolUpdate(bashResponse(id, result.ok));
    return tr.onToolUpdate(bashCompleted(id, result.ok));
  }
  return tr.onToolUpdate(bashFailed(id, result.fail));
}

describe("classifyCommand", () => {
  const cases: [string, string | null, string?][] = [
    ["npm test", "tests"],
    ["npm run test", "tests"],
    ["npm t", "tests"],
    ["npm run test:unit", "tests"],
    ["npm run typecheck", "typecheck"],
    ["npm run lint", "lint"],
    ["npm run build", "build"],
    ["pnpm test", "tests"],
    ["pnpm -r test", "tests"],
    ["pnpm --filter web lint", "lint"],
    ["pnpm build", "build"],
    ["yarn test", "tests"],
    ["yarn workspace web build", "build"],
    ["bun test", "tests"],
    ["bun run typecheck", "typecheck"],
    ["npm -w @perzian/daemon run typecheck", "typecheck"],
    ["npm --prefix apps/web run build", "build"],
    ["npx tsc --noEmit", "typecheck"],
    ["npx tsc -b", "build"],
    ["tsc --noEmit -p apps/daemon", "typecheck"],
    ["npx vitest run", "tests"],
    ["vitest", "tests"],
    ["npx jest --ci", "tests"],
    ["mocha", "tests"],
    ["node --test test/", "tests"],
    ["tsx --test apps/*/test/*.test.ts", "tests"],
    ["npx playwright test", "tests"],
    ["pytest -q", "tests"],
    ["python -m pytest tests/", "tests"],
    ["python3 -m unittest discover", "tests"],
    ["uv run pytest -x", "tests"],
    ["poetry run mypy src", "typecheck"],
    ["coverage run -m pytest", "tests"],
    ["ruff check .", "lint"],
    ["ruff format --check .", "lint"],
    ["eslint src", "lint"],
    ["prettier --check .", "lint"],
    ["biome check .", "lint"],
    ["mypy src", "typecheck"],
    ["pyright", "typecheck"],
    ["go test ./...", "tests"],
    ["go build ./...", "build"],
    ["go vet ./...", "lint"],
    ["golangci-lint run", "lint"],
    ["cargo test", "tests"],
    ["cargo +nightly test", "tests"],
    ["cargo build --release", "build"],
    ["cargo check", "typecheck"],
    ["cargo clippy -- -D warnings", "lint"],
    ["cargo fmt --check", "lint"],
    ["make test", "tests"],
    ["make check", "tests"],
    ["make -C backend test", "tests"],
    ["make", "build"],
    ["make lint", "lint"],
    ["mvn test", "tests"],
    ["./mvnw -q verify", "tests"],
    ["./gradlew test", "tests"],
    ["gradle :app:testDebugUnitTest", "tests"],
    ["./gradlew assembleDebug", "build"],
    ["swift test", "tests"],
    ["swift build", "build"],
    ["xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' test", "tests"],
    ["xcodebuild -scheme App build", "build"],
    ["dotnet test", "tests"],
    ["bundle exec rspec", "tests"],
    ["deno test", "tests"],
    ["nx run web:test", "tests"],
    ["nx run-many -t lint,test", "tests"],
    ["turbo run build", "build"],
    // Shell around it
    ["cd apps/daemon && npx tsc --noEmit", "typecheck", "npx tsc --noEmit (in apps/daemon)"],
    ["CI=1 FORCE_COLOR=0 npm test 2>&1 | tail -20", "tests", "npm test"],
    ["(cd web && npm run lint)", "lint", "npm run lint (in web)"],
    ["timeout 120 npm test", "tests", "npm test"],
    ["env NODE_ENV=test npx jest", "tests", "npx jest"],
    ["npm test > /tmp/out.log 2>&1", "tests", "npm test"],
    ["npm test -- --grep 'foo bar'", "tests", "npm test -- --grep 'foo bar'"],
    ["cd /x && npm run build && npm test", "tests", "npm run build && npm test (in /x)"],
    ["npm test; echo done", "tests", "npm test"],
    // Not verification
    ["npm install", null],
    ["pnpm i", null],
    ["yarn add zod", null],
    ["npm run dev", null],
    ["npm start", null],
    ["npm run test:watch", null],
    ["npm run lint:fix", null],
    ["vitest --watch", null],
    ["jest --watch", null],
    ["tsc --watch", null],
    ["eslint --fix src", null],
    ["ruff format .", null],
    ["cargo fmt", null],
    ["make clean", null],
    ["node index.js", null],
    ["go run .", null],
    ["xcodebuild -list", null],
    ["git status", null],
    ["ls -la", null],
    ["echo npm test", null],
    ["grep -r 'npm test' .", null],
    ["cat package.json | grep test", null],
    ["node -e 'process.exit(3)'", null],
    ["", null],
  ];
  for (const [cmd, kind, label] of cases) {
    test(`${JSON.stringify(cmd)} -> ${kind ?? "null"}`, () => {
      const c = classifyCommand(cmd);
      assert.equal(c?.kind ?? null, kind);
      if (label) assert.equal(c?.label, label);
    });
  }

  test("labels are capped", () => {
    const c = classifyCommand(`npx vitest run ${"src/some/really/long/path/".repeat(6)}`);
    assert.ok(c && c.label.length <= 80 && c.label.endsWith("…"));
  });
});

describe("parseSummary", () => {
  test("node:test", () => {
    assert.deepEqual(parseSummary(NODE_OK), { summary: "45 passed", failed: false });
    assert.deepEqual(parseSummary(NODE_FAIL), { summary: "2 failed, 43 passed", failed: true });
    assert.deepEqual(parseSummary("# tests 3\n# pass 3\n# fail 0"), { summary: "3 passed", failed: false });
  });
  test("node:test across workspaces sums", () => {
    assert.equal(parseSummary(`${NODE_OK}\n${NODE_FAIL}`).summary, "2 failed, 88 passed");
  });
  test("jest and vitest", () => {
    assert.deepEqual(parseSummary("Tests:       1 failed, 2 skipped, 44 passed, 47 total"), { summary: "1 failed, 44 passed, 2 skipped", failed: true });
    assert.deepEqual(parseSummary(" Test Files  3 passed (3)\n      Tests  42 passed (42)\n   Start at  10:00"), { summary: "42 passed", failed: false });
    assert.equal(parseSummary("\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m3 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m42 passed\x1b[39m (45)").summary, "3 failed, 42 passed");
  });
  test("pytest", () => {
    assert.deepEqual(parseSummary("=========== 3 failed, 42 passed, 1 skipped in 1.23s ==========="), { summary: "3 failed, 42 passed, 1 skipped", failed: true });
    assert.deepEqual(parseSummary("....\n4 passed in 0.05s"), { summary: "4 passed", failed: false });
    assert.equal(parseSummary("==== 1 passed, 2 errors in 0.3s ====").failed, true);
  });
  test("mocha, cargo, go, rspec, xctest", () => {
    assert.equal(parseSummary("  45 passing (2s)\n  3 failing").summary, "3 failed, 45 passed");
    assert.equal(parseSummary("test result: ok. 10 passed; 0 failed; 1 ignored\ntest result: FAILED. 2 passed; 1 failed; 0 ignored").summary, "1 failed, 12 passed, 1 skipped");
    assert.deepEqual(parseSummary("ok  \tgithub.com/x/a\t0.01s\n?   \tgithub.com/x/b\t[no test files]\nok  \tgithub.com/x/c\t0.2s"), { summary: "2 packages ok", failed: false });
    assert.deepEqual(parseSummary("--- FAIL: TestX (0.00s)\nFAIL\tgithub.com/x/a\t0.01s\nok  \tgithub.com/x/c\t0.2s"), { summary: "1 package failed, 1 ok", failed: true });
    assert.equal(parseSummary("12 examples, 2 failures").summary, "2 failed, 10 passed");
    assert.equal(parseSummary("Executed 12 tests, with 0 failures (0 unexpected) in 0.5s").summary, "12 passed");
  });
  test("typecheck and lint", () => {
    assert.deepEqual(parseSummary("src/a.ts(3,7): error TS2322: Type 'string' is not assignable.\n\nFound 1 error in src/a.ts:3"), { summary: "1 error", failed: true });
    assert.deepEqual(parseSummary("src/a.ts(3,7): error TS2322: x\nsrc/b.ts(1,1): error TS2304: y"), { summary: "2 errors", failed: true });
    assert.deepEqual(parseSummary("✖ 5 problems (3 errors, 2 warnings)"), { summary: "3 errors, 2 warnings", failed: true });
    assert.deepEqual(parseSummary("✖ 2 problems (0 errors, 2 warnings)"), { summary: "2 warnings", failed: false });
    assert.deepEqual(parseSummary("Success: no issues found in 10 source files"), { summary: "no issues" });
    assert.deepEqual(parseSummary("All checks passed!"), { summary: "all checks passed" });
  });
  test("nothing recognisable", () => {
    assert.deepEqual(parseSummary(""), {});
    assert.deepEqual(parseSummary("built in 1.2s"), {});
  });
});

describe("ProofTracker", () => {
  test("records a passing verification with exit code, duration and summary", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "npm test", { ok: NODE_OK }, 2500);
    assert.deepEqual(p, { kind: "tests", label: "npm test", passed: true, observed: true, command: "npm test", exitCode: 0, durationMs: 2500, summary: "45 passed" });
    assert.deepEqual(tr.proofs(), [p]);
  });

  test("records a failing verification from the adapter's 'Exit code N' text", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "cd apps/daemon && npx tsc --noEmit", { fail: "Exit code 2\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'." });
    assert.equal(p?.passed, false);
    assert.equal(p?.exitCode, 2);
    assert.equal(p?.kind, "typecheck");
    assert.equal(p?.label, "npx tsc --noEmit (in apps/daemon)");
    assert.equal(p?.summary, "1 error");
    assert.match(p?.detail ?? "", /error TS2322/);
    assert.doesNotMatch(p?.detail ?? "", /Exit code/);
  });

  test("a non-zero exit fails even when the output looks clean", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "npm test", { fail: `Exit code 1\n${NODE_OK}\nnpm ERR! Test failed.` });
    assert.equal(p?.passed, false);
    assert.equal(p?.exitCode, 1);
  });

  test("ignores commands that are not verification (live fixture)", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    assert.equal(run(tr, c, "t1", `node -e 'process.exit(0)'; echo "exit=$?"; node -e 'process.exit(3)'; echo "exit=$?"`, { ok: "exit=0\nexit=3" }), undefined);
    assert.equal(run(tr, c, "t2", `node -e 'console.log("boom"); process.exit(3)'`, { fail: "Exit code 3\nboom" }), undefined);
    assert.deepEqual(tr.proofs(), []);
  });

  test("ignores tools that are not commands", () => {
    const tr = new ProofTracker();
    const edit: ToolUpdateLike = { toolCallId: "e1", title: "Edit a.ts", kind: "edit", name: "Edit", status: "pending", rawInput: { file_path: "a.ts" }, sessionUpdate: "tool_call" };
    tr.onToolCall(edit);
    assert.equal(tr.onToolUpdate({ toolCallId: "e1", status: "completed", rawOutput: "npm test", sessionUpdate: "tool_call_update" }), undefined);
    assert.deepEqual(tr.proofs(), []);
  });

  test("an exit code hidden by a pipe is recovered from the output", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "npm test 2>&1 | tail -20", { ok: NODE_FAIL });
    assert.equal(p?.passed, false);
    assert.equal(p?.exitCode, 0);
    assert.equal(p?.summary, "2 failed, 43 passed");
  });

  test("a pipe-hidden exit code with no parseable summary says so", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "npm run build | tail -5", { ok: "built in 1.2s" });
    assert.equal(p?.passed, true);
    assert.equal(p?.detail, "exit code hidden by `| tail -5`");
  });

  test("keeps only the latest result per label, latest last", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    run(tr, c, "t1", "npm test", { fail: `Exit code 1\n${NODE_FAIL}` });
    run(tr, c, "t2", "npm run typecheck", { ok: "" });
    run(tr, c, "t3", "npm test", { ok: NODE_OK });
    assert.deepEqual(
      tr.proofs().map((p) => [p.label, p.passed]),
      [
        ["npm run typecheck", true],
        ["npm test", true],
      ],
    );
  });

  test("cancelled, denied, interrupted and backgrounded calls are not proof", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    tr.onToolCall(bashCall("c1"));
    tr.onToolUpdate(bashInput("c1", "npm test"));
    assert.equal(tr.onToolUpdate({ toolCallId: "c1", status: "cancelled", sessionUpdate: "tool_call_update" }), undefined);

    // Denied by the developer: failed, but no exit code.
    assert.equal(run(tr, c, "c2", "npm test", { fail: "The user doesn't want to proceed with this tool use." }), undefined);

    tr.onToolCall(bashCall("c3"));
    tr.onToolUpdate(bashInput("c3", "npm test"));
    tr.onToolUpdate(bashResponse("c3", "partial", { interrupted: true }));
    assert.equal(tr.onToolUpdate(bashCompleted("c3", "partial\n[Command was aborted before completion]")), undefined);

    tr.onToolCall(bashCall("c4"));
    tr.onToolUpdate({ ...bashInput("c4", "npm test"), rawInput: { command: "npm test", run_in_background: true } });
    assert.equal(tr.onToolUpdate(bashCompleted("c4", "Command running in background with ID: abc")), undefined);

    tr.onToolCall(bashCall("c5"));
    tr.onToolUpdate(bashInput("c5", "npm test"));
    tr.onToolUpdate(bashResponse("c5", "", { backgroundTaskId: "bg1" }));
    assert.equal(tr.onToolUpdate(bashCompleted("c5", "")), undefined);

    assert.deepEqual(tr.proofs(), []);
  });

  test("a timed-out verification fails", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    const p = run(tr, c, "t1", "npm test", { fail: "Command timed out after 2m 0.0s" });
    assert.equal(p?.passed, false);
    assert.equal(p?.exitCode, undefined);
    assert.equal(p?.summary, "timed out");
  });

  test("reads _meta.terminal_exit when the client declares terminal output", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    tr.onToolCall({ ...bashCall("t1"), _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: "t1" } } });
    tr.onToolUpdate(bashInput("t1", "pytest -q"));
    tr.onToolUpdate({ toolCallId: "t1", _meta: { terminal_output: { terminal_id: "t1", data: "F...\n1 failed, 3 passed in 0.1s" } }, sessionUpdate: "tool_call_update" });
    const p = tr.onToolUpdate({
      toolCallId: "t1",
      status: "failed",
      content: [{ type: "terminal", terminalId: "t1" }],
      _meta: { claudeCode: { toolName: "Bash" }, terminal_exit: { terminal_id: "t1", exit_code: 1, signal: null } },
      sessionUpdate: "tool_call_update",
    });
    assert.equal(p?.exitCode, 1);
    assert.equal(p?.passed, false);
    assert.equal(p?.summary, "1 failed, 3 passed");
  });

  test("handles codex-style argv input and structured rawOutput", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    tr.onToolCall({ toolCallId: "x1", title: "go test ./...", kind: "execute", status: "pending", rawInput: { command: ["bash", "-lc", "go test ./..."] }, sessionUpdate: "tool_call" });
    c.tick(300);
    const p = tr.onToolUpdate({ toolCallId: "x1", status: "completed", rawOutput: { exit_code: 1, stdout: "FAIL\tgithub.com/x/a\t0.01s", stderr: "" }, sessionUpdate: "tool_call_update" });
    assert.equal(p?.exitCode, 1);
    assert.equal(p?.passed, false);
    assert.equal(p?.durationMs, 300);
    assert.equal(p?.summary, "1 package failed, 0 ok");
  });

  test("picks up a command first seen in an update (reattach)", () => {
    const tr = new ProofTracker();
    tr.onToolUpdate({ ...bashInput("r1", "cargo test"), kind: "execute" });
    const p = tr.onToolUpdate(bashCompleted("r1", "test result: ok. 3 passed; 0 failed; 0 ignored"));
    assert.equal(p?.summary, "3 passed");
    assert.equal(p?.passed, true);
  });

  test("reset forgets results but keeps commands still running", () => {
    const c = clock();
    const tr = new ProofTracker({ now: c.now });
    run(tr, c, "t1", "npm test", { ok: NODE_OK });
    tr.onToolCall(bashCall("t2"));
    tr.onToolUpdate(bashInput("t2", "npm run lint"));
    tr.reset();
    assert.deepEqual(tr.proofs(), []);
    tr.onToolUpdate(bashCompleted("t2", ""));
    assert.deepEqual(tr.proofs().map((p) => p.label), ["npm run lint"]);
  });
});

describe("mergeProofs", () => {
  const obs = (kind: Proof["kind"], label: string, passed = true): Proof => ({ kind, label, passed, observed: true, command: label, exitCode: passed ? 0 : 1 });
  const rep = (kind: Proof["kind"], label: string, passed = true): Proof => ({ kind, label, passed });

  test("observed first; observed wins over self-reported of the same kind", () => {
    const merged = mergeProofs([obs("tests", "npm test", false)], [rep("tests", "All 45 tests pass"), rep("manual", "Clicked through the form")]);
    assert.deepEqual(
      merged.map((p) => [p.label, p.passed, !!p.observed]),
      [
        ["npm test", false, true],
        ["Clicked through the form", true, false],
      ],
    );
  });

  test("an observed typecheck settles a reported build; a lint does not", () => {
    assert.deepEqual(mergeProofs([obs("typecheck", "npx tsc --noEmit")], [rep("build", "TypeScript compiles")]).length, 1);
    assert.deepEqual(mergeProofs([obs("lint", "npm run lint")], [rep("build", "vite build")]).length, 2);
  });

  test("a reported command proof that names an observed verification is dropped", () => {
    const merged = mergeProofs([obs("typecheck", "npx tsc --noEmit (in apps/daemon)")], [rep("command", "cd apps/daemon && npx tsc --noEmit"), rep("command", "node scripts/smoke.js")]);
    assert.deepEqual(merged.map((p) => p.label), ["npx tsc --noEmit (in apps/daemon)", "node scripts/smoke.js"]);
  });

  test("with nothing observed, the agent's claims pass through", () => {
    const reported = [rep("tests", "npm test")];
    assert.equal(mergeProofs([], reported), reported);
    assert.deepEqual(mergeProofs([obs("tests", "npm test")]), [obs("tests", "npm test")]);
  });
});
