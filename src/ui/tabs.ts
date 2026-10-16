/** Built-in ribbon tabs: Home, Insert, Layout, View, Tools. */
import type { Editor } from "@tiptap/core";
import { Ribbon } from "./ribbon";
import {
  smartPaste,
  pasteTextContent,
  pasteImageContent,
  copySelectionOrImage,
  cutSelectionOrImage,
  hasSelectionOrImage,
} from "../core/clipboard";
import { h, icon, toast, promptDialog, popover, closePopover } from "./dom";
import { menu, fontPicker, sizePicker, stepSize, colorPalette, highlightPalette, tableGrid, type MenuItem } from "./pickers";
import { state, emit } from "../core/state";
import { PAGE_SIZES, MARGIN_PRESETS, type PageBorderStyle, type PageSizeName } from "../core/native";
import {
  settings,
  saveSettings,
  type CanvasViewMode,
  type PaperColorMode,
  type PaperTexture,
  type ProofUnderlineStyle,
} from "../core/settings";
import {
  setZoom,
  zoomToWidth,
  zoomToPage,
  addNewPage,
  scheduleLayout,
  editHeaderFooter,
  togglePageNumbers,
  toggleDifferentFirstPage,
  setPageColumns,
  setPageWatermark,
  setPageBorder,
  toggleHyphenation,
  toggleBaselineGrid,
  setCanvasViewMode,
  isScratchpadOpen,
  toggleScratchpad,
  openPreflightInspector,
  openSavedWidthsDialog,
  saveCurrentMarginPreset,
  renderRuler,
} from "../core/page";
import { openFind } from "./findbar";
import { openDictionary, openProofingPanel } from "./dictionary";
import { openStickerStudioModal } from "./stickers";
import { openPdfEditorModal } from "./pdf-editor";
import { exportEpubFile, exportPdfFile, convertPdfToWordFlow } from "../core/document";
import {
  isAutoSpellcheck,
  isManualScanActive,
  setAutoSpellcheck,
  runOneShotProofCheck,
  clearProofHighlights,
} from "../editor/proofing";
import { insertPictureFromDialog } from "./contextmenu";
import { toggleOutline, isOutlineOpen, toggleFocusMode, isFocusMode } from "./outline";
import type { ImageWrapMode } from "../editor/image-node";
import { BACKDROP_PRESETS, pickCustomBackgroundPhoto, pickCustomPaperTexture } from "../core/themes";

let lastTextColor: string | null = "#c00000";
let lastHighlight: string | null = "#ffff00";

function markDirtyPage() {
  emit("page:change");
  emit("document:change");
}

export function setPaperColorMode(mode: PaperColorMode, applyTheme: () => void, refresh?: () => void): void {
  settings.paperColor = mode;
  settings.paperPreview = mode === "white";
  if (mode === "parchment") {
    settings.paperTexture = "parchment";
  }
  saveSettings();
  applyTheme();
  refresh?.();
  emit("theme:change", settings.themeId);
}

export function paperColorMenu(applyTheme: () => void, refresh?: () => void): HTMLElement {
  const cur = settings.paperColor || (settings.paperPreview ? "white" : "auto");
  const curTex: PaperTexture = settings.paperTexture || "smooth";
  const hasCustomTex = Boolean(settings.customPaperTexturePath?.trim());
  const opts: { id: PaperColorMode; label: string; hint: string; icon: string }[] = [
    { id: "auto", label: "Match Theme (Dark Paper)", hint: "Default", icon: "Moon" },
    { id: "white", label: "Classic White Paper", hint: "#FFFFFF", icon: "Sun" },
    { id: "parchment", label: "Medieval Parchment", hint: "Vellum", icon: "Scroll" },
    { id: "sepia", label: "Warm Cream / Sepia", hint: "Eye care", icon: "BookOpen" },
    { id: "mist", label: "Soft Gray Mist", hint: "Low glare", icon: "Cloud" },
  ];
  const texOpts: { id: PaperTexture; label: string; hint: string }[] = [
    { id: "smooth", label: "Smooth Studio Finish", hint: "Clean" },
    { id: "parchment", label: "Medieval Parchment", hint: "Manuscript" },
    { id: "cotton", label: "Archival Cotton Rag", hint: "Fiber" },
    { id: "vintage", label: "Vintage Typewriter Bond", hint: "Aged" },
    { id: "linen", label: "Fine Linen Weave", hint: "Tactile" },
    { id: "grain", label: "Archival Paper Grain", hint: "Matte" },
    { id: "lined", label: "College Ruled Lines", hint: "Ruled" },
    { id: "dots", label: "Dot-Grid Notebook", hint: "Grid" },
    { id: "blueprint", label: "Architect Blueprint Grid", hint: "Drafting" },
  ];
  const topMenu = menu([
    { heading: "Paper Sheet Color (works in Dark Mode)" },
    ...opts.map((o) => ({
      label: o.label,
      hint: o.hint,
      icon: o.icon,
      checked: cur === o.id,
      onSelect: () => setPaperColorMode(o.id, applyTheme, refresh),
    })),
  ]);

  const customHex = /^#[0-9a-f]{6}$/i.test(settings.customPaperColor || "")
    ? settings.customPaperColor
    : "#18222d";
  const swatchDot = h("span", {
    class: "studio-accent__dot",
    style: { background: customHex, width: "13px", height: "13px" },
  });
  const hexHint = h("span", { class: "menu__hint" }, customHex.toUpperCase());
  const colorInput = h("input", {
    type: "color",
    class: "palette__custom-input",
    value: customHex,
  }) as HTMLInputElement;
  colorInput.addEventListener("input", () => {
    settings.customPaperColor = colorInput.value;
    settings.paperColor = "custom";
    settings.paperPreview = false;
    swatchDot.style.background = colorInput.value;
    hexHint.textContent = colorInput.value.toUpperCase();
    saveSettings();
    applyTheme();
    refresh?.();
    emit("theme:change", settings.themeId);
  });

  const customRow = h(
    "label",
    { class: "menu__item palette__custom" + (cur === "custom" ? " is-checked" : "") },
    h("span", { class: "menu__icon" }, cur === "custom" ? icon("Check", 15) : swatchDot),
    h("span", { class: "menu__label" }, "Custom Paper Color…"),
    hexHint,
    colorInput,
  );
  topMenu.append(customRow);

  const bottomMenu = menu([
    "sep",
    { heading: "Paper Surface Texture" },
    ...texOpts.map((t) => ({
      label: t.label,
      hint: t.hint,
      checked: curTex === t.id,
      onSelect: () => {
        settings.paperTexture = t.id;
        if (t.id === "parchment" && settings.paperColor === "auto") {
          settings.paperColor = "parchment";
        }
        saveSettings();
        applyTheme();
        refresh?.();
      },
    })),
    "sep",
    { heading: "Custom Paper Texture (From PC)" },
    {
      label: hasCustomTex ? "Change Custom Paper Texture from PC…" : "Upload Custom Paper Texture from PC…",
      icon: "ImagePlus",
      onSelect: async () => {
        const file = await pickCustomPaperTexture();
        if (!file) return;
        settings.customPaperTexturePath = file;
        settings.paperTexture = "custom";
        saveSettings();
        applyTheme();
        refresh?.();
        toast("Custom paper texture applied to sheet", "success", 2000);
      },
    },
    ...(hasCustomTex
      ? [
          {
            label: "Use Active Custom Paper Texture",
            icon: "Image",
            checked: curTex === "custom",
            onSelect: () => {
              settings.paperTexture = "custom";
              saveSettings();
              applyTheme();
              refresh?.();
            },
          },
          {
            label: "Clear Custom Paper Texture",
            icon: "Trash2",
            onSelect: () => {
              settings.customPaperTexturePath = "";
              if (settings.paperTexture === "custom") settings.paperTexture = "smooth";
              saveSettings();
              applyTheme();
              refresh?.();
              toast("Custom paper texture cleared", "info", 1600);
            },
          },
        ]
      : []),
  ]);
  while (bottomMenu.firstChild) {
    topMenu.append(bottomMenu.firstChild);
  }
  return topMenu;
}

export function proofingMenu(editor: Editor, refresh?: () => void): HTMLElement {
  const autoOn = isAutoSpellcheck();
  const hasHighlights = autoOn || isManualScanActive();
  const curStyle: ProofUnderlineStyle = settings.proofUnderlineStyle || "wavy";
  const setUnderline = (s: ProofUnderlineStyle) => {
    settings.proofUnderlineStyle = s;
    saveSettings();
    document.documentElement.dataset.proofStyle = s;
    refresh?.();
  };
  return menu([
    { heading: "Spell & Grammar Checker" },
    {
      label: "Check Now (Scan Document Once)",
      icon: "ScanSearch",
      hint: "F7",
      onSelect: () => {
        const found = runOneShotProofCheck(editor);
        refresh?.();
        toast(
          found.length === 0
            ? "Scan complete — 0 issues found!"
            : `Scanned document — ${found.length} ${found.length === 1 ? "issue" : "issues"} highlighted`,
          found.length === 0 ? "success" : "info",
          2400,
        );
      },
    },
    {
      label: "Open Spelling & Grammar Panel…",
      icon: "SpellCheck",
      onSelect: () => {
        openProofingPanel(editor);
        refresh?.();
      },
    },
    "sep",
    {
      label: "Auto Spell & Grammar Check (Live)",
      icon: "Check",
      hint: autoOn ? "ON" : "OFF",
      checked: autoOn,
      onSelect: () => {
        setAutoSpellcheck(editor, !autoOn);
        refresh?.();
      },
    },
    {
      label: "Clear Highlights / Turn Off",
      icon: "EyeOff",
      hint: hasHighlights ? "" : "Off",
      onSelect: () => {
        clearProofHighlights(editor);
        refresh?.();
      },
    },
    "sep",
    { heading: "Proofing Underline Style" },
    {
      label: "Classic Wavy Underline",
      checked: curStyle === "wavy",
      onSelect: () => setUnderline("wavy"),
    },
    {
      label: "Subtle Dotted Underline",
      checked: curStyle === "dotted",
      onSelect: () => setUnderline("dotted"),
    },
    {
      label: "Crisp Solid Underline",
      checked: curStyle === "solid",
      onSelect: () => setUnderline("solid"),
    },
  ]);
}

export function buildTabs(ribbon: Ribbon, editor: Editor, hooks: { applyTheme: () => void; openThemes: () => void }) {
  const chain = () => editor.chain().focus();

  // =========================================================================
  // HOME
  // =========================================================================
  const home = ribbon.addTab("home", "Home");

  // Clipboard ---------------------------------------------------------------
  const clip = home.addGroup("Clipboard");
  clip.large({
    icon: "ClipboardPaste", label: "Paste", shortcut: "Ctrl+V",
    onClick: () => void smartPaste(editor),
    dropdown: () => menu([
      { label: "Paste Text", icon: "ClipboardPaste", hint: "Ctrl+V", onSelect: () => void pasteTextContent(editor, false) },
      { label: "Paste Plain Text Only", icon: "Type", hint: "Ctrl+Shift+V", onSelect: () => void pasteTextContent(editor, true) },
      "sep",
      { label: "Paste Picture", icon: "Image", hint: "Ctrl+Alt+V", onSelect: () => void pasteImageContent(editor) },
    ]),
  });
  const [c1, c2] = clip.stack(2);
  clip.small(c1, {
    icon: "Scissors", label: "Cut", shortcut: "Ctrl+X", showLabel: true,
    onClick: () => void cutSelectionOrImage(editor),
    isEnabled: () => hasSelectionOrImage(editor),
  });
  clip.small(c2, {
    icon: "Copy", label: "Copy", shortcut: "Ctrl+C", showLabel: true,
    onClick: () => void copySelectionOrImage(editor),
    isEnabled: () => hasSelectionOrImage(editor),
  });

  // Font ----------------------------------------------------------------------
  const font = home.addGroup("Font");
  const [f1, f2] = font.stack(2);
  const fp = fontPicker(editor);
  font.custom(fp.el, fp.update, f1);
  const sp = sizePicker(editor);
  font.custom(sp.el, sp.update, f1);
  font.small(f1, { icon: "AArrowUp", label: "Grow font", shortcut: "Ctrl+]", onClick: () => stepSize(editor, 1) });
  font.small(f1, { icon: "AArrowDown", label: "Shrink font", shortcut: "Ctrl+[", onClick: () => stepSize(editor, -1) });
  font.small(f1, { icon: "RemoveFormatting", label: "Clear formatting", shortcut: "Ctrl+Space", onClick: () => chain().unsetAllMarks().setParagraph().setStyleName(null).run() });

  font.small(f2, { icon: "Bold", label: "Bold", shortcut: "Ctrl+B", onClick: () => chain().toggleBold().run(), isActive: () => editor.isActive("bold") });
  font.small(f2, { icon: "Italic", label: "Italic", shortcut: "Ctrl+I", onClick: () => chain().toggleItalic().run(), isActive: () => editor.isActive("italic") });
  font.small(f2, { icon: "Underline", label: "Underline", shortcut: "Ctrl+U", onClick: () => chain().toggleUnderline().run(), isActive: () => editor.isActive("underline") });
  font.small(f2, { icon: "Strikethrough", label: "Strikethrough", shortcut: "Ctrl+Shift+X", onClick: () => chain().toggleStrike().run(), isActive: () => editor.isActive("strike") });
  font.small(f2, { icon: "Subscript", label: "Subscript", shortcut: "Ctrl+=", onClick: () => chain().toggleSubscript().run(), isActive: () => editor.isActive("subscript") });
  font.small(f2, { icon: "Superscript", label: "Superscript", shortcut: "Ctrl+Shift+=", onClick: () => chain().toggleSuperscript().run(), isActive: () => editor.isActive("superscript") });
  font.separator(f2);
  font.small(f2, {
    icon: "Highlighter", label: "Highlight", tip: "Text highlight colour",
    swatch: () => lastHighlight,
    onClick: () => (lastHighlight ? chain().toggleHighlight({ color: lastHighlight }).run() : chain().unsetHighlight().run()),
    dropdown: () => highlightPalette((c) => {
      lastHighlight = c;
      if (c) chain().setHighlight({ color: c }).run();
      else chain().unsetHighlight().run();
      ribbon.refresh();
    }),
  });
  font.small(f2, {
    icon: "Baseline", label: "Font colour",
    swatch: () => lastTextColor,
    onClick: () => (lastTextColor ? chain().setColor(lastTextColor).run() : chain().unsetColor().run()),
    dropdown: () => colorPalette({
      automaticLabel: "Automatic",
      current: editor.getAttributes("textStyle").color ?? null,
      onPick: (c) => {
        lastTextColor = c;
        if (c) chain().setColor(c).run();
        else chain().unsetColor().run();
        ribbon.refresh();
      },
    }),
  });

  // Paragraph -----------------------------------------------------------------
  const para = home.addGroup("Paragraph");
  const [p1, p2] = para.stack(2);
  para.small(p1, { icon: "List", label: "Bullets", onClick: () => chain().toggleBulletList().run(), isActive: () => editor.isActive("bulletList") });
  para.small(p1, {
    icon: "ListOrdered", label: "Numbering", onClick: () => chain().toggleOrderedList().run(), isActive: () => editor.isActive("orderedList"),
    dropdown: () => {
      const set = (type: string | null) => {
        if (!editor.isActive("orderedList")) chain().toggleOrderedList().run();
        chain().updateAttributes("orderedList", { type }).run();
      };
      return menu([
        { heading: "Numbering format" },
        { label: "1. 2. 3.", onSelect: () => set(null) },
        { label: "a. b. c.", onSelect: () => set("a") },
        { label: "A. B. C.", onSelect: () => set("A") },
        { label: "i. ii. iii.", onSelect: () => set("i") },
        { label: "I. II. III.", onSelect: () => set("I") },
        "sep",
        { label: "Set start value…", icon: "ListOrdered", onSelect: async () => {
          const r = await promptDialog("Start numbering at", [{ name: "start", label: "Start value", value: String(editor.getAttributes("orderedList").start ?? 1), type: "number" }]);
          const n = parseInt(r?.start ?? "", 10);
          if (Number.isFinite(n)) chain().updateAttributes("orderedList", { start: n }).run();
        } },
      ]);
    },
  });
  para.small(p1, { icon: "ListChecks", label: "Checklist", onClick: () => chain().toggleTaskList().run(), isActive: () => editor.isActive("taskList") });
  para.separator(p1);
  const inList = () => editor.isActive("listItem") || editor.isActive("taskItem");
  const listType = () => (editor.isActive("taskItem") ? "taskItem" : "listItem");
  para.small(p1, { icon: "IndentDecrease", label: "Decrease indent", shortcut: "Ctrl+Shift+M", onClick: () => (inList() ? chain().liftListItem(listType()).run() : chain().changeIndent(-1).run()) });
  para.small(p1, { icon: "IndentIncrease", label: "Increase indent", shortcut: "Ctrl+M", onClick: () => (inList() ? chain().sinkListItem(listType()).run() : chain().changeIndent(1).run()) });

  const align = (a: "left" | "center" | "right" | "justify") => () => chain().smartAlign(a).run();
  const isAlign = (a: string) => () => editor.isActive({ textAlign: a }) || (a === "left" && !["center", "right", "justify"].some((x) => editor.isActive({ textAlign: x })));
  para.small(p2, { icon: "TextAlignStart", label: "Align left", shortcut: "Ctrl+L", onClick: align("left"), isActive: isAlign("left") });
  para.small(p2, { icon: "TextAlignCenter", label: "Center", shortcut: "Ctrl+E", onClick: align("center"), isActive: isAlign("center") });
  para.small(p2, { icon: "TextAlignEnd", label: "Align right", shortcut: "Ctrl+R", onClick: align("right"), isActive: isAlign("right") });
  para.small(p2, { icon: "TextAlignJustify", label: "Justify", shortcut: "Ctrl+J", onClick: align("justify"), isActive: isAlign("justify") });
  para.separator(p2);
  para.small(p2, {
    icon: "UnfoldVertical", label: "Line spacing",
    dropdown: () => {
      const cur = editor.getAttributes(editor.isActive("heading") ? "heading" : "paragraph").lineHeight ?? null;
      const opts: MenuItem[] = ["1.0", "1.15", "1.5", "2.0", "2.5", "3.0"].map((v) => ({
        label: v, checked: cur === v || (cur === null && v === "1.15"), onSelect: () => chain().setBlockLineHeight(v === "1.15" ? null : v).run(),
      }));
      return menu([{ heading: "Line spacing" }, ...opts]);
    },
  });
  para.small(p2, { icon: "TextQuote", label: "Quote", onClick: () => chain().toggleBlockquote().run(), isActive: () => editor.isActive("blockquote") });
  para.small(p2, { icon: "SquareCode", label: "Code block", onClick: () => chain().toggleCodeBlock().run(), isActive: () => editor.isActive("codeBlock") });

  // Styles gallery -------------------------------------------------------------
  const styles = home.addGroup("Styles");
  styles.el.classList.add("rgroup--styles");
  const gallery = h("div", { class: "styles" });
  type StyleDef = { id: string; label: string; apply: () => void; active: () => boolean; cls: string };
  const styleDefs: StyleDef[] = [
    { id: "normal", label: "Normal", cls: "sty--normal", apply: () => chain().setParagraph().setStyleName(null).run(), active: () => editor.isActive("paragraph") && !editor.getAttributes("paragraph").styleName },
    { id: "title", label: "Title", cls: "sty--title", apply: () => chain().setStyleName("Title").run(), active: () => editor.isActive("paragraph", { styleName: "Title" }) },
    { id: "subtitle", label: "Subtitle", cls: "sty--subtitle", apply: () => chain().setStyleName("Subtitle").run(), active: () => editor.isActive("paragraph", { styleName: "Subtitle" }) },
    ...[1, 2, 3].map((lvl) => ({
      id: `h${lvl}`, label: `Heading ${lvl}`, cls: `sty--h${lvl}`,
      apply: () => chain().setHeading({ level: lvl as 1 | 2 | 3 }).run(),
      active: () => editor.isActive("heading", { level: lvl }),
    })),
    { id: "quote", label: "Quote", cls: "sty--quote", apply: () => chain().setParagraph().toggleBlockquote().run(), active: () => editor.isActive("blockquote") },
  ];
  const tiles = styleDefs.map((s) => {
    const t = h("button", { class: `sty ${s.cls}`, type: "button", "data-tip": `Style: ${s.label}` }, h("span", { class: "sty__sample" }, "AaBbCc"), h("span", { class: "sty__name" }, s.label));
    t.addEventListener("mousedown", (e) => e.preventDefault());
    t.addEventListener("click", s.apply);
    gallery.append(t);
    return { t, s };
  });
  styles.custom(gallery, () => tiles.forEach(({ t, s }) => t.classList.toggle("is-on", s.active())));

  // Pages & Paper --------------------------------------------------------------
  const quickPage = home.addGroup("Page");
  quickPage.large({
    icon: "FilePlus2",
    label: "Add Page",
    shortcut: "Ctrl+Enter",
    tip: "Insert a new page",
    onClick: () => addNewPage(false),
    dropdown: () => menu([
      { label: "Add Page at Cursor", icon: "SeparatorHorizontal", hint: "Ctrl+Enter", onSelect: () => addNewPage(false) },
      { label: "Add Blank Page at End", icon: "FilePlus2", onSelect: () => addNewPage(true) },
    ]),
  });
  quickPage.large({
    icon: "FileText",
    label: "Paper Color",
    tip: "Choose Paper Sheet Color (Dark, White, Parchment, Sepia, Mist, Custom) & Custom Paper Texture",
    isActive: () => settings.paperColor === "white" || settings.paperPreview || (settings.paperTexture && settings.paperTexture !== "smooth"),
    dropdown: () => paperColorMenu(hooks.applyTheme, () => ribbon.refresh()),
  });

  // Editing (Find & Replace) ----------------------------------------------------
  const editing = home.addGroup("Editing");
  const [e1, e2] = editing.stack(2);
  editing.small(e1, { icon: "Search", label: "Find", shortcut: "Ctrl+F", showLabel: true, onClick: () => openFind(false) });
  editing.small(e2, { icon: "Replace", label: "Replace", shortcut: "Ctrl+H", showLabel: true, onClick: () => openFind(true) });

  // =========================================================================
  // INSERT
  // =========================================================================
  const insert = ribbon.addTab("insert", "Insert");
  const pages = insert.addGroup("Pages");
  pages.large({
    icon: "FilePlus2",
    label: "Add Page",
    tip: "Add a new blank page",
    onClick: () => addNewPage(true),
  });
  pages.large({ icon: "SeparatorHorizontal", label: "Page Break", shortcut: "Ctrl+Enter", onClick: () => addNewPage(false) });

  const hfGroup = insert.addGroup("Header & Footer");
  hfGroup.large({
    icon: "PanelTop",
    label: "Header & Footer",
    tip: "Edit document header and footer text",
    dropdown: () => menu([
      { label: "Edit Header…", icon: "PanelTop", onSelect: () => void editHeaderFooter("header") },
      { label: "Edit Footer…", icon: "PanelBottom", onSelect: () => void editHeaderFooter("footer") },
      { label: "Edit Both Header & Footer…", icon: "FileText", onSelect: () => void editHeaderFooter("both") },
      "sep",
      {
        label: "Clear Header & Footer",
        icon: "Trash2",
        onSelect: () => {
          state.page.header = "";
          state.page.footer = "";
          markDirtyPage();
        },
      },
    ]),
  });
  hfGroup.large({
    icon: "Hash",
    label: "Page Numbers",
    tip: "Toggle Page 1 of N numbering in the page footer",
    isActive: () => Boolean(state.page.pageNumbers),
    onClick: () => {
      togglePageNumbers();
      ribbon.refresh();
    },
  });

  const tables = insert.addGroup("Tables");
  tables.large({
    icon: "Table", label: "Table",
    dropdown: () => tableGrid((rows, cols) => chain().insertTable({ rows, cols, withHeaderRow: false }).run()),
  });

  const illus = insert.addGroup("Illustrations & Stickers");
  illus.large({
    icon: "Image", label: "Picture",
    tip: "Insert a picture (drag anywhere in Free-Roam or snap to text wrap)",
    onClick: () => void insertPictureFromDialog(editor),
  });
  illus.large({
    icon: "Sticker",
    label: "Stickers",
    tip: "Open Sticker Studio — insert cute built-in stickers or import your own sticker packs",
    onClick: () => openStickerStudioModal(editor),
  });
  illus.large({
    icon: "Move",
    label: "Text Wrap",
    tip: "Choose Free-Roam Drag Anywhere (In Front / Behind Text) or InDesign-style paragraph wrap",
    isEnabled: () => editor.isActive("image"),
    dropdown: () => {
      const cur: ImageWrapMode = editor.getAttributes("image").wrap || "wrap-left";
      const set = (w: ImageWrapMode) => {
        editor.chain().focus().setImageWrap(w).run();
        scheduleLayout();
      };
      return menu([
        { heading: "Free-Roam (Drag Anywhere on Page)" },
        { label: "Free-Roam: In Front of Text", icon: "Move", checked: cur === "free-front", onSelect: () => set("free-front") },
        { label: "Free-Roam: Behind Text", icon: "Layers", checked: cur === "free-behind", onSelect: () => set("free-behind") },
        "sep",
        { heading: "Paragraph Text Wrapping" },
        { label: "Wrap Left (Text flows right)", icon: "AlignLeft", checked: cur === "wrap-left", onSelect: () => set("wrap-left") },
        { label: "Wrap Right (Text flows left)", icon: "AlignRight", checked: cur === "wrap-right", onSelect: () => set("wrap-right") },
        { label: "Center (Break text top/bottom)", icon: "AlignCenter", checked: cur === "center", onSelect: () => set("center") },
        { label: "Inline with Text", icon: "Baseline", checked: cur === "inline", onSelect: () => set("inline") },
        "sep",
        { label: "Delete Picture / Sticker", icon: "Trash2", hint: "Del", onSelect: () => { editor.chain().focus().deleteSelection().run(); scheduleLayout(); } },
      ]);
    },
  });

  const refs = insert.addGroup("References");
  refs.large({
    icon: "BookMarked",
    label: "Contents",
    tip: "Generate and insert an automatic Table of Contents from Heading 1–3 styles",
    onClick: () => insertTableOfContents(editor),
  });
  refs.large({
    icon: "Superscript",
    label: "Footnote",
    tip: "Insert a numbered superscript footnote reference and entry at the end of the document",
    onClick: () => void insertFootnote(editor),
  });

  const links = insert.addGroup("Links & Code");
  links.large({
    icon: "Link", label: "Link", shortcut: "Ctrl+K",
    onClick: () => insertLink(editor),
  });
  links.large({
    icon: "Code2",
    label: "Code Block",
    tip: "Insert a monospaced code block or language template",
    isActive: () => editor.isActive("codeBlock"),
    dropdown: () =>
      menu([
        { heading: "Insert Code Block" },
        { label: "Toggle Empty Code Block", icon: "Code2", onSelect: () => chain().toggleCodeBlock().run() },
        "sep",
        {
          label: "Python Snippet",
          onSelect: () =>
            chain()
              .insertContent(`<pre><code># Python\ndef main() -> None:\n    print("Hello from Typo")\n</code></pre>`)
              .run(),
        },
        {
          label: "TypeScript / JS Snippet",
          onSelect: () =>
            chain()
              .insertContent(`<pre><code>// TypeScript\nexport function compute(x: number): number {\n  return x * 2;\n}\n</code></pre>`)
              .run(),
        },
        {
          label: "Rust Snippet",
          onSelect: () =>
            chain()
              .insertContent(`<pre><code>// Rust\nfn main() {\n    println!("Hello from Typo");\n}\n</code></pre>`)
              .run(),
        },
        {
          label: "SQL Query Block",
          onSelect: () =>
            chain()
              .insertContent(`<pre><code>-- SQL Query\nSELECT id, title, created_at\nFROM documents\nORDER BY created_at DESC;\n</code></pre>`)
              .run(),
        },
      ]),
  });

  const text = insert.addGroup("Text");
  const [t1, t2] = text.stack(2);
  text.small(t1, { icon: "Minus", label: "Horizontal line", showLabel: true, onClick: () => chain().setHorizontalRule().run() });
  text.small(t2, {
    icon: "CalendarClock", label: "Date & time", showLabel: true,
    dropdown: () => {
      const now = new Date();
      const fmts = [
        now.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }),
        now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        now.toLocaleDateString(),
        now.toISOString().slice(0, 10),
        now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
        now.toLocaleString(),
      ];
      return menu(fmts.map((f) => ({ label: f, onSelect: () => chain().insertContent(f).run() })));
    },
  });
  const symbols = insert.addGroup("Symbols & Math");
  symbols.large({
    icon: "Sigma",
    label: "Equation",
    tip: "Insert a mathematical equation or LaTeX formula",
    dropdown: () =>
      menu([
        { heading: "Mathematical Equations" },
        {
          label: "Custom Equation (LaTeX / Math)…",
          icon: "Sigma",
          onSelect: () => void insertCustomEquation(editor),
        },
        "sep",
        ...EQUATION_PRESETS.map((eq) => ({
          label: eq.name,
          hint: eq.formula,
          onSelect: () => insertEquationBlock(editor, eq.formula),
        })),
      ]),
  });
  symbols.large({
    icon: "Omega", label: "Symbol",
    dropdown: () => {
      const chars = "©®™§¶†‡•…–—‘’“”«»€£¥¢°±×÷≈≠≤≥∞√∑πΩµ←→↑↓⇒⇔✓✗★☆♥♦♣♠";
      const grid = h("div", { class: "symgrid" });
      for (const ch of chars) {
        const b = h("button", { class: "symgrid__cell", type: "button", "data-tip": `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` }, ch);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => chain().insertContent(ch).run());
        grid.append(b);
      }
      return grid;
    },
  });

  // Table tools (contextual: enabled only inside a table) -------------------------
  const tbl = insert.addGroup("Table tools");
  const inTable = () => editor.isActive("table");
  const [tt1, tt2] = tbl.stack(2);
  tbl.small(tt1, { icon: "BetweenHorizontalStart", label: "Row above", onClick: () => chain().addRowBefore().run(), isEnabled: inTable });
  tbl.small(tt1, { icon: "BetweenHorizontalEnd", label: "Row below", onClick: () => chain().addRowAfter().run(), isEnabled: inTable });
  tbl.small(tt1, { icon: "BetweenVerticalStart", label: "Column left", onClick: () => chain().addColumnBefore().run(), isEnabled: inTable });
  tbl.small(tt1, { icon: "BetweenVerticalEnd", label: "Column right", onClick: () => chain().addColumnAfter().run(), isEnabled: inTable });
  tbl.small(tt2, { icon: "TableCellsMerge", label: "Merge cells", onClick: () => chain().mergeCells().run(), isEnabled: () => editor.can().mergeCells() });
  tbl.small(tt2, { icon: "TableCellsSplit", label: "Split cell", onClick: () => chain().splitCell().run(), isEnabled: () => editor.can().splitCell() });
  tbl.small(tt2, { icon: "Rows3", label: "Toggle header row", onClick: () => chain().toggleHeaderRow().run(), isEnabled: inTable });
  tbl.small(tt2, {
    icon: "PaintBucket", label: "Cell shading", isEnabled: inTable,
    dropdown: () => colorPalette({ automaticLabel: "No colour", onPick: (c) => chain().setCellAttribute("backgroundColor", c).run() }),
  });
  tbl.small(tt2, {
    icon: "Trash2", label: "Delete", isEnabled: inTable,
    dropdown: () => menu([
      { label: "Delete row", onSelect: () => chain().deleteRow().run() },
      { label: "Delete column", onSelect: () => chain().deleteColumn().run() },
      { label: "Delete table", onSelect: () => chain().deleteTable().run() },
    ]),
  });

  // =========================================================================
  // LAYOUT
  // =========================================================================
  const layout = ribbon.addTab("layout", "Layout");
  const setup = layout.addGroup("Page Setup");
  setup.large({
    icon: "Ruler",
    label: "Margins",
    tip: "Page margin presets, saved ruler widths, and symmetric ruler lock",
    dropdown: () =>
      menu([
        { heading: "Standard Margin Presets" },
        ...Object.entries(MARGIN_PRESETS).map(([name, m]) => ({
          label: name,
          hint: `${m.top}″ · ${m.left}″`,
          checked: JSON.stringify(m) === JSON.stringify(state.page.margins),
          onSelect: () => {
            state.page.margins = { ...m };
            markDirtyPage();
          },
        })),
        ...((settings.savedMarginPresets ?? []).length > 0
          ? [
              "sep" as const,
              { heading: "Saved Ruler Widths" },
              ...(settings.savedMarginPresets ?? []).map((sp) => ({
                label: sp.name,
                hint: `L ${sp.left.toFixed(2)}″ · R ${sp.right.toFixed(2)}″`,
                checked:
                  Math.abs(state.page.margins.left - sp.left) < 0.02 &&
                  Math.abs(state.page.margins.right - sp.right) < 0.02,
                onSelect: () => {
                  state.page.margins = {
                    top: sp.top,
                    bottom: sp.bottom,
                    left: sp.left,
                    right: sp.right,
                  };
                  markDirtyPage();
                },
              })),
            ]
          : []),
        "sep",
        {
          label: "Save Current Width as Preset…",
          icon: "BookmarkCheck",
          onSelect: () => void saveCurrentMarginPreset(),
        },
        {
          label: "Manage Saved Ruler Widths…",
          icon: "Bookmark",
          onSelect: () => openSavedWidthsDialog(),
        },
        {
          label: "Symmetric (Even) Ruler Dragging",
          hint: settings.rulerSymmetric !== false ? "ON" : "OFF",
          checked: settings.rulerSymmetric !== false,
          onSelect: () => {
            settings.rulerSymmetric = settings.rulerSymmetric === false;
            saveSettings();
            renderRuler();
          },
        },
        "sep",
        {
          label: "Custom margins…",
          icon: "Settings",
          onSelect: async () => {
            const m = state.page.margins;
            const r = await promptDialog(
              "Custom margins (inches)",
              [
                { name: "top", label: "Top", value: String(m.top), type: "number" },
                { name: "bottom", label: "Bottom", value: String(m.bottom), type: "number" },
                { name: "left", label: "Left", value: String(m.left), type: "number" },
                { name: "right", label: "Right", value: String(m.right), type: "number" },
              ],
              "Apply",
            );
            if (!r) return;
            const n = (s: string, d: number) => {
              const v = parseFloat(s);
              return Number.isFinite(v) && v >= 0 && v < 5 ? v : d;
            };
            state.page.margins = {
              top: n(r.top, m.top),
              bottom: n(r.bottom, m.bottom),
              left: n(r.left, m.left),
              right: n(r.right, m.right),
            };
            markDirtyPage();
          },
        },
      ]),
  });
  setup.large({
    icon: "RectangleVertical",
    label: "Orientation",
    tip: "Switch between Portrait and Landscape page orientation",
    dropdown: () =>
      menu([
        {
          label: "Portrait",
          icon: "RectangleVertical",
          checked: state.page.orientation === "portrait",
          onSelect: () => {
            state.page.orientation = "portrait";
            markDirtyPage();
          },
        },
        {
          label: "Landscape",
          icon: "RectangleHorizontal",
          checked: state.page.orientation === "landscape",
          onSelect: () => {
            state.page.orientation = "landscape";
            markDirtyPage();
          },
        },
      ]),
  });
  setup.large({
    icon: "FileText",
    label: "Size",
    tip: "Select paper sheet dimensions (A4, Letter, Legal, A5, Executive)",
    dropdown: () =>
      menu(
        (Object.keys(PAGE_SIZES) as PageSizeName[]).map((k) => ({
          label: PAGE_SIZES[k].label,
          checked: state.page.size === k,
          onSelect: () => {
            state.page.size = k;
            markDirtyPage();
          },
        })),
      ),
  });
  setup.large({
    icon: "Columns2",
    label: "Columns",
    tip: "Split document text into multi-column newspaper or academic layout (opt-in)",
    isActive: () => (state.page.columns ?? 1) > 1,
    dropdown: () => {
      const curCols = state.page.columns ?? 1;
      const hasRule = Boolean(state.page.columnRule);
      return menu([
        { heading: "Page Column Flow" },
        {
          label: "1 Column (Standard)",
          hint: "Default",
          icon: "FileText",
          checked: curCols === 1,
          onSelect: () => setPageColumns(1),
        },
        {
          label: "2 Columns (Editorial / Academic)",
          hint: "Split",
          icon: "Columns2",
          checked: curCols === 2,
          onSelect: () => setPageColumns(2),
        },
        {
          label: "3 Columns (Publication / Zine)",
          hint: "Tri-fold",
          icon: "Columns3",
          checked: curCols === 3,
          onSelect: () => setPageColumns(3),
        },
        "sep",
        {
          label: "Vertical Divider Line Between Columns",
          checked: hasRule,
          onSelect: () => setPageColumns(curCols > 1 ? curCols : 2, !hasRule),
        },
      ]);
    },
  });
  setup.large({
    icon: "SeparatorHorizontal",
    label: "Breaks",
    tip: "Insert a page break, section divider, or cover page",
    dropdown: () =>
      menu([
        { heading: "Page & Section Breaks" },
        {
          label: "Insert Page Break",
          hint: "Ctrl+Enter",
          icon: "SeparatorHorizontal",
          onSelect: () => addNewPage(false),
        },
        {
          label: "Add New Blank Page at End",
          icon: "FilePlus2",
          onSelect: () => addNewPage(true),
        },
        {
          label: "Insert Section Divider Rule",
          icon: "Minus",
          onSelect: () => chain().setHorizontalRule().run(),
        },
        "sep",
        { heading: "1-Click Designer Cover Pages (Inserts at Top)" },
        {
          label: "Minimalist Spec Cover",
          hint: "Clean frame",
          icon: "FileBadge",
          onSelect: () => insertCoverPage(editor, "spec"),
        },
        {
          label: "Research Whitepaper Cover",
          hint: "Academic",
          icon: "BookOpen",
          onSelect: () => insertCoverPage(editor, "whitepaper"),
        },
        {
          label: "Classic Manuscript Title Page",
          hint: "Literary",
          icon: "Feather",
          onSelect: () => insertCoverPage(editor, "manuscript"),
        },
        {
          label: "Editorial Magazine Pitch",
          hint: "Bold display",
          icon: "Sparkles",
          onSelect: () => insertCoverPage(editor, "editorial"),
        },
      ]),
  });

  // --- Group 2: Paragraph Spacing, Indentation & Editorial Typography -------
  const paraLayout = layout.addGroup("Paragraph & Typography");
  const [pl1, pl2] = paraLayout.stack(2);
  paraLayout.small(pl1, {
    icon: "ArrowUpFromLine",
    label: "Space Before",
    showLabel: true,
    tip: "Set vertical spacing above the selected paragraph(s)",
    dropdown: () => {
      const cur =
        (editor.getAttributes("paragraph").spaceBefore as string | null) ??
        (editor.getAttributes("heading").spaceBefore as string | null) ??
        null;
      const opts: [string, string | null][] = [
        ["0 pt (Default)", null],
        ["4 pt", "4pt"],
        ["6 pt", "6pt"],
        ["12 pt", "12pt"],
        ["18 pt", "18pt"],
        ["24 pt", "24pt"],
      ];
      return menu([
        { heading: "Spacing Before Paragraph" },
        ...opts.map(([lbl, val]) => ({
          label: lbl,
          checked: cur === val,
          onSelect: () => {
            chain().setSpaceBefore(val).run();
            scheduleLayout();
          },
        })),
      ]);
    },
  });
  paraLayout.small(pl1, {
    icon: "ArrowDownToLine",
    label: "Space After",
    showLabel: true,
    tip: "Set vertical spacing below the selected paragraph(s)",
    dropdown: () => {
      const cur =
        (editor.getAttributes("paragraph").spaceAfter as string | null) ??
        (editor.getAttributes("heading").spaceAfter as string | null) ??
        null;
      const opts: [string, string | null][] = [
        ["8 pt (Default)", null],
        ["0 pt (Tight)", "0pt"],
        ["4 pt", "4pt"],
        ["6 pt", "6pt"],
        ["12 pt", "12pt"],
        ["18 pt", "18pt"],
        ["24 pt", "24pt"],
      ];
      return menu([
        { heading: "Spacing After Paragraph" },
        ...opts.map(([lbl, val]) => ({
          label: lbl,
          checked: cur === val,
          onSelect: () => {
            chain().setSpaceAfter(val).run();
            scheduleLayout();
          },
        })),
      ]);
    },
  });
  paraLayout.small(pl1, {
    icon: "CaseSensitive",
    label: "Drop Cap",
    showLabel: true,
    tip: "Toggle an editorial 3-line Drop Cap on the current paragraph",
    isActive: () => Boolean(editor.getAttributes("paragraph").dropCap),
    dropdown: () => {
      const cur = (editor.getAttributes("paragraph").dropCap as "dropped" | "margin" | null) ?? null;
      return menu([
        { heading: "Editorial Drop Cap" },
        {
          label: "None (Standard Paragraph)",
          checked: !cur,
          onSelect: () => {
            chain().setDropCap(null).run();
            scheduleLayout();
          },
        },
        {
          label: "Dropped Initial (3-Line Editorial)",
          checked: cur === "dropped",
          onSelect: () => {
            chain().setDropCap("dropped").run();
            scheduleLayout();
          },
        },
        {
          label: "In-Margin Hanging Initial",
          checked: cur === "margin",
          onSelect: () => {
            chain().setDropCap("margin").run();
            scheduleLayout();
          },
        },
      ]);
    },
  });

  paraLayout.small(pl2, {
    icon: "IndentDecrease",
    label: "Outdent",
    showLabel: true,
    shortcut: "Ctrl+Shift+M",
    onClick: () => chain().changeIndent(-1).run(),
  });
  paraLayout.small(pl2, {
    icon: "IndentIncrease",
    label: "Indent",
    showLabel: true,
    shortcut: "Ctrl+M",
    onClick: () => chain().changeIndent(1).run(),
  });
  paraLayout.small(pl2, {
    icon: "SpellCheck2",
    label: "Hyphenate",
    showLabel: true,
    tip: "Toggle smart automatic syllable hyphenation for cleaner justified paragraphs",
    isActive: () => Boolean(state.page.hyphenation),
    onClick: () => {
      toggleHyphenation();
      ribbon.refresh();
    },
  });

  // --- Group 3: Header, Footer, Watermark & Framing -------------------------
  const hfStamp = layout.addGroup("Header, Footer & Frame");
  hfStamp.large({
    icon: "PanelTop",
    label: "Header & Footer",
    tip: "Edit running page headers, footers, and cover page suppression",
    isActive: () => Boolean(state.page.header?.trim() || state.page.footer?.trim()),
    dropdown: () =>
      menu([
        { heading: "Running Header & Footer" },
        { label: "Edit Header & Footer…", icon: "PanelTop", onSelect: () => void editHeaderFooter("both") },
        { label: "Edit Header Only…", onSelect: () => void editHeaderFooter("header") },
        { label: "Edit Footer Only…", onSelect: () => void editHeaderFooter("footer") },
        "sep",
        {
          label: "Different First Page (Hide on Page 1)",
          checked: Boolean(state.page.differentFirstPage),
          onSelect: () => {
            toggleDifferentFirstPage();
            ribbon.refresh();
          },
        },
        "sep",
        {
          label: "Clear Header & Footer",
          icon: "Trash2",
          onSelect: () => {
            state.page.header = "";
            state.page.footer = "";
            markDirtyPage();
            ribbon.refresh();
          },
        },
      ]),
  });
  hfStamp.large({
    icon: "Hash",
    label: "Page Numbers",
    tip: "Toggle running page numbers and Page 1 cover suppression",
    isActive: () => Boolean(state.page.pageNumbers),
    onClick: () => {
      togglePageNumbers();
      ribbon.refresh();
    },
    dropdown: () =>
      menu([
        {
          label: "Show Page Numbers (Page X of Y)",
          checked: Boolean(state.page.pageNumbers),
          onSelect: () => {
            togglePageNumbers();
            ribbon.refresh();
          },
        },
        {
          label: "Different First Page (Hide on Page 1)",
          checked: Boolean(state.page.differentFirstPage),
          onSelect: () => {
            toggleDifferentFirstPage();
            ribbon.refresh();
          },
        },
      ]),
  });
  hfStamp.large({
    icon: "Stamp",
    label: "Watermark",
    tip: "Add a faint diagonal watermark stamp across pages (opt-in)",
    isActive: () => Boolean(state.page.watermark?.trim()),
    dropdown: () => {
      const curWm = (state.page.watermark ?? "").trim();
      const presets = ["CONFIDENTIAL", "DRAFT", "DO NOT COPY", "SAMPLE", "INTERNAL"];
      return menu([
        { heading: "Page Watermark Stamp" },
        {
          label: "None (Clean Page)",
          checked: !curWm,
          onSelect: () => {
            setPageWatermark("");
            ribbon.refresh();
          },
        },
        "sep",
        ...presets.map((p) => ({
          label: p,
          checked: curWm.toUpperCase() === p,
          onSelect: () => {
            setPageWatermark(p);
            ribbon.refresh();
          },
        })),
        "sep",
        {
          label: "Custom Watermark Text…",
          icon: "Edit3",
          onSelect: async () => {
            const r = await promptDialog(
              "Custom Page Watermark",
              [{ name: "wm", label: "Watermark stamp text", value: curWm || "DRAFT", placeholder: "e.g. EMBARGOED" }],
              "Apply",
            );
            if (!r) return;
            setPageWatermark(r.wm);
            ribbon.refresh();
          },
        },
      ]);
    },
  });
  hfStamp.large({
    icon: "Frame",
    label: "Page Border",
    tip: "Add an editorial or archival frame around the page margins (opt-in)",
    isActive: () => Boolean(state.page.pageBorder && state.page.pageBorder !== "none"),
    dropdown: () => {
      const curB: PageBorderStyle = state.page.pageBorder ?? "none";
      const opts: { id: PageBorderStyle; label: string; hint: string }[] = [
        { id: "none", label: "None (Borderless Sheet)", hint: "Default" },
        { id: "thin", label: "Thin Editorial Hairline", hint: "1px rule" },
        { id: "double", label: "Archival Double Rule", hint: "Classic" },
        { id: "accent", label: "Accent Signature Frame", hint: "Theme color" },
      ];
      return menu([
        { heading: "Page Sheet Framing" },
        ...opts.map((o) => ({
          label: o.label,
          hint: o.hint,
          checked: curB === o.id,
          onSelect: () => {
            setPageBorder(o.id);
            ribbon.refresh();
          },
        })),
      ]);
    },
  });

  // --- Group 4: Document Font, Pre-Flight & Scratchpad ----------------------
  const docFont = layout.addGroup("Defaults & Studio Tools");
  const [d1, d2] = docFont.stack(2);
  const dfLabel = h(
    "button",
    { class: "rbtn rbtn--small rbtn--wide", type: "button", "data-tip": "Default font for this document (Normal style)" },
    icon("Type", 15),
    h("span", { class: "rbtn__label" }, ""),
  );
  dfLabel.addEventListener("mousedown", (e) => e.preventDefault());
  dfLabel.addEventListener("click", () => {
    const list = h("div", { class: "fontpanel" });
    const search = h("input", { class: "input fontlist__search", placeholder: "Search fonts", spellcheck: "false" }) as HTMLInputElement;
    const ul = h("div", { class: "fontlist" });
    const render = () => {
      ul.replaceChildren();
      const q = search.value.toLowerCase();
      for (const f of state.fonts.filter((x) => x.toLowerCase().includes(q)).slice(0, 600)) {
        const b = h(
          "button",
          { class: "fontlist__item" + (f === state.defaults.fontFamily ? " is-checked" : ""), type: "button", style: { fontFamily: `"${f}"` } },
          f,
        );
        b.addEventListener("click", () => {
          state.defaults.fontFamily = f;
          markDirtyPage();
          closePopover();
          ribbon.refresh();
        });
        ul.append(b);
      }
    };
    search.addEventListener("input", render);
    render();
    list.append(search, ul);
    popover(dfLabel, list);
    requestAnimationFrame(() => search.focus());
  });
  docFont.custom(dfLabel, () => {
    (dfLabel.querySelector(".rbtn__label") as HTMLElement).textContent = `${state.defaults.fontFamily}`;
  }, d1);

  const dsLabel = h(
    "button",
    { class: "rbtn rbtn--small", type: "button", "data-tip": "Default font size for this document" },
    icon("ALargeSmall", 15),
    h("span", { class: "rbtn__label" }, ""),
  );
  dsLabel.addEventListener("mousedown", (e) => e.preventDefault());
  dsLabel.addEventListener("click", () =>
    popover(
      dsLabel,
      menu(
        [9, 10, 10.5, 11, 12, 13, 14, 16].map((s) => ({
          label: `${s} pt`,
          checked: state.defaults.fontSize === s,
          onSelect: () => {
            state.defaults.fontSize = s;
            markDirtyPage();
            ribbon.refresh();
          },
        })),
      ),
    ),
  );
  docFont.custom(dsLabel, () => {
    (dsLabel.querySelector(".rbtn__label") as HTMLElement).textContent = `${state.defaults.fontSize} pt`;
  }, d2);

  docFont.small(d2, {
    icon: "BookmarkCheck",
    label: "Save Default",
    showLabel: true,
    tip: "Save current page setup and font as the default for new documents",
    onClick: () => {
      settings.defaultPage = structuredClone(state.page);
      settings.defaultFont = state.defaults.fontFamily;
      settings.defaultFontSize = state.defaults.fontSize;
      saveSettings();
      toast("Saved current page setup and font as default", "success");
    },
  });

  docFont.large({
    icon: "ScanSearch",
    label: "Pre-Flight",
    tip: "Run an InDesign-style layout & typography health check on this document",
    onClick: () => openPreflightInspector(),
  });
  docFont.large({
    icon: "StickyNote",
    label: "Scratchpad",
    tip: "Toggle the floating Desk Margin Scratchpad (notes never print or affect your document)",
    isActive: () => isScratchpadOpen(),
    onClick: () => {
      toggleScratchpad();
      ribbon.refresh();
    },
  });

  // =========================================================================
  // VIEW
  // =========================================================================
  const view = ribbon.addTab("view", "View");
  const appearance = view.addGroup("Appearance & Studio");
  appearance.large({
    icon: "Palette",
    label: "Theme Studio",
    tip: "Open Themes & Workspace Customization Studio",
    onClick: () => hooks.openThemes(),
  });
  appearance.large({
    icon: "FileText",
    label: "Paper Tone",
    tip: "Choose Paper Sheet Color & Surface Texture (Smooth, Linen, Cotton, Parchment, Ruled, Dots, or Custom PC Texture)",
    isActive: () => settings.paperColor === "white" || settings.paperPreview || (settings.paperTexture && settings.paperTexture !== "smooth"),
    dropdown: () => paperColorMenu(hooks.applyTheme, () => ribbon.refresh()),
  });
  appearance.large({
    icon: "ImagePlus",
    label: "Backdrop",
    tip: "Set a custom background photo, Nature backdrop, or Liquid Glass UI",
    isActive: () => (settings.backgroundPreset && settings.backgroundPreset !== "none") || Boolean(settings.liquidGlassUi),
    dropdown: () => {
      const curBg = settings.backgroundPreset || "none";
      const hasCustom = Boolean(settings.customBackgroundPath?.trim());
      return menu([
        { heading: "Custom Background Photo" },
        {
          label: hasCustom ? "Change Custom Photo from PC…" : "Choose Custom Photo from PC…",
          icon: "ImagePlus",
          onSelect: async () => {
            const file = await pickCustomBackgroundPhoto();
            if (!file) return;
            settings.customBackgroundPath = file;
            settings.backgroundPreset = "custom";
            saveSettings();
            hooks.applyTheme();
            ribbon.refresh();
            toast("Custom background photo applied", "success", 1800);
          },
        },
        ...(hasCustom
          ? [
              {
                label: "Use Active Custom Photo",
                icon: "Image",
                checked: curBg === "custom",
                onSelect: () => {
                  settings.backgroundPreset = "custom";
                  saveSettings();
                  hooks.applyTheme();
                  ribbon.refresh();
                },
              },
              {
                label: "Clear Custom Photo",
                icon: "Trash2",
                onSelect: () => {
                  settings.customBackgroundPath = "";
                  if (settings.backgroundPreset === "custom") settings.backgroundPreset = "none";
                  saveSettings();
                  hooks.applyTheme();
                  ribbon.refresh();
                },
              },
            ]
          : []),
        "sep",
        { heading: "Scenic Nature & Liquid Backdrops" },
        ...BACKDROP_PRESETS.filter((b) => b.id !== "custom").map((b) => ({
          label: b.label,
          hint: b.badge,
          checked: curBg === b.id,
          onSelect: () => {
            settings.backgroundPreset = b.id;
            saveSettings();
            hooks.applyTheme();
            ribbon.refresh();
          },
        })),
        "sep",
        {
          label: "Liquid Glass UI Chrome",
          icon: "Sparkles",
          checked: Boolean(settings.liquidGlassUi) || settings.themeId === "liquid-glass" || curBg !== "none",
          onSelect: () => {
            settings.liquidGlassUi = !settings.liquidGlassUi;
            saveSettings();
            hooks.applyTheme();
            ribbon.refresh();
          },
        },
      ]);
    },
  });

  // --- Canvas Layout Modes (100% opt-in, defaults to Single Page) -----------
  const canvasGroup = view.addGroup("Canvas Mode");
  const setMode = (m: CanvasViewMode) => {
    setCanvasViewMode(m);
    ribbon.refresh();
  };
  canvasGroup.large({
    icon: "File",
    label: "Single Page",
    tip: "Standard centered vertical page stack (Default)",
    isActive: () => (settings.canvasViewMode || "single") === "single",
    onClick: () => setMode("single"),
  });
  canvasGroup.large({
    icon: "BookOpen",
    label: "2-Page Spread",
    tip: "Editorial book spread view tailored for widescreen monitors",
    isActive: () => settings.canvasViewMode === "spread",
    onClick: () => setMode(settings.canvasViewMode === "spread" ? "single" : "spread"),
  });
  canvasGroup.large({
    icon: "ScrollText",
    label: "Web Flow",
    tip: "Borderless continuous writing canvas without page breaks",
    isActive: () => settings.canvasViewMode === "web",
    onClick: () => setMode(settings.canvasViewMode === "web" ? "single" : "web"),
  });
  canvasGroup.large({
    icon: "BookCopy",
    label: "Booklet Fold",
    tip: "Zine & saddle-stitch booklet layout preview",
    isActive: () => settings.canvasViewMode === "booklet",
    onClick: () => setMode(settings.canvasViewMode === "booklet" ? "single" : "booklet"),
  });

  const zoom = view.addGroup("Zoom");
  zoom.large({ icon: "ZoomIn", label: "100%", onClick: () => setZoom(1) });
  const [z1, z2] = zoom.stack(2);
  zoom.small(z1, { icon: "RectangleHorizontal", label: "Page width", showLabel: true, onClick: () => zoomToWidth() });
  zoom.small(z2, { icon: "RectangleVertical", label: "One page", showLabel: true, onClick: () => zoomToPage() });

  const show = view.addGroup("Guides & Workspace");
  show.large({
    icon: "Ruler",
    label: "Page Ruler",
    tip: "Toggle interactive top inch ruler with draggable margin stops",
    isActive: () => settings.showRuler !== false,
    onClick: () => {
      settings.showRuler = settings.showRuler === false;
      saveSettings();
      hooks.applyTheme();
      ribbon.refresh();
    },
  });
  show.large({
    icon: "Grid3x3",
    label: "Baseline Grid",
    tip: "Overlay faint 12pt typographic baseline rhythm lines across the sheet (opt-in)",
    isActive: () => Boolean(state.page.baselineGrid),
    onClick: () => {
      toggleBaselineGrid();
      ribbon.refresh();
    },
  });
  show.large({
    icon: "StickyNote",
    label: "Scratchpad",
    tip: "Toggle the floating Desk Margin Scratchpad on the right of the canvas",
    isActive: () => isScratchpadOpen(),
    onClick: () => {
      toggleScratchpad();
      ribbon.refresh();
    },
  });
  show.large({
    icon: "ListTree",
    label: "Outline",
    shortcut: "Ctrl+Shift+O",
    tip: "Toggle Document Outline & Page Navigator sidebar",
    isActive: () => isOutlineOpen(),
    onClick: () => {
      toggleOutline();
      ribbon.refresh();
    },
  });
  show.large({
    icon: "Maximize2",
    label: "Focus Mode",
    shortcut: "F11",
    tip: "Distraction-free writing mode (F11)",
    isActive: () => isFocusMode(),
    onClick: () => {
      toggleFocusMode();
      ribbon.refresh();
    },
  });
  const [s1, s2] = show.stack(2);
  show.small(s1, {
    icon: "SpellCheck",
    label: "Spell & Grammar",
    showLabel: true,
    isActive: () => isAutoSpellcheck() || isManualScanActive(),
    onClick: () => {
      setAutoSpellcheck(editor, !isAutoSpellcheck());
      ribbon.refresh();
    },
    dropdown: () => proofingMenu(editor, () => ribbon.refresh()),
  });
  show.small(s1, {
    icon: "BookOpen",
    label: "Dictionary",
    shortcut: "Ctrl+Shift+D",
    showLabel: true,
    onClick: () => openDictionary(editor),
  });
  show.small(s2, {
    icon: "Scan",
    label: "Margin guides",
    showLabel: true,
    isActive: () => Boolean(settings.showMarginGuides),
    onClick: () => {
      settings.showMarginGuides = !settings.showMarginGuides;
      saveSettings();
      hooks.applyTheme();
      ribbon.refresh();
    },
  });
  show.small(s2, {
    icon: "PanelTopClose",
    label: "Hide Ribbon",
    shortcut: "Ctrl+F1",
    showLabel: true,
    onClick: () => ribbon.setCollapsed(!ribbon.collapsed),
  });

  // =========================================================================
  // TOOLS (Comprehensive Writing, Editorial, Focus & Research Suite)
  // =========================================================================
  const tools = ribbon.addTab("tools", "Tools");

  // --- Group 1: Text Transform & Clean-Up -----------------------------------
  const xform = tools.addGroup("Text Transform");
  xform.large({
    icon: "CaseSensitive",
    label: "Change Case",
    tip: "Convert selected text (or current paragraph) between UPPERCASE, lowercase, Title Case, or Sentence case",
    dropdown: () =>
      menu([
        { heading: "Convert Text Case" },
        {
          label: "UPPERCASE",
          icon: "CaseUpper",
          onSelect: () => transformSelectionOrBlock(editor, (s) => s.toUpperCase(), "Converted to UPPERCASE"),
        },
        {
          label: "lowercase",
          icon: "CaseLower",
          onSelect: () => transformSelectionOrBlock(editor, (s) => s.toLowerCase(), "Converted to lowercase"),
        },
        {
          label: "Title Case (Capitalize Major Words)",
          icon: "CaseSensitive",
          onSelect: () =>
            transformSelectionOrBlock(
              editor,
              (s) =>
                s.replace(/\w\S*/g, (w, idx) => {
                  const lower = w.toLowerCase();
                  if (idx > 0 && /^(a|an|the|and|but|or|for|nor|on|at|to|from|by|in|of)$/.test(lower)) {
                    return lower;
                  }
                  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
                }),
              "Converted to Title Case",
            ),
        },
        {
          label: "Sentence case",
          icon: "Type",
          onSelect: () =>
            transformSelectionOrBlock(
              editor,
              (s) =>
                s
                  .toLowerCase()
                  .replace(/(^\s*[a-z]|[.!?]\s+[a-z])/g, (m) => m.toUpperCase())
                  .replace(/\bi\b/g, "I"),
              "Converted to Sentence case",
            ),
        },
      ]),
  });
  const [xf1, xf2] = xform.stack(2);
  xform.small(xf1, {
    icon: "Sparkles",
    label: "Smart Quotes",
    showLabel: true,
    tip: "Polish straight quotes to curly quotes, -- to em-dash (—), ... to ellipsis (…), and collapse double spaces",
    onClick: () => polishTypographyInDoc(editor),
  });
  xform.small(xf2, {
    icon: "ArrowUpDown",
    label: "Sort & Clean",
    showLabel: true,
    tip: "Sort lines A→Z, remove duplicate lines, or strip extra blank lines",
    dropdown: () =>
      menu([
        { heading: "Line & Clipboard Operations" },
        {
          label: "Sort Selected Lines (A → Z)",
          icon: "ArrowUpAZ",
          onSelect: () => sortSelectedParagraphs(editor, false),
        },
        {
          label: "Sort Selected Lines (Z → A)",
          icon: "ArrowDownZA",
          onSelect: () => sortSelectedParagraphs(editor, true),
        },
        {
          label: "Remove Duplicate Paragraphs",
          icon: "ListFilter",
          onSelect: () => deduplicateParagraphs(editor),
        },
        "sep",
        {
          label: "Clean Pasted Text (Trim & Collapse Spaces)",
          icon: "Sparkles",
          onSelect: () =>
            transformSelectionOrBlock(
              editor,
              (s) =>
                s
                  .replace(/[ \t]+/g, " ")
                  .replace(/\s+([,.!?;:])/g, "$1")
                  .trim(),
              "Cleaned whitespace and punctuation spacing",
            ),
        },
      ]),
  });

  // --- Group 2: Writing & Style Diagnostics ---------------------------------
  const diag = tools.addGroup("Diagnostics");
  diag.large({
    icon: "Gauge",
    label: "Readability",
    tip: "Analyze Flesch-Kincaid Grade Level, Reading Ease, Passive Voice, and Sentence Rhythm",
    onClick: () => openReadabilityModal(editor),
  });
  const [dg1, dg2] = diag.stack(2);
  diag.small(dg1, {
    icon: "Repeat",
    label: "Word Echoes",
    showLabel: true,
    tip: "Find overused words, repeated phrases, and vocabulary density across your document",
    onClick: () => openRepeatedWordsModal(editor),
  });
  diag.small(dg2, {
    icon: "ScanSearch",
    label: "Pre-Flight",
    showLabel: true,
    tip: "Run an InDesign-style layout & typography health check on this document",
    onClick: () => openPreflightInspector(),
  });

  // --- Group 3: Proofing, Dictionary & Stickers -----------------------------
  const lookupGrp = tools.addGroup("Proofing & Creative");
  lookupGrp.large({
    icon: "SpellCheck",
    label: "Grammar",
    shortcut: "F7",
    tip: "Scan entire document for grammar, missing full stops, punctuation, and spelling",
    onClick: () => openProofingPanel(editor),
    dropdown: () => proofingMenu(editor, () => ribbon.refresh()),
  });
  lookupGrp.large({
    icon: "BookOpen",
    label: "Dictionary",
    shortcut: "Ctrl+Shift+D",
    tip: "Open the Built-In Offline + Live Dictionary, Root Analyzer & Thesaurus",
    onClick: () => openDictionary(editor),
    dropdown: () =>
      menu([
        {
          label: "Open Built-In Dictionary & Thesaurus…",
          icon: "BookOpen",
          hint: "Ctrl+Shift+D",
          onSelect: () => openDictionary(editor),
        },
        {
          label: "Manage Custom Dictionary Words…",
          icon: "BookPlus",
          onSelect: () => openCustomDictionaryModal(editor),
        },
      ]),
  });
  lookupGrp.large({
    icon: "Sticker",
    label: "Stickers",
    tip: "Browse 4 built-in sticker packs or import custom stickers from your PC",
    onClick: () => openStickerStudioModal(editor),
  });

  // --- Group 3B: PDF & Export -----------------------------------------------
  const pdfToolsGrp = tools.addGroup("PDF & Export");
  pdfToolsGrp.large({
    icon: "FileEdit",
    label: "PDF Editor",
    tip: "Open the Built-In PDF Editor & Annotator Studio (edit text blocks, add stamps, signatures, highlights, or reorder pages)",
    onClick: () => void openPdfEditorModal(),
  });
  const [pt1, pt2] = pdfToolsGrp.stack(2);
  pdfToolsGrp.small(pt1, {
    icon: "FileOutput",
    label: "PDF to Word",
    showLabel: true,
    tip: "Convert a .pdf file into an editable Word (.docx) document",
    onClick: () => void convertPdfToWordFlow(),
  });
  pdfToolsGrp.small(pt2, {
    icon: "FileDown",
    label: "Save PDF / EPUB",
    showLabel: true,
    tip: "Export the active document as a PDF (.pdf) or EPUB 3.0 E-Book (.epub)",
    dropdown: () =>
      menu([
        { heading: "Export Document" },
        {
          label: "Save as PDF (.pdf)…",
          icon: "FileCheck",
          onSelect: () => void exportPdfFile(),
        },
        {
          label: "Save as EPUB E-Book (.epub)…",
          icon: "BookOpen",
          onSelect: () => void exportEpubFile(),
        },
      ]),
  });

  // --- Group 4: Focus & Session ---------------------------------------------
  const sessionGrp = tools.addGroup("Focus & Session");
  sessionGrp.large({
    icon: "Timer",
    label: "Sprint Timer",
    tip: "Start a Pomodoro writing sprint timer in the status bar",
    isActive: () => isPomodoroRunning(),
    dropdown: () =>
      menu([
        { heading: "Writing Sprint / Pomodoro Timer" },
        {
          label: "15-Minute Quick Sprint",
          icon: "Timer",
          onSelect: () => startPomodoroSprint(15, () => ribbon.refresh()),
        },
        {
          label: "25-Minute Classic Pomodoro",
          icon: "Timer",
          onSelect: () => startPomodoroSprint(25, () => ribbon.refresh()),
        },
        {
          label: "45-Minute Deep Work Session",
          icon: "Timer",
          onSelect: () => startPomodoroSprint(45, () => ribbon.refresh()),
        },
        "sep",
        {
          label: "Stop / Reset Sprint Timer",
          icon: "Square",
          onSelect: () => stopPomodoroSprint(() => ribbon.refresh()),
        },
      ]),
  });
  const [fs1, fs2] = sessionGrp.stack(2);
  sessionGrp.small(fs1, {
    icon: "AlignCenterHorizontal",
    label: "Typewriter",
    showLabel: true,
    tip: "Keep the active typing line comfortably centered in the viewport as you write",
    isActive: () => Boolean(settings.typewriterScroll),
    onClick: () => {
      settings.typewriterScroll = !settings.typewriterScroll;
      saveSettings();
      ribbon.refresh();
      toast(
        settings.typewriterScroll ? "Typewriter scroll lock enabled" : "Typewriter scroll lock off",
        "info",
        1800,
      );
    },
  });
  sessionGrp.small(fs2, {
    icon: "Target",
    label: "Word Target",
    showLabel: true,
    tip: "Set a word count goal for this writing session",
    isActive: () => sessionWordTarget > 0,
    onClick: () => void promptWordTarget(editor, () => ribbon.refresh()),
  });

  // --- Group 5: Citations, Snippets & Snapshots -----------------------------
  const researchGrp = tools.addGroup("Research & Snapshots");
  researchGrp.large({
    icon: "Quote",
    label: "Cite Source",
    tip: "Format and insert an academic citation (APA 7th, MLA 9th, Chicago, or IEEE)",
    onClick: () => void openCitationModal(editor),
  });
  researchGrp.large({
    icon: "BookmarkPlus",
    label: "Snippets",
    tip: "Insert reusable text snippets or save your current selection as a snippet",
    dropdown: () => buildSnippetsMenu(editor),
  });
  researchGrp.large({
    icon: "History",
    label: "Snapshots",
    tip: "Save a checkpoint snapshot of your current draft or restore a previous version",
    onClick: () => openSnapshotsModal(editor),
  });
}

// ============================================================================
// TOOLS TAB HELPER FUNCTIONS & MODALS
// ============================================================================

function transformSelectionOrBlock(editor: Editor, fn: (s: string) => string, msg: string): void {
  const { from, to, empty } = editor.state.selection;
  if (!empty) {
    const selected = editor.state.doc.textBetween(from, to, "\n");
    const out = fn(selected);
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to }, out)
      .setTextSelection({ from, to: from + out.length })
      .run();
    toast(msg, "success", 1800);
    return;
  }
  const $from = editor.state.selection.$from;
  if ($from.parent.isTextblock && $from.parent.textContent.trim()) {
    const start = $from.start();
    const end = $from.end();
    const orig = $from.parent.textContent;
    const out = fn(orig);
    editor.chain().focus().insertContentAt({ from: start, to: end }, out).run();
    toast(`${msg} (current paragraph)`, "success", 1800);
  } else {
    toast("Select text or place cursor inside a paragraph first", "info", 2000);
  }
}

function polishTypographyInDoc(editor: Editor): void {
  const polish = (s: string) =>
    s
      .replace(/---/g, "—")
      .replace(/--/g, "–")
      .replace(/\.\.\./g, "…")
      .replace(/(^|[\s(\[{])"(\S)/g, "$1“$2")
      .replace(/"/g, "”")
      .replace(/(\w)'(\w)/g, "$1’$2")
      .replace(/(^|[\s(\[{])'(\S)/g, "$1‘$2")
      .replace(/'/g, "’")
      .replace(/[ \t]{2,}/g, " ");

  const { empty } = editor.state.selection;
  if (!empty) {
    transformSelectionOrBlock(editor, polish, "Polished smart quotes, dashes & spacing");
    return;
  }

  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      state.doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          const updated = polish(node.text);
          if (updated !== node.text) {
            tr.replaceWith(pos, pos + node.nodeSize, state.schema.text(updated, node.marks));
          }
        }
      });
      return true;
    })
    .run();
  toast("Polished smart quotes, dashes, ellipses & extra spaces across document", "success", 2400);
}

function sortSelectedParagraphs(editor: Editor, descending: boolean): void {
  const { from, to, empty } = editor.state.selection;
  const text = empty
    ? editor.getText({ blockSeparator: "\n" })
    : editor.state.doc.textBetween(from, to, "\n");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    toast("Select at least 2 lines or paragraphs to sort", "info", 2000);
    return;
  }
  lines.sort((a, b) => (descending ? b.localeCompare(a) : a.localeCompare(b)));
  const nodes = lines.map((l) => ({ type: "paragraph", content: [{ type: "text", text: l }] }));
  if (empty) {
    editor.chain().focus().clearContent().insertContent(nodes).run();
  } else {
    editor.chain().focus().insertContentAt({ from, to }, nodes).run();
  }
  toast(`Sorted ${lines.length} lines (${descending ? "Z → A" : "A → Z"})`, "success", 2000);
}

function deduplicateParagraphs(editor: Editor): void {
  const seen = new Set<string>();
  let removed = 0;
  const kept: any[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      const norm = node.textContent.trim().toLowerCase();
      if (norm && seen.has(norm)) {
        removed++;
        return;
      }
      if (norm) seen.add(norm);
    }
    kept.push(node.toJSON());
  });
  if (removed === 0) {
    toast("No duplicate paragraphs found", "info", 1800);
    return;
  }
  editor.commands.setContent({ type: "doc", content: kept });
  toast(`Removed ${removed} duplicate paragraph${removed === 1 ? "" : "s"}`, "success", 2200);
}

function openReadabilityModal(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  const rawText = editor.getText({ blockSeparator: "\n" }).trim();
  const words = rawText ? rawText.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const sentences = rawText
    ? rawText
        .split(/[.!?]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  const sentenceCount = Math.max(1, sentences.length);

  let totalSyllables = 0;
  const uniqueWords = new Set<string>();
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    if (!clean) continue;
    uniqueWords.add(clean);
    const m = clean
      .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
      .replace(/^y/, "")
      .match(/[aeiouy]{1,2}/g);
    totalSyllables += clean.length <= 3 ? 1 : m ? Math.max(1, m.length) : 1;
  }

  const avgWordsPerSentence = wordCount > 0 ? wordCount / sentenceCount : 0;
  const avgSyllablesPerWord = wordCount > 0 ? totalSyllables / wordCount : 0;
  const readingEase =
    wordCount > 0
      ? Math.max(0, Math.min(100, Math.round(206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord)))
      : 100;
  const fkGrade =
    wordCount > 0
      ? Math.max(1, Math.round((0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59) * 10) / 10)
      : 0;
  const vocabDiversity = wordCount > 0 ? Math.round((uniqueWords.size / wordCount) * 100) : 100;

  const passiveMatches =
    rawText.match(/\b(am|is|are|was|were|been|being)\s+([a-z]+ed|written|taken|made|done|given|shown|known|seen|found|held|told)\b/gi) ??
    [];
  const longSentences = sentences.filter((s) => s.split(/\s+/).length > 30);

  const easeLabel =
    readingEase >= 70
      ? "Clear & Conversational"
      : readingEase >= 50
        ? "Standard Editorial / Business"
        : "Dense / Academic";

  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));
  const body = h(
    "div",
    { class: "dict__body" },
    h(
      "div",
      { class: "studio-grid" },
      h(
        "div",
        { class: "studio-card" },
        h("div", { class: "studio-card__head" }, h("strong", {}, "Flesch Reading Ease"), h("span", {}, easeLabel)),
        h("div", { style: { fontSize: "24px", fontWeight: "700", color: "var(--accent)" } }, `${readingEase} / 100`),
      ),
      h(
        "div",
        { class: "studio-card" },
        h("div", { class: "studio-card__head" }, h("strong", {}, "Flesch-Kincaid Grade Level"), h("span", {}, "Estimated school/reading grade")),
        h("div", { style: { fontSize: "24px", fontWeight: "700" } }, `Grade ${fkGrade}`),
      ),
      h(
        "div",
        { class: "studio-card" },
        h("div", { class: "studio-card__head" }, h("strong", {}, "Sentence Rhythm"), h("span", {}, `${sentences.length} sentences · ${longSentences.length} long (>30w)`)),
        h("div", { style: { fontSize: "20px", fontWeight: "700" } }, `${avgWordsPerSentence.toFixed(1)} words / sentence`),
      ),
      h(
        "div",
        { class: "studio-card" },
        h("div", { class: "studio-card__head" }, h("strong", {}, "Vocabulary & Voice"), h("span", {}, `${passiveMatches.length} passive constructions detected`)),
        h("div", { style: { fontSize: "20px", fontWeight: "700" } }, `${vocabDiversity}% unique words (${uniqueWords.size})`),
      ),
    ),
  );

  if (passiveMatches.length > 0) {
    body.append(
      h(
        "div",
        { class: "dict__section" },
        h("div", { class: "dict__pos" }, "Passive Voice Phrases Found"),
        h(
          "div",
          { class: "dict__chips" },
          ...passiveMatches.slice(0, 15).map((p) => h("span", { class: "dict__chip" }, p)),
        ),
      ),
    );
  }

  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Readability & Style Diagnostics" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("Gauge", 18), h("span", {}, "Readability & Style Report")),
      closeBtn,
    ),
    body,
  );
  const scrim = h("div", { class: "scrim dict-scrim" }, modal);
  const close = () => {
    scrim.remove();
    editor.commands.focus();
  };
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

const STOP_WORDS = new Set([
  "the", "and", "that", "have", "for", "not", "with", "you", "this", "but", "his", "from", "they", "we",
  "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so",
  "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make", "can", "like", "time",
  "no", "just", "him", "know", "take", "into", "your", "some", "could", "them", "see", "other", "than",
  "then", "now", "look", "only", "come", "its", "over", "also", "back", "after", "use", "two", "how",
  "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day",
  "most", "us", "was", "were", "are", "is", "been", "has", "had", "did", "does",
]);

function openRepeatedWordsModal(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  const rawText = editor.getText({ blockSeparator: " " });
  const words = rawText.toLowerCase().match(/\b[a-z']{4,}\b/g) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));
  const body = h("div", { class: "dict__body" });

  if (sorted.length === 0) {
    body.append(
      h(
        "div",
        { class: "proof-empty" },
        icon("Check", 28),
        h("strong", {}, "No overused words detected"),
        h("span", {}, "Your vocabulary variety looks super clean!"),
      ),
    );
  } else {
    body.append(
      h(
        "div",
        { class: "dict__pos" },
        "Most Frequent Content Words (Click any word to open Synonyms in the Built-In Dictionary)",
      ),
    );
    const chips = h("div", { class: "dict__chips" });
    for (const [word, count] of sorted) {
      const chip = h("button", { type: "button", class: "dict__chip" }, `${word} (${count}×)`);
      chip.addEventListener("click", () => {
        scrim.remove();
        openDictionary(editor, word);
      });
      chips.append(chip);
    }
    body.append(chips);
  }

  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Overused Words & Echoes" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("Repeat", 18), h("span", {}, "Word Echoes & Frequency Finder")),
      closeBtn,
    ),
    body,
  );
  const scrim = h("div", { class: "scrim dict-scrim" }, modal);
  const close = () => {
    scrim.remove();
    editor.commands.focus();
  };
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

function openCustomDictionaryModal(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));
  const input = h("input", {
    class: "input dict__input",
    type: "text",
    placeholder: "Add a custom word, character name, or technical term…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const addBtn = h("button", { type: "submit", class: "btn btn--primary" }, icon("Plus", 14), "Add Word");
  const form = h("form", { class: "dict__bar" }, input, addBtn);
  const body = h("div", { class: "dict__body" });

  const renderWords = () => {
    body.replaceChildren();
    const list = settings.userDictionary ?? [];
    if (list.length === 0) {
      body.append(h("div", { class: "dict__empty" }, "Your custom spellcheck dictionary is currently empty. Add names or terms above."));
      return;
    }
    const chips = h("div", { class: "dict__chips" });
    for (const w of list) {
      const chip = h(
        "button",
        { type: "button", class: "dict__chip", "data-tip": "Click to remove from custom dictionary" },
        w,
        " ×",
      );
      chip.addEventListener("click", () => {
        settings.userDictionary = settings.userDictionary.filter((x) => x !== w);
        saveSettings();
        renderWords();
      });
      chips.append(chip);
    }
    body.append(chips);
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const w = input.value.trim().toLowerCase();
    if (!w) return;
    if (!settings.userDictionary.includes(w)) {
      settings.userDictionary.push(w);
      saveSettings();
    }
    input.value = "";
    renderWords();
  });

  renderWords();
  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Custom Dictionary" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("BookPlus", 18), h("span", {}, "Custom Dictionary Manager")),
      closeBtn,
    ),
    form,
    body,
  );
  const scrim = h("div", { class: "scrim dict-scrim" }, modal);
  const close = () => {
    scrim.remove();
    editor.commands.focus();
  };
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

// --- Pomodoro Sprint & Word Target -----------------------------------------
let pomodoroInterval: ReturnType<typeof setInterval> | null = null;
let pomodoroRemainingSec = 0;
let sessionWordTarget = 0;

function isPomodoroRunning(): boolean {
  return pomodoroInterval !== null;
}

function updateSprintBadge(): void {
  let badge = document.getElementById("statusbar-sprint-badge");
  const statusRight = document.querySelector("#statusbar .sbar__right, #statusbar");
  if (!badge && statusRight) {
    badge = h("span", { id: "statusbar-sprint-badge", class: "sbar__item", style: { color: "var(--accent)", fontWeight: "600" } });
    statusRight.prepend(badge);
  }
  if (!badge) return;
  const parts: string[] = [];
  if (pomodoroInterval && pomodoroRemainingSec > 0) {
    const m = Math.floor(pomodoroRemainingSec / 60);
    const s = String(pomodoroRemainingSec % 60).padStart(2, "0");
    parts.push(`⏱ ${m}:${s}`);
  }
  if (sessionWordTarget > 0 && state.editor) {
    const words = state.editor
      .getText({ blockSeparator: " " })
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const pct = Math.min(100, Math.round((words / sessionWordTarget) * 100));
    parts.push(`🎯 ${words}/${sessionWordTarget}w (${pct}%)`);
  }
  badge.textContent = parts.join(" · ");
  badge.style.display = parts.length > 0 ? "" : "none";
}

function startPomodoroSprint(minutes: number, onUpdate?: () => void): void {
  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroRemainingSec = minutes * 60;
  updateSprintBadge();
  pomodoroInterval = setInterval(() => {
    pomodoroRemainingSec--;
    updateSprintBadge();
    if (pomodoroRemainingSec <= 0) {
      if (pomodoroInterval) clearInterval(pomodoroInterval);
      pomodoroInterval = null;
      updateSprintBadge();
      onUpdate?.();
      toast(`🎉 ${minutes}-minute writing sprint complete! Great session!`, "success", 4000);
    }
  }, 1000);
  onUpdate?.();
  toast(`Started ${minutes}-minute writing sprint timer`, "info", 2000);
}

function stopPomodoroSprint(onUpdate?: () => void): void {
  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroInterval = null;
  pomodoroRemainingSec = 0;
  updateSprintBadge();
  onUpdate?.();
  toast("Sprint timer stopped", "info", 1500);
}

export function togglePomodoroSprint(defaultMin: number, onUpdate?: () => void): void {
  if (pomodoroInterval) stopPomodoroSprint(onUpdate);
  else startPomodoroSprint(defaultMin, onUpdate);
}

async function promptWordTarget(editor: Editor, onUpdate?: () => void): Promise<void> {
  const curWords = editor
    .getText({ blockSeparator: " " })
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const r = await promptDialog(
    "Session Word Count Goal",
    [
      {
        name: "target",
        label: `Target word count (Current: ${curWords} words, 0 to clear)`,
        value: String(sessionWordTarget || Math.max(500, Math.ceil((curWords + 250) / 100) * 100)),
        type: "number",
      },
    ],
    "Set Goal",
  );
  if (!r) return;
  const n = Math.max(0, parseInt(r.target, 10) || 0);
  sessionWordTarget = n;
  updateSprintBadge();
  onUpdate?.();
  if (n > 0) toast(`Word count goal set to ${n} words`, "success", 2000);
}

async function openCitationModal(editor: Editor): Promise<void> {
  const r = await promptDialog(
    "Academic Citation Generator (APA 7th / MLA 9th / Chicago / IEEE)",
    [
      { name: "author", label: "Author(s) (e.g. Smith, J. or Doe, Jane)", value: "Smith, J." },
      { name: "year", label: "Publication Year", value: String(new Date().getFullYear()) },
      { name: "title", label: "Title of Book / Article", value: "" },
      { name: "source", label: "Publisher / Journal Name", value: "" },
      { name: "style", label: "Format (APA, MLA, Chicago, or IEEE)", value: "APA" },
    ],
    "Insert Citation",
  );
  if (!r || !r.title.trim()) return;
  const author = r.author.trim() || "Author";
  const year = r.year.trim() || "n.d.";
  const title = r.title.trim();
  const source = r.source.trim() || "Publisher";
  const st = r.style.trim().toUpperCase();

  let html = "";
  if (st.startsWith("MLA")) {
    html = `<p>${author}. <em>${title}</em>. ${source}, ${year}.</p>`;
  } else if (st.startsWith("CHI")) {
    html = `<p>${author}. <em>${title}</em>. ${source}, ${year}.</p>`;
  } else if (st.startsWith("IEE")) {
    html = `<p>[1] ${author}, <em>${title}</em>. ${source}, ${year}.</p>`;
  } else {
    html = `<p>${author} (${year}). <em>${title}</em>. ${source}.</p>`;
  }
  editor.chain().focus().insertContent(html).run();
  toast(`Inserted ${st || "APA"} citation`, "success", 2000);
}

function buildSnippetsMenu(editor: Editor): HTMLElement {
  const snippets = settings.customSnippets ?? [];
  return menu([
    { heading: "Quick Text Snippets" },
    {
      label: "Save Current Selection as Snippet…",
      icon: "Plus",
      onSelect: async () => {
        const { from, to, empty } = editor.state.selection;
        const selected = empty ? "" : editor.state.doc.textBetween(from, to, "\n").trim();
        const r = await promptDialog(
          "Save Reusable Text Snippet",
          [
            { name: "name", label: "Snippet Name", value: selected.slice(0, 24) || "Signature Block" },
            { name: "body", label: "Snippet Text", value: selected || "Best regards,\n" },
          ],
          "Save Snippet",
        );
        if (!r || !r.name.trim() || !r.body.trim()) return;
        if (!settings.customSnippets) settings.customSnippets = [];
        settings.customSnippets.push({
          id: `snip-${Date.now()}`,
          title: r.name.trim(),
          text: r.body,
        });
        saveSettings();
        toast(`Saved snippet "${r.name.trim()}"`, "success", 2000);
      },
    },
    ...(snippets.length > 0
      ? [
          "sep" as const,
          ...snippets.map((sn) => ({
            label: sn.title,
            hint: "Insert",
            icon: "FileText",
            onSelect: () => {
              editor.chain().focus().insertContent(sn.text).run();
              toast(`Inserted snippet "${sn.title}"`, "success", 1600);
            },
          })),
        ]
      : []),
  ]);
}

const SNAPSHOTS_KEY = "typo.draftSnapshots.v1";
interface DraftSnapshot {
  id: string;
  label: string;
  timestamp: string;
  words: number;
  html: string;
}

function loadSnapshots(): DraftSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveSnapshots(list: DraftSnapshot[]): void {
  try {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    // ignore
  }
}

function openSnapshotsModal(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));
  const takeBtn = h(
    "button",
    { type: "button", class: "btn btn--primary" },
    icon("Camera", 14),
    "Take Snapshot of Current Draft",
  );
  const body = h("div", { class: "dict__body" });

  const renderList = () => {
    body.replaceChildren();
    const snaps = loadSnapshots();
    if (snaps.length === 0) {
      body.append(
        h(
          "div",
          { class: "proof-empty" },
          icon("History", 28),
          h("strong", {}, "No draft snapshots saved yet"),
          h("span", {}, "Click 'Take Snapshot of Current Draft' above before making major edits so you can restore anytime."),
        ),
      );
      return;
    }
    for (const sn of snaps) {
      const restoreBtn = h("button", { type: "button", class: "proof-card__fix" }, icon("RotateCcw", 12), "Restore");
      restoreBtn.addEventListener("click", () => {
        editor.commands.setContent(sn.html);
        scheduleLayout();
        toast(`Restored snapshot "${sn.label}"`, "success", 2200);
        scrim.remove();
      });
      const delBtn = h("button", { type: "button", class: "proof-card__act" }, "Delete");
      delBtn.addEventListener("click", () => {
        saveSnapshots(loadSnapshots().filter((x) => x.id !== sn.id));
        renderList();
      });
      body.append(
        h(
          "div",
          { class: "proof-item" },
          h(
            "div",
            { class: "proof-item__head" },
            h("strong", {}, sn.label),
            h("span", { class: "proof-item__msg" }, `${sn.timestamp} · ${sn.words} words`),
          ),
          h("div", { class: "proof-card__suggestions" }, restoreBtn, delBtn),
        ),
      );
    }
  };

  takeBtn.addEventListener("click", () => {
    const words = editor
      .getText({ blockSeparator: " " })
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const snaps = loadSnapshots();
    snaps.unshift({
      id: `snap-${Date.now()}`,
      label: `${state.name || "Untitled"} — Checkpoint #${snaps.length + 1}`,
      timestamp: new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      words,
      html: editor.getHTML(),
    });
    saveSnapshots(snaps);
    renderList();
    toast("Draft snapshot saved", "success", 1800);
  });

  renderList();
  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Draft Snapshots" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("History", 18), h("span", {}, "Draft Snapshots & Version Checkpoints")),
      closeBtn,
    ),
    h("div", { class: "dict__bar" }, takeBtn),
    body,
  );
  const scrim = h("div", { class: "scrim dict-scrim" }, modal);
  const close = () => {
    scrim.remove();
    editor.commands.focus();
  };
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

function insertCoverPage(editor: Editor, style: "spec" | "whitepaper" | "manuscript" | "editorial"): void {
  const dateStr = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const docTitle = state.name && state.name !== "Untitled" ? state.name.replace(/\.[^.]+$/, "") : "Document Title";
  let html = "";
  if (style === "spec") {
    html = `<p data-space-before="24pt" data-space-after="4pt"><span style="font-size: 9.5pt; color: #888894">TECHNICAL SPECIFICATION · ${dateStr.toUpperCase()}</span></p><p data-style="Title">${docTitle}</p><p data-style="Subtitle">Architecture, Systems Design &amp; Operational Overview</p><hr><p data-space-before="18pt"><strong>Prepared By:</strong> Author Name</p><p><strong>Status:</strong> Draft v1.0</p><div class="page-break" data-page-break="true"></div><p></p>`;
  } else if (style === "whitepaper") {
    html = `<p style="text-align: center" data-space-before="24pt"><span style="font-size: 10pt">RESEARCH MONOGRAPH · ${dateStr}</span></p><p style="text-align: center" data-style="Title">${docTitle}</p><p style="text-align: center" data-style="Subtitle">An Empirical Investigation &amp; Executive Synthesis</p><hr><blockquote data-space-before="12pt"><p><strong>Abstract —</strong> Summarize the core thesis, methodology, and principal findings of your paper in this executive block.</p></blockquote><div class="page-break" data-page-break="true"></div><p></p>`;
  } else if (style === "manuscript") {
    html = `<p style="text-align: right" data-space-after="24pt">Author Name · Approx. Word Count</p><p style="text-align: center" data-space-before="24pt" data-style="Title">${docTitle.toUpperCase()}</p><p style="text-align: center" data-style="Subtitle">by Author Name</p><div class="page-break" data-page-break="true"></div><p></p>`;
  } else {
    html = `<p data-space-before="18pt"><span style="font-size: 10pt">FEATURE REPORT · ${dateStr.toUpperCase()}</span></p><p data-style="Title"><strong>${docTitle}</strong></p><p data-style="Subtitle">A deep-dive perspective on craft, structure, and modern execution.</p><hr><p><strong>Byline:</strong> Lead Author &amp; Editorial Team</p><div class="page-break" data-page-break="true"></div><p></p>`;
  }

  state.page.differentFirstPage = true;
  editor.chain().focus().insertContentAt(0, html).run();
  emit("page:change");
  scheduleLayout();
  toast("Inserted cover page at Page 1 (Header/Footer suppressed on Page 1)", "success", 2400);
}

export async function insertLink(editor: Editor): Promise<void> {
  const existing = editor.getAttributes("link").href as string | undefined;
  const { from, to, empty } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, " ");
  const r = await promptDialog(existing ? "Edit link" : "Insert link", [
    { name: "text", label: "Text to display", value: selected, placeholder: "Link text" },
    { name: "href", label: "Address", value: existing ?? "https://", placeholder: "https://example.com" },
  ], existing ? "Update" : "Insert");
  if (!r) {
    editor.commands.focus();
    return;
  }
  let href = r.href.trim();
  if (!href || href === "https://") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  if (!/^(https?:|mailto:|tel:|#)/i.test(href)) href = `https://${href}`;
  const label = r.text.trim() || href;
  if (empty || label !== selected) {
    editor.chain().focus().insertContentAt({ from, to }, { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }).run();
  } else {
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  }
}

const EQUATION_PRESETS: { name: string; formula: string }[] = [
  { name: "Quadratic Formula", formula: "x = (−b ± √(b² − 4ac)) / 2a" },
  { name: "Euler's Identity", formula: "e^(iπ) + 1 = 0" },
  { name: "Gaussian Integral", formula: "∫_(-∞)^(+∞) e^(−x²) dx = √π" },
  { name: "Basel Series", formula: "∑_(n=1)^(∞) (1 / n²) = π² / 6" },
  { name: "Derivative Definition", formula: "f′(x) = lim_(h → 0) [f(x + h) − f(x)] / h" },
  { name: "Normal Distribution", formula: "f(x) = (1 / (σ√(2π))) · exp(−(x − μ)² / (2σ²))" },
  { name: "Pythagorean Theorem", formula: "a² + b² = c²" },
  { name: "Mass–Energy Equivalence", formula: "E = mc²" },
];

const SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ", "x": "ˣ",
};
const SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "n": "ₙ", "x": "ₓ",
};

function formatLatexToMath(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1) / ($2)");
  s = s.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
  const tokens: [RegExp, string][] = [
    [/\\alpha\b/g, "α"], [/\\beta\b/g, "β"], [/\\gamma\b/g, "γ"], [/\\delta\b/g, "δ"],
    [/\\epsilon\b/g, "ε"], [/\\theta\b/g, "θ"], [/\\lambda\b/g, "λ"], [/\\mu\b/g, "μ"],
    [/\\pi\b/g, "π"], [/\\sigma\b/g, "σ"], [/\\tau\b/g, "τ"], [/\\phi\b/g, "φ"],
    [/\\omega\b/g, "ω"], [/\\Delta\b/g, "Δ"], [/\\Sigma\b/g, "∑"], [/\\Omega\b/g, "Ω"],
    [/\\sum\b/g, "∑"], [/\\prod\b/g, "∏"], [/\\int\b/g, "∫"], [/\\infty\b/g, "∞"],
    [/\\pm\b/g, "±"], [/\\mp\b/g, "∓"], [/\\times\b/g, "×"], [/\\cdot\b/g, "·"],
    [/\\div\b/g, "÷"], [/\\neq\b/g, "≠"], [/\\leq\b/g, "≤"], [/\\geq\b/g, "≥"],
    [/\\approx\b/g, "≈"], [/\\equiv\b/g, "≡"], [/\\rightarrow\b/g, "→"], [/\\to\b/g, "→"],
    [/\\Rightarrow\b/g, "⇒"], [/\\partial\b/g, "∂"], [/\\nabla\b/g, "∇"], [/\\forall\b/g, "∀"],
    [/\\exists\b/g, "∃"], [/\\in\b/g, "∈"],
  ];
  for (const [re, rep] of tokens) s = s.replace(re, rep);
  s = s.replace(/\^\{([^{}]+)\}|\^([0-9a-z+-])/gi, (_m, g1, g2) => {
    const val = String(g1 ?? g2);
    return [...val].map((ch) => SUPERSCRIPT_MAP[ch] ?? ch).join("");
  });
  s = s.replace(/_\{([^{}]+)\}|_([0-9a-z+-])/gi, (_m, g1, g2) => {
    const val = String(g1 ?? g2);
    return [...val].map((ch) => SUBSCRIPT_MAP[ch] ?? ch).join("");
  });
  return s;
}

function insertEquationBlock(editor: Editor, formula: string): void {
  const formatted = formatLatexToMath(formula);
  editor
    .chain()
    .focus()
    .insertContent(
      `<blockquote data-math="true"><p style="text-align: center; font-family: Cambria Math, Georgia, serif; font-size: 13pt">${formatted}</p></blockquote><p></p>`,
    )
    .run();
  scheduleLayout();
}

export async function insertCustomEquation(editor: Editor): Promise<void> {
  const r = await promptDialog(
    "Insert Mathematical Equation",
    [
      {
        name: "eq",
        label: "LaTeX or Mathematical Expression (e.g. \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} or \\sum_{i=1}^n x_i)",
        value: "\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}",
        placeholder: "e.g. E = mc^2 or \\sum_{i=1}^n x_i",
      },
    ],
    "Insert Equation",
  );
  if (!r || !r.eq.trim()) {
    editor.commands.focus();
    return;
  }
  insertEquationBlock(editor, r.eq);
}

export function insertTableOfContents(editor: Editor): void {
  const headings: { level: number; text: string; page: number }[] = [];
  const sheet = document.getElementById("sheet");
  const sheetRect = sheet?.getBoundingClientRect();
  const pageHeightPx = 11.69 * 96 * (settings.zoom || 1);

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text && text.toLowerCase() !== "table of contents" && text.toLowerCase() !== "contents") {
        let pageNum = 1;
        try {
          const coords = editor.view.coordsAtPos(pos);
          if (sheetRect && pageHeightPx > 100) {
            pageNum = Math.max(1, Math.floor((coords.top - sheetRect.top) / pageHeightPx) + 1);
          }
        } catch {
          pageNum = 1;
        }
        headings.push({ level: Number(node.attrs.level) || 1, text, page: pageNum });
      }
    }
  });

  if (headings.length === 0) {
    editor
      .chain()
      .focus()
      .insertContent(
        `<h2>Table of Contents</h2><p><strong>1. Introduction</strong> ........................................................................................................ 1</p><p style="margin-left: 18pt">1.1 Background &amp; Context ......................................................................................... 1</p><p><strong>2. Analysis &amp; Findings</strong> ................................................................................................. 2</p><p><strong>3. Conclusion</strong> ............................................................................................................... 3</p><hr><p></p>`,
      )
      .run();
    toast("Inserted starter Table of Contents (add Heading 1–3 styles to auto-populate)", "info", 2800);
    scheduleLayout();
    return;
  }

  const lines = headings.map((h) => {
    const indent = (h.level - 1) * 18;
    const weight = h.level === 1 ? "font-weight: 700;" : "";
    const dotsCount = Math.max(8, 68 - h.text.length - (h.level - 1) * 6);
    const dots = ".".repeat(dotsCount);
    return `<p style="margin-left: ${indent}pt; ${weight}">${h.text} <span style="opacity: 0.45">${dots}</span> <strong>${h.page}</strong></p>`;
  });

  editor
    .chain()
    .focus()
    .insertContent(`<h2>Table of Contents</h2>${lines.join("")}<hr><p></p>`)
    .run();
  toast(`Generated Table of Contents (${headings.length} sections)`, "success", 2000);
  scheduleLayout();
}

export async function insertFootnote(editor: Editor): Promise<void> {
  const fullText = editor.state.doc.textContent;
  const matches = fullText.match(/\[\d+\]/g) ?? [];
  const nextNum = Math.floor(matches.length / 2) + 1;

  const r = await promptDialog(
    `Insert Footnote [${nextNum}]`,
    [
      {
        name: "note",
        label: "Footnote citation or explanation text",
        value: "",
        placeholder: "e.g. Source: Journal of Computing, Vol. 14, pp. 42–49.",
      },
    ],
    "Insert Footnote",
  );
  if (!r || !r.note.trim()) {
    editor.commands.focus();
    return;
  }
  const noteText = r.note.trim();

  // 1. Insert superscript reference at current cursor
  editor.chain().focus().insertContent(`<sup>[${nextNum}]</sup>`).run();

  // 2. Append footnote entry at the end of the document
  const endPos = editor.state.doc.content.size;
  const hasFootnotesHeader = /Footnotes/i.test(fullText);
  const footerHtml = hasFootnotesHeader
    ? `<p style="font-size: 9.5pt"><sup>[${nextNum}]</sup> ${noteText}</p>`
    : `<hr><p><strong>Footnotes</strong></p><p style="font-size: 9.5pt"><sup>[${nextNum}]</sup> ${noteText}</p>`;

  editor.chain().insertContentAt(endPos, footerHtml).run();
  toast(`Inserted Footnote [${nextNum}]`, "success", 1800);
  scheduleLayout();
}

