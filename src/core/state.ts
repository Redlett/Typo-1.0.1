/** Shared app state + a tiny event bus (used by UI modules and plugins). */
import type { Editor } from "@tiptap/core";
import type { DocDefaults, PageSettings } from "./native";

export type AppEvent =
  | "document:new"
  | "document:open"
  | "document:save"
  | "document:change"
  | "selection:change"
  | "page:change"
  | "page:count"
  | "zoom:change"
  | "theme:change"
  | "dirty:change"
  | "proofing:update"
  | "outline:change"
  | "focus:change"
  | "tabs:change";

export const state = {
  editor: null as unknown as Editor,
  path: null as string | null,
  name: "Untitled",
  dirty: false,
  page: { size: "A4", orientation: "portrait", margins: { top: 1, right: 1, bottom: 1, left: 1 } } as PageSettings,
  defaults: { fontFamily: "Calibri", fontSize: 11 } as DocDefaults,
  fonts: [] as string[],
};

type Handler = (payload?: any) => void;
const handlers = new Map<AppEvent, Set<Handler>>();

export function on(event: AppEvent, fn: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(fn);
  return () => handlers.get(event)?.delete(fn);
}

export function emit(event: AppEvent, payload?: any): void {
  handlers.get(event)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (e) {
      console.error(`[event ${event}]`, e);
    }
  });
}

export function setDirty(v: boolean): void {
  if (state.dirty === v) return;
  state.dirty = v;
  emit("dirty:change", v);
}
