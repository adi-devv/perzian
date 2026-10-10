// Perzian desktop shell: owns the daemon process, shows the UI in a native window, and turns daemon
// state into native cues (dock badge, window title, notifications) so you know what needs you
// without looking at the window.
import { app, BrowserWindow, Menu, Notification, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attentionCount, subscribe } from "./tower.js";
import { makeIcon } from "./icon.js";

// Packaged (.app): the bundled daemon (dist/daemon) and UI (dist/web) sit in Contents/Resources and
// run on Electron itself (ELECTRON_RUN_AS_NODE), so no repo, node or tsx is needed at runtime.
// Dev: the daemon runs from source via tsx and the UI from apps/web/dist (or PERZIAN_WEB_URL).
const packaged = app.isPackaged;
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const DEFAULT_PORT = 4317; // what the web UI dials when loaded from file://
const PORT = Number(process.env.PERZIAN_PORT ?? DEFAULT_PORT);
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const WEB_URL = process.env.PERZIAN_WEB_URL; // set in dev to the Vite server
const MAX_RESTARTS = 3;

let win;
let tower;
let quitting = false;
let attention = 0;

// ---------- daemon supervisor ----------

let daemon;
let restarts = 0;

const portOpen = () =>
  new Promise((resolve) => {
    const sock = createConnection({ port: PORT, host: "127.0.0.1" }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });

const waitForPort = async (ms = 10_000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await portOpen()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

function daemonCommand() {
  if (packaged) {
    const dir = join(process.resourcesPath, "daemon");
    return {
      args: [join(dir, "daemon.mjs")],
      cwd: homedir(),
      // Read by the daemon to launch the report MCP server (bundled next to it).
      env: { PERZIAN_REPORT_MCP: join(dir, "report-mcp.mjs") },
    };
  }
  // Load tsx as an in-process loader (not its CLI, which forks a second process that would be
  // orphaned if ours is killed) so the pid we supervise is the daemon itself.
  const tsx = pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href;
  return { args: ["--import", tsx, join(root, "apps/daemon/src/index.ts")], cwd: root, env: {} };
}

// Apps launched from Finder/Dock get launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so agents
// couldn't find brew/npm/etc. Take the PATH the user's login shell would have, once, before the
// daemon (and through it every agent) inherits our environment.
let shellPathDone;
function adoptLoginShellPath() {
  if (!packaged) return Promise.resolve(); // launched from a terminal: PATH is already right
  shellPathDone ??= new Promise((resolve) => {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(shellBin, ["-ilc", 'printf "\n__PZ_PATH__%s__PZ_PATH__\n" "$PATH"'], { env, timeout: 3000 }, (_err, stdout) => {
      const fromShell = /__PZ_PATH__(.*)__PZ_PATH__/.exec(String(stdout ?? ""))?.[1] ?? "";
      const parts = [...fromShell.split(delimiter), ...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin"];
      process.env.PATH = [...new Set(parts.filter(Boolean))].join(delimiter);
      resolve();
    });
  });
  return shellPathDone;
}

// Packaged builds have no terminal: keep the daemon's output in <PERZIAN_HOME>/logs/daemon.log too.
let daemonLog;
function daemonLogStream() {
  if (!packaged) return undefined;
  if (!daemonLog) {
    const dir = join(process.env.PERZIAN_HOME ?? join(homedir(), ".perzian"), "logs");
    try {
      mkdirSync(dir, { recursive: true });
      daemonLog = createWriteStream(join(dir, "daemon.log"), { flags: "a" });
      daemonLog.on("error", () => {});
    } catch {
      return undefined;
    }
  }
  return daemonLog;
}

function spawnDaemon() {
  const startedAt = Date.now();
  const cmd = daemonCommand();
  const log = daemonLogStream();
  const child = spawn(process.execPath, cmd.args, {
    cwd: cmd.cwd,
    env: { ...process.env, ...cmd.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: log ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (log) {
    log.write(`--- ${new Date().toISOString()} daemon start (pid ${child.pid}, port ${PORT})\n`);
    child.stdout.on("data", (d) => (process.stdout.write(d), log.write(d)));
    child.stderr.on("data", (d) => (process.stderr.write(d), log.write(d)));
  }
  daemon = child;
  console.log(`[desktop] daemon started (pid ${child.pid}, port ${PORT})`);
  child.on("error", (err) => console.error("[desktop] daemon spawn error:", err));
  child.on("exit", (code, signal) => {
    if (daemon === child) daemon = undefined;
    if (quitting) return;
    console.error(`[desktop] daemon exited (code ${code}, signal ${signal})`);
    if (Date.now() - startedAt > 60_000) restarts = 0; // it was healthy for a while; fresh budget
    if (restarts >= MAX_RESTARTS) {
      console.error(`[desktop] daemon crashed ${MAX_RESTARTS} times; not restarting`);
      return;
    }
    restarts++;
    setTimeout(async () => {
      if (quitting) return;
      if (await portOpen()) return console.log("[desktop] another daemon is serving the port; not restarting ours");
      console.log(`[desktop] restarting daemon (${restarts}/${MAX_RESTARTS})`);
      spawnDaemon();
    }, 500 * restarts);
  });
}

async function ensureDaemon() {
  if (await portOpen()) {
    console.log(`[desktop] reusing daemon already on port ${PORT}`);
    return; // e.g. started by `npm run dev`
  }
  await adoptLoginShellPath();
  spawnDaemon();
  if (!(await waitForPort())) console.error("[desktop] daemon did not open its port in time");
}

function stopDaemon() {
  const child = daemon;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

// ---------- attention: badge + title ----------

function renderAttention(n) {
  attention = n;
  app.dock?.setBadge(n > 0 ? String(n) : "");
  win?.setTitle(n > 0 ? `Perzian · ${n} need${n === 1 ? "s" : ""} you` : "Perzian");
}

// ---------- notifications ----------

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 4;
const DEDUPE_MS = 3000;
const live = new Set(); // keep Notification objects alive so click handlers fire
const recent = []; // timestamps of shown notifications
const lastByKey = new Map();
let suppressed = 0;
let summaryTimer;

function focusWindow() {
  if (!win || win.isDestroyed()) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function show(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  live.add(n);
  const drop = () => live.delete(n);
  n.on("click", () => {
    focusWindow();
    drop();
  });
  n.on("close", drop);
  n.on("failed", (_e, err) => {
    console.error("[desktop] notification failed:", err);
    drop();
  });
  n.show();
  console.log(`[desktop] notification: ${title} | ${body.split("\n")[0]}`);
}

// Throttled: at most MAX_PER_WINDOW per WINDOW_MS, same key at most once per DEDUPE_MS;
// overflow collapses into one summary notification.
function notify(key, title, body) {
  const now = Date.now();
  if (now - (lastByKey.get(key) ?? 0) < DEDUPE_MS) return;
  lastByKey.set(key, now);
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_PER_WINDOW) {
    suppressed++;
    if (!summaryTimer) {
      summaryTimer = setTimeout(() => {
        summaryTimer = undefined;
        const count = suppressed;
        suppressed = 0;
        if (count > 0) show("Perzian", `${count} more update${count === 1 ? "" : "s"}`);
      }, WINDOW_MS - (now - recent[0]));
    }
    return;
  }
  recent.push(now);
  show(title, body);
}

const focused = () => !!win && !win.isDestroyed() && win.isFocused();

function onDaemonChange(state, event, prev) {
  renderAttention(attentionCount(state));
  if (!event) return; // snapshot (initial or after reconnect): no notifications for history
  if (focused()) return; // the window already shows it
  if (event.type === "decision.requested") {
    const d = event.decision;
    const title = state.sessions[d.sessionId]?.title ?? "Perzian";
    notify(`decision:${d.id}`, title, d.detail ? `${d.question}\n${d.detail}` : d.question);
  } else if (event.type === "session.status" && (event.status === "done" || event.status === "failed")) {
    const s = state.sessions[event.sessionId];
    if (!s || s.role !== "worker" || prev.sessions[event.sessionId]?.status === event.status) return;
    notify(`status:${s.id}:${event.status}`, s.title, event.status === "done" ? "Done" : "Failed");
  }
}

// ---------- menu ----------

function newSession() {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  if (!target || target.isDestroyed()) return;
  const wc = target.webContents;
  // Blur any input first: the UI ignores 'n' while typing, and the keystroke must not land in a field.
  wc.executeJavaScript("document.activeElement && document.activeElement.blur && document.activeElement.blur()", true)
    .catch(() => {})
    .finally(() => {
      wc.focus();
      wc.sendInputEvent({ type: "keyDown", keyCode: "n" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "n" });
    });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Session",
      submenu: [{ id: "new-session", label: "New Session", accelerator: "CmdOrCtrl+N", click: newSession }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- window ----------

async function createWindow() {
  await ensureDaemon();
  if (quitting) return;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Perzian",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: "#0b0d11",
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(here, "preload.cjs") },
  });
  win.on("page-title-updated", (e) => e.preventDefault()); // the title carries the attention count
  win.on("closed", () => (win = undefined));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  renderAttention(attention);
  tower ??= subscribe(WS_URL, {
    onChange: onDaemonChange,
    onStatus: (up) => console.log(`[desktop] daemon stream ${up ? "connected" : "disconnected"}`),
  });
  if (WEB_URL) await win.loadURL(WEB_URL);
  else {
    const index = packaged ? join(process.resourcesPath, "web/index.html") : join(root, "apps/web/dist/index.html");
    // ?port= tells the UI which daemon to dial (preload.cjs applies it until the UI reads it itself).
    await win.loadFile(index, { query: { port: String(PORT) } });
  }
}


app.setName("Perzian");
app.whenReady().then(() => {
  buildMenu();
  // Packaged builds carry the same mark as the bundle's .icns; dev runs inside Electron.app and need it set.
  if (!packaged) {
    try {
      app.dock?.setIcon(makeIcon(512));
    } catch (err) {
      console.error("[desktop] icon failed:", err);
    }
  }
  return createWindow();
}).catch((err) => console.error("[desktop] startup failed:", err));

app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
app.on("window-all-closed", () => app.quit());

let stopping = false;
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", (e) => {
  tower?.close();
  if (stopping || !daemon) return;
  e.preventDefault();
  stopping = true;
  app.dock?.setBadge("");
  stopDaemon().finally(() => app.quit());
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => app.quit()); // graceful path, stops the daemon
process.on("exit", () => daemon?.kill("SIGKILL")); // last resort: never leave an orphan daemon
