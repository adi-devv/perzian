// Runs before the UI's scripts. The file:// UI dials the daemon at 127.0.0.1:4317; when the shell
// runs its daemon on another port (PERZIAN_PORT, passed as ?port=), point the UI's WebSocket and
// fetch calls there instead, so the window never talks to a different daemon that owns 4317.
// (Chromium's webRequest can't redirect WebSocket handshakes, hence the main-world shim.)
// CommonJS because sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require("electron");

// Native folder picker for the UI; resolves to a path or null when cancelled.
contextBridge.exposeInMainWorld("perzian", { pickFolder: () => ipcRenderer.invoke("perzian:pick-folder") });

const port = new URLSearchParams(location.search).get("port");
if (location.protocol === "file:" && port && port !== "4317") {
  contextBridge.executeInMainWorld({
    func: (to) => {
      const from = "127.0.0.1:4317";
      const fix = (u) => (typeof u === "string" || u instanceof URL ? String(u).replace(from, to) : u);
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class WebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          super(fix(url), protocols);
        }
      };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => nativeFetch(input instanceof Request ? input : fix(input), init);
    },
    args: [`127.0.0.1:${port}`],
  });
}
