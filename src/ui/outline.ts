/**
 * Collapsible Document Outline & Page Navigator Sidebar (Ctrl+Shift+O)
 * + Distraction-Free Focus Mode (F11).
 */
import { h, icon, toast } from "./dom";
import { state, on, emit } from "../core/state";
import { settings, saveSettings } from "../core/settings";
import { native } from "../core/native";
import { getPageCount, currentPage, scrollToPage, addNewPage } from "../core/page";

let sidebarEl: HTMLElement | null = null;
let headingsHost: HTMLElement | null = null;
let pagesHost: HTMLElement | null = null;
let focusExitBtn: HTMLElement | null = null;

export function isOutlineOpen(): boolean {
  return Boolean(settings.outlineOpen);
}

export function toggleOutline(force?: boolean): void {
  const next = typeof force === "boolean" ? force : !settings.outlineOpen;
  settings.outlineOpen = next;
  saveSettings();
  if (sidebarEl) {
    sidebarEl.hidden = !next;
  }
  if (next) refreshOutline();
  emit("outline:change", next);
}

export function isFocusMode(): boolean {
  return document.documentElement.classList.contains("is-focus-mode");
}

export function toggleFocusMode(force?: boolean): void {
  const next = typeof force === "boolean" ? force : !isFocusMode();
  document.documentElement.classList.toggle("is-focus-mode", next);
  if (focusExitBtn) focusExitBtn.hidden = !next;
  void native.setFullscreen(next).catch(() => {});
  if (next) {
    toast("Focus Mode — press F11 or Esc to exit", "info", 2200);
    state.editor?.commands.focus();
  }
  emit("focus:change", next);
}

export function initOutline(): void {
  const workspace = document.getElementById("workspace")!;
  const canvas = document.getElementById("canvas")!;

  headingsHost = h("div", { class: "outline__list" });
  pagesHost = h("div", { class: "outline__pages" });

  const closeBtn = h(
    "button",
    { type: "button", class: "ibtn ibtn--sm", "data-tip": "Close Outline (Ctrl+Shift+O)" },
    icon("X", 14),
  );
  closeBtn.addEventListener("click", () => toggleOutline(false));

  const addPageBtn = h(
    "button",
    { type: "button", class: "outline__addpage" },
    icon("Plus", 13),
    h("span", {}, "New Page"),
  );
  addPageBtn.addEventListener("click", () => addNewPage(true));

  sidebarEl = h(
    "aside",
    { id: "outline", class: "outline", hidden: !settings.outlineOpen },
    h(
      "div",
      { class: "outline__head" },
      h("span", { class: "outline__title" }, icon("ListTree", 15), "Document Outline"),
      closeBtn,
    ),
    h("div", { class: "outline__sec-label" }, "Headings"),
    headingsHost,
    h(
      "div",
      { class: "outline__sec-row" },
      h("span", { class: "outline__sec-label" }, "Pages"),
      addPageBtn,
    ),
    pagesHost,
  );

  workspace.insertBefore(sidebarEl, canvas);

  // Floating exit button when in Focus Mode
  focusExitBtn = h(
    "button",
    {
      type: "button",
      class: "focus-exit-pill",
      hidden: true,
      "data-tip": "Exit Focus Mode (F11)",
    },
    icon("Minimize2", 13),
    h("span", {}, "Exit Focus"),
  );
  focusExitBtn.addEventListener("click", () => toggleFocusMode(false));
  document.getElementById("app")!.append(focusExitBtn);

  on("document:change", scheduleOutlineRefresh);
  on("document:open", scheduleOutlineRefresh);
  on("document:new", scheduleOutlineRefresh);
  on("page:count", scheduleOutlineRefresh);
  on("selection:change", scheduleOutlineRefresh);

  if (settings.outlineOpen) {
    refreshOutline();
  }
}

let outlineRaf = 0;
export function scheduleOutlineRefresh(): void {
  if (!settings.outlineOpen) return;
  if (outlineRaf) return;
  outlineRaf = requestAnimationFrame(() => {
    outlineRaf = 0;
    refreshOutline();
  });
}

export function refreshOutline(): void {
  if (!headingsHost || !pagesHost || !state.editor) return;

  headingsHost.replaceChildren();
  const items: { text: string; level: number; pos: number }[] = [];

  state.editor.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text) items.push({ text, level: Number(node.attrs.level || 1), pos: pos + 1 });
      return false;
    }
    if (node.type.name === "paragraph" && (node.attrs?.styleName === "Title" || node.attrs?.styleName === "Subtitle")) {
      const text = node.textContent.trim();
      if (text) items.push({ text, level: node.attrs.styleName === "Title" ? 0 : 1, pos: pos + 1 });
      return false;
    }
    return true;
  });

  if (items.length === 0) {
    headingsHost.append(
      h("div", { class: "outline__empty" }, "Add a Title or Heading 1–3 to see your document structure here."),
    );
  } else {
    for (const item of items) {
      const row = h(
        "button",
        {
          type: "button",
          class: `outline__item outline__item--lvl${item.level}`,
        },
        h("span", { class: "outline__bullet" }),
        h("span", { class: "outline__text" }, item.text),
      );
      row.addEventListener("click", () => {
        const ed = state.editor;
        ed.chain().focus().setTextSelection(item.pos).run();
        const coords = ed.view.coordsAtPos(item.pos);
        const canvas = document.getElementById("canvas");
        if (canvas && coords) {
          const cr = canvas.getBoundingClientRect();
          canvas.scrollBy({ top: coords.top - cr.top - 96, behavior: "smooth" });
        }
      });
      headingsHost.append(row);
    }
  }

  pagesHost.replaceChildren();
  const total = getPageCount();
  const cur = currentPage();
  for (let p = 1; p <= total; p++) {
    const pill = h(
      "button",
      {
        type: "button",
        class: "outline__page" + (p === cur ? " is-active" : ""),
      },
      icon("FileText", 13),
      h("span", {}, `Page ${p}`),
    );
    pill.addEventListener("click", () => scrollToPage(p));
    pagesHost.append(pill);
  }
}
