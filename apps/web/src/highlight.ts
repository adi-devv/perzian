// Lazy syntax highlighting for the read-only viewer. Loaded on first use so it never slows startup.
import type { HighlighterCore, ThemedToken } from "shiki/core";

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};

const EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", css: "css", html: "html", md: "markdown", py: "python", go: "go", rs: "rust", sh: "shellscript", zsh: "shellscript",
  bash: "shellscript", yml: "yaml", yaml: "yaml", swift: "swift", sql: "sql",
};

export function langFor(path: string): string | undefined {
  return EXT[path.split(".").pop()?.toLowerCase() ?? ""];
}

let core: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

async function highlighter(lang: string): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/min-dark.mjs"),
      import("shiki/themes/min-light.mjs"),
    ]);
    return createHighlighterCore({ themes: [dark.default, light.default], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  const h = await core;
  if (!loaded.has(lang)) {
    const mod = (await LANGS[lang]()) as { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
    await h.loadLanguage(mod.default);
    loaded.add(lang);
  }
  return h;
}

const prefersDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// Returns one token array per input line, or null when the language isn't supported.
export async function tokenize(lines: string[], path: string): Promise<ThemedToken[][] | null> {
  const lang = langFor(path);
  if (!lang) return null;
  try {
    const h = await highlighter(lang);
    return h.codeToTokensBase(lines.join("\n"), { lang, theme: prefersDark() ? "min-dark" : "min-light" });
  } catch {
    return null;
  }
}
