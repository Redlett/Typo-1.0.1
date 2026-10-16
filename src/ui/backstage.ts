/** File backstage: full-window view for new/open/save/export, themes, plugins and about. */
import { h, icon, toast, promptDialog, popover, closePopover } from "./dom";
import { state, emit } from "../core/state";
import {
  settings,
  saveSettings,
  removeRecent,
  clearRecent,
  DEFAULT_CUSTOM_THEME,
  type BackgroundBlur,
  type BackgroundDim,
  type BackgroundPreset,
  type CustomThemeColors,
  type PaperColorMode,
  type PaperShadow,
  type PaperTexture,
  type ProofUnderlineStyle,
  type UiDensity,
  type UiFontChoice,
} from "../core/settings";
import { native, type UpdateCheckResult } from "../core/native";
import {
  newDocument,
  newFromPreset,
  openFile,
  openPath,
  save,
  saveAs,
  exportEpubFile,
  exportPdfFile,
  convertPdfToWordFlow,
  printDocument,
  confirmDiscard,
} from "../core/document";
import { openPdfEditorModal } from "./pdf-editor";
import { buildProjectsBackstageSection } from "./projects";
import { DOCUMENT_PRESETS, PRESET_CATEGORIES, type DocumentPreset, type PresetCategory } from "../core/presets";
import { plugins, setPluginEnabled } from "../core/plugins";
import { ACCENT_PRESETS, BACKDROP_PRESETS, pickCustomBackgroundPhoto, pickCustomPaperTexture, themeToJson, type Theme } from "../core/themes";

export interface BackstageHooks {
  themes: () => Theme[];
  currentThemeId: () => string;
  setTheme: (id: string) => void;
  applyCustomization: () => void;
  reloadThemes: () => Promise<void>;
  reloadPlugins: () => Promise<void>;
}

type Page = "home" | "projects" | "open" | "export" | "themes" | "plugins" | "about";
type StudioTabId = "palettes" | "paper" | "interface" | "backdrop" | "json";

let root: HTMLElement;
let content: HTMLElement;
let hooks: BackstageHooks;
let navButtons = new Map<Page, HTMLElement>();
let current: Page = "home";
let activePresetCategory: PresetCategory = "all";
let activeStudioTab: StudioTabId = "palettes";

export function initBackstage(h0: BackstageHooks): void {
  hooks = h0;
  root = document.getElementById("backstage")!;
  content = h("div", { class: "bs__content" });

  const nav = h("nav", { class: "bs__nav" });
  const back = h("button", { class: "bs__back", type: "button", "aria-label": "Back to document", "data-tip": "Return to editor (Esc)" }, icon("ArrowLeft", 18));
  back.addEventListener("click", closeBackstage);
  nav.append(back);

  const page = (id: Page, label: string, ic: string) => {
    const b = h("button", { class: "bs__navitem", type: "button" }, icon(ic, 17), h("span", {}, label));
    b.addEventListener("click", () => show(id));
    navButtons.set(id, b);
    nav.append(b);
  };
  const action = (label: string, ic: string, fn: () => void) => {
    const b = h("button", { class: "bs__navitem", type: "button" }, icon(ic, 17), h("span", {}, label));
    b.addEventListener("click", fn);
    nav.append(b);
  };

  page("home", "Home & New", "LayoutTemplate");
  action("Blank Doc", "FilePlus", async () => {
    if (await confirmDiscard()) {
      await newDocument(true);
      closeBackstage();
    }
  });
  page("projects", "Projects", "FolderOpen");
  page("open", "Open", "Folder");
  action("Save", "Save", async () => {
    if (await save()) closeBackstage();
  });
  action("Save As", "FileDown", async () => {
    if (await saveAs("docx")) closeBackstage();
  });
  action("Save as PDF", "FileCheck", async () => {
    if (await exportPdfFile()) closeBackstage();
  });
  action("Save as EPUB", "BookOpen", async () => {
    if (await exportEpubFile()) closeBackstage();
  });
  action("PDF to Word", "FileOutput", async () => {
    closeBackstage();
    await convertPdfToWordFlow();
  });
  action("PDF Editor", "FileEdit", () => {
    closeBackstage();
    void openPdfEditorModal();
  });
  page("export", "Export", "FileType");
  action("Print", "Printer", () => {
    closeBackstage();
    setTimeout(printDocument, 120);
  });
  nav.append(h("div", { class: "bs__navsep" }));
  page("themes", "Themes & Studio", "Palette");
  page("plugins", "Plugins", "Puzzle");
  nav.append(h("div", { class: "bs__spacer" }));
  page("about", "About", "Info");

  root.append(nav, content);
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeBackstage();
  });
}

export function openBackstage(pageId: Page = "home"): void {
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add("bs--in"));
  show(pageId);
}

export function closeBackstage(): void {
  root.classList.remove("bs--in");
  root.hidden = true;
  state.editor.commands.focus();
}

export function isBackstageOpen(): boolean {
  return !root.hidden;
}

function show(p: Page): void {
  current = p;
  for (const [id, b] of navButtons) b.classList.toggle("is-active", id === p);
  content.replaceChildren(render(p));
  content.scrollTop = 0;
}

function render(p: Page): HTMLElement {
  switch (p) {
    case "home":
    case "open":
      return renderOpen(p === "home");
    case "projects":
      return renderProjectsPage();
    case "export":
      return renderExport();
    case "themes":
      return renderThemes();
    case "plugins":
      return renderPlugins();
    case "about":
      return renderAbout();
  }
}

function renderProjectsPage(): HTMLElement {
  const wrap = h(
    "div",
    { class: "bs__page" },
    h("h1", { class: "bs__title" }, "Writer's Projects"),
    h(
      "p",
      { class: "bs__sub" },
      "Create a dedicated folder on your PC for your book, story, or research — then add pages and brainstorm sheets inside it with one click.",
    ),
    buildProjectsBackstageSection(closeBackstage),
  );
  return wrap;
}

function fmtTime(t: number): string {
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function buildMiniSheetPreview(preset: DocumentPreset): HTMLElement {
  const sheet = h("div", { class: `tpl__sheet tpl__sheet--${preset.previewStyle}` });
  if (preset.badge) {
    sheet.append(h("span", { class: "tpl__badge" }, preset.badge));
  }
  const inner = h("div", { class: "tpl__mini" });
  switch (preset.previewStyle) {
    case "blank":
      inner.append(h("div", { class: "tpl__plus" }, icon("Plus", 20)));
      break;
    case "brainstorm":
      inner.append(
        h("div", { class: "tpl__brainstorm-preview" },
          icon("Pencil", 20),
          h("span", {}, "Landscape Sketch"),
        ),
      );
      break;
    case "academic":
      inner.append(
        h("div", { class: "tpl__line tpl__line--hdr" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--bold" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--short" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--med" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--short" }),
      );
      break;
    case "resume":
      inner.append(
        h("div", { class: "tpl__line tpl__line--accent tpl__line--med" }),
        h("div", { class: "tpl__line tpl__line--short" }),
        h("div", { class: "tpl__rule" }),
        h("div", { class: "tpl__line tpl__line--bold tpl__line--short" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--med" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line tpl__line--bold tpl__line--short" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--short" }),
      );
      break;
    case "table":
      inner.append(
        h("div", { class: "tpl__line tpl__line--accent tpl__line--med" }),
        h("div", { class: "tpl__minigrid" },
          h("span", { class: "tpl__cell tpl__cell--th" }), h("span", { class: "tpl__cell tpl__cell--th" }),
          h("span", { class: "tpl__cell" }), h("span", { class: "tpl__cell" }),
          h("span", { class: "tpl__cell" }), h("span", { class: "tpl__cell" }),
          h("span", { class: "tpl__cell" }), h("span", { class: "tpl__cell" }),
        ),
        h("div", { class: "tpl__line tpl__line--med" }),
      );
      break;
    case "letter":
      inner.append(
        h("div", { class: "tpl__line tpl__line--short" }),
        h("div", { class: "tpl__line tpl__line--short" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line tpl__line--bold tpl__line--med" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--med" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line tpl__line--accent tpl__line--short" }),
      );
      break;
    case "report":
      inner.append(
        h("div", { class: "tpl__line tpl__line--accent tpl__line--bold" }),
        h("div", { class: "tpl__line tpl__line--short" }),
        h("div", { class: "tpl__rule" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--med" }),
        h("div", { class: "tpl__minigrid" },
          h("span", { class: "tpl__cell tpl__cell--th" }), h("span", { class: "tpl__cell tpl__cell--th" }),
          h("span", { class: "tpl__cell" }), h("span", { class: "tpl__cell" }),
        ),
      );
      break;
    case "script":
      inner.append(
        h("div", { class: "tpl__line tpl__line--bold tpl__line--med" }),
        h("div", { class: "tpl__rule" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--accent tpl__line--short" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--med" }),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--accent tpl__line--short" }),
        h("div", { class: "tpl__line tpl__line--center tpl__line--med" }),
      );
      break;
    case "notes":
      inner.append(
        h("div", { class: "tpl__line tpl__line--accent tpl__line--med" }),
        h("div", { class: "tpl__checkrow" }, h("i", {}), h("div", { class: "tpl__line" })),
        h("div", { class: "tpl__checkrow" }, h("i", {}), h("div", { class: "tpl__line tpl__line--med" })),
        h("div", { class: "tpl__checkrow" }, h("i", {}), h("div", { class: "tpl__line tpl__line--short" })),
        h("div", { class: "tpl__spacer" }),
        h("div", { class: "tpl__line" }),
        h("div", { class: "tpl__line tpl__line--med" }),
      );
      break;
  }
  sheet.append(inner);
  return sheet;
}

function renderOpen(isHome: boolean): HTMLElement {
  const wrap = h("div", { class: "bs__page" });
  wrap.append(h("h1", { class: "bs__title" }, isHome ? greeting() : "Open"));
  if (isHome) {
    const filterBar = h("div", { class: "tpl-cats" });
    for (const cat of PRESET_CATEGORIES) {
      const pill = h(
        "button",
        {
          type: "button",
          class: "tpl-cat" + (activePresetCategory === cat.id ? " is-active" : ""),
        },
        cat.label,
      );
      pill.addEventListener("click", () => {
        activePresetCategory = cat.id;
        show("home");
      });
      filterBar.append(pill);
    }
    wrap.append(
      h("div", { class: "bs__row bs__row--between" }, h("h2", { class: "bs__subtitle" }, "Start a new document"), filterBar),
    );

    const visiblePresets =
      activePresetCategory === "all"
        ? DOCUMENT_PRESETS
        : DOCUMENT_PRESETS.filter((p) => p.id === "blank" || p.category === activePresetCategory);

    const grid = h("div", { class: "tpls" });
    for (const preset of visiblePresets) {
      const card = h(
        "button",
        { class: "tpl", type: "button", "data-tip": `${preset.name} — ${preset.subtitle}` },
        buildMiniSheetPreview(preset),
        h("span", { class: "tpl__label" }, preset.name),
        h("span", { class: "tpl__sub" }, preset.subtitle),
      );
      card.addEventListener("click", async () => {
        if (await confirmDiscard()) {
          await newFromPreset(preset, true);
          closeBackstage();
        }
      });
      grid.append(card);
    }
    wrap.append(grid);
  }
  const pdfToWordBtn = h(
    "button",
    { class: "btn", type: "button", "data-tip": "Convert a .pdf file into an editable Word (.docx) document" },
    icon("FileOutput", 15),
    "PDF to Word (.docx)…",
  );
  pdfToWordBtn.addEventListener("click", async () => {
    closeBackstage();
    await convertPdfToWordFlow();
  });

  const pdfEditorBtn = h(
    "button",
    { class: "btn", type: "button", "data-tip": "Open the Built-In PDF Editor & Annotator Studio" },
    icon("FileEdit", 15),
    "PDF Editor…",
  );
  pdfEditorBtn.addEventListener("click", () => {
    closeBackstage();
    void openPdfEditorModal();
  });

  const browse = h("button", { class: "btn btn--primary", type: "button" }, icon("FolderOpen", 15), "Browse…");
  browse.addEventListener("click", async () => {
    closeBackstage();
    await openFile();
  });

  const clearAllBtn = settings.recent.length
    ? h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Dismiss all recent documents from the list" },
        icon("Trash2", 13),
        "Clear Recent",
      )
    : null;
  clearAllBtn?.addEventListener("click", () => {
    clearRecent();
    show(isHome ? "home" : "open");
    toast("Recent documents list cleared", "info", 1500);
  });

  wrap.append(
    h(
      "div",
      { class: "bs__row bs__row--between" },
      h("h2", { class: "bs__subtitle" }, "Recent Documents"),
      h("div", { class: "bs__row" }, clearAllBtn, pdfEditorBtn, pdfToWordBtn, browse),
    ),
  );

  if (!settings.recent.length) {
    wrap.append(h("p", { class: "bs__empty" }, "Documents you open or save will show up here."));
  } else {
    const list = h("div", { class: "recent" });
    for (const r of settings.recent) {
      const dir = r.path.replace(/[\\/][^\\/]*$/, "");
      const openBtn = h(
        "button",
        { class: "recent__main", type: "button", "data-tip": `Open ${r.path}` },
        icon(/\.docx?$/i.test(r.name) ? "FileText" : "File", 18),
        h("span", { class: "recent__name" }, r.name),
        h("span", { class: "recent__path" }, dir),
        h("span", { class: "recent__time" }, fmtTime(r.time)),
      );
      openBtn.addEventListener("click", async () => {
        if (!(await confirmDiscard())) return;
        closeBackstage();
        await openPath(r.path);
      });

      const dismissBtn = h(
        "button",
        {
          class: "recent__dismiss",
          type: "button",
          "aria-label": `Dismiss ${r.name}`,
          "data-tip": "Dismiss from Recent Documents",
        },
        icon("X", 14),
      );
      dismissBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeRecent(r.path);
        show(isHome ? "home" : "open");
        toast(`Dismissed “${r.name}” from recent`, "info", 1500);
      });

      list.append(h("div", { class: "recent__item" }, openBtn, dismissBtn));
    }
    wrap.append(list);
  }
  return wrap;
}

function greeting(): string {
  const hr = new Date().getHours();
  return hr < 5 ? "Burning the midnight oil" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
}

function renderExport(): HTMLElement {
  const wrap = h("div", { class: "bs__page" }, h("h1", { class: "bs__title" }, "Export"));
  const opt = (ic: string, title: string, desc: string, fn: () => void) => {
    const b = h("button", { class: "xopt", type: "button" }, h("span", { class: "xopt__icon" }, icon(ic, 22)), h("span", { class: "xopt__text" }, h("strong", {}, title), h("span", {}, desc)));
    b.addEventListener("click", fn);
    return b;
  };
  wrap.append(
    h("div", { class: "xopts" },
      opt("FileCheck", "Save as PDF (.pdf)", "Saves a publication-ready .pdf file directly to disk with your page size, margins, and images.", async () => { if (await saveAs("pdf")) closeBackstage(); }),
      opt("BookOpen", "EPUB E-Book (.epub)", "Exports a standards-compliant EPUB 3.0 e-book for Apple Books, Kindle, Kobo & Calibre with chapters split at Heading 1 / Page Breaks, embedded images, and Table of Contents.", async () => { if (await saveAs("epub")) closeBackstage(); }),
      opt("FileText", "Word Document (.docx)", "Opens in Microsoft Word, LibreOffice, Google Docs and Pages.", async () => { if (await saveAs("docx")) closeBackstage(); }),
      opt("FileOutput", "PDF to Word Converter (.pdf → .docx)", "Open any .pdf file and convert its pages, headings, paragraphs, and images into an editable Word (.docx) document.", async () => { closeBackstage(); await convertPdfToWordFlow(); }),
      opt("FileEdit", "Built-In PDF Editor Studio", "Open any PDF or edit the current document as PDF pages: edit text blocks, add text boxes, highlights, stamps, signatures, reorder/rotate pages, and save as .pdf.", () => { closeBackstage(); void openPdfEditorModal(); }),
      opt("Code", "Web page (.html)", "A standalone HTML file with embedded images.", async () => { if (await saveAs("html")) closeBackstage(); }),
      opt("Hash", "Markdown (.md)", "Plain-text formatting for notes apps, GitHub and Obsidian.", async () => { if (await saveAs("md")) closeBackstage(); }),
      opt("Type", "Plain text (.txt)", "Just the words, no formatting.", async () => { if (await saveAs("txt")) closeBackstage(); }),
    ),
  );
  return wrap;
}

const NATURE_THEME_IDS = new Set([
  "evergreen-canopy",
  "botanical-meadow",
  "oceanic-abyss",
  "nordic-aurora",
  "sakura-grove",
  "desert-canyon",
  "alpine-daylight",
]);

function themeCard(t: Theme, active: boolean): HTMLElement {
  const c = t.colors;
  const isLiquid = t.id === "liquid-glass";
  const previewBg = isLiquid
    ? "linear-gradient(135deg, #07111e 0%, #102a45 45%, #1e1b4b 100%)"
    : c.canvas;
  const preview = h("div", { class: "tcard__preview", style: { background: previewBg } },
    h("div", { class: "tcard__chrome", style: { background: c.chrome } }, h("span", { style: { background: c.accent } })),
    h("div", { class: "tcard__ribbon", style: { background: c.ribbon, borderColor: c.border } }),
    h("div", { class: "tcard__page", style: { background: c.page } },
      h("i", { style: { background: c.pageText } }), h("i", { style: { background: c.pageText } }), h("i", { style: { background: c.accent } }),
    ),
  );
  const tag = isLiquid
    ? " · Liquid Glass"
    : NATURE_THEME_IDS.has(t.id)
      ? " · Nature"
      : t.transparency && t.transparency !== "none"
        ? " · " + t.transparency
        : "";
  const swatches = h(
    "div",
    { class: "tcard__swatches" },
    h("span", { style: { background: c.chrome }, title: "Chrome" }),
    h("span", { style: { background: c.page }, title: "Page" }),
    h("span", { style: { background: c.accent }, title: "Accent" }),
  );
  const card = h("button", { class: "tcard" + (active ? " is-active" : ""), type: "button" },
    preview,
    h("div", { class: "tcard__foot" },
      h("div", { class: "tcard__info" },
        h("span", { class: "tcard__name" }, t.name, active ? icon("Check", 13) : null),
        h("span", { class: "tcard__meta" }, `${t.mode === "dark" ? "Dark" : "Light"}${tag}${t.source === "user" ? " · custom" : ""}`),
      ),
      swatches,
    ),
  );
  card.addEventListener("click", () => {
    hooks.setTheme(t.id);
    show("themes");
  });
  return card;
}

function buildStudioSection<T extends string>(
  title: string,
  subtitle: string,
  currentVal: T,
  options: { id: T; label: string }[],
  onPick: (v: T) => void,
): HTMLElement {
  const seg = h("div", { class: "studio-seg" });
  for (const o of options) {
    const btn = h(
      "button",
      {
        type: "button",
        class: "studio-seg__btn" + (currentVal === o.id ? " is-active" : ""),
      },
      o.label,
    );
    btn.addEventListener("click", () => {
      onPick(o.id);
      saveSettings();
      hooks.applyCustomization();
      show("themes");
    });
    seg.append(btn);
  }
  return h(
    "div",
    { class: "studio-card" },
    h("div", { class: "studio-card__head" }, h("strong", {}, title), h("span", {}, subtitle)),
    seg,
  );
}

function renderThemes(): HTMLElement {
  const wrap = h("div", { class: "bs__page studio-workbench" });
  const all = hooks.themes();
  const cur = hooks.currentThemeId();
  const builtin = all.filter((t) => t.source !== "user");
  const user = all.filter((t) => t.source === "user");
  const activeThemeObj = all.find((t) => t.id === cur) ?? all[0];

  // --- Studio Top Header & Active Configuration Summary Strip ---------------
  const resetStudioBtn = h(
    "button",
    { class: "btn btn--sm", type: "button" },
    icon("RotateCcw", 13),
    "Reset Studio Defaults",
  );
  resetStudioBtn.addEventListener("click", () => {
    settings.customAccent = "";
    settings.paperColor = "auto";
    settings.paperPreview = false;
    settings.paperTexture = "smooth";
    settings.customPaperTexturePath = "";
    settings.paperShadow = "studio";
    settings.uiDensity = "comfortable";
    settings.uiScale = 100;
    settings.uiFont = "system";
    settings.customUiFont = "";
    settings.showRuler = true;
    settings.showMarginGuides = false;
    settings.proofUnderlineStyle = "wavy";
    settings.backgroundPreset = "none";
    settings.customBackgroundPath = "";
    settings.backgroundBlur = "soft";
    settings.backgroundDim = "balanced";
    settings.liquidGlassUi = false;
    saveSettings();
    hooks.applyCustomization();
    show("themes");
    toast("Workspace studio settings reset to defaults", "info", 1800);
  });

  const activeFontLabel =
    settings.uiFont === "custom" && settings.customUiFont
      ? settings.customUiFont
      : settings.uiFont === "inter"
        ? "Inter Sans"
        : settings.uiFont === "mono"
          ? "JetBrains Mono"
          : settings.uiFont === "serif"
            ? "Editorial Serif"
            : "Segoe UI";

  const activePaperLabel =
    settings.paperColor === "white" || settings.paperPreview
      ? "Classic White"
      : settings.paperColor === "parchment"
        ? "Medieval Parchment"
        : settings.paperColor === "sepia"
          ? "Warm Sepia"
          : settings.paperColor === "mist"
            ? "Soft Mist"
            : settings.paperColor === "custom"
              ? `Custom (${settings.customPaperColor.toUpperCase()})`
              : "Match Theme";

  const statusStrip = h(
    "div",
    { class: "studio-banner" },
    h(
      "div",
      { class: "studio-banner__meta" },
      h("div", { class: "studio-pill" }, icon("Palette", 13), h("span", {}, "Theme:"), h("strong", {}, activeThemeObj.name)),
      h("div", { class: "studio-pill" }, icon("FileText", 13), h("span", {}, "Paper:"), h("strong", {}, activePaperLabel)),
      h("div", { class: "studio-pill" }, icon("Type", 13), h("span", {}, "UI Font:"), h("strong", {}, activeFontLabel)),
      h("div", { class: "studio-pill" }, icon("Scaling", 13), h("span", {}, "Scale:"), h("strong", {}, `${settings.uiScale || 100}%`)),
    ),
    resetStudioBtn,
  );

  // --- Categorized Workbench Tabs -------------------------------------------
  const studioTabs: { id: StudioTabId; label: string; icon: string; badge?: string }[] = [
    { id: "palettes", label: "Themes & Palettes", icon: "Palette", badge: String(builtin.length) },
    { id: "paper", label: "Paper & Surface", icon: "FileText" },
    { id: "interface", label: "Interface & Typography", icon: "Type" },
    { id: "backdrop", label: "Backdrop & Glass", icon: "Sparkles" },
    { id: "json", label: "Custom JSON", icon: "FileCode", badge: user.length ? String(user.length) : undefined },
  ];

  const tabBar = h("div", { class: "studio-tabs", role: "tablist" });
  for (const st of studioTabs) {
    const isAct = activeStudioTab === st.id;
    const btn = h(
      "button",
      {
        type: "button",
        role: "tab",
        class: "studio-tab" + (isAct ? " is-active" : ""),
        "aria-selected": String(isAct),
      },
      icon(st.icon, 15),
      h("span", {}, st.label),
      st.badge ? h("span", { class: "studio-tab__badge" }, st.badge) : null,
    );
    btn.addEventListener("click", () => {
      activeStudioTab = st.id;
      show("themes");
    });
    tabBar.append(btn);
  }

  wrap.append(
    h(
      "div",
      { class: "studio-header" },
      h("div", {}, h("h1", { class: "bs__title" }, "Themes & Studio"), h("p", { class: "studio-header__sub" }, "Customize your theme palette, paper sheet tactile finish, interface typography, and optical glass backdrops.")),
    ),
    statusStrip,
    tabBar,
  );

  const stage = h("div", { class: "studio-stage" });

  // =========================================================================
  // TAB 1: THEMES & PALETTES
  // =========================================================================
  if (activeStudioTab === "palettes") {
    const accentRow = h("div", { class: "studio-accents" });
    const activeAccent = (settings.customAccent || "").toLowerCase();

    for (const sw of ACCENT_PRESETS) {
      const isSelected = activeAccent === sw.id.toLowerCase();
      const displayColor = sw.color || activeThemeObj.colors.accent;
      const chip = h(
        "button",
        {
          type: "button",
          class: "studio-accent" + (isSelected ? " is-active" : ""),
          "data-tip": sw.label,
        },
        h("span", { class: "studio-accent__dot", style: { background: displayColor } }),
        h("span", { class: "studio-accent__label" }, sw.label),
      );
      chip.addEventListener("click", () => {
        settings.customAccent = sw.id;
        saveSettings();
        hooks.applyCustomization();
        show("themes");
      });
      accentRow.append(chip);
    }

    const colorInput = h("input", {
      type: "color",
      class: "studio-accent__picker",
      value: /^#[0-9a-f]{6}$/i.test(settings.customAccent) ? settings.customAccent : activeThemeObj.colors.accent,
      title: "Pick any custom hex accent color",
    }) as HTMLInputElement;
    colorInput.addEventListener("input", () => {
      settings.customAccent = colorInput.value;
      saveSettings();
      hooks.applyCustomization();
    });
    colorInput.addEventListener("change", () => show("themes"));
    const customColorWrap = h(
      "label",
      { class: "studio-accent studio-accent--custom", "data-tip": "Choose custom hex color" },
      icon("Pipette", 13),
      h("span", { class: "studio-accent__label" }, "Custom Hex…"),
      colorInput,
    );
    accentRow.append(customColorWrap);

    const accentCard = h(
      "div",
      { class: "studio-card studio-card--wide" },
      h(
        "div",
        { class: "studio-card__head" },
        h("strong", {}, "Signature Accent Color"),
        h("span", {}, "Override the active theme's accent across buttons, highlights, rulers, and selections"),
      ),
      accentRow,
    );

    // --- Live Custom Theme Color Picker Studio -------------------------------
    const customColors: CustomThemeColors = {
      ...DEFAULT_CUSTOM_THEME,
      ...(settings.customThemeColors ?? {}),
    };
    const isCustomActive = cur === "custom-studio";

    const pickerDefs: { key: Exclude<keyof CustomThemeColors, "mode">; label: string; sub: string }[] = [
      { key: "chrome", label: "Window Chrome", sub: "Titlebar & Sidebar" },
      { key: "ribbon", label: "Ribbon Surface", sub: "Toolbar & Popovers" },
      { key: "canvas", label: "Canvas Desk", sub: "Workspace Backdrop" },
      { key: "page", label: "Paper Sheet", sub: "Document Page" },
      { key: "pageText", label: "Page Ink", sub: "Document Typography" },
      { key: "text", label: "Interface Text", sub: "UI Labels & Icons" },
      { key: "accent", label: "Theme Accent", sub: "Primary Highlight" },
    ];

    const pickersGrid = h("div", { class: "custom-theme-grid" });
    for (const def of pickerDefs) {
      const hexVal = /^#[0-9a-f]{6}$/i.test(customColors[def.key] || "")
        ? customColors[def.key]
        : DEFAULT_CUSTOM_THEME[def.key];
      const dot = h("span", { class: "custom-theme-swatch__dot", style: { background: hexVal } });
      const hexLabel = h("code", { class: "custom-theme-swatch__hex" }, hexVal.toUpperCase());
      const inp = h("input", {
        type: "color",
        class: "studio-accent__picker",
        value: hexVal,
        title: `Pick ${def.label} color`,
      }) as HTMLInputElement;

      inp.addEventListener("input", () => {
        if (!settings.customThemeColors) {
          settings.customThemeColors = { ...DEFAULT_CUSTOM_THEME };
        }
        settings.customThemeColors[def.key] = inp.value;
        dot.style.background = inp.value;
        hexLabel.textContent = inp.value.toUpperCase();
        saveSettings();
        if (hooks.currentThemeId() !== "custom-studio") {
          hooks.setTheme("custom-studio");
        } else {
          hooks.applyCustomization();
        }
      });
      inp.addEventListener("change", () => show("themes"));

      const cell = h(
        "label",
        { class: "custom-theme-swatch" },
        dot,
        h(
          "div",
          { class: "custom-theme-swatch__meta" },
          h("strong", {}, def.label),
          h("span", {}, def.sub),
          hexLabel,
        ),
        inp,
      );
      pickersGrid.append(cell);
    }

    const activateCustomBtn = h(
      "button",
      { type: "button", class: "btn btn--sm" + (isCustomActive ? " btn--primary" : "") },
      icon("Palette", 13),
      isCustomActive ? "Custom Palette Active" : "Activate Custom Palette",
    );
    activateCustomBtn.addEventListener("click", () => {
      hooks.setTheme("custom-studio");
      show("themes");
    });

    const cloneActiveToCustomBtn = h(
      "button",
      { type: "button", class: "btn btn--sm", "data-tip": "Load the currently active theme's colors into the color pickers as a starting point" },
      icon("Copy", 13),
      "Clone Current Theme Colors",
    );
    cloneActiveToCustomBtn.addEventListener("click", () => {
      const c = activeThemeObj.colors;
      settings.customThemeColors = {
        mode: activeThemeObj.mode,
        chrome: c.chrome.startsWith("#") ? c.chrome : "#141820",
        ribbon: c.ribbon.startsWith("#") ? c.ribbon : "#1b202b",
        canvas: c.canvas.startsWith("#") ? c.canvas : "#0f1218",
        page: c.page.startsWith("#") ? c.page : "#181d26",
        pageText: c.pageText.startsWith("#") ? c.pageText : "#e6edf3",
        text: c.text.startsWith("#") ? c.text : "#d9e1eb",
        accent: c.accent.startsWith("#") ? c.accent : "#7aa2f7",
      };
      saveSettings();
      hooks.setTheme("custom-studio");
      show("themes");
      toast(`Cloned "${activeThemeObj.name}" into Custom Studio Palette`, "success", 2000);
    });

    const resetCustomBtn = h(
      "button",
      { type: "button", class: "btn btn--sm" },
      icon("RotateCcw", 13),
      "Reset Custom Colors",
    );
    resetCustomBtn.addEventListener("click", () => {
      settings.customThemeColors = { ...DEFAULT_CUSTOM_THEME };
      saveSettings();
      hooks.applyCustomization();
      show("themes");
    });

    const customThemeCard = h(
      "div",
      { class: "studio-card studio-card--wide" },
      h(
        "div",
        { class: "studio-card__head", style: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" } },
        h(
          "div",
          {},
          h("strong", {}, "Custom Theme Color Picker Studio"),
          h("span", { style: { display: "block" } }, "Design your own bespoke theme with live color pickers — clicking any swatch immediately previews it"),
        ),
        h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } }, activateCustomBtn, cloneActiveToCustomBtn, resetCustomBtn),
      ),
      pickersGrid,
    );

    const GREYTONE_IDS = new Set(["graphite-monolith", "silver-halide"]);
    const studioDark = builtin.filter(
      (t) => t.mode === "dark" && !NATURE_THEME_IDS.has(t.id) && !GREYTONE_IDS.has(t.id),
    );
    const greytoneThemes = builtin.filter((t) => GREYTONE_IDS.has(t.id));
    const natureThemes = builtin.filter((t) => NATURE_THEME_IDS.has(t.id));
    const lightThemes = builtin.filter(
      (t) => t.mode === "light" && !NATURE_THEME_IDS.has(t.id) && !GREYTONE_IDS.has(t.id),
    );

    stage.append(
      accentCard,
      customThemeCard,
      h("div", { class: "studio-section-title" }, icon("Moon", 14), h("span", {}, "Studio Dark & Spatial Themes")),
      h("div", { class: "tcards" }, ...studioDark.map((t) => themeCard(t, t.id === cur))),
    );
    if (greytoneThemes.length) {
      stage.append(
        h("div", { class: "studio-section-title" }, icon("Contrast", 14), h("span", {}, "Greytone & Monolith Themes")),
        h("div", { class: "tcards" }, ...greytoneThemes.map((t) => themeCard(t, t.id === cur))),
      );
    }
    if (natureThemes.length) {
      stage.append(
        h("div", { class: "studio-section-title" }, icon("Trees", 14), h("span", {}, "Scenic Nature Collection")),
        h("div", { class: "tcards" }, ...natureThemes.map((t) => themeCard(t, t.id === cur))),
      );
    }
    if (lightThemes.length) {
      stage.append(
        h("div", { class: "studio-section-title" }, icon("Sun", 14), h("span", {}, "Editorial Light Themes")),
        h("div", { class: "tcards" }, ...lightThemes.map((t) => themeCard(t, t.id === cur))),
      );
    }
  }

  // =========================================================================
  // TAB 2: PAPER & SURFACE
  // =========================================================================
  if (activeStudioTab === "paper") {
    const curPaperMode = settings.paperColor || (settings.paperPreview ? "white" : "auto");
    const paperSeg = h("div", { class: "studio-seg" });
    const paperPresets: { id: PaperColorMode; label: string }[] = [
      { id: "auto", label: "Match Theme" },
      { id: "white", label: "Classic White" },
      { id: "parchment", label: "Medieval Parchment" },
      { id: "sepia", label: "Warm Sepia" },
      { id: "mist", label: "Soft Mist" },
    ];
    for (const p of paperPresets) {
      const btn = h(
        "button",
        { type: "button", class: "studio-seg__btn" + (curPaperMode === p.id ? " is-active" : "") },
        p.label,
      );
      btn.addEventListener("click", () => {
        settings.paperColor = p.id;
        settings.paperPreview = p.id === "white";
        if (p.id === "parchment") {
          settings.paperTexture = "parchment";
        }
        saveSettings();
        hooks.applyCustomization();
        show("themes");
      });
      paperSeg.append(btn);
    }
    const customPaperHex = /^#[0-9a-f]{6}$/i.test(settings.customPaperColor || "")
      ? settings.customPaperColor
      : "#18222d";
    const paperColorInput = h("input", {
      type: "color",
      class: "studio-accent__picker",
      value: customPaperHex,
      title: "Pick any custom paper color",
    }) as HTMLInputElement;
    paperColorInput.addEventListener("input", () => {
      settings.customPaperColor = paperColorInput.value;
      settings.paperColor = "custom";
      settings.paperPreview = false;
      saveSettings();
      hooks.applyCustomization();
    });
    paperColorInput.addEventListener("change", () => show("themes"));
    const customPaperBtn = h(
      "label",
      {
        class: "studio-seg__btn" + (curPaperMode === "custom" ? " is-active" : ""),
        style: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", cursor: "pointer" },
      },
      h("span", { class: "studio-accent__dot", style: { background: customPaperHex, width: "11px", height: "11px" } }),
      h("span", {}, "Custom Color…"),
      paperColorInput,
    );
    paperSeg.append(customPaperBtn);

    const paperColorCard = h(
      "div",
      { class: "studio-card" },
      h(
        "div",
        { class: "studio-card__head" },
        h("strong", {}, "Paper Sheet Tone"),
        h("span", {}, "Independent from the dark or light UI chrome — pick a preset, Medieval Parchment, or any custom color"),
      ),
      paperSeg,
    );

    const customTexPath = (settings.customPaperTexturePath || "").trim();
    const customTexFileName = customTexPath ? customTexPath.split(/[\\/]/).pop() || "Custom Texture" : "";

    const textureCard = buildStudioSection<PaperTexture>(
      "Paper Surface Texture",
      "Tactile finish rendered across the document sheet (including Medieval Parchment, Cotton Rag, Blueprint & Custom PC Texture)",
      settings.paperTexture || "smooth",
      [
        { id: "smooth", label: "Smooth Studio" },
        { id: "parchment", label: "Medieval Parchment" },
        { id: "cotton", label: "Cotton Rag" },
        { id: "vintage", label: "Vintage Bond" },
        { id: "linen", label: "Fine Linen" },
        { id: "grain", label: "Archival Grain" },
        { id: "lined", label: "Ruled Lines" },
        { id: "dots", label: "Dot Grid" },
        { id: "blueprint", label: "Blueprint Grid" },
        ...(customTexPath ? [{ id: "custom" as PaperTexture, label: "Custom Texture" }] : []),
      ],
      (v) => {
        settings.paperTexture = v;
        if (v === "parchment" && settings.paperColor === "auto") {
          settings.paperColor = "parchment";
        }
      },
    );

    const pickTexBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn--sm" + (settings.paperTexture === "custom" ? " is-active" : ""),
      },
      icon("ImagePlus", 13),
      customTexPath ? `Custom Texture: ${customTexFileName}` : "Upload Custom Paper Texture from PC…",
    );
    pickTexBtn.addEventListener("click", async () => {
      const file = await pickCustomPaperTexture();
      if (!file) return;
      settings.customPaperTexturePath = file;
      settings.paperTexture = "custom";
      saveSettings();
      hooks.applyCustomization();
      show("themes");
      toast("Custom paper texture applied to sheet", "success", 2000);
    });

    const clearTexBtn = h(
      "button",
      { type: "button", class: "btn btn--sm" },
      icon("Trash2", 13),
      "Clear",
    );
    clearTexBtn.addEventListener("click", () => {
      settings.customPaperTexturePath = "";
      if (settings.paperTexture === "custom") settings.paperTexture = "smooth";
      saveSettings();
      hooks.applyCustomization();
      show("themes");
      toast("Custom paper texture cleared", "info", 1600);
    });

    textureCard.append(
      h(
        "div",
        { class: "studio-custom-font-bar" },
        h(
          "div",
          { class: "studio-custom-font-bar__info" },
          h("strong", {}, "Custom Paper Texture Image (From PC)"),
          h("span", {}, "Import any parchment, watercolor paper, canvas, or grain image (PNG, JPG, WebP) from your PC"),
        ),
        h("div", { class: "studio-custom-font-bar__actions" }, pickTexBtn, customTexPath ? clearTexBtn : null),
      ),
    );

    const shadowCard = buildStudioSection<PaperShadow>(
      "Sheet Elevation & Depth",
      "Controls the physical desk drop-shadow beneath the page",
      settings.paperShadow || "studio",
      [
        { id: "subtle", label: "Subtle Flat" },
        { id: "studio", label: "Studio Layered" },
        { id: "deep", label: "Deep Floating" },
      ],
      (v) => (settings.paperShadow = v),
    );

    const rulerOn = settings.showRuler !== false;
    const guidesOn = Boolean(settings.showMarginGuides);
    const gridOn = Boolean(state.page.baselineGrid);
    const guidesSeg = h("div", { class: "studio-seg" });
    const rulerBtn = h(
      "button",
      { type: "button", class: "studio-seg__btn" + (rulerOn ? " is-active" : "") },
      rulerOn ? "Page Ruler: ON" : "Page Ruler: OFF",
    );
    rulerBtn.addEventListener("click", () => {
      settings.showRuler = !rulerOn;
      saveSettings();
      hooks.applyCustomization();
      show("themes");
    });
    const guidesBtn = h(
      "button",
      { type: "button", class: "studio-seg__btn" + (guidesOn ? " is-active" : "") },
      guidesOn ? "Crop Marks: ON" : "Crop Marks: OFF",
    );
    guidesBtn.addEventListener("click", () => {
      settings.showMarginGuides = !guidesOn;
      saveSettings();
      hooks.applyCustomization();
      show("themes");
    });
    const gridBtn = h(
      "button",
      { type: "button", class: "studio-seg__btn" + (gridOn ? " is-active" : "") },
      gridOn ? "Baseline Grid: ON" : "Baseline Grid: OFF",
    );
    gridBtn.addEventListener("click", () => {
      state.page.baselineGrid = !gridOn;
      emit("page:change");
      show("themes");
    });
    guidesSeg.append(rulerBtn, guidesBtn, gridBtn);

    const rulerCard = h(
      "div",
      { class: "studio-card" },
      h(
        "div",
        { class: "studio-card__head" },
        h("strong", {}, "Ruler, Crop Marks & Baseline Grid"),
        h("span", {}, "Interactive top inch ruler, corner margin crop marks, and 12pt typographic baseline grid"),
      ),
      guidesSeg,
    );

    stage.append(h("div", { class: "studio-grid" }, paperColorCard, textureCard, shadowCard, rulerCard));
  }

  // =========================================================================
  // TAB 3: INTERFACE & TYPOGRAPHY (Includes Custom Typeface Picker!)
  // =========================================================================
  if (activeStudioTab === "interface") {
    const curFontChoice: UiFontChoice = settings.uiFont || "system";
    const curCustomFont = (settings.customUiFont || "").trim();

    const fontSeg = h("div", { class: "studio-seg" });
    const fontPresets: { id: UiFontChoice; label: string }[] = [
      { id: "system", label: "Segoe UI" },
      { id: "inter", label: "Inter Sans" },
      { id: "mono", label: "JetBrains Mono" },
      { id: "serif", label: "Editorial Serif" },
    ];
    for (const fp of fontPresets) {
      const b = h(
        "button",
        {
          type: "button",
          class: "studio-seg__btn" + (curFontChoice === fp.id ? " is-active" : ""),
        },
        fp.label,
      );
      b.addEventListener("click", () => {
        settings.uiFont = fp.id;
        saveSettings();
        hooks.applyCustomization();
        show("themes");
      });
      fontSeg.append(b);
    }

    // Custom Typeface Picker Button (Opens searchable installed fonts popover) + Direct Type Input
    const pickSystemFontBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn--sm" + (curFontChoice === "custom" ? " is-active" : ""),
        "data-tip": "Browse and select any typeface installed on your PC for the interface",
      },
      icon("Type", 13),
      curFontChoice === "custom" && curCustomFont ? `Custom: ${curCustomFont}` : "Pick Installed Font…",
      icon("ChevronDown", 13),
    );
    pickSystemFontBtn.addEventListener("click", () => {
      const list = h("div", { class: "fontpanel" });
      const search = h("input", {
        class: "input fontlist__search",
        placeholder: "Search installed PC fonts…",
        spellcheck: "false",
      }) as HTMLInputElement;
      const ul = h("div", { class: "fontlist" });
      const renderList = () => {
        ul.replaceChildren();
        const q = search.value.toLowerCase();
        const pool = state.fonts.length
          ? state.fonts
          : ["Segoe UI", "Inter", "JetBrainsMono Nerd Font", "Cascadia Code", "Consolas", "Georgia", "Calibri", "Arial", "Verdana"];
        for (const f of pool.filter((x) => x.toLowerCase().includes(q)).slice(0, 500)) {
          const isSel = curFontChoice === "custom" && curCustomFont.toLowerCase() === f.toLowerCase();
          const item = h(
            "button",
            {
              class: "fontlist__item" + (isSel ? " is-checked" : ""),
              type: "button",
              style: { fontFamily: `"${f}", sans-serif` },
            },
            f,
          );
          item.addEventListener("click", () => {
            settings.customUiFont = f;
            settings.uiFont = "custom";
            saveSettings();
            hooks.applyCustomization();
            closePopover();
            show("themes");
            toast(`Interface typeface set to “${f}”`, "success", 1800);
          });
          ul.append(item);
        }
      };
      search.addEventListener("input", renderList);
      renderList();
      list.append(search, ul);
      popover(pickSystemFontBtn, list);
      requestAnimationFrame(() => search.focus());
    });

    const typeCustomFontBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn--sm",
        "data-tip": "Type any custom font family name manually",
      },
      icon("Edit3", 13),
      "Enter Font Name…",
    );
    typeCustomFontBtn.addEventListener("click", async () => {
      const r = await promptDialog(
        "Custom Interface Typeface",
        [
          {
            name: "font",
            label: "Typeface family name installed on your system",
            value: curCustomFont || "JetBrainsMono Nerd Font",
            placeholder: "e.g. Geist, JetBrainsMono Nerd Font, Fira Code, Aptos",
          },
        ],
        "Apply Typeface",
      );
      const name = r?.font?.trim();
      if (!name) return;
      settings.customUiFont = name;
      settings.uiFont = "custom";
      saveSettings();
      hooks.applyCustomization();
      show("themes");
      toast(`Interface typeface set to “${name}”`, "success", 1800);
    });

    const uiFontCard = h(
      "div",
      { class: "studio-card studio-card--wide" },
      h(
        "div",
        { class: "studio-card__head studio-card__head--row" },
        h(
          "div",
          {},
          h("strong", {}, "Interface Typography & Custom Typeface"),
          h("span", {}, "Choose a built-in UI font preset or pick any custom typeface installed on your system for menus, tabs, and panels"),
        ),
        h("div", { class: "studio-card__actions" }, pickSystemFontBtn, typeCustomFontBtn),
      ),
      fontSeg,
    );

    const densityCard = buildStudioSection<UiDensity>(
      "Ribbon & Toolbar Density",
      "Adjusts control spacing and ribbon height",
      settings.uiDensity || "comfortable",
      [
        { id: "compact", label: "Compact" },
        { id: "comfortable", label: "Comfortable" },
        { id: "spacious", label: "Spacious" },
      ],
      (v) => (settings.uiDensity = v),
    );

    const curScale = Math.max(75, Math.min(130, Number(settings.uiScale) || 100));
    const scaleSeg = h("div", { class: "studio-seg" });
    const scalePresets: { val: number; label: string }[] = [
      { val: 85, label: "85%" },
      { val: 90, label: "90%" },
      { val: 95, label: "95%" },
      { val: 100, label: "100%" },
      { val: 110, label: "110%" },
      { val: 120, label: "120%" },
    ];
    const scaleBadge = h(
      "span",
      {
        style: {
          fontFamily: "var(--mono-font)",
          fontSize: "11.5px",
          fontWeight: "600",
          color: "var(--accent)",
          minWidth: "42px",
          textAlign: "right",
        },
      },
      `${curScale}%`,
    );
    const scaleSlider = h("input", {
      type: "range",
      min: "75",
      max: "125",
      step: "5",
      value: String(curScale),
      class: "zoom__slider",
      style: { flex: "1", width: "100%" },
    }) as HTMLInputElement;

    for (const sp of scalePresets) {
      const b = h(
        "button",
        {
          type: "button",
          class: "studio-seg__btn" + (curScale === sp.val ? " is-active" : ""),
        },
        sp.label,
      );
      b.addEventListener("click", () => {
        settings.uiScale = sp.val;
        saveSettings();
        hooks.applyCustomization();
        show("themes");
      });
      scaleSeg.append(b);
    }

    scaleSlider.addEventListener("input", () => {
      const v = Number(scaleSlider.value) || 100;
      settings.uiScale = v;
      scaleBadge.textContent = `${v}%`;
      saveSettings();
      hooks.applyCustomization();
      const btns = scaleSeg.querySelectorAll(".studio-seg__btn");
      scalePresets.forEach((sp, idx) => {
        btns[idx]?.classList.toggle("is-active", sp.val === v);
      });
    });

    const uiScaleCard = h(
      "div",
      { class: "studio-card" },
      h(
        "div",
        { class: "studio-card__head studio-card__head--row" },
        h(
          "div",
          {},
          h("strong", {}, "Interface Size (UI Scale)"),
          h("span", {}, "Scale the entire ribbon, tabs, menus, and status bar (75% – 125%)"),
        ),
        scaleBadge,
      ),
      scaleSeg,
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px", paddingTop: "2px" } },
        h("span", { style: { fontSize: "11px", color: "var(--text-muted)" } }, "75%"),
        scaleSlider,
        h("span", { style: { fontSize: "11px", color: "var(--text-muted)" } }, "125%"),
      ),
    );

    const proofStyleCard = buildStudioSection<ProofUnderlineStyle>(
      "Proofing Underline Style",
      "Visual indicator for spelling and grammar marks on the page",
      settings.proofUnderlineStyle || "wavy",
      [
        { id: "wavy", label: "Classic Wavy" },
        { id: "dotted", label: "Subtle Dotted" },
        { id: "solid", label: "Crisp Solid" },
      ],
      (v) => (settings.proofUnderlineStyle = v),
    );

    stage.append(h("div", { class: "studio-grid" }, uiFontCard, densityCard, uiScaleCard, proofStyleCard));
  }

  // =========================================================================
  // TAB 4: BACKDROP & LIQUID GLASS
  // =========================================================================
  if (activeStudioTab === "backdrop") {
    const curBgPreset: BackgroundPreset = settings.backgroundPreset || "none";
    const hasCustomPhoto = Boolean(settings.customBackgroundPath?.trim());
    const customFileName = hasCustomPhoto ? settings.customBackgroundPath.replace(/^.*[\\/]/, "") : "";

    const pickPhotoBtn = h(
      "button",
      { class: "btn btn--primary btn--sm", type: "button" },
      icon("ImagePlus", 14),
      hasCustomPhoto ? "Change Custom Photo…" : "Choose Custom Photo from PC…",
    );
    pickPhotoBtn.addEventListener("click", async () => {
      const file = await pickCustomBackgroundPhoto();
      if (!file) return;
      settings.customBackgroundPath = file;
      settings.backgroundPreset = "custom";
      saveSettings();
      hooks.applyCustomization();
      show("themes");
      toast("Custom background photo applied", "success", 1800);
    });

    const clearPhotoBtn = hasCustomPhoto
      ? h(
          "button",
          { class: "btn btn--sm", type: "button", "data-tip": "Remove custom background photo" },
          icon("Trash2", 13),
          "Clear Photo",
        )
      : null;
    clearPhotoBtn?.addEventListener("click", () => {
      settings.customBackgroundPath = "";
      if (settings.backgroundPreset === "custom") settings.backgroundPreset = "none";
      saveSettings();
      hooks.applyCustomization();
      show("themes");
      toast("Custom background photo cleared", "info", 1500);
    });

    const glassToggleBtn = h(
      "button",
      {
        type: "button",
        class:
          "btn btn--sm" +
          (settings.liquidGlassUi || cur === "liquid-glass" || curBgPreset !== "none" ? " is-active" : ""),
        "data-tip": "Enable translucent refractive Liquid Glass across the ribbon, titlebar, and panels",
      },
      icon("Sparkles", 13),
      settings.liquidGlassUi || cur === "liquid-glass" || curBgPreset !== "none"
        ? "Liquid Glass Chrome: Active"
        : "Enable Liquid Glass Chrome",
    );
    glassToggleBtn.addEventListener("click", () => {
      settings.liquidGlassUi = !settings.liquidGlassUi;
      saveSettings();
      hooks.applyCustomization();
      show("themes");
    });

    const bgPresetRow = h("div", { class: "studio-accents" });
    for (const bp of BACKDROP_PRESETS) {
      if (bp.id === "custom" && !hasCustomPhoto) continue;
      const isSel = curBgPreset === bp.id || (curBgPreset === "none" && cur === "liquid-glass" && bp.id === "liquid-prism");
      const chip = h(
        "button",
        {
          type: "button",
          class: "studio-accent" + (isSel ? " is-active" : ""),
        },
        icon(bp.id === "custom" ? "Image" : bp.id === "none" ? "Ban" : "MountainSnow", 13),
        h(
          "span",
          { class: "studio-accent__label" },
          bp.id === "custom" && customFileName ? `Photo: ${customFileName}` : bp.label,
        ),
      );
      chip.addEventListener("click", () => {
        settings.backgroundPreset = bp.id;
        saveSettings();
        hooks.applyCustomization();
        show("themes");
      });
      bgPresetRow.append(chip);
    }

    const blurCard = buildStudioSection<BackgroundBlur>(
      "Backdrop Optical Blur",
      "Depth-of-field blur applied to scenic or custom background photos",
      settings.backgroundBlur || "soft",
      [
        { id: "none", label: "Crisp (0px)" },
        { id: "soft", label: "Soft Depth" },
        { id: "frosted", label: "Liquid Frosted" },
      ],
      (v) => (settings.backgroundBlur = v),
    );

    const dimCard = buildStudioSection<BackgroundDim>(
      "Backdrop Focus Dimming",
      "Ambient vignette darkening behind the document sheet",
      settings.backgroundDim || "balanced",
      [
        { id: "light", label: "Subtle (18%)" },
        { id: "balanced", label: "Balanced (40%)" },
        { id: "deep", label: "Deep Focus (65%)" },
      ],
      (v) => (settings.backgroundDim = v),
    );

    const backdropCard = h(
      "div",
      { class: "studio-card studio-card--wide" },
      h(
        "div",
        { class: "studio-card__head studio-card__head--row" },
        h(
          "div",
          {},
          h("strong", {}, "Custom Background Wallpaper & Scenic Backdrops"),
          h("span", {}, "Upload your own wallpaper photo or choose a scenic Nature / Liquid Glass backdrop behind the document desk"),
        ),
        h("div", { class: "studio-card__actions" }, pickPhotoBtn, clearPhotoBtn, glassToggleBtn),
      ),
      bgPresetRow,
    );

    stage.append(h("div", { class: "studio-grid" }, backdropCard, blurCard, dimCard));
  }

  // =========================================================================
  // TAB 5: CUSTOM JSON THEMES
  // =========================================================================
  if (activeStudioTab === "json") {
    const openFolder = h("button", { class: "btn", type: "button" }, icon("FolderCog", 15), "Open themes folder");
    openFolder.addEventListener("click", async () => native.openFolder((await native.appPaths()).themes));
    const reload = h("button", { class: "btn", type: "button" }, icon("RefreshCw", 15), "Reload");
    reload.addEventListener("click", async () => {
      await hooks.reloadThemes();
      show("themes");
      toast("Themes reloaded", "success", 1400);
    });
    const create = h("button", { class: "btn btn--primary", type: "button" }, icon("Plus", 15), "New theme from current");
    create.addEventListener("click", async () => {
      const r = await promptDialog("New theme", [{ name: "name", label: "Theme name", placeholder: "My theme" }], "Create");
      const name = r?.name.trim();
      if (!name) return;
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-theme";
      const base = all.find((t) => t.id === cur) ?? all[0];
      try {
        await native.writeUserTheme(`${id}.json`, themeToJson(base, id, name));
        await hooks.reloadThemes();
        hooks.setTheme(`user:${id}`);
        show("themes");
        toast(`Created ${id}.json — edit it in the themes folder, then hit Reload`, "success", 4500);
      } catch (e) {
        toast(String(e), "error");
      }
    });

    stage.append(
      h(
        "div",
        { class: "studio-card studio-card--wide" },
        h(
          "div",
          { class: "studio-card__head studio-card__head--row" },
          h(
            "div",
            {},
            h("strong", {}, "User JSON Theme Files"),
            h("span", {}, "Drop .json theme files into your themes folder or clone the current theme as a customizable JSON template."),
          ),
          h("div", { class: "studio-card__actions" }, openFolder, reload, create),
        ),
      ),
      user.length
        ? h("div", { class: "tcards" }, ...user.map((t) => themeCard(t, t.id === cur)))
        : h("p", { class: "bs__empty" }, "No custom .json themes found yet. Click “New theme from current” above to generate a starter template."),
    );
  }

  wrap.append(stage);
  return wrap;
}

function renderPlugins(): HTMLElement {
  const wrap = h("div", { class: "bs__page" }, h("h1", { class: "bs__title" }, "Plugins"));
  const openFolder = h("button", { class: "btn", type: "button" }, icon("FolderCog", 15), "Open plugins folder");
  openFolder.addEventListener("click", async () => native.openFolder((await native.appPaths()).plugins));
  const reload = h("button", { class: "btn", type: "button" }, icon("RefreshCw", 15), "Reload plugins");
  reload.addEventListener("click", async () => {
    await hooks.reloadPlugins();
    show("plugins");
    toast("Plugins reloaded", "success", 1400);
  });
  wrap.append(
    h("p", { class: "bs__lead" }, "Plugins are small JavaScript modules that can add ribbon tabs, buttons and commands. Each one lives in its own folder with a plugin.json and main.js — see the bundled Text Tools plugin for a working example."),
    h("div", { class: "bs__row" }, openFolder, reload),
  );
  if (!plugins.length) {
    wrap.append(h("p", { class: "bs__empty" }, "No plugins installed."));
    return wrap;
  }
  const list = h("div", { class: "plist" });
  for (const p of plugins) {
    const toggle = h("button", { class: "switch" + (p.enabled ? " is-on" : ""), type: "button", role: "switch", "aria-checked": String(p.enabled), "aria-label": `Enable ${p.name}` }, h("span", { class: "switch__knob" }));
    toggle.addEventListener("click", async () => {
      await setPluginEnabled(p.id, !p.enabled);
      show("plugins");
    });
    const statusText = p.status === "active" ? "Active" : p.status === "error" ? "Error" : "Disabled";
    list.append(
      h("div", { class: "pcard" },
        h("div", { class: "pcard__icon" }, icon("Puzzle", 20)),
        h("div", { class: "pcard__body" },
          h("div", { class: "pcard__head" }, h("strong", {}, p.name), h("span", { class: "pcard__ver" }, `v${p.version}`), h("span", { class: `pill pill--${p.status}` }, statusText)),
          p.description ? h("p", { class: "pcard__desc" }, p.description) : null,
          p.error ? h("p", { class: "pcard__error" }, p.error) : null,
          h("span", { class: "pcard__folder" }, `plugins/${p.folder}${p.author ? " · " + p.author : ""}`),
        ),
        toggle,
      ),
    );
  }
  wrap.append(list);
  return wrap;
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl+N / O / S", "New · Open · Save"], ["Ctrl+Shift+S", "Save as"], ["Ctrl+P", "Print / PDF"],
  ["Ctrl+T / Ctrl+W", "New tab · Close tab"], ["Ctrl+C / X / V", "Copy · Cut · Paste (Text or Picture)"],
  ["Ctrl+Shift+V", "Paste Plain Text Only"], ["Ctrl+Alt+V", "Paste Picture from Clipboard"],
  ["Ctrl+D", "Duplicate Selected Picture"], ["Ctrl+B / I / U", "Bold · Italic · Underline"],
  ["Ctrl+E / L / R / J", "Center · Left · Right · Justify"], ["Ctrl+1 / 2 / 5", "Line spacing 1 · 2 · 1.5"],
  ["Ctrl+Alt+1–3", "Heading 1–3"], ["Ctrl+] / [", "Grow · shrink font"],
  ["Ctrl+M / Ctrl+Shift+M", "Indent · outdent"], ["Ctrl+K", "Insert link"], ["Ctrl+Enter", "Page break"],
  ["Ctrl+F / H", "Find · Replace"], ["F7", "Spell & Grammar Check"], ["Ctrl+Shift+D", "Dictionary & Thesaurus"],
  ["Ctrl+Shift+O", "Document Outline"], ["F11", "Focus Mode"], ["Ctrl+wheel", "Zoom"],
];

let cachedUpdateCheck: UpdateCheckResult | null = null;
let updateCheckBusy = false;

function renderAbout(): HTMLElement {
  const wrap = h("div", { class: "bs__page" }, h("h1", { class: "bs__title" }, "About, Privacy & Updates"));

  // --- 1. Strict Offline Privacy Mode Card ---
  const privacyOn = settings.strictOfflinePrivacy !== false;
  const privacyToggle = h(
    "button",
    {
      class: "switch" + (privacyOn ? " is-on" : ""),
      type: "button",
      role: "switch",
      "aria-checked": String(privacyOn),
      "aria-label": "Enable Strict Offline Privacy Mode",
    },
    h("span", { class: "switch__knob" }),
  );
  privacyToggle.addEventListener("click", () => {
    settings.strictOfflinePrivacy = !privacyOn;
    saveSettings();
    show("about");
    toast(
      settings.strictOfflinePrivacy
        ? "Strict Offline Privacy Mode ON — 100% local on-device processing (zero network text transmission)"
        : "Online Grammar & Web Dictionary enrichment enabled",
      "info",
      2800,
    );
  });

  const privacyCard = h(
    "div",
    { class: "pcard" },
    h("div", { class: "pcard__icon" }, icon("Shield", 20)),
    h(
      "div",
      { class: "pcard__body" },
      h(
        "div",
        { class: "pcard__head" },
        h("strong", {}, "Strict Offline Privacy Mode"),
        h(
          "span",
          { class: `pill pill--${privacyOn ? "active" : "disabled"}` },
          privacyOn ? "100% Local On-Device (Active)" : "Online Enrichment Allowed",
        ),
      ),
      h(
        "p",
        { class: "pcard__desc" },
        "All documents (.docx, .pdf, .epub, .md), images, autosaves, and Windows 11 COM spellchecking run 100% locally on your computer with zero telemetry or cloud accounts. When active, zero words or paragraphs are ever sent to external grammar or dictionary APIs.",
      ),
    ),
    privacyToggle,
  );

  // --- 2. Software Updates & Auto-Sync Card ---
  const repoInput = h("input", {
    type: "text",
    class: "input",
    value: settings.updateRepo || "Redlett/Typo-1.0.1",
    placeholder: "e.g. Redlett/Typo-1.0.1",
    style: "max-width: 280px; height: 30px; font-size: 12.5px;",
    "aria-label": "GitHub Release Repository",
  }) as HTMLInputElement;

  const saveRepoBtn = h(
    "button",
    { class: "btn btn--sm", type: "button", "data-tip": "Save release channel repository" },
    icon("Check", 13),
    "Save Channel",
  );
  saveRepoBtn.addEventListener("click", () => {
    settings.updateRepo = repoInput.value.trim();
    saveSettings();
    cachedUpdateCheck = null;
    show("about");
    toast(
      settings.updateRepo
        ? `Release channel saved: ${settings.updateRepo}`
        : "Release channel cleared",
      "success",
      2200,
    );
  });

  const checkUpdateBtn = h(
    "button",
    {
      class: "btn btn--sm btn--primary",
      type: "button",
      "data-tip": "Check GitHub Releases for a newer version of Typo",
    },
    icon("RefreshCw", 13),
    updateCheckBusy ? "Checking…" : "Check for Updates",
  );

  const statusHost = h("div", { style: "margin-top: 10px; display: flex; flex-direction: column; gap: 8px;" });

  const renderUpdateStatus = () => {
    statusHost.replaceChildren();
    if (!cachedUpdateCheck) return;
    const res = cachedUpdateCheck;
    if (res.updateAvailable) {
      const installBtn = h(
        "button",
        { class: "btn btn--sm btn--primary", type: "button" },
        icon("Download", 13),
        res.downloadUrl
          ? `Download & Install v${res.latestVersion} (${res.assetName || "Setup"})`
          : `Open v${res.latestVersion} Release Page`,
      );
      installBtn.addEventListener("click", async () => {
        if (!res.downloadUrl) {
          if (res.htmlUrl) await native.openUrl(res.htmlUrl);
          return;
        }
        installBtn.setAttribute("disabled", "true");
        installBtn.textContent = `Downloading v${res.latestVersion}…`;
        toast(`Downloading Typo v${res.latestVersion} update package…`, "info", 3500);
        try {
          await native.installAppUpdate(res.downloadUrl, res.assetName || `Typo_${res.latestVersion}_x64-setup.exe`);
          toast(`Installing Typo v${res.latestVersion} — restarting momentarily…`, "success", 4000);
        } catch (e) {
          installBtn.removeAttribute("disabled");
          installBtn.textContent = `Download & Install v${res.latestVersion}`;
          toast(String(e), "error", 4000);
        }
      });

      statusHost.append(
        h(
          "div",
          {
            style:
              "display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);",
          },
          h(
            "div",
            {},
            h("strong", { style: "display: block; font-size: 13px;" }, `New Update Available: v${res.latestVersion} (${res.releaseName})`),
            res.releaseNotes
              ? h("span", { style: "font-size: 12px; opacity: 0.85;" }, res.releaseNotes.slice(0, 180))
              : null,
          ),
          installBtn,
        ),
      );
    } else {
      statusHost.append(
        h(
          "div",
          { style: "font-size: 12.5px; opacity: 0.85; display: flex; align-items: center; gap: 8px;" },
          icon("Check", 14),
          `You are running the latest version (v${res.currentVersion} · remote latest: v${res.latestVersion}).`,
        ),
      );
    }
  };
  renderUpdateStatus();

  checkUpdateBtn.addEventListener("click", async () => {
    const repo = repoInput.value.trim() || settings.updateRepo.trim();
    if (!repo) {
      toast("Enter your GitHub release repository first (e.g. username/typo-releases)", "info", 3200);
      repoInput.focus();
      return;
    }
    if (repo !== settings.updateRepo) {
      settings.updateRepo = repo;
      saveSettings();
    }
    updateCheckBusy = true;
    show("about");
    try {
      cachedUpdateCheck = await native.checkAppUpdate(repo);
      if (cachedUpdateCheck.updateAvailable) {
        toast(`Update available: Typo v${cachedUpdateCheck.latestVersion}!`, "success", 3500);
      } else {
        toast(`Typo v${cachedUpdateCheck.currentVersion} is up to date!`, "success", 2400);
      }
    } catch (e) {
      toast(String(e), "error", 4000);
    } finally {
      updateCheckBusy = false;
      show("about");
    }
  });

  const autoUpdateOn = settings.autoCheckUpdates !== false;
  const autoUpdateToggle = h(
    "button",
    {
      class: "switch" + (autoUpdateOn ? " is-on" : ""),
      type: "button",
      role: "switch",
      "aria-checked": String(autoUpdateOn),
      "aria-label": "Automatically check for updates on launch",
      "data-tip": "Automatically check for updates in the background when Typo starts",
    },
    h("span", { class: "switch__knob" }),
  );
  autoUpdateToggle.addEventListener("click", () => {
    settings.autoCheckUpdates = !autoUpdateOn;
    saveSettings();
    show("about");
    toast(
      settings.autoCheckUpdates
        ? "Startup update check enabled"
        : "Startup update check disabled",
      "info",
      2000,
    );
  });

  const updateCard = h(
    "div",
    { class: "pcard" },
    h("div", { class: "pcard__icon" }, icon("Download", 20)),
    h(
      "div",
      { class: "pcard__body" },
      h(
        "div",
        { class: "pcard__head" },
        h("strong", {}, "Software Updates & Friend Auto-Sync"),
        h("span", { class: "pcard__ver" }, "Installed: v1.0.1"),
        h(
          "span",
          { class: `pill pill--${settings.updateRepo ? "active" : "disabled"}` },
          settings.updateRepo ? `Channel: ${settings.updateRepo}` : "Local Standalone",
        ),
      ),
      h(
        "p",
        { class: "pcard__desc" },
        "Connect a GitHub Releases repository (e.g. username/typo-releases) so you and your friends get 1-click in-app updates whenever a new version is published.",
      ),
      h(
        "div",
        { style: "display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px;" },
        repoInput,
        saveRepoBtn,
        checkUpdateBtn,
      ),
      statusHost,
    ),
    autoUpdateToggle,
  );

  // --- 3. Hardware Acceleration Card ---
  const hwOn = settings.hardwareAcceleration !== false;
  const hwToggle = h(
    "button",
    {
      class: "switch" + (hwOn ? " is-on" : ""),
      type: "button",
      role: "switch",
      "aria-checked": String(hwOn),
      "aria-label": "Enable GPU Hardware Acceleration",
    },
    h("span", { class: "switch__knob" }),
  );
  hwToggle.addEventListener("click", () => {
    settings.hardwareAcceleration = !hwOn;
    saveSettings();
    document.documentElement.classList.toggle("is-gpu-accel", settings.hardwareAcceleration);
    show("about");
    toast(
      settings.hardwareAcceleration
        ? "GPU Hardware Acceleration enabled (Direct3D + Zero-Copy)"
        : "GPU Hardware Acceleration disabled (takes full effect on next launch)",
      "info",
      2600,
    );
  });

  const hwCard = h(
    "div",
    { class: "pcard" },
    h("div", { class: "pcard__icon" }, icon("Cpu", 20)),
    h(
      "div",
      { class: "pcard__body" },
      h(
        "div",
        { class: "pcard__head" },
        h("strong", {}, "GPU Hardware Acceleration"),
        h("span", { class: `pill pill--${hwOn ? "active" : "disabled"}` }, hwOn ? "Active (Direct3D 11/12)" : "Software Mode"),
      ),
      h(
        "p",
        { class: "pcard__desc" },
        "Uses your GPU for zero-copy page rasterization, DirectWrite subpixel font rendering, smooth high-refresh-rate scrolling, and Windows 11 Mica/Acrylic shaders.",
      ),
    ),
    hwToggle,
  );

  wrap.append(
    h("p", { class: "bs__lead" }, "Version 1.0.1 · Rust core (Tauri 2) · ProseMirror editing engine · native OpenXML .docx & PDF Studio Suite · Windows 11 COM Spellchecker."),
    h("h2", { class: "bs__subtitle" }, "Privacy & Software Updates"),
    h("div", { class: "plist" }, privacyCard, updateCard),
    h("h2", { class: "bs__subtitle" }, "Hardware & Rendering"),
    hwCard,
    h("h2", { class: "bs__subtitle" }, "Keyboard shortcuts"),
    h("div", { class: "keys" }, ...SHORTCUTS.map(([k, d]) => h("div", { class: "keys__row" }, h("kbd", {}, k), h("span", {}, d)))),
  );
  return wrap;
}

export function currentBackstagePage(): Page {
  return current;
}

