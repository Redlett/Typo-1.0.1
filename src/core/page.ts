/**
 * Page layout: sizes the sheet to the chosen paper + margins, draws page-boundary
 * guides, renders editable Header / Footer / Page Numbers on each page, makes explicit
 * page breaks jump to the next page, handles zoom, and generates the @page rule.
 */
import { PAGE_SIZES, type PageBorderStyle } from "./native";
import { state, emit, on, setDirty } from "./state";
import { settings, saveSettings, type CanvasViewMode } from "./settings";
import { h, icon, promptDialog, toast } from "../ui/dom";
import { initDoodleEngine, syncDoodleCanvasDimensions } from "../ui/doodle";
import { initProjectSidebar } from "../ui/projects";

const DPI = 96;

let sheet: HTMLElement;
let editorHost: HTMLElement;
let markers: HTMLElement;
let hfLayer: HTMLElement;
let watermarkLayer: HTMLElement;
let scratchpadEl: HTMLElement | null = null;
let printStyle: HTMLStyleElement;
let pageFlowStyle: HTMLStyleElement | null = null;
let pageCount = 1;
let laying = false;

export function pageDims(): { w: number; h: number } {
  const s = PAGE_SIZES[state.page.size] ?? PAGE_SIZES.A4;
  const portrait = { w: s.w * DPI, h: s.h * DPI };
  return state.page.orientation === "landscape" ? { w: portrait.h, h: portrait.w } : portrait;
}

export function getPageCount(): number {
  return pageCount;
}

export async function editHeaderFooter(mode: "header" | "footer" | "both" = "both"): Promise<void> {
  const fields =
    mode === "header"
      ? [{ name: "header", label: "Header text (shown at the top of every page)", value: state.page.header ?? "", placeholder: "e.g. Project Proposal · Confidential" }]
      : mode === "footer"
        ? [{ name: "footer", label: "Footer text (shown at the bottom of every page)", value: state.page.footer ?? "", placeholder: "e.g. Author Name · Department" }]
        : [
            { name: "header", label: "Header text (top of page)", value: state.page.header ?? "", placeholder: "e.g. Document Title" },
            { name: "footer", label: "Footer text (bottom of page)", value: state.page.footer ?? "", placeholder: "e.g. Confidential" },
          ];
  const r = await promptDialog(mode === "header" ? "Page Header" : mode === "footer" ? "Page Footer" : "Header & Footer", fields, "Apply");
  if (!r) return;
  if ("header" in r) state.page.header = r.header.trim();
  if ("footer" in r) state.page.footer = r.footer.trim();
  setDirty(true);
  emit("page:change");
  scheduleLayout();
}

export function togglePageNumbers(): void {
  state.page.pageNumbers = !state.page.pageNumbers;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
  toast(state.page.pageNumbers ? "Page numbers enabled" : "Page numbers hidden", "info", 1600);
}

export function toggleDifferentFirstPage(): void {
  state.page.differentFirstPage = !state.page.differentFirstPage;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
  toast(
    state.page.differentFirstPage
      ? "Cover page mode enabled (Header & Footer hidden on Page 1)"
      : "Header & Footer shown on all pages",
    "info",
    1800,
  );
}

export function setPageColumns(cols: number, rule?: boolean): void {
  state.page.columns = cols <= 1 ? undefined : cols;
  if (rule !== undefined) state.page.columnRule = rule;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
}

export function setPageWatermark(text: string): void {
  state.page.watermark = text.trim() || undefined;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
}

export function setPageBorder(style: PageBorderStyle): void {
  state.page.pageBorder = style === "none" ? undefined : style;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
}

export function toggleHyphenation(): void {
  state.page.hyphenation = !state.page.hyphenation;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
  toast(state.page.hyphenation ? "Smart auto-hyphenation enabled" : "Auto-hyphenation off", "info", 1600);
}

export function toggleBaselineGrid(): void {
  state.page.baselineGrid = !state.page.baselineGrid;
  setDirty(true);
  emit("page:change");
  scheduleLayout();
  toast(state.page.baselineGrid ? "12pt Typographic Baseline Grid enabled" : "Baseline Grid hidden", "info", 1600);
}

export function setCanvasViewMode(mode: CanvasViewMode): void {
  settings.canvasViewMode = mode;
  document.documentElement.dataset.canvasView = mode;
  saveSettings();
  emit("page:change");
  scheduleLayout();
}

export function isScratchpadOpen(): boolean {
  return Boolean(settings.scratchpadOpen);
}

export function toggleScratchpad(): void {
  settings.scratchpadOpen = !settings.scratchpadOpen;
  saveSettings();
  syncScratchpadVisibility();
  emit("page:change");
}

function syncScratchpadVisibility(): void {
  if (!scratchpadEl) return;
  scratchpadEl.hidden = !settings.scratchpadOpen;
  document.documentElement.dataset.scratchpad = settings.scratchpadOpen ? "on" : "off";
}

function buildScratchpad(): HTMLElement {
  const textarea = h("textarea", {
    class: "scratchpad__area",
    placeholder: "Jot down loose ideas, cut paragraphs, character notes, or links here…\n\n• Stays outside your document\n• Never prints or exports to .docx",
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  textarea.value = settings.scratchpadText || "";

  const countEl = h("span", { class: "scratchpad__meta" }, "");
  const updateCount = () => {
    const words = textarea.value.trim() ? textarea.value.trim().split(/\s+/).length : 0;
    countEl.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  };
  updateCount();

  textarea.addEventListener("input", () => {
    settings.scratchpadText = textarea.value;
    updateCount();
    saveSettings();
  });

  const insertBtn = h(
    "button",
    {
      type: "button",
      class: "scratchpad__btn",
      "data-tip": "Insert selected or all scratchpad text into the document at cursor",
    },
    icon("CornerDownLeft", 13),
    "Send to Doc",
  );
  insertBtn.addEventListener("click", () => {
    const sel = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim() || textarea.value.trim();
    if (!sel) {
      toast("Scratchpad is empty", "info", 1400);
      return;
    }
    const paragraphs = sel
      .split(/\n+/)
      .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
      .join("");
    state.editor?.chain().focus().insertContent(paragraphs).run();
    toast("Inserted scratchpad note into document", "success", 1600);
  });

  const clearBtn = h(
    "button",
    { type: "button", class: "scratchpad__btn", "data-tip": "Clear scratchpad notes" },
    icon("Trash2", 13),
  );
  clearBtn.addEventListener("click", () => {
    if (!textarea.value.trim()) return;
    textarea.value = "";
    settings.scratchpadText = "";
    updateCount();
    saveSettings();
    toast("Scratchpad cleared", "info", 1400);
  });

  const closeBtn = h(
    "button",
    { type: "button", class: "scratchpad__close", "data-tip": "Hide Desk Scratchpad" },
    icon("X", 14),
  );
  closeBtn.addEventListener("click", () => toggleScratchpad());

  const panel = h(
    "aside",
    { id: "desk-scratchpad", class: "scratchpad", hidden: !settings.scratchpadOpen },
    h(
      "div",
      { class: "scratchpad__head" },
      h("div", { class: "scratchpad__title" }, icon("StickyNote", 14), h("strong", {}, "Desk Scratchpad")),
      closeBtn,
    ),
    textarea,
    h("div", { class: "scratchpad__foot" }, countEl, h("div", { class: "scratchpad__actions" }, insertBtn, clearBtn)),
  );
  return panel;
}

export function openPreflightInspector(): void {
  const ed = state.editor;
  if (!ed) return;

  const issues: { kind: "warn" | "info" | "ok"; title: string; detail: string }[] = [];
  let headingCount = 0;
  let orphanHeadings = 0;
  let rawUrls = 0;
  let longSentences = 0;
  let emptyParagraphs = 0;

  const doc = ed.state.doc;
  const totalNodes = doc.childCount;

  doc.forEach((node, _offset, idx) => {
    const txt = node.textContent.trim();
    if (node.type.name === "heading") {
      headingCount++;
      const next = idx + 1 < totalNodes ? doc.child(idx + 1) : null;
      if (!next || next.type.name === "pageBreak" || (next.type.name === "heading" && Number(next.attrs.level) <= Number(node.attrs.level))) {
        orphanHeadings++;
      }
    }
    if (node.type.name === "paragraph" && !txt && idx < totalNodes - 1) {
      emptyParagraphs++;
    }
    if (/https?:\/\/\S+/i.test(txt)) {
      let hasRawUrl = false;
      node.descendants((child) => {
        if (child.isText && /https?:\/\/\S+/i.test(child.text || "")) {
          const isLinked = child.marks.some((m) => m.type.name === "link");
          if (!isLinked) hasRawUrl = true;
        }
      });
      if (hasRawUrl) rawUrls++;
    }
    const sentences = txt.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      if (s.split(/\s+/).length > 38) longSentences++;
    }
  });

  const fullText = doc.textContent.trim();
  const words = fullText ? fullText.split(/\s+/).length : 0;
  const sentencesCount = Math.max(1, fullText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length);
  const syllablesApprox = Math.max(1, Math.round(fullText.replace(/[^a-zA-Z]/g, "").length / 3));
  const fkGrade = words > 10
    ? Math.max(1, Math.min(18, +(0.39 * (words / sentencesCount) + 11.8 * (syllablesApprox / Math.max(1, words)) - 15.59).toFixed(1)))
    : 0;
  const readMins = Math.max(1, Math.ceil(words / 220));

  if (orphanHeadings > 0) {
    issues.push({
      kind: "warn",
      title: `${orphanHeadings} Orphaned Heading${orphanHeadings > 1 ? "s" : ""}`,
      detail: "A heading is stranded at the end of a section or right before a page break without body text under it.",
    });
  }
  if (emptyParagraphs > 2) {
    issues.push({
      kind: "warn",
      title: `${emptyParagraphs} Blank Spacer Lines`,
      detail: "Multiple empty paragraphs detected. Use Layout → Spacing After or Page Break instead of pressing Enter repeatedly.",
    });
  }
  if (rawUrls > 0) {
    issues.push({
      kind: "info",
      title: `${rawUrls} Unformatted Raw URL${rawUrls > 1 ? "s" : ""}`,
      detail: "Plain https:// addresses found in body text. Consider wrapping them with Ctrl+K links for cleaner print typography.",
    });
  }
  if (longSentences > 0) {
    issues.push({
      kind: "info",
      title: `${longSentences} Dense Sentence${longSentences > 1 ? "s" : ""} (>38 words)`,
      detail: "Consider splitting extra-long sentences to improve reader cadence and visual rhythm.",
    });
  }
  if (issues.length === 0) {
    issues.push({
      kind: "ok",
      title: "Zero Layout or Typography Issues",
      detail: "Heading hierarchy, paragraph spacing, links, and page breaks all pass pre-flight inspection.",
    });
  }

  const root = document.getElementById("overlay-root")!;
  const close = () => scrim.remove();
  const scrim = h(
    "div",
    { class: "scrim", onmousedown: (e: MouseEvent) => { if (e.target === scrim) close(); } },
    h(
      "div",
      { class: "modal preflight-modal" },
      h(
        "div",
        { class: "preflight__head" },
        h("div", { class: "preflight__title" }, icon("ScanSearch", 18), h("h2", { class: "modal__title" }, "Pre-Flight Layout & Print Inspector")),
        h("button", { type: "button", class: "scratchpad__close", onclick: close }, icon("X", 15)),
      ),
      h(
        "div",
        { class: "preflight__stats" },
        h("div", { class: "preflight__stat" }, h("strong", {}, String(pageCount)), h("span", {}, "Pages")),
        h("div", { class: "preflight__stat" }, h("strong", {}, words.toLocaleString()), h("span", {}, "Words")),
        h("div", { class: "preflight__stat" }, h("strong", {}, `${readMins} min`), h("span", {}, "Read Time")),
        h("div", { class: "preflight__stat" }, h("strong", {}, fkGrade ? `Grade ${fkGrade}` : "N/A"), h("span", {}, "Readability")),
        h("div", { class: "preflight__stat" }, h("strong", {}, String(headingCount)), h("span", {}, "Headings")),
      ),
      h(
        "div",
        { class: "preflight__checks" },
        ...issues.map((iss) =>
          h(
            "div",
            {
              class: `preflight__row preflight__row--${iss.kind === "ok" ? "pass" : iss.kind}`,
            },
            h(
              "span",
              { class: "preflight__badge" },
              iss.kind === "warn" ? "WARN" : iss.kind === "ok" ? "PASS" : "INFO",
            ),
            h("div", { class: "preflight__info" }, h("strong", {}, iss.title), h("span", {}, iss.detail)),
          ),
        ),
      ),
      h(
        "div",
        { class: "modal__actions" },
        h("button", { type: "button", class: "btn btn--primary", onclick: close }, "Done"),
      ),
    ),
  );
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

let rulerEl: HTMLElement | null = null;
let marginGuidesEl: HTMLElement | null = null;
let spreadSpineEl: HTMLElement | null = null;

export async function saveCurrentMarginPreset(): Promise<void> {
  const m = state.page.margins;
  const { w } = pageDims();
  const textWidthIn = Math.max(1, w / DPI - m.left - m.right).toFixed(2);
  const r = await promptDialog(
    "Save Page Width & Margin Preset",
    [
      {
        name: "name",
        label: `Preset Name (Text Width: ${textWidthIn}″ · Margins: ${m.left.toFixed(2)}″ L / ${m.right.toFixed(2)}″ R)`,
        value: `Custom ${textWidthIn}″ Width (${m.left.toFixed(2)}″ margins)`,
        placeholder: "e.g. Novel Manuscript Width",
      },
    ],
    "Save Preset",
  );
  if (!r || !r.name.trim()) return;
  if (!Array.isArray(settings.savedMarginPresets)) settings.savedMarginPresets = [];
  settings.savedMarginPresets.unshift({
    id: "mp-" + Date.now(),
    name: r.name.trim(),
    left: m.left,
    right: m.right,
    top: m.top,
    bottom: m.bottom,
  });
  saveSettings();
  renderRuler();
  toast(`Saved width preset "${r.name.trim()}"`, "success", 1800);
}

export function openSavedWidthsDialog(): void {
  const root = document.getElementById("overlay-root")!;
  const close = () => scrim.remove();
  const { w } = pageDims();
  const m = state.page.margins;
  const curWidthIn = Math.max(1, w / DPI - m.left - m.right).toFixed(2);

  const listHost = h("div", { class: "preflight__checks" });
  const rebuildList = () => {
    listHost.replaceChildren();
    const presets = settings.savedMarginPresets || [];
    if (presets.length === 0) {
      listHost.append(
        h(
          "div",
          { class: "preflight__row preflight__row--info" },
          h("span", { class: "preflight__badge" }, "INFO"),
          h(
            "div",
            { class: "preflight__info" },
            h("strong", {}, "No custom width presets saved yet"),
            h("span", {}, "Click '+ Save Current Width' below to bookmark your current ruler margins."),
          ),
        ),
      );
      return;
    }
    for (const p of presets) {
      const pWidth = Math.max(1, w / DPI - p.left - p.right).toFixed(2);
      const isCur = Math.abs(p.left - state.page.margins.left) < 0.01 && Math.abs(p.right - state.page.margins.right) < 0.01;
      const applyBtn = h(
        "button",
        {
          type: "button",
          class: "btn" + (isCur ? " is-active" : ""),
          onclick: () => {
            state.page.margins = { top: p.top, right: p.right, bottom: p.bottom, left: p.left };
            setDirty(true);
            emit("page:change");
            close();
            toast(`Applied "${p.name}"`, "success", 1500);
          },
        },
        isCur ? "Active" : "Apply",
      );
      const delBtn = h(
        "button",
        {
          type: "button",
          class: "btn",
          "data-tip": "Delete saved preset",
          onclick: () => {
            settings.savedMarginPresets = settings.savedMarginPresets.filter((x) => x.id !== p.id);
            saveSettings();
            rebuildList();
          },
        },
        icon("Trash2", 13),
      );
      listHost.append(
        h(
          "div",
          { class: "preflight__row", style: { alignItems: "center", justifyContent: "space-between" } },
          h(
            "div",
            { class: "preflight__info" },
            h("strong", {}, p.name),
            h("span", {}, `Text Width: ${pWidth}″ · Left: ${p.left.toFixed(2)}″ · Right: ${p.right.toFixed(2)}″`),
          ),
          h("div", { style: { display: "flex", gap: "6px" } }, applyBtn, delBtn),
        ),
      );
    }
  };
  rebuildList();

  const scrim = h(
    "div",
    { class: "scrim", onmousedown: (e: MouseEvent) => { if (e.target === scrim) close(); } },
    h(
      "div",
      { class: "modal preflight-modal" },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, icon("Ruler", 18), h("h2", { class: "modal__title", style: { margin: "0" } }, "Ruler Width & Margin Bookmarks")),
        h("button", { type: "button", class: "ibtn", onclick: close }, icon("X", 15)),
      ),
      h(
        "p",
        { style: { margin: "0 0 12px", fontSize: "12px", color: "var(--text-muted)" } },
        `Current Page Text Width: ${curWidthIn}″ (Left ${m.left.toFixed(2)}″ / Right ${m.right.toFixed(2)}″). Symmetric Ruler Lock is ${settings.rulerSymmetric !== false ? "ON (both sides move evenly)" : "OFF (independent sides)"}.`,
      ),
      listHost,
      h(
        "div",
        { class: "modal__actions", style: { justifyContent: "space-between" } },
        h(
          "div",
          { style: { display: "flex", gap: "6px" } },
          h(
            "button",
            {
              type: "button",
              class: "btn",
              onclick: () => {
                state.page.margins.left = 1;
                state.page.margins.right = 1;
                setDirty(true);
                emit("page:change");
                close();
                toast("Reset margins to 1.00″ standard width", "info", 1500);
              },
            },
            "Reset 1.00″",
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn",
              onclick: async () => {
                close();
                await saveCurrentMarginPreset();
              },
            },
            icon("BookmarkPlus", 14),
            "+ Save Current Width",
          ),
        ),
        h("button", { type: "button", class: "btn btn--primary", onclick: close }, "Done"),
      ),
    ),
  );
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}

export function renderRuler(): void {
  if (!rulerEl) return;
  const baseDims = pageDims();
  const isSpread = settings.canvasViewMode === "spread";
  const w = isSpread ? Math.round(baseDims.w * 1.65) : baseDims.w;
  const m = state.page.margins;
  const leftPx = m.left * DPI;
  const rightPx = m.right * DPI;
  const totalInches = w / DPI;

  rulerEl.style.width = `${w}px`;
  rulerEl.replaceChildren();

  const leftMarginZone = document.createElement("div");
  leftMarginZone.className = "ruler__margin ruler__margin--left";
  leftMarginZone.style.width = `${leftPx}px`;

  const rightMarginZone = document.createElement("div");
  rightMarginZone.className = "ruler__margin ruler__margin--right";
  rightMarginZone.style.width = `${rightPx}px`;

  const ticksHost = document.createElement("div");
  ticksHost.className = "ruler__ticks";

  const stepInches = 0.125;
  const steps = Math.floor(totalInches / stepInches);
  for (let i = 1; i < steps; i++) {
    const posInches = i * stepInches;
    const x = posInches * DPI;
    const relInches = posInches - m.left;
    const absRel = Math.abs(relInches);
    const isWhole = Math.abs(absRel - Math.round(absRel)) < 0.01;
    const isHalf = !isWhole && Math.abs((absRel * 2) - Math.round(absRel * 2)) < 0.01;
    const isQuarter = !isWhole && !isHalf && Math.abs((absRel * 4) - Math.round(absRel * 4)) < 0.01;

    if (isWhole && Math.round(absRel) > 0) {
      const num = document.createElement("span");
      num.className = "ruler__num";
      num.style.left = `${x}px`;
      num.textContent = String(Math.round(absRel));
      ticksHost.append(num);
    } else {
      const tick = document.createElement("i");
      tick.className =
        "ruler__tick " +
        (isWhole ? "ruler__tick--lg" : isHalf ? "ruler__tick--md" : isQuarter ? "ruler__tick--sm" : "ruler__tick--xs");
      tick.style.left = `${x}px`;
      ticksHost.append(tick);
    }
  }

  // Draggable Left & Right Margin Handles (Symmetric by default!)
  const isSym = settings.rulerSymmetric !== false;
  const leftHandle = document.createElement("button");
  leftHandle.type = "button";
  leftHandle.className = "ruler__handle ruler__handle--left";
  leftHandle.style.left = `${leftPx}px`;
  leftHandle.title = `Left Margin: ${m.left.toFixed(2)}″ (${isSym ? "Mirrored with Right — hold Alt for single side" : "Independent"})`;

  const rightHandle = document.createElement("button");
  rightHandle.type = "button";
  rightHandle.className = "ruler__handle ruler__handle--right";
  rightHandle.style.left = `${w - rightPx}px`;
  rightHandle.title = `Right Margin: ${m.right.toFixed(2)}″ (${isSym ? "Mirrored with Left — hold Alt for single side" : "Independent"})`;

  // Quick Ruler Controls Pill (Symmetric Lock + Saved Widths)
  const symBtn = document.createElement("button");
  symBtn.type = "button";
  symBtn.className = "ruler__pill-btn" + (isSym ? " is-on" : "");
  symBtn.textContent = isSym ? "⇄ Even" : "⇄ Free";
  symBtn.title = isSym
    ? "Symmetric Margins ON: Both sides move together so your page stays even. Click to unlock."
    : "Symmetric Margins OFF: Each side moves independently. Click to lock evenly.";
  symBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  symBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settings.rulerSymmetric = settings.rulerSymmetric === false;
    if (settings.rulerSymmetric) {
      // Snap right margin to match left margin so they're immediately even
      state.page.margins.right = state.page.margins.left;
      applyPage();
    } else {
      renderRuler();
    }
    saveSettings();
    toast(
      settings.rulerSymmetric
        ? "Symmetric Ruler Lock ON (left & right margins move evenly)"
        : "Symmetric Ruler Lock OFF (independent left & right margins)",
      "info",
      1700,
    );
  });

  const presetsCount = settings.savedMarginPresets?.length || 0;
  const saveWidthBtn = document.createElement("button");
  saveWidthBtn.type = "button";
  saveWidthBtn.className = "ruler__pill-btn";
  saveWidthBtn.textContent = presetsCount > 0 ? `★ Widths (${presetsCount})` : "★ Save Width";
  saveWidthBtn.title = "Save or apply custom ruler page-width bookmarks";
  saveWidthBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  saveWidthBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openSavedWidthsDialog();
  });

  const rulerTools = document.createElement("div");
  rulerTools.className = "ruler__tools";
  rulerTools.append(symBtn, saveWidthBtn);

  const attachDrag = (side: "left" | "right", handle: HTMLElement) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startVal = side === "left" ? state.page.margins.left : state.page.margins.right;
      const zoom = settings.zoom || 1;

      const guideLeft = document.createElement("div");
      guideLeft.className = "sheet-margin-drag-guide";
      const guideRight = document.createElement("div");
      guideRight.className = "sheet-margin-drag-guide";
      const badge = document.createElement("div");
      badge.className = "ruler__drag-badge";
      sheet.append(guideLeft, guideRight);
      rulerEl?.append(badge);

      const syncGuide = (mirrored: boolean) => {
        const lPx = state.page.margins.left * DPI;
        const rPx = w - state.page.margins.right * DPI;
        guideLeft.style.left = `${lPx}px`;
        guideRight.style.left = `${rPx}px`;
        guideLeft.style.display = side === "left" || mirrored ? "block" : "none";
        guideRight.style.display = side === "right" || mirrored ? "block" : "none";
        const textWidthIn = Math.max(1, w / DPI - state.page.margins.left - state.page.margins.right).toFixed(2);
        badge.textContent = `Width: ${textWidthIn}″  ·  L: ${state.page.margins.left.toFixed(2)}″ / R: ${state.page.margins.right.toFixed(2)}″`;
      };
      syncGuide(settings.rulerSymmetric !== false && !e.altKey);

      const onMove = (ev: MouseEvent) => {
        const dxInches = (ev.clientX - startX) / (DPI * zoom);
        const raw = side === "left" ? startVal + dxInches : startVal - dxInches;
        const snapped = Math.round(Math.max(0.25, Math.min(3.0, raw)) * 8) / 8;
        const mirrored = settings.rulerSymmetric !== false && !ev.altKey;
        if (mirrored) {
          state.page.margins.left = snapped;
          state.page.margins.right = snapped;
        } else if (side === "left") {
          state.page.margins.left = snapped;
        } else {
          state.page.margins.right = snapped;
        }
        applyPage();
        syncGuide(mirrored);
      };

      const onUp = () => {
        guideLeft.remove();
        guideRight.remove();
        badge.remove();
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        setDirty(true);
        emit("page:change");
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  };

  attachDrag("left", leftHandle);
  attachDrag("right", rightHandle);

  rulerEl.append(leftMarginZone, rightMarginZone, ticksHost, leftHandle, rightHandle, rulerTools);
}

export function initPage(): void {
  sheet = document.getElementById("sheet")!;
  editorHost = document.getElementById("editor")!;
  editorHost.setAttribute("lang", "en");
  markers = document.getElementById("page-markers")!;

  watermarkLayer = document.createElement("div");
  watermarkLayer.id = "page-watermark-layer";
  watermarkLayer.className = "page-watermark-layer";
  sheet.insertBefore(watermarkLayer, editorHost);

  hfLayer = document.createElement("div");
  hfLayer.id = "page-hf-layer";
  hfLayer.className = "page-hf-layer";
  sheet.insertBefore(hfLayer, editorHost);

  marginGuidesEl = document.createElement("div");
  marginGuidesEl.className = "page-margin-guides";
  sheet.insertBefore(marginGuidesEl, editorHost);

  spreadSpineEl = document.createElement("div");
  spreadSpineEl.id = "spread-spine";
  spreadSpineEl.className = "spread-spine";
  spreadSpineEl.setAttribute("aria-hidden", "true");
  spreadSpineEl.innerHTML = `<span class="spread-spine__tag spread-spine__tag--left">Left Page</span><i class="spread-spine__line"></i><span class="spread-spine__tag spread-spine__tag--right">Right Page</span>`;
  sheet.insertBefore(spreadSpineEl, editorHost);

  initDoodleEngine(sheet, editorHost);
  initProjectSidebar();

  printStyle = document.createElement("style");
  printStyle.id = "print-page";
  document.head.append(printStyle);

  pageFlowStyle = document.createElement("style");
  pageFlowStyle.id = "page-flow-style";
  document.head.append(pageFlowStyle);

  const wrap = document.getElementById("sheet-wrap");
  if (wrap && !document.getElementById("page-ruler")) {
    rulerEl = document.createElement("div");
    rulerEl.id = "page-ruler";
    rulerEl.className = "page-ruler";
    wrap.insertBefore(rulerEl, sheet);
  }

  // Add floating "+ Add Page" bar directly below the sheet on the canvas
  if (wrap && !document.getElementById("add-page-bar")) {
    const bar = document.createElement("div");
    bar.id = "add-page-bar";
    bar.className = "add-page-bar";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-page-btn";
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Add New Page</span><kbd>Ctrl+Enter</kbd>`;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => addNewPage(true));
    bar.append(btn);
    wrap.append(bar);
  }

  const workspace = document.getElementById("workspace");
  if (workspace && !document.getElementById("desk-scratchpad")) {
    scratchpadEl = buildScratchpad();
    workspace.append(scratchpadEl);
    syncScratchpadVisibility();
  }

  document.documentElement.dataset.canvasView = settings.canvasViewMode || "single";

  new ResizeObserver(() => scheduleLayout()).observe(editorHost);
  on("page:change", () => applyPage());
  on("proofing:update", () => scheduleLayout());
  applyPage();
  setZoom(settings.zoom, false);
}

/** Inserts a new page (either at the end of the document or at the current cursor) and scrolls to it. */
export function addNewPage(atEnd = false): void {
  const ed = state.editor;
  if (!ed) return;
  if (atEnd) {
    const endPos = ed.state.doc.content.size;
    ed.chain()
      .focus()
      .insertContentAt(endPos, [{ type: "pageBreak" }, { type: "paragraph" }])
      .focus("end")
      .run();
  } else {
    ed.chain().focus().setPageBreak().run();
  }
  layout();
  requestAnimationFrame(() => {
    const coords = ed.view.coordsAtPos(ed.state.selection.head);
    const canvas = document.getElementById("canvas");
    if (canvas && coords) {
      const cr = canvas.getBoundingClientRect();
      if (coords.top > cr.bottom - 120 || coords.top < cr.top + 60) {
        canvas.scrollBy({ top: coords.top - cr.top - 140, behavior: "smooth" });
      }
    }
  });
}

export function scrollToPage(pageNum: number): void {
  const canvas = document.getElementById("canvas");
  if (!canvas || !sheet) return;
  const { h } = pageDims();
  const zoom = settings.zoom || 1;
  const targetY = Math.max(0, (pageNum - 1) * h * zoom);
  canvas.scrollTo({ top: targetY, behavior: "smooth" });
}

export function applyPage(): void {
  const { w, h } = pageDims();
  const m = state.page.margins;
  const root = sheet.style;
  root.setProperty("--page-w", `${w}px`);
  root.setProperty("--page-h", `${h}px`);
  root.setProperty("--m-top", `${m.top * DPI}px`);
  root.setProperty("--m-right", `${m.right * DPI}px`);
  root.setProperty("--m-bottom", `${m.bottom * DPI}px`);
  root.setProperty("--m-left", `${m.left * DPI}px`);
  const pm = editorHost.firstElementChild as HTMLElement | null;
  editorHost.style.setProperty("--doc-font", `"${state.defaults.fontFamily}"`);
  editorHost.style.setProperty("--doc-size", `${state.defaults.fontSize}pt`);
  if (pm) pm.style.fontFamily = "";

  // Opt-in layout attributes (all off/clean by default)
  const cols = state.page.columns && state.page.columns > 1 ? state.page.columns : 1;
  sheet.dataset.columns = cols > 1 ? String(cols) : "";
  sheet.dataset.columnRule = cols > 1 && state.page.columnRule ? "on" : "";
  sheet.dataset.pageBorder = state.page.pageBorder && state.page.pageBorder !== "none" ? state.page.pageBorder : "";
  sheet.dataset.hyphenation = state.page.hyphenation ? "on" : "";
  sheet.dataset.baselineGrid = state.page.baselineGrid ? "on" : "";
  document.documentElement.dataset.canvasView = settings.canvasViewMode || "single";

  const sizeName = state.page.size === "Executive" ? "7.25in 10.5in" : state.page.size;
  printStyle.textContent = `@page { size: ${sizeName} ${state.page.orientation}; margin: 0mm !important; } @media print { #sheet { padding: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in !important; } }`;
  renderRuler();
  scheduleLayout();
}

let raf = 0;
export function scheduleLayout(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    layout();
  });
}

function renderMarginGuides(n: number, h: number): void {
  if (!marginGuidesEl) return;
  marginGuidesEl.replaceChildren();
  const m = state.page.margins;
  const mTop = m.top * DPI;
  const mRight = m.right * DPI;
  const mBottom = m.bottom * DPI;
  const mLeft = m.left * DPI;

  for (let p = 1; p <= n; p++) {
    const pageTop = (p - 1) * h;
    const box = document.createElement("div");
    box.className = "page-margin-box";
    box.style.top = `${pageTop + mTop}px`;
    box.style.left = `${mLeft}px`;
    box.style.right = `${mRight}px`;
    box.style.height = `${Math.max(40, h - mTop - mBottom)}px`;
    box.innerHTML =
      `<i class="mg mg--tl"></i><i class="mg mg--tr"></i><i class="mg mg--bl"></i><i class="mg mg--br"></i>` +
      `<span class="page-margin-box__label">Margins: ${m.top.toFixed(2)}″ T · ${m.left.toFixed(2)}″ L · ${m.right.toFixed(2)}″ R · ${m.bottom.toFixed(2)}″ B</span>`;
    marginGuidesEl.append(box);
  }
}

function renderWatermarks(n: number, h: number): void {
  if (!watermarkLayer) return;
  watermarkLayer.replaceChildren();
  const wmText = (state.page.watermark ?? "").trim();
  if (!wmText) return;

  for (let p = 1; p <= n; p++) {
    const stamp = document.createElement("div");
    stamp.className = "page-watermark";
    stamp.style.top = `${(p - 1) * h + h * 0.5}px`;
    stamp.textContent = wmText;
    watermarkLayer.append(stamp);
  }
}

function renderHeadersAndFooters(n: number, h: number): void {
  if (!hfLayer) return;
  hfLayer.replaceChildren();
  const headerText = (state.page.header ?? "").trim();
  const footerText = (state.page.footer ?? "").trim();
  const showPageNums = Boolean(state.page.pageNumbers);
  const diffFirst = Boolean(state.page.differentFirstPage);

  if (!headerText && !footerText && !showPageNums) {
    return;
  }

  for (let p = 1; p <= n; p++) {
    if (diffFirst && p === 1) continue;
    const pageTop = (p - 1) * h;
    const pageBottom = p * h;

    if (headerText) {
      const hBand = document.createElement("div");
      hBand.className = "page-hf page-hf--header is-filled";
      hBand.style.top = `${pageTop + 18}px`;
      hBand.title = "Click to edit Page Header";
      const span = document.createElement("span");
      span.className = "page-hf__text";
      span.textContent = headerText;
      hBand.append(span);
      hBand.addEventListener("mousedown", (e) => e.preventDefault());
      hBand.addEventListener("click", () => void editHeaderFooter("header"));
      hfLayer.append(hBand);
    }

    if (footerText || showPageNums) {
      const fBand = document.createElement("div");
      fBand.className = "page-hf page-hf--footer is-filled";
      fBand.style.top = `${pageBottom - 36}px`;
      fBand.title = "Click to edit Page Footer";
      const leftSpan = document.createElement("span");
      leftSpan.className = "page-hf__text";
      leftSpan.textContent = footerText;
      const rightSpan = document.createElement("span");
      rightSpan.className = "page-hf__pagenum";
      rightSpan.textContent = showPageNums ? `Page ${p} of ${n}` : "";
      fBand.append(leftSpan, rightSpan);
      fBand.addEventListener("mousedown", (e) => e.preventDefault());
      fBand.addEventListener("click", () => void editHeaderFooter("footer"));
      hfLayer.append(fBand);
    }
  }
}

function layout(): void {
  if (laying) return;
  laying = true;
  try {
    const { w, h } = pageDims();
    const isSpread = settings.canvasViewMode === "spread";
    const sheetW = isSpread ? Math.round(w * 1.65) : w;
    const mTop = state.page.margins.top * DPI;
    const mBottom = state.page.margins.bottom * DPI;

    // 1. Reset previous auto-pagination pushes and explicit page break heights
    if (pageFlowStyle) pageFlowStyle.textContent = "";
    editorHost.querySelectorAll<HTMLElement>("[data-auto-page-push]").forEach((el) => {
      el.style.marginTop = "";
      delete el.dataset.autoPagePush;
    });
    const breaks = editorHost.querySelectorAll<HTMLElement>(".page-break");
    breaks.forEach((br) => (br.style.height = ""));

    const sRect0 = sheet.getBoundingClientRect();
    const rectScale = sRect0.width > 0 ? sRect0.width / sheetW : (settings.zoom || 1);

    // 2. Sequentially paginate explicit .page-break nodes AND overflowing blocks
    //    so paragraphs/headings/tables jump cleanly across the page gap from
    //    Page N's bottom margin to Page (N+1)'s top margin.
    const pm = editorHost.querySelector<HTMLElement>(".ProseMirror");
    const flowRules: string[] = [];
    let breakIdx = 0;
    if (pm) {
      const children = Array.from(pm.children) as HTMLElement[];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const sheetTop = sheet.getBoundingClientRect().top;
        const rect = child.getBoundingClientRect();
        const top = (rect.top - sheetTop) / rectScale;
        const bottom = (rect.bottom - sheetTop) / rectScale;

        if (child.classList.contains("page-break")) {
          breakIdx++;
          const pageIdx = Math.max(1, Math.ceil((top + 1) / h));
          const pageEnd = pageIdx * h;
          const height = Math.max(36, Math.ceil(pageEnd + mTop - top));
          child.style.height = `${height}px`;
          flowRules.push(`#sheet .ProseMirror > :nth-child(${i + 1}) { height: ${height}px !important; }`);
          child.dataset.pageLabel = `Page ${pageIdx + 1}`;
          child.dataset.breakIndex = String(breakIdx);
          continue;
        }

        const pageIdx = Math.max(1, Math.floor(top / h) + 1);
        const pageStartPrintable = (pageIdx - 1) * h + mTop;
        const pageEndPrintable = pageIdx * h - mBottom;
        const nextPageStartPrintable = pageIdx * h + mTop;

        // If block starts inside the top margin of Page 2+, push it down to the page's top printable margin
        if (pageIdx > 1 && top < pageStartPrintable - 2) {
          const pushPx = Math.max(12, Math.ceil(pageStartPrintable - top + 11));
          child.style.setProperty("margin-top", `${pushPx}px`, "important");
          child.dataset.autoPagePush = "1";
          flowRules.push(`#sheet .ProseMirror > :nth-child(${i + 1}) { margin-top: ${pushPx}px !important; }`);
          continue;
        }

        // If block crosses into the bottom margin / page break zone and isn't already at the very top of the page,
        // push it cleanly onto the top margin of the next page.
        if (bottom > pageEndPrintable && top > pageStartPrintable + 14) {
          const pushPx = Math.max(16, Math.ceil(nextPageStartPrintable - top + 11));
          child.style.setProperty("margin-top", `${pushPx}px`, "important");
          child.dataset.autoPagePush = "1";
          flowRules.push(`#sheet .ProseMirror > :nth-child(${i + 1}) { margin-top: ${pushPx}px !important; }`);
        }
      }
    }
    if (pageFlowStyle) {
      pageFlowStyle.textContent = flowRules.join("\n");
    }

    const contentH = editorHost.offsetHeight + mTop + mBottom;
    const n = Math.max(1, Math.ceil((contentH - 1) / h));
    sheet.style.minHeight = `${n * h}px`;

    pageCount = n;
    markers.replaceChildren();
    const sRectFinal = sheet.getBoundingClientRect();
    const scaleFinal = sRectFinal.width > 0 ? sRectFinal.width / sheetW : rectScale;
    const blockRects = pm
      ? Array.from(pm.children)
          .filter((el) => !el.classList.contains("page-break"))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              top: (r.top - sRectFinal.top) / scaleFinal,
              bottom: (r.bottom - sRectFinal.top) / scaleFinal,
            };
          })
      : [];

    for (let k = 1; k < n; k++) {
      const boundaryY = k * h;
      const straddled = blockRects.some((b) => b.top < boundaryY - 6 && b.bottom > boundaryY + 6);
      const line = document.createElement("div");
      line.className = straddled ? "page-marker page-marker--passthrough" : "page-marker";
      line.style.top = `${boundaryY}px`;
      line.dataset.page = `Page ${k + 1}`;
      markers.append(line);
    }
    emit("page:count", n);

    renderMarginGuides(n, h);
    renderWatermarks(n, h);
    renderHeadersAndFooters(n, h);
    syncDoodleCanvasDimensions(sheetW, n * h);
  } finally {
    laying = false;
  }
}

/** Page index (1-based) where the caret currently is. */
export function currentPage(): number {
  try {
    const { w, h } = pageDims();
    const isSpread = settings.canvasViewMode === "spread";
    const sheetW = isSpread ? Math.round(w * 1.65) : w;
    const coords = state.editor.view.coordsAtPos(state.editor.state.selection.head);
    const r = sheet.getBoundingClientRect();
    const scale = r.width > 0 ? r.width / sheetW : (settings.zoom || 1);
    const y = (coords.top - r.top) / scale;
    return Math.min(pageCount, Math.max(1, Math.floor(y / h) + 1));
  } catch {
    return 1;
  }
}

export function setZoom(
  z: number,
  persist = true,
  focalPoint?: { clientX: number; clientY: number },
): void {
  const prevZoom = settings.zoom || 1;
  const clamped = Math.round(Math.min(4, Math.max(0.35, z)) * 200) / 200;
  const currentApplied = parseFloat(sheet?.style.getPropertyValue("zoom") || "0");
  if (Math.abs(clamped - prevZoom) < 0.001 && Math.abs(clamped - currentApplied) < 0.001) return;

  const canvas = document.getElementById("canvas");
  let anchorY = 0;
  let anchorX = 0;
  let prevScrollTop = 0;
  let prevScrollLeft = 0;
  if (canvas && focalPoint) {
    const rect = canvas.getBoundingClientRect();
    anchorY = focalPoint.clientY - rect.top;
    anchorX = focalPoint.clientX - rect.left;
    prevScrollTop = canvas.scrollTop;
    prevScrollLeft = canvas.scrollLeft;
  }

  settings.zoom = clamped;
  sheet.style.setProperty("zoom", String(clamped));
  rulerEl?.style.setProperty("zoom", String(clamped));

  if (canvas && focalPoint && prevZoom > 0) {
    const ratio = clamped / prevZoom;
    canvas.scrollTop = (prevScrollTop + anchorY) * ratio - anchorY;
    canvas.scrollLeft = (prevScrollLeft + anchorX) * ratio - anchorX;
  }

  if (persist) saveSettings();
  emit("zoom:change", clamped);
  scheduleLayout();
}

/** Fit the page width into the visible canvas. */
export function zoomToWidth(): void {
  const canvas = document.getElementById("canvas")!;
  const { w } = pageDims();
  setZoom((canvas.clientWidth - 64) / w);
}

export function zoomToPage(): void {
  const canvas = document.getElementById("canvas")!;
  const { w, h } = pageDims();
  setZoom(Math.min((canvas.clientWidth - 64) / w, (canvas.clientHeight - 48) / h));
}
