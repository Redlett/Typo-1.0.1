/** Custom title bar (quick-access toolbar + multi-document tabs + window controls) and status bar. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h, icon, popover, promptDialog } from "./dom";
import { state, on } from "../core/state";
import {
  save,
  exportPdfFile,
  getDocTabs,
  getActiveTabId,
  switchToTab,
  createNewTab,
  closeTab,
  initDocTabs,
} from "../core/document";
import { settings, saveSettings } from "../core/settings";
import { setZoom, getPageCount, currentPage, addNewPage, scrollToPage } from "../core/page";
import { menu, type MenuItem } from "./pickers";
import { paperColorMenu, proofingMenu } from "./tabs";
import { openDictionary } from "./dictionary";
import { openPdfEditorModal } from "./pdf-editor";
import { proofingKey, isAutoSpellcheck, isManualScanActive } from "./../editor/proofing";
import { toggleOutline, toggleFocusMode } from "./outline";

const LOGO = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="var(--accent)"/><path d="M7 7.5h10M12 7.5v9.5" stroke="var(--accent-text)" stroke-width="2.4" stroke-linecap="round"/><path d="M15.2 17h2.3" stroke="var(--accent-text)" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></svg>`;

export function initTitlebar(onClose: () => void): void {
  const bar = document.getElementById("titlebar")!;
  const win = getCurrentWindow();
  initDocTabs();

  const qa = (ic: string, tip: string, fn: () => void, enabled?: () => boolean) => {
    const b = h("button", { class: "qa", type: "button", "data-tip": tip, "aria-label": tip }, icon(ic, 15));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", fn);
    if (enabled) {
      const sync = () => ((b as HTMLButtonElement).disabled = !enabled());
      on("selection:change", sync);
      on("document:change", sync);
      on("document:open", sync);
      on("document:new", sync);
    }
    return b;
  };

  const logo = h("span", { class: "titlebar__logo" });
  logo.innerHTML = LOGO;

  const tabsStrip = h("div", { class: "doctabs", role: "tablist" });
  const newTabBtn = h(
    "button",
    {
      class: "doctab__add",
      type: "button",
      "data-tip": "New Document Tab  (Ctrl+T)",
      "aria-label": "New Document Tab",
    },
    icon("Plus", 14),
  );
  newTabBtn.addEventListener("mousedown", (e) => e.preventDefault());
  newTabBtn.addEventListener("click", () => createNewTab());
  const tabsWrap = h("div", { class: "doctabs-wrap" }, tabsStrip, newTabBtn);

  const ctl = (ic: string, label: string, fn: () => void, cls = "") => {
    const b = h("button", { class: `wctl ${cls}`, type: "button", "aria-label": label, tabindex: "-1" }, icon(ic, 14));
    b.addEventListener("click", fn);
    return b;
  };
  const maxBtn = ctl("Square", "Maximize", () => win.toggleMaximize());

  bar.append(
    h("div", { class: "titlebar__left" },
      logo,
      qa("Save", "Save  (Ctrl+S)", () => void save()),
      qa("FileDown", "Save as PDF (.pdf)", () => void exportPdfFile()),
      qa("FileEdit", "Built-In PDF Editor & PDF to Word Studio", () => void openPdfEditorModal()),
      qa("Undo2", "Undo  (Ctrl+Z)", () => state.editor.chain().focus().undo().run(), () => state.editor?.can().undo() ?? false),
      qa("Redo2", "Redo  (Ctrl+Y)", () => state.editor.chain().focus().redo().run(), () => state.editor?.can().redo() ?? false),
      qa("FilePlus2", "Add New Page  (Ctrl+Enter)", () => addNewPage(true)),
      qa("ListTree", "Document Outline  (Ctrl+Shift+O)", () => toggleOutline()),
      qa("BookOpen", "Dictionary & Thesaurus  (Ctrl+Shift+D)", () => openDictionary(state.editor)),
    ),
    tabsWrap,
    h("div", { class: "titlebar__drag", "data-tauri-drag-region": "" }),
    h("div", { class: "titlebar__controls" },
      ctl("Minus", "Minimize", () => win.minimize()),
      maxBtn,
      ctl("X", "Close", onClose, "wctl--close"),
    ),
  );
  bar.setAttribute("data-tauri-drag-region", "");

  const renderDocTabs = () => {
    const tabs = getDocTabs();
    const activeId = getActiveTabId();
    tabsStrip.replaceChildren();
    for (const t of tabs) {
      const isActive = t.id === activeId;
      const isDirty = isActive ? state.dirty : t.dirty;
      const labelText = isActive ? state.name : t.name;
      const closeBtn = h(
        "span",
        {
          class: "doctab__close",
          role: "button",
          "data-tip": "Close tab",
          "aria-label": `Close ${labelText}`,
        },
        icon("X", 11),
      );
      closeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(t.id);
      });

      const tabEl = h(
        "button",
        {
          class: "doctab" + (isActive ? " is-active" : ""),
          type: "button",
          role: "tab",
          "aria-selected": String(isActive),
          "data-tip": t.path || labelText,
        },
        icon("FileText", 12),
        h("span", { class: "doctab__name" }, labelText),
        isDirty ? h("span", { class: "doctab__dirty", "data-tip": "Unsaved changes" }) : null,
        closeBtn,
      );
      tabEl.addEventListener("mousedown", (e) => e.preventDefault());
      tabEl.addEventListener("click", () => switchToTab(t.id));
      tabsStrip.append(tabEl);
    }
    document.title = `${state.dirty ? "• " : ""}${state.name} — Typo`;
    win.setTitle(document.title).catch(() => {});
  };

  on("dirty:change", renderDocTabs);
  on("document:open", renderDocTabs);
  on("document:new", renderDocTabs);
  on("document:save", renderDocTabs);
  on("tabs:change", renderDocTabs);
  renderDocTabs();

  const syncMax = async () => {
    const m = await win.isMaximized().catch(() => false);
    maxBtn.replaceChildren(icon(m ? "Copy" : "Square", 14));
    maxBtn.setAttribute("aria-label", m ? "Restore" : "Maximize");
    document.documentElement.classList.toggle("is-maximized", m);
  };
  win.onResized(() => void syncMax());
  void syncMax();
}

export function initStatusbar(applyTheme?: () => void): { refresh: () => void } {
  const bar = document.getElementById("statusbar")!;
  const outlineBtn = h(
    "button",
    { class: "sb__item", type: "button", "data-tip": "Toggle Document Outline & Page Navigator (Ctrl+Shift+O)" },
    icon("ListTree", 13),
    h("span", {}, "Outline"),
  );
  const pageEl = h("button", { class: "sb__item", type: "button", "data-tip": "Jump to page or add a new page" });
  const addPageBtn = h(
    "button",
    { class: "sb__item sb__item--pill", type: "button", "data-tip": "Add a new page  (Ctrl+Enter)" },
    icon("Plus", 12),
    h("span", {}, "Add Page"),
  );
  const wordsEl = h("button", { class: "sb__item", type: "button", "data-tip": "Word count · Click to set a writing goal" });
  const readTimeEl = h("span", { class: "sb__item sb__item--muted", "data-tip": "Estimated reading time (225 WPM)" });
  const proofEl = h("button", { class: "sb__item", type: "button", "data-tip": "Click to review spelling & grammar" });
  const dictBtn = h(
    "button",
    { class: "sb__item", type: "button", "data-tip": "Open Dictionary & Thesaurus  (Ctrl+Shift+D)" },
    icon("BookOpen", 13),
    h("span", {}, "Dictionary"),
  );
  const savedEl = h("span", { class: "sb__item sb__item--muted" });

  const focusBtn = h(
    "button",
    { class: "sb__item", type: "button", "data-tip": "Distraction-free Focus Mode  (F11)" },
    icon("Maximize2", 12),
    h("span", {}, "Focus"),
  );
  const paperBtn = h("button", {
    class: "sb__item sb__item--pill",
    type: "button",
    "data-tip": "Choose paper sheet color (Dark, White, Sepia, Mist)",
  });

  outlineBtn.addEventListener("click", () => toggleOutline());
  focusBtn.addEventListener("click", () => toggleFocusMode());

  pageEl.addEventListener("click", () => {
    const count = getPageCount();
    const cur = currentPage();
    const items: (MenuItem | "sep" | { heading: string })[] = [{ heading: "Pages" }];
    for (let i = 1; i <= count; i++) {
      items.push({
        label: `Go to Page ${i}`,
        checked: i === cur,
        onSelect: () => scrollToPage(i),
      });
    }
    items.push("sep", {
      label: "Add New Page",
      icon: "FilePlus2",
      hint: "Ctrl+Enter",
      onSelect: () => addNewPage(true),
    });
    popover(pageEl, menu(items));
  });

  wordsEl.addEventListener("click", async () => {
    const r = await promptDialog(
      "Word Count Goal",
      [
        {
          name: "goal",
          label: "Target word count (set 0 to turn off)",
          value: String(settings.wordGoal ?? 0),
          type: "number",
          placeholder: "e.g. 1000",
        },
      ],
      "Save Goal",
    );
    if (!r) return;
    const g = Math.max(0, parseInt(r.goal || "0", 10) || 0);
    settings.wordGoal = g;
    saveSettings();
    refresh();
  });

  addPageBtn.addEventListener("click", () => addNewPage(true));
  proofEl.addEventListener("click", () => {
    popover(proofEl, proofingMenu(state.editor, () => refresh()));
  });
  dictBtn.addEventListener("click", () => openDictionary(state.editor));

  paperBtn.addEventListener("click", () => {
    popover(
      paperBtn,
      paperColorMenu(
        () => applyTheme?.(),
        () => syncPaperLabel(),
      ),
      { align: "end" },
    );
  });

  const syncPaperLabel = () => {
    const mode = settings.paperColor || (settings.paperPreview ? "white" : "auto");
    const labelMap: Record<string, string> = {
      auto: "Paper: Theme",
      dark: "Paper: Dark",
      white: "Paper: White",
      parchment: "Paper: Parchment",
      sepia: "Paper: Sepia",
      mist: "Paper: Mist",
      custom: "Paper: Custom",
    };
    const baseLabel = labelMap[mode] ?? "Paper: Theme";
    const texSuffix = settings.paperTexture === "custom" ? " (Custom Tex)" : "";
    paperBtn.replaceChildren(
      icon(mode === "white" ? "Sun" : "FileText", 13),
      h("span", {}, baseLabel + texSuffix),
    );
  };
  on("theme:change", syncPaperLabel);
  syncPaperLabel();

  const zoomOut = h("button", { class: "ibtn ibtn--sm", type: "button", "aria-label": "Zoom out", "data-tip": "Zoom out  (Ctrl+wheel)" }, icon("Minus", 13));
  const zoomIn = h("button", { class: "ibtn ibtn--sm", type: "button", "aria-label": "Zoom in", "data-tip": "Zoom in  (Ctrl+wheel)" }, icon("Plus", 13));
  const slider = h("input", { class: "zoom__slider", type: "range", min: "50", max: "300", step: "5", "aria-label": "Zoom" }) as HTMLInputElement;
  const pct = h("button", { class: "sb__item zoom__pct", type: "button", "data-tip": "Reset to 100%" });
  zoomOut.addEventListener("click", () => setZoom(settings.zoom - 0.1));
  zoomIn.addEventListener("click", () => setZoom(settings.zoom + 0.1));
  slider.addEventListener("input", () => setZoom(parseInt(slider.value, 10) / 100));
  pct.addEventListener("click", () => setZoom(1));

  for (const b of [outlineBtn, pageEl, addPageBtn, wordsEl, proofEl, dictBtn, focusBtn, paperBtn, zoomOut, zoomIn, pct]) {
    b.addEventListener("mousedown", (e) => e.preventDefault());
  }

  bar.append(
    h("div", { class: "sb__left" }, outlineBtn, pageEl, addPageBtn, wordsEl, readTimeEl, proofEl, dictBtn, savedEl),
    h("div", { class: "sb__right" }, focusBtn, paperBtn, h("div", { class: "zoom" }, zoomOut, slider, zoomIn, pct)),
  );

  const syncZoom = () => {
    slider.value = String(Math.round(settings.zoom * 100));
    pct.textContent = `${Math.round(settings.zoom * 100)}%`;
  };
  on("zoom:change", syncZoom);
  syncZoom();

  let raf = 0;
  const refresh = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ed = state.editor;
      const words = ed.storage.characterCount.words() as number;
      const chars = ed.storage.characterCount.characters() as number;
      const { from, to, empty } = ed.state.selection;
      const goal = settings.wordGoal || 0;

      if (!empty) {
        const sel = ed.state.doc.textBetween(from, to, " ", " ");
        const sw = (sel.match(/\S+/g) ?? []).length;
        wordsEl.textContent = `${sw} of ${words.toLocaleString()} words`;
      } else if (goal > 0) {
        const pctGoal = Math.min(100, Math.round((words / goal) * 100));
        wordsEl.textContent = `${words.toLocaleString()} / ${goal.toLocaleString()} words (${pctGoal}%)`;
      } else {
        wordsEl.textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`;
      }
      wordsEl.setAttribute("data-tip", `${chars.toLocaleString()} characters · Click to set word goal`);

      const mins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 225));
      readTimeEl.textContent = words === 0 ? "0 min read" : `~${mins} min read`;

      pageEl.textContent = `Page ${currentPage()} of ${getPageCount()}`;

      const issues = proofingKey.getState(ed.state)?.issues ?? [];
      const activeScan = isAutoSpellcheck() || isManualScanActive();
      if (!activeScan) {
        proofEl.replaceChildren(icon("SpellCheck", 13), h("span", {}, "Check Spelling (Off)"));
        proofEl.classList.remove("sb__item--warn");
      } else if (issues.length === 0) {
        proofEl.replaceChildren(
          icon("Check", 13),
          h("span", {}, isAutoSpellcheck() ? "Proofing OK (Auto)" : "Proofing OK"),
        );
        proofEl.classList.remove("sb__item--warn");
      } else {
        proofEl.replaceChildren(
          icon("SpellCheck", 13),
          h("span", {}, `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`),
        );
        proofEl.classList.add("sb__item--warn");
      }
      syncPaperLabel();
    });
  };
  on("page:count", refresh);
  on("proofing:update", refresh);
  on("document:save", () => {
    const t = new Date();
    savedEl.textContent = `Saved ${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  });
  on("document:open", () => (savedEl.textContent = ""));
  on("document:new", () => (savedEl.textContent = ""));
  return { refresh };
}
