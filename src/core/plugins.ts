/**
 * Plugin host. A plugin is a folder in <config>/plugins/<id>/ containing
 *   plugin.json  { "id", "name", "version", "description", "main": "main.js" }
 *   main.js      ES module: export default function activate(typo) { ... return cleanup? }
 *
 * Plugins get a narrow, documented API object (`typo`) plus the TipTap editor.
 * Everything a plugin registers (ribbon tabs, event handlers) is tracked so it
 * can be torn down cleanly when the plugin is disabled.
 */
import type { Editor } from "@tiptap/core";
import { native, type PluginBundle } from "./native";
import { settings, saveSettings } from "./settings";
import { state, on, type AppEvent } from "./state";
import type { Ribbon, ButtonOpts } from "../ui/ribbon";
import { toast, promptDialog, type Field } from "../ui/dom";

export const API_VERSION = "1.0";

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  folder: string;
  enabled: boolean;
  status: "active" | "disabled" | "error";
  error?: string;
  cleanup: (() => void)[];
}

export const plugins: LoadedPlugin[] = [];
const commands = new Map<string, () => unknown>();
let ribbonRef: Ribbon;
let editorRef: Editor;

function makeApi(p: LoadedPlugin) {
  const track = (fn: () => void) => p.cleanup.push(fn);
  return Object.freeze({
    apiVersion: API_VERSION,
    plugin: { id: p.id, name: p.name, version: p.version },
    editor: editorRef,

    ribbon: {
      addTab(id: string, label: string) {
        const tabId = `plugin:${p.id}:${id}`;
        const tab = ribbonRef.addTab(tabId, label);
        track(() => ribbonRef.removeTab(tabId));
        return {
          addGroup(groupLabel: string) {
            const group = tab.addGroup(groupLabel);
            let row: HTMLElement[] | null = null;
            let rowIdx = 0;
            return {
              /** size: "large" (icon over label) or "small" (stacked two per column). */
              button(opts: ButtonOpts & { size?: "large" | "small" }) {
                const safe: ButtonOpts = {
                  ...opts,
                  onClick: opts.onClick
                    ? (ev, el) => {
                        try {
                          opts.onClick!(ev, el);
                        } catch (e) {
                          reportError(p, e);
                        }
                      }
                    : undefined,
                };
                if (opts.size === "small") {
                  if (!row || rowIdx >= row.length) {
                    row = group.stack(2);
                    rowIdx = 0;
                  }
                  return group.small(row[rowIdx++], { ...safe, showLabel: opts.showLabel ?? true });
                }
                return group.large(safe);
              },
            };
          },
        };
      },
      refresh: () => ribbonRef.refresh(),
    },

    commands: {
      register(id: string, fn: () => unknown) {
        const full = `${p.id}.${id}`;
        commands.set(full, fn);
        track(() => commands.delete(full));
        return full;
      },
      run(id: string) {
        return commands.get(id)?.();
      },
    },

    on(event: AppEvent, fn: (payload?: unknown) => void) {
      const off = on(event, (payload) => {
        try {
          fn(payload);
        } catch (e) {
          reportError(p, e);
        }
      });
      track(off);
      return off;
    },

    ui: {
      toast: (msg: string, kind: "info" | "error" | "success" = "info") => toast(String(msg), kind),
      prompt: (title: string, fields: Field[]) => promptDialog(title, fields),
    },

    document: {
      get name() {
        return state.name;
      },
      get path() {
        return state.path;
      },
      getJSON: () => editorRef.getJSON(),
      getHTML: () => editorRef.getHTML(),
      getText: () => editorRef.getText({ blockSeparator: "\n" }),
      getSelectionText: () => {
        const { from, to } = editorRef.state.selection;
        return editorRef.state.doc.textBetween(from, to, "\n");
      },
      insert: (content: unknown) => editorRef.chain().focus().insertContent(content as any).run(),
      replaceSelection: (text: string) => {
        const { from, to } = editorRef.state.selection;
        return editorRef.chain().focus().insertContentAt({ from, to }, text).setTextSelection({ from, to: from + text.length }).run();
      },
    },

    storage: {
      get(key: string) {
        const raw = localStorage.getItem(`plugin:${p.id}:${key}`);
        try {
          return raw === null ? null : JSON.parse(raw);
        } catch {
          return null;
        }
      },
      set(key: string, value: unknown) {
        localStorage.setItem(`plugin:${p.id}:${key}`, JSON.stringify(value));
      },
    },
  });
}

function reportError(p: LoadedPlugin, e: unknown) {
  console.error(`[plugin ${p.id}]`, e);
  toast(`Plugin "${p.name}": ${e instanceof Error ? e.message : String(e)}`, "error", 5000);
}

async function activate(p: LoadedPlugin, code: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    const fn = mod.default ?? mod.activate;
    if (typeof fn !== "function") throw new Error("main.js must `export default function activate(typo) { … }`");
    const result = await fn(makeApi(p));
    if (typeof result === "function") p.cleanup.push(result);
    p.status = "active";
    p.error = undefined;
  } catch (e) {
    deactivate(p);
    p.status = "error";
    p.error = e instanceof Error ? e.message : String(e);
    console.error(`[plugin ${p.id}]`, e);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function deactivate(p: LoadedPlugin): void {
  for (const fn of p.cleanup.splice(0).reverse()) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
  if (p.status === "active") p.status = "disabled";
}

let bundles: PluginBundle[] = [];

export async function loadPlugins(ribbon: Ribbon, editor: Editor): Promise<void> {
  ribbonRef = ribbon;
  editorRef = editor;
  for (const p of plugins) deactivate(p);
  plugins.length = 0;
  try {
    bundles = await native.listPlugins();
  } catch (e) {
    console.warn("plugin scan failed", e);
    return;
  }
  for (const b of bundles) {
    const m = b.manifest ?? {};
    const id = String(m.id ?? b.folder).replace(/[^\w.-]/g, "-");
    if (id === "text-tools") continue; // Superseded by the comprehensive native Tools ribbon tab
    const p: LoadedPlugin = {
      id,
      name: String(m.name ?? b.folder),
      version: String(m.version ?? "0.0.0"),
      description: String(m.description ?? ""),
      author: m.author ? String(m.author) : undefined,
      folder: b.folder,
      enabled: settings.plugins[id] ?? m.enabledByDefault !== false,
      status: "disabled",
      cleanup: [],
    };
    plugins.push(p);
    if (b.error || !b.code) {
      p.status = "error";
      p.error = b.error ?? "no code";
      continue;
    }
    if (p.enabled) await activate(p, b.code);
  }
  const failed = plugins.filter((p) => p.status === "error");
  if (failed.length) toast(`${failed.length} plugin${failed.length > 1 ? "s" : ""} failed to load — see File › Plugins`, "error", 4500);
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const p = plugins.find((x) => x.id === id);
  if (!p) return;
  p.enabled = enabled;
  settings.plugins[id] = enabled;
  saveSettings();
  if (!enabled) {
    deactivate(p);
    p.status = "disabled";
  } else {
    const b = bundles.find((x) => x.folder === p.folder);
    if (b?.code) await activate(p, b.code);
  }
}
