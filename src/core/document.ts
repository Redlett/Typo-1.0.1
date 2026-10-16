/** Document lifecycle: multi-document tabs, new / open / save / save as / export / print. */
import { open as openDialog, save as saveDialog, message } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import TurndownService from "turndown";
import { EditorState } from "@tiptap/pm/state";
import { native, type ImportedDocx, type PageSettings, type ParsedPdfDocument } from "./native";
import { settings, pushRecent } from "./settings";
import { state, emit, on, setDirty } from "./state";
import { toast } from "../ui/dom";
import type { DocumentPreset } from "./presets";
import { renderPdfPagesWithPdfJs, buildDocxFromPdfPages } from "../ui/pdf-editor";

export type ExportFormat = "docx" | "epub" | "pdf" | "html" | "md" | "txt";

export interface DocTabSession {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
  page: PageSettings;
  defaults: { fontFamily: string; fontSize: number };
  content: any;
}

const docTabs: DocTabSession[] = [];
let activeTabId = "";
let tabSeq = 1;

function nextTabId(): string {
  return `tab-${tabSeq++}`;
}

function isCurrentDocEmpty(): boolean {
  if (!state.editor) return true;
  const text = state.editor.getText().trim();
  return text.length === 0 && state.editor.state.doc.childCount <= 1;
}

export function syncActiveTabSnapshot(): void {
  if (!state.editor) return;
  let cur = docTabs.find((t) => t.id === activeTabId);
  if (!cur) {
    cur = {
      id: activeTabId || nextTabId(),
      path: state.path,
      name: state.name,
      dirty: state.dirty,
      page: structuredClone(state.page),
      defaults: { ...state.defaults },
      content: state.editor.getJSON(),
    };
    activeTabId = cur.id;
    docTabs.push(cur);
  } else {
    cur.path = state.path;
    cur.name = state.name;
    cur.dirty = state.dirty;
    cur.page = structuredClone(state.page);
    cur.defaults = { ...state.defaults };
    cur.content = state.editor.getJSON();
  }
}

export function initDocTabs(): void {
  if (docTabs.length === 0) {
    const id = nextTabId();
    activeTabId = id;
    docTabs.push({
      id,
      path: state.path,
      name: state.name,
      dirty: state.dirty,
      page: structuredClone(state.page),
      defaults: { ...state.defaults },
      content: state.editor ? state.editor.getJSON() : "<p></p>",
    });
  }
  on("dirty:change", () => {
    const cur = docTabs.find((t) => t.id === activeTabId);
    if (cur) cur.dirty = state.dirty;
    emit("tabs:change");
  });
}

export function getDocTabs(): readonly DocTabSession[] {
  return docTabs;
}

export function getActiveTabId(): string {
  return activeTabId;
}

export function switchToTab(id: string): void {
  if (id === activeTabId) return;
  const target = docTabs.find((t) => t.id === id);
  if (!target) return;
  syncActiveTabSnapshot();
  activeTabId = target.id;
  state.path = target.path;
  state.name = target.name;
  state.page = structuredClone(target.page);
  state.defaults = { ...target.defaults };
  loadContent(target.content);
  applyDocVisuals();
  state.dirty = target.dirty;
  emit("dirty:change", target.dirty);
  emit("document:open", { path: state.path ?? "", kind: "docx" });
  emit("tabs:change");
}

export function createNewTab(): void {
  syncActiveTabSnapshot();
  const id = nextTabId();
  const page = structuredClone(settings.defaultPage);
  const defaults = { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize };
  const session: DocTabSession = {
    id,
    path: null,
    name: "Untitled",
    dirty: false,
    page,
    defaults,
    content: "<p></p>",
  };
  docTabs.push(session);
  activeTabId = id;
  state.path = null;
  state.name = "Untitled";
  state.page = structuredClone(page);
  state.defaults = { ...defaults };
  loadContent("<p></p>");
  applyDocVisuals();
  state.dirty = false;
  emit("dirty:change", false);
  emit("document:new");
  emit("tabs:change");
}

export async function closeTab(id: string): Promise<void> {
  const idx = docTabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = docTabs[idx];
  if (id === activeTabId) {
    syncActiveTabSnapshot();
  }
  if (tab.dirty) {
    const prevId = activeTabId;
    if (id !== activeTabId) switchToTab(id);
    const ok = await confirmDiscard();
    if (!ok) {
      if (prevId !== activeTabId && docTabs.some((t) => t.id === prevId)) switchToTab(prevId);
      return;
    }
  }
  if (docTabs.length <= 1) {
    // Last tab: reset to a clean Untitled document
    state.path = null;
    state.name = "Untitled";
    state.page = structuredClone(settings.defaultPage);
    state.defaults = { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize };
    loadContent("<p></p>");
    applyDocVisuals();
    state.dirty = false;
    syncActiveTabSnapshot();
    emit("dirty:change", false);
    emit("document:new");
    emit("tabs:change");
    return;
  }
  const wasActive = id === activeTabId;
  docTabs.splice(idx, 1);
  if (wasActive) {
    const next = docTabs[Math.min(idx, docTabs.length - 1)];
    activeTabId = "";
    switchToTab(next.id);
  } else {
    emit("tabs:change");
  }
}

const OPEN_FILTERS = [
  { name: "All supported", extensions: ["docx", "docm", "dotx", "epub", "pdf", "md", "markdown", "txt", "html", "htm"] },
  { name: "Word Document (.docx)", extensions: ["docx", "docm", "dotx"] },
  { name: "EPUB E-Book (.epub)", extensions: ["epub"] },
  { name: "PDF Document (.pdf)", extensions: ["pdf"] },
  { name: "Markdown (.md)", extensions: ["md", "markdown"] },
  { name: "Plain text (.txt)", extensions: ["txt"] },
  { name: "Web page (.html)", extensions: ["html", "htm"] },
];

const SAVE_FILTERS: Record<Exclude<ExportFormat, "pdf">, { name: string; extensions: string[] }> = {
  docx: { name: "Word Document (.docx)", extensions: ["docx"] },
  epub: { name: "EPUB E-Book (.epub)", extensions: ["epub"] },
  html: { name: "Web page (.html)", extensions: ["html"] },
  md: { name: "Markdown (.md)", extensions: ["md"] },
  txt: { name: "Plain text (.txt)", extensions: ["txt"] },
};

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Resets the undo history so "Undo" can't walk back into the previous document. */
function loadContent(content: any): void {
  const editor = state.editor;
  editor.commands.setContent(content, { emitUpdate: false });
  const fresh = EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins });
  editor.view.updateState(fresh);
  editor.commands.focus("start");
}

function applyDocVisuals(): void {
  emit("page:change");
}

export async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  const choice = await message(`Do you want to save changes to "${state.name}"?`, {
    title: "Typo",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  if (choice === "Yes" || choice === "Save") return await save();
  if (choice === "No" || choice === "Don't Save") {
    await native.clearAutosave().catch(() => {});
    return true;
  }
  return false;
}

function prepareTargetTabForOpen(): void {
  syncActiveTabSnapshot();
  if (state.dirty || state.path || !isCurrentDocEmpty()) {
    const id = nextTabId();
    docTabs.push({
      id,
      path: null,
      name: "Untitled",
      dirty: false,
      page: structuredClone(settings.defaultPage),
      defaults: { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize },
      content: "<p></p>",
    });
    activeTabId = id;
  }
}

export async function newDocument(force = false): Promise<void> {
  if (!force) {
    prepareTargetTabForOpen();
  }
  state.path = null;
  state.name = "Untitled";
  state.page = structuredClone(settings.defaultPage);
  state.defaults = { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize };
  loadContent("<p></p>");
  applyDocVisuals();
  state.dirty = false;
  syncActiveTabSnapshot();
  emit("dirty:change", false);
  emit("document:new");
  emit("tabs:change");
}

export async function newFromPreset(preset: DocumentPreset, force = false): Promise<void> {
  if (!force) {
    prepareTargetTabForOpen();
  }
  state.path = null;
  state.name = preset.id === "blank" ? "Untitled" : preset.name;
  const basePage = structuredClone(settings.defaultPage);
  state.page = {
    ...basePage,
    ...(preset.page ?? {}),
    margins: { ...basePage.margins, ...(preset.page?.margins ?? {}) },
  };
  state.defaults = {
    fontFamily: preset.defaults?.fontFamily ?? settings.defaultFont,
    fontSize: preset.defaults?.fontSize ?? settings.defaultFontSize,
  };
  loadContent(preset.html.trim() || "<p></p>");
  applyDocVisuals();
  state.dirty = false;
  syncActiveTabSnapshot();
  emit("dirty:change", false);
  emit("document:new");
  emit("tabs:change");
  if (preset.id !== "blank") {
    toast(`Loaded "${preset.name}" preset`, "success", 1800);
  }
}

export function restoreAutosaveDraft(draft: {
  name?: string;
  path?: string | null;
  page?: PageSettings;
  defaults?: { fontFamily: string; fontSize: number };
  doc?: any;
}): void {
  if (!draft?.doc) return;
  state.path = draft.path ?? null;
  state.name = draft.name || "Untitled";
  if (draft.page) state.page = draft.page;
  if (draft.defaults) state.defaults = draft.defaults;
  loadContent(draft.doc);
  applyDocVisuals();
  setDirty(true);
  syncActiveTabSnapshot();
  emit("document:open", { path: state.path ?? "", kind: "docx" });
  emit("tabs:change");
  toast(`Restored unsaved draft "${state.name}"`, "success", 2800);
}

function textToDoc(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((l) => (l.length ? { type: "paragraph", content: [{ type: "text", text: l }] } : { type: "paragraph" })),
  };
}

export function loadImportedDocxIntoNewTab(imported: ImportedDocx, docName: string, markModified = true): void {
  prepareTargetTabForOpen();
  state.page = imported.page as PageSettings;
  state.defaults = imported.defaults;
  loadContent(imported.doc);
  state.path = null;
  state.name = docName;
  applyDocVisuals();
  state.dirty = markModified;
  syncActiveTabSnapshot();
  emit("dirty:change", markModified);
  emit("document:open", { path: "", kind: "docx" });
  emit("tabs:change");
}

export async function openPath(path: string): Promise<void> {
  try {
    // Check if file is already open in a tab
    const existingTab = docTabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
    if (existingTab) {
      switchToTab(existingTab.id);
      toast(`Switched to open tab "${existingTab.name}"`, "info", 1400);
      return;
    }

    prepareTargetTabForOpen();
    const t0 = performance.now();
    const opened = await native.openDocument(path);
    if (opened.kind === "pdf") {
      const parsed = await native.parsePdfFile(path);
      const pdfPages = parsed.pdfBase64
        ? await renderPdfPagesWithPdfJs(parsed.pdfBase64, parsed.pages)
        : parsed.pages;
      const imported = buildDocxFromPdfPages(pdfPages);
      state.page = imported.page as PageSettings;
      state.defaults = imported.defaults;
      loadContent(imported.doc);
    } else if ((opened.kind === "docx" || opened.kind === "epub") && opened.docx) {
      state.page = opened.docx.page as PageSettings;
      state.defaults = opened.docx.defaults;
      loadContent(opened.docx.doc);
    } else {
      state.page = structuredClone(settings.defaultPage);
      state.defaults = { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize };
      const text = opened.text ?? "";
      if (opened.kind === "md") loadContent(await marked.parse(text, { gfm: true }));
      else if (opened.kind === "html") loadContent(text);
      else loadContent(textToDoc(text));
    }
    state.path = opened.kind === "docx" || opened.kind === "epub" ? opened.path : null;
    state.name = opened.kind === "pdf" ? `${baseName(opened.name)}.docx` : opened.name;
    applyDocVisuals();
    state.dirty = opened.kind === "pdf";
    syncActiveTabSnapshot();
    emit("dirty:change", state.dirty);
    void native.clearAutosave().catch(() => {});
    pushRecent(opened.path, opened.name);
    emit("document:open", { path: opened.path, kind: opened.kind });
    emit("tabs:change");
    const ms = Math.round(performance.now() - t0);
    if (opened.kind === "pdf") {
      toast(`Converted "${opened.name}" (PDF → Editable Word) in ${ms} ms`, "success", 2800);
    } else if (opened.kind === "epub") {
      toast(`Opened E-Book "${opened.name}" in ${ms} ms`, "success", 2200);
    } else {
      toast(`Opened ${opened.name} in ${ms} ms`, "success", 1800);
    }
  } catch (e) {
    toast(`Couldn't open file: ${errText(e)}`, "error", 5000);
  }
}

export async function openFile(): Promise<void> {
  const picked = await openDialog({ multiple: false, directory: false, filters: OPEN_FILTERS });
  if (typeof picked === "string") await openPath(picked);
}

/**
 * Dedicated PDF to Word (.docx) workflow:
 * 1. User selects a .pdf file from disk
 * 2. Extracts pages, headings, paragraphs & images into an editable Word tab in Typo
 * 3. Prompts to save the converted .docx file directly to disk
 */
export async function convertPdfToWordFlow(sourcePdfPath?: string): Promise<ParsedPdfDocument | null> {
  try {
    const pdfPath =
      sourcePdfPath ??
      ((await openDialog({
        multiple: false,
        directory: false,
        title: "Select PDF to Convert to Word (.docx)",
        filters: [{ name: "PDF Document (.pdf)", extensions: ["pdf"] }],
      })) as string | null);
    if (!pdfPath || typeof pdfPath !== "string") return null;

    toast("Extracting PDF text, headings, and layout…", "info", 1800);
    const t0 = performance.now();
    const parsed = await native.parsePdfFile(pdfPath);
    const pdfPages = parsed.pdfBase64
      ? await renderPdfPagesWithPdfJs(parsed.pdfBase64, parsed.pages)
      : parsed.pages;
    const importedDocx = buildDocxFromPdfPages(pdfPages);
    parsed.pages = pdfPages;
    parsed.docx = importedDocx;
    const docxName = `${baseName(parsed.name)}.docx`;

    // Load immediately into a live editable Word Processor tab
    loadImportedDocxIntoNewTab(importedDocx, docxName, true);
    pushRecent(pdfPath, parsed.name);

    // Offer immediate Save As .docx so the user gets their .docx file on disk right away
    const defaultDocxPath = pdfPath.replace(/\.pdf$/i, "") + ".docx";
    const targetDocx = await saveDialog({
      title: "Save Converted Word Document (.docx)",
      defaultPath: defaultDocxPath,
      filters: [{ name: "Word Document (.docx)", extensions: ["docx"] }],
    });
    if (targetDocx) {
      await writeDocx(targetDocx);
      toast(
        `Converted PDF → "${targetDocx.split(/[\\/]/).pop()}" (${pdfPages.length} page${pdfPages.length === 1 ? "" : "s"}) in ${Math.round(performance.now() - t0)} ms`,
        "success",
        3200,
      );
    } else {
      toast(
        `Opened "${parsed.name}" as an editable Word document (${pdfPages.length} page${pdfPages.length === 1 ? "" : "s"})`,
        "success",
        2600,
      );
    }
    return parsed;
  } catch (e) {
    toast(`PDF to Word conversion failed: ${errText(e)}`, "error", 5000);
    return null;
  }
}

export async function save(): Promise<boolean> {
  if (state.path && /\.epub$/i.test(state.path)) return writeEpub(state.path);
  if (!state.path || !/\.docx$/i.test(state.path)) return saveAs("docx");
  return writeDocx(state.path);
}

async function writeDocx(path: string): Promise<boolean> {
  try {
    const t0 = performance.now();
    await native.saveDocx(path, state.editor.getJSON(), state.page, state.defaults, baseName(state.name));
    state.path = path;
    state.name = path.split(/[\\/]/).pop() ?? state.name;
    state.dirty = false;
    syncActiveTabSnapshot();
    emit("dirty:change", false);
    void native.clearAutosave().catch(() => {});
    pushRecent(path, state.name);
    emit("document:save", { path });
    emit("tabs:change");
    toast(`Saved in ${Math.round(performance.now() - t0)} ms`, "success", 1400);
    return true;
  } catch (e) {
    toast(`Save failed: ${errText(e)}`, "error", 6000);
    return false;
  }
}

async function writeEpub(path: string): Promise<boolean> {
  try {
    const t0 = performance.now();
    await native.saveEpub(path, state.editor.getJSON(), state.page, state.defaults, baseName(state.name));
    state.path = path;
    state.name = path.split(/[\\/]/).pop() ?? state.name;
    state.dirty = false;
    syncActiveTabSnapshot();
    emit("dirty:change", false);
    void native.clearAutosave().catch(() => {});
    pushRecent(path, state.name);
    emit("document:save", { path });
    emit("tabs:change");
    toast(`Saved EPUB "${state.name}" in ${Math.round(performance.now() - t0)} ms`, "success", 2200);
    return true;
  } catch (e) {
    toast(`EPUB export failed: ${errText(e)}`, "error", 6000);
    return false;
  }
}

export async function exportEpubFile(): Promise<boolean> {
  const target = await saveDialog({
    title: "Save as EPUB E-Book (.epub)",
    defaultPath: `${baseName(state.name)}.epub`,
    filters: [{ name: "EPUB E-Book (.epub)", extensions: ["epub"] }],
  });
  if (!target) return false;
  return writeEpub(target);
}

export async function exportPdfToPath(target: string): Promise<boolean> {
  try {
    toast("Saving PDF…", "info", 1600);
    const t0 = performance.now();
    const ok = await native.exportPdf(
      target,
      state.editor.getJSON(),
      state.page,
      state.defaults,
      baseName(state.name),
      state.editor.getHTML(),
    );
    if (ok) {
      toast(`Saved PDF "${target.split(/[\\/]/).pop()}" in ${Math.round(performance.now() - t0)} ms`, "success", 2800);
      return true;
    }
    printDocument();
    return true;
  } catch (e) {
    toast(`PDF export error: ${errText(e)}`, "error", 5000);
    return false;
  }
}

export async function exportPdfFile(): Promise<boolean> {
  const target = await saveDialog({
    title: "Save as PDF",
    defaultPath: `${baseName(state.name)}.pdf`,
    filters: [{ name: "PDF Document (.pdf)", extensions: ["pdf"] }],
  });
  if (!target) return false;
  return exportPdfToPath(target);
}

export async function saveAs(format: ExportFormat = "docx"): Promise<boolean> {
  if (format === "pdf") {
    return exportPdfFile();
  }
  if (format === "epub") {
    return exportEpubFile();
  }
  const filter = SAVE_FILTERS[format];
  const filters =
    format === "docx"
      ? [
          { name: "Word Document (.docx)", extensions: ["docx"] },
          { name: "EPUB E-Book (.epub)", extensions: ["epub"] },
          { name: "PDF Document (.pdf)", extensions: ["pdf"] },
          { name: "Web page (.html)", extensions: ["html"] },
          { name: "Markdown (.md)", extensions: ["md"] },
          { name: "Plain text (.txt)", extensions: ["txt"] },
        ]
      : [filter];
  const target = await saveDialog({
    defaultPath: `${baseName(state.name)}.${filter.extensions[0]}`,
    filters,
  });
  if (!target) return false;
  if (/\.epub$/i.test(target)) return writeEpub(target);
  if (/\.pdf$/i.test(target)) return exportPdfToPath(target);
  if (/\.html?$/i.test(target)) {
    await native.saveText(target, renderAs("html"));
    toast(`Exported ${target.split(/[\\/]/).pop()}`, "success");
    return true;
  }
  if (/\.md$/i.test(target)) {
    await native.saveText(target, renderAs("md"));
    toast(`Exported ${target.split(/[\\/]/).pop()}`, "success");
    return true;
  }
  if (/\.txt$/i.test(target)) {
    await native.saveText(target, renderAs("txt"));
    toast(`Exported ${target.split(/[\\/]/).pop()}`, "success");
    return true;
  }
  if (format === "docx") return writeDocx(target);
  try {
    await native.saveText(target, renderAs(format as "html" | "md" | "txt"));
    toast(`Exported ${target.split(/[\\/]/).pop()}`, "success");
    return true;
  } catch (e) {
    toast(`Export failed: ${errText(e)}`, "error", 6000);
    return false;
  }
}

function renderAs(format: "html" | "md" | "txt"): string {
  const editor = state.editor;
  if (format === "txt") return editor.getText({ blockSeparator: "\n" }).replace(/\ufffc/g, "");
  if (format === "md") {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
    td.addRule("strike", { filter: ["s", "del"] as any, replacement: (c) => `~~${c}~~` });
    td.addRule("pageBreak", { filter: (n) => (n as HTMLElement).hasAttribute?.("data-page-break"), replacement: () => "\n\n---\n\n" });
    return td.turndown(editor.getHTML());
  }
  const title = baseName(state.name).replace(/[<>&]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: "${state.defaults.fontFamily}", system-ui, sans-serif; font-size: ${state.defaults.fontSize}pt; line-height: 1.5; max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; color: #1c1c1f; }
  table { border-collapse: collapse; } td, th { border: 1px solid #bbb; padding: 4px 8px; vertical-align: top; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #555; }
  pre { background: #f4f4f6; padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
  [data-page-break] { break-after: page; border-top: 1px dashed #ccc; margin: 2rem 0; }
  [data-style="Title"] { font-size: 2.4em; font-weight: 300; } [data-style="Subtitle"] { font-size: 1.3em; color: #666; }
  img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${editor.getHTML()}
</body>
</html>
`;
}

export function printDocument(): void {
  const prevTitle = document.title;
  document.title = "";
  const restore = () => {
    document.title = prevTitle;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
  setTimeout(restore, 1000);
}
