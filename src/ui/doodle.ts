/**
 * Freehand Draw / Doodle & Windows Ink Engine for Typo (`#page-doodle-under` & `#page-doodle-over`).
 *
 * Features:
 * - Two dedicated transparent HTML5 canvases mounted inside `#sheet`:
 *   1. `Behind Text & Images` (`#page-doodle-under`, z-index: 1 — underneath `#editor`)
 *   2. `Above Text & Images` (`#page-doodle-over`, z-index: 4 — above `#editor`)
 * - Tools: Pencil (textured pressure-sensitive graphite), Pen (smooth ink),
 *   Highlighter (translucent marker), and Doodle Eraser (`destination-out` on doodle
 *   canvases ONLY — never touches text, stickers, or inserted images).
 * - Draggable Floating Side Palette (`#doodle-toolbar`) that can be moved anywhere on
 *   screen and automatically hides when Draw Mode is disabled.
 * - Exact 1:1 cursor tracking (`getBoundingClientRect()` on the canvas itself + viewport
 *   cursor ring) so drawing and erasing happen at the exact tip of the mouse/stylus.
 */
import { state, emit, on, setDirty } from "../core/state";
import { h, icon, toast } from "./dom";

export type DoodleTool = "pencil" | "pen" | "highlighter" | "eraser";
export type DoodleLayer = "over" | "under";

interface DoodleSnapshot {
  under: string;
  over: string;
}

const DOODLE_SWATCHES = [
  { color: "#1e1e2e", label: "Charcoal Black" },
  { color: "#e64553", label: "Crimson Red" },
  { color: "#fe640b", label: "Amber Orange" },
  { color: "#df8e1d", label: "Warm Gold" },
  { color: "#40a02b", label: "Forest Green" },
  { color: "#1e66f5", label: "Cobalt Blue" },
  { color: "#8839ef", label: "Royal Violet" },
  { color: "#ea76cb", label: "Sakura Pink" },
  { color: "#ffffff", label: "Chalk White" },
];

let underCanvas: HTMLCanvasElement | null = null;
let overCanvas: HTMLCanvasElement | null = null;
let toolbarEl: HTMLElement | null = null;
let cursorPreviewEl: HTMLElement | null = null;

let activeMode = false;
let currentTool: DoodleTool = "pencil";
let currentLayer: DoodleLayer = "over";
let eraseBothLayers = true;
let strokeColor = "#1e66f5";
let pencilSize = 3;
let penSize = 4;
let highlighterSize = 18;
let eraserSize = 28;

let isDrawing = false;
let activePointerId: number | null = null;
let lastPenTimestamp = 0;
let lastPoint: { x: number; y: number; pressure: number } | null = null;

let undoStack: DoodleSnapshot[] = [];
let redoStack: DoodleSnapshot[] = [];
const MAX_HISTORY = 25;

let restoringBitmap = false;
let lastLoadedUnder = "";
let lastLoadedOver = "";

// Saved floating dock position across toggles
let dockPos: { left: number; top: number } | null = null;

export function isDoodleModeActive(): boolean {
  return activeMode;
}

export function getDoodleTool(): DoodleTool {
  return currentTool;
}

export function getDoodleLayer(): DoodleLayer {
  return currentLayer;
}

function getActiveSize(): number {
  switch (currentTool) {
    case "pencil":
      return pencilSize;
    case "pen":
      return penSize;
    case "highlighter":
      return highlighterSize;
    case "eraser":
      return eraserSize;
  }
}

function setActiveSize(val: number): void {
  const clamped = Math.max(1, Math.min(64, Math.round(val)));
  switch (currentTool) {
    case "pencil":
      pencilSize = clamped;
      break;
    case "pen":
      penSize = clamped;
      break;
    case "highlighter":
      highlighterSize = clamped;
      break;
    case "eraser":
      eraserSize = clamped;
      break;
  }
}

/** Mounts the Under & Over doodle canvases inside `#sheet` and sets up the floating Draw Dock. */
export function initDoodleEngine(sheet: HTMLElement, editorHost: HTMLElement): void {
  if (!underCanvas) {
    underCanvas = document.createElement("canvas");
    underCanvas.id = "page-doodle-under";
    underCanvas.className = "page-doodle-canvas page-doodle-canvas--under";
    sheet.insertBefore(underCanvas, editorHost);
  }

  if (!overCanvas) {
    overCanvas = document.createElement("canvas");
    overCanvas.id = "page-doodle-over";
    overCanvas.className = "page-doodle-canvas page-doodle-canvas--over";
    sheet.append(overCanvas);
  }

  if (!cursorPreviewEl) {
    cursorPreviewEl = document.createElement("div");
    cursorPreviewEl.id = "doodle-cursor-preview";
    cursorPreviewEl.className = "doodle-cursor-preview";
    cursorPreviewEl.hidden = true;
    document.body.append(cursorPreviewEl);
  }

  bindSheetPointerEvents(sheet);

  on("page:change", () => {
    syncDoodleFromPageState();
  });
}

/** Resizes both doodle canvases when `#sheet` dimensions or page counts change, preserving existing ink. */
export function syncDoodleCanvasDimensions(widthPx: number, heightPx: number): void {
  if (!underCanvas || !overCanvas) return;
  const w = Math.max(300, Math.round(widthPx));
  const h = Math.max(400, Math.round(heightPx));

  resizeSingleCanvasPreservingInk(underCanvas, w, h, state.page.doodleUnder);
  resizeSingleCanvasPreservingInk(overCanvas, w, h, state.page.doodleOver);
}

function resizeSingleCanvasPreservingInk(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  fallbackDataUrl?: string,
): void {
  if (canvas.width === w && canvas.height === h) return;

  let tempCanvas: HTMLCanvasElement | null = null;
  if (canvas.width > 0 && canvas.height > 0) {
    tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tctx = tempCanvas.getContext("2d");
    tctx?.drawImage(canvas, 0, 0);
  }

  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  if (tempCanvas && tempCanvas.width > 0 && tempCanvas.height > 0) {
    ctx.drawImage(tempCanvas, 0, 0);
  } else if (fallbackDataUrl) {
    void drawDataUrlToCanvas(canvas, fallbackDataUrl);
  }
}

function drawDataUrlToCanvas(canvas: HTMLCanvasElement, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve();
      return;
    }
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      resolve();
      return;
    }
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) return true;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 64) {
    if (data[i] !== 0) return false;
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return false;
  }
  return true;
}

function exportCanvasDataUrl(canvas: HTMLCanvasElement | null): string {
  if (!canvas || isCanvasBlank(canvas)) return "";
  return canvas.toDataURL("image/png");
}

/** Saves current canvas bitmaps into `state.page.doodleUnder` and `state.page.doodleOver`. */
export function commitDoodleToPageState(markDirty = true): void {
  if (restoringBitmap) return;
  const u = exportCanvasDataUrl(underCanvas);
  const o = exportCanvasDataUrl(overCanvas);
  lastLoadedUnder = u;
  lastLoadedOver = o;
  state.page.doodleUnder = u || undefined;
  state.page.doodleOver = o || undefined;
  if (markDirty) {
    setDirty(true);
  }
}

/** Restores `state.page.doodleUnder` and `state.page.doodleOver` onto the canvases (e.g. on tab switch or file open). */
export function syncDoodleFromPageState(): void {
  if (!underCanvas || !overCanvas) return;
  const wantUnder = state.page.doodleUnder || "";
  const wantOver = state.page.doodleOver || "";
  if (wantUnder === lastLoadedUnder && wantOver === lastLoadedOver) return;

  restoringBitmap = true;
  lastLoadedUnder = wantUnder;
  lastLoadedOver = wantOver;
  undoStack = [];
  redoStack = [];

  Promise.all([
    drawDataUrlToCanvas(underCanvas, wantUnder),
    drawDataUrlToCanvas(overCanvas, wantOver),
  ]).finally(() => {
    restoringBitmap = false;
    updateToolbarState();
  });
}

function captureSnapshot(): DoodleSnapshot {
  return {
    under: exportCanvasDataUrl(underCanvas),
    over: exportCanvasDataUrl(overCanvas),
  };
}

function pushUndoSnapshot(snap: DoodleSnapshot): void {
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  updateToolbarState();
}

export async function undoDoodleStroke(): Promise<void> {
  if (!underCanvas || !overCanvas || undoStack.length === 0) return;
  const current = captureSnapshot();
  const prev = undoStack.pop()!;
  redoStack.push(current);

  restoringBitmap = true;
  await Promise.all([
    drawDataUrlToCanvas(underCanvas, prev.under),
    drawDataUrlToCanvas(overCanvas, prev.over),
  ]);
  restoringBitmap = false;
  commitDoodleToPageState(true);
  updateToolbarState();
}

export async function redoDoodleStroke(): Promise<void> {
  if (!underCanvas || !overCanvas || redoStack.length === 0) return;
  const current = captureSnapshot();
  const next = redoStack.pop()!;
  undoStack.push(current);

  restoringBitmap = true;
  await Promise.all([
    drawDataUrlToCanvas(underCanvas, next.under),
    drawDataUrlToCanvas(overCanvas, next.over),
  ]);
  restoringBitmap = false;
  commitDoodleToPageState(true);
  updateToolbarState();
}

export function clearDoodles(target: "active" | "all" = "all"): void {
  if (!underCanvas || !overCanvas) return;
  const before = captureSnapshot();
  if (!before.under && !before.over) {
    toast("No doodles on the page to clear", "info", 1400);
    return;
  }
  pushUndoSnapshot(before);

  if (target === "all" || currentLayer === "under") {
    underCanvas.getContext("2d")?.clearRect(0, 0, underCanvas.width, underCanvas.height);
  }
  if (target === "all" || currentLayer === "over") {
    overCanvas.getContext("2d")?.clearRect(0, 0, overCanvas.width, overCanvas.height);
  }
  commitDoodleToPageState(true);
  updateToolbarState();
  toast(
    target === "all"
      ? "Cleared all doodles (text & images untouched)"
      : `Cleared ${currentLayer === "over" ? "Above" : "Behind"} doodle layer`,
    "info",
    1700,
  );
}

export function toggleDoodleMode(force?: boolean, initialTool?: DoodleTool): void {
  activeMode = force !== undefined ? force : !activeMode;
  if (initialTool) currentTool = initialTool;
  document.documentElement.dataset.doodleMode = activeMode ? "on" : "off";
  document.documentElement.dataset.doodleTool = currentTool;
  document.documentElement.dataset.doodleLayer = currentLayer;

  if (activeMode) {
    ensureToolbarMounted();
    if (toolbarEl) toolbarEl.hidden = false;
    updateToolbarState();
  } else {
    if (toolbarEl) toolbarEl.hidden = true;
    if (cursorPreviewEl) cursorPreviewEl.hidden = true;
  }
  emit("doodle:change", activeMode);
}

export function enableDoodleMode(tool: DoodleTool = "pencil", layer?: DoodleLayer): void {
  if (layer) currentLayer = layer;
  toggleDoodleMode(true, tool);
}

/**
 * Computes exact 1:1 internal bitmap coordinates on the doodle canvas directly from the
 * canvas's live `getBoundingClientRect()`, eliminating any offset from CSS zoom, scroll, or margins.
 */
function getCanvasCoords(e: PointerEvent): { x: number; y: number; pressure: number; scale: number } {
  const refCanvas = overCanvas || underCanvas;
  if (!refCanvas) {
    return { x: 0, y: 0, pressure: 0.65, scale: 1 };
  }
  const rect = refCanvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? refCanvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? refCanvas.height / rect.height : 1;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const rawPressure = e.pointerType === "pen" ? (e.pressure || 0.5) : 0.65;
  const pressure = Math.max(0.15, Math.min(1.0, rawPressure));
  const visualScale = rect.width > 0 ? rect.width / refCanvas.width : 1;
  return { x, y, pressure, scale: visualScale };
}

function isStylusEraserButton(e: PointerEvent): boolean {
  return e.pointerType === "pen" && ((e.buttons & 32) !== 0 || e.button === 5);
}

function bindSheetPointerEvents(sheet: HTMLElement): void {
  sheet.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!activeMode) return;
      if (e.pointerType === "pen") {
        lastPenTimestamp = performance.now();
        setStylusBadgeVisible(true);
      }
      updateCursorPreview(e);
    },
    { passive: true },
  );

  sheet.addEventListener("pointerleave", () => {
    if (cursorPreviewEl) cursorPreviewEl.hidden = true;
  });

  sheet.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (!activeMode) return;
      if (e.button !== 0 && e.button !== 5 && (e.buttons & 32) === 0) return;

      // Palm rejection when using Windows Ink / SuperDisplay stylus
      if (e.pointerType === "touch" && performance.now() - lastPenTimestamp < 2200) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.pointerType === "pen") {
        lastPenTimestamp = performance.now();
        setStylusBadgeVisible(true);
      }

      e.preventDefault();
      e.stopPropagation();

      if (!underCanvas || !overCanvas) return;

      pushUndoSnapshot(captureSnapshot());

      isDrawing = true;
      activePointerId = e.pointerId;
      try {
        sheet.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      const pt = getCanvasCoords(e);
      lastPoint = pt;
      const effectiveTool: DoodleTool = isStylusEraserButton(e) ? "eraser" : currentTool;
      updateCursorPreview(e);
      drawDot(pt, effectiveTool);
    },
    true,
  );

  sheet.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!activeMode || !isDrawing || e.pointerId !== activePointerId) return;
      e.preventDefault();
      e.stopPropagation();

      updateCursorPreview(e);
      const effectiveTool: DoodleTool = isStylusEraserButton(e) ? "eraser" : currentTool;
      const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      const events = coalesced.length > 0 ? coalesced : [e];

      for (const ev of events) {
        const pt = getCanvasCoords(ev);
        if (!lastPoint) {
          lastPoint = pt;
          drawDot(pt, effectiveTool);
          continue;
        }
        if (Math.hypot(pt.x - lastPoint.x, pt.y - lastPoint.y) < 0.4) continue;
        drawDirectStroke(lastPoint, pt, effectiveTool);
        lastPoint = pt;
      }
    },
    true,
  );

  const finishStroke = (e: PointerEvent) => {
    if (!isDrawing || e.pointerId !== activePointerId) return;
    e.preventDefault();
    e.stopPropagation();
    isDrawing = false;
    activePointerId = null;
    lastPoint = null;
    try {
      if (sheet.hasPointerCapture(e.pointerId)) {
        sheet.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    commitDoodleToPageState(true);
    updateToolbarState();
  };

  sheet.addEventListener("pointerup", finishStroke, true);
  sheet.addEventListener("pointercancel", finishStroke, true);

  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (!activeMode) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        e.preventDefault();
        toggleDoodleMode(false);
        toast("Exited Draw Mode — back to typing", "info", 1400);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void undoDoodleStroke();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        void redoDoodleStroke();
        return;
      }
      if (e.key === "[") {
        e.preventDefault();
        setActiveSize(getActiveSize() - 2);
        updateToolbarState();
      } else if (e.key === "]") {
        e.preventDefault();
        setActiveSize(getActiveSize() + 2);
        updateToolbarState();
      }
    },
    true,
  );
}

function getTargetContexts(tool: DoodleTool): CanvasRenderingContext2D[] {
  const ctxs: CanvasRenderingContext2D[] = [];
  if (tool === "eraser" && eraseBothLayers) {
    const u = underCanvas?.getContext("2d");
    const o = overCanvas?.getContext("2d");
    if (u) ctxs.push(u);
    if (o) ctxs.push(o);
    return ctxs;
  }
  const target = currentLayer === "under" ? underCanvas : overCanvas;
  const c = target?.getContext("2d");
  if (c) ctxs.push(c);
  return ctxs;
}

function drawDot(pt: { x: number; y: number; pressure: number }, tool: DoodleTool): void {
  const ctxs = getTargetContexts(tool);
  const baseSize = tool === "eraser" ? eraserSize : getActiveSize();

  for (const ctx of ctxs) {
    ctx.save();
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, baseSize * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (tool === "highlighter") {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, baseSize * 0.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (tool === "pencil") {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = Math.min(0.92, 0.55 + pt.pressure * 0.38);
      ctx.fillStyle = strokeColor;
      const r = Math.max(0.75, baseSize * 0.5 * (0.75 + pt.pressure * 0.4));
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.fillStyle = strokeColor;
      const r = Math.max(0.8, baseSize * 0.5 * (0.75 + pt.pressure * 0.4));
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Draws directly between `from` and `to` right up to the live cursor point (`to.x, to.y`)
 * so there is zero trailing lag behind the mouse or stylus tip.
 */
function drawDirectStroke(
  from: { x: number; y: number; pressure: number },
  to: { x: number; y: number; pressure: number },
  tool: DoodleTool,
): void {
  const ctxs = getTargetContexts(tool);
  const baseSize = tool === "eraser" ? eraserSize : getActiveSize();
  const pressure = (from.pressure + to.pressure) * 0.5;

  for (const ctx of ctxs) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = baseSize;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (tool === "highlighter") {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = baseSize;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    } else if (tool === "pencil") {
      ctx.globalCompositeOperation = "source-over";
      const w = Math.max(1, baseSize * (0.75 + pressure * 0.4));
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = w;
      ctx.globalAlpha = Math.min(0.95, 0.55 + pressure * 0.4);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      // Subtle graphite grain along the stroke
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.min(10, Math.max(1, Math.floor(dist / 3)));
      ctx.fillStyle = strokeColor;
      for (let i = 0; i < steps; i++) {
        const t = i / steps;
        const gx = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * w * 0.5;
        const gy = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * w * 0.5;
        ctx.globalAlpha = 0.2 * pressure;
        ctx.fillRect(gx, gy, 1.2, 1.2);
      }
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(1, baseSize * (0.75 + pressure * 0.4));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Positions the fixed cursor preview ring at the exact viewport `clientX, clientY` of the mouse/stylus. */
function updateCursorPreview(e: PointerEvent): void {
  if (!cursorPreviewEl) return;
  const { scale } = getCanvasCoords(e);
  const effectiveTool: DoodleTool = isStylusEraserButton(e) ? "eraser" : currentTool;
  const rawSize = effectiveTool === "eraser" ? eraserSize : getActiveSize();
  const visualDiameter = Math.max(6, rawSize * scale);

  cursorPreviewEl.hidden = false;
  cursorPreviewEl.style.width = `${visualDiameter}px`;
  cursorPreviewEl.style.height = `${visualDiameter}px`;
  cursorPreviewEl.style.left = `${e.clientX}px`;
  cursorPreviewEl.style.top = `${e.clientY}px`;
  cursorPreviewEl.dataset.tool = effectiveTool;
  cursorPreviewEl.style.borderColor = effectiveTool === "eraser" ? "#f38ba8" : strokeColor;
  cursorPreviewEl.style.background =
    effectiveTool === "eraser" ? "rgba(243, 139, 168, 0.14)" : "transparent";
}

function setStylusBadgeVisible(visible: boolean): void {
  const badge = toolbarEl?.querySelector<HTMLElement>("[data-doodle-stylus]");
  if (badge) badge.hidden = !visible;
}

/** Builds the movable, draggable floating side palette (`#doodle-toolbar`). */
function ensureToolbarMounted(): void {
  if (toolbarEl && document.body.contains(toolbarEl)) return;

  const makeToolBtn = (tool: DoodleTool, label: string, ic: string, tip: string) =>
    h(
      "button",
      {
        type: "button",
        class: "doodle-dock__tool",
        "data-tool-btn": tool,
        "data-tip": tip,
        onclick: () => {
          currentTool = tool;
          document.documentElement.dataset.doodleTool = currentTool;
          updateToolbarState();
        },
      },
      icon(ic, 15),
      h("span", {}, label),
    );

  const makeLayerBtn = (layer: DoodleLayer, label: string, ic: string, tip: string) =>
    h(
      "button",
      {
        type: "button",
        class: "doodle-dock__layer",
        "data-layer-btn": layer,
        "data-tip": tip,
        onclick: () => {
          currentLayer = layer;
          document.documentElement.dataset.doodleLayer = currentLayer;
          updateToolbarState();
          toast(
            layer === "over"
              ? "Drawing Layer: Above Text & Images"
              : "Drawing Layer: Behind Text & Images",
            "info",
            1400,
          );
        },
      },
      icon(ic, 13),
      h("span", {}, label),
    );

  const swatchButtons = DOODLE_SWATCHES.map((s) =>
    h("button", {
      type: "button",
      class: "doodle-dock__swatch",
      "data-swatch": s.color,
      "data-tip": s.label,
      style: `background:${s.color}`,
      onclick: () => {
        strokeColor = s.color;
        if (currentTool === "eraser") currentTool = "pencil";
        updateToolbarState();
      },
    }),
  );

  const customColorInput = h("input", {
    type: "color",
    class: "doodle-dock__color-picker",
    value: strokeColor,
    title: "Pick Custom Color",
    oninput: (ev: Event) => {
      strokeColor = (ev.target as HTMLInputElement).value;
      if (currentTool === "eraser") currentTool = "pencil";
      updateToolbarState();
    },
  }) as HTMLInputElement;

  const customColorWrap = h(
    "label",
    {
      class: "doodle-dock__custom-color",
      "data-tip": "Custom Color Picker",
    },
    customColorInput,
    icon("Pipette", 12),
  );

  const sizeSlider = h("input", {
    type: "range",
    class: "doodle-dock__slider",
    min: "1",
    max: "64",
    value: String(getActiveSize()),
    oninput: (ev: Event) => {
      setActiveSize(Number((ev.target as HTMLInputElement).value));
      updateToolbarState();
    },
  }) as HTMLInputElement;

  const sizeValueEl = h("span", { class: "doodle-dock__size-val", "data-doodle-size": "1" }, `${getActiveSize()}px`);

  const eraseBothChk = h("input", {
    type: "checkbox",
    checked: eraseBothLayers,
    onchange: (ev: Event) => {
      eraseBothLayers = (ev.target as HTMLInputElement).checked;
      updateToolbarState();
    },
  }) as HTMLInputElement;

  const eraseBothRow = h(
    "label",
    {
      class: "doodle-dock__chk",
      "data-erase-both": "1",
      "data-tip": "Erase doodles on both Above & Behind layers at once (never touches text, stickers, or images)",
    },
    eraseBothChk,
    h("span", {}, "Erase Both Doodle Layers"),
  );

  const undoBtn = h(
    "button",
    {
      type: "button",
      class: "doodle-dock__act",
      "data-doodle-undo": "1",
      "data-tip": "Undo Stroke (Ctrl+Z)",
      onclick: () => void undoDoodleStroke(),
    },
    icon("Undo2", 14),
    h("span", {}, "Undo"),
  );

  const redoBtn = h(
    "button",
    {
      type: "button",
      class: "doodle-dock__act",
      "data-doodle-redo": "1",
      "data-tip": "Redo Stroke (Ctrl+Y)",
      onclick: () => void redoDoodleStroke(),
    },
    icon("Redo2", 14),
    h("span", {}, "Redo"),
  );

  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "doodle-dock__act doodle-dock__act--danger",
      "data-tip": "Clear all doodles on the page (leaves text, stickers & images untouched)",
      onclick: () => clearDoodles("all"),
    },
    icon("Trash2", 13),
    h("span", {}, "Clear All Doodles"),
  );

  const stylusBadge = h(
    "div",
    {
      class: "doodle-dock__stylus",
      "data-doodle-stylus": "1",
      hidden: true,
    },
    icon("Sparkles", 12),
    h("span", {}, "Windows Ink Active"),
  );

  const doneBtn = h(
    "button",
    {
      type: "button",
      class: "doodle-dock__done",
      "data-tip": "Exit Draw Mode and hide this palette (Esc)",
      onclick: () => toggleDoodleMode(false),
    },
    icon("Check", 14),
    h("span", {}, "Done Drawing"),
  );

  const dragHandle = h(
    "div",
    {
      class: "doodle-dock__head",
      title: "Drag to move Draw Palette anywhere on screen",
    },
    h(
      "div",
      { class: "doodle-dock__title" },
      icon("GripVertical", 14),
      h("span", {}, "Draw Palette"),
    ),
    h(
      "button",
      {
        type: "button",
        class: "doodle-dock__close",
        "data-tip": "Close Draw Mode (Esc)",
        onmousedown: (e: MouseEvent) => e.stopPropagation(),
        onclick: () => toggleDoodleMode(false),
      },
      icon("X", 14),
    ),
  );

  toolbarEl = h(
    "aside",
    { id: "doodle-toolbar", class: "doodle-dock", hidden: !activeMode },
    dragHandle,
    stylusBadge,
    h(
      "div",
      { class: "doodle-dock__section" },
      h("div", { class: "doodle-dock__label" }, "Tools"),
      h(
        "div",
        { class: "doodle-dock__tools-grid" },
        makeToolBtn("pencil", "Pencil", "Pencil", "Sketchy graphite pencil"),
        makeToolBtn("pen", "Pen", "PenTool", "Smooth ink pen"),
        makeToolBtn("highlighter", "Marker", "Highlighter", "Translucent marker"),
        makeToolBtn("eraser", "Eraser", "Eraser", "Erases ONLY doodles (never touches text or images)"),
      ),
    ),
    h(
      "div",
      { class: "doodle-dock__section" },
      h("div", { class: "doodle-dock__label" }, "Drawing Layer"),
      h(
        "div",
        { class: "doodle-dock__layers" },
        makeLayerBtn("over", "Above Text & Images", "Layers", "Draw on top of text, stickers & images"),
        makeLayerBtn("under", "Behind Text & Images", "Layers", "Draw underneath text, stickers & images"),
      ),
      eraseBothRow,
    ),
    h(
      "div",
      { class: "doodle-dock__section", "data-color-section": "1" },
      h("div", { class: "doodle-dock__label" }, "Ink Color"),
      h("div", { class: "doodle-dock__swatches" }, ...swatchButtons, customColorWrap),
    ),
    h(
      "div",
      { class: "doodle-dock__section" },
      h(
        "div",
        { class: "doodle-dock__label-row" },
        h("span", { class: "doodle-dock__label", "data-size-label": "1" }, "Brush Size"),
        sizeValueEl,
      ),
      sizeSlider,
    ),
    h(
      "div",
      { class: "doodle-dock__section doodle-dock__history" },
      undoBtn,
      redoBtn,
    ),
    clearBtn,
    doneBtn,
  );

  // Restore saved position or place neatly on the right side of the workspace
  if (dockPos) {
    toolbarEl.style.left = `${dockPos.left}px`;
    toolbarEl.style.top = `${dockPos.top}px`;
    toolbarEl.style.right = "auto";
  }

  // Make the entire header draggable anywhere on screen
  dragHandle.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0 || !toolbarEl) return;
    e.preventDefault();
    const rect = toolbarEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    dragHandle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!toolbarEl) return;
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(44, window.innerHeight - rect.height - 8);
      const nextLeft = Math.max(8, Math.min(maxLeft, ev.clientX - offsetX));
      const nextTop = Math.max(44, Math.min(maxTop, ev.clientY - offsetY));
      toolbarEl.style.left = `${nextLeft}px`;
      toolbarEl.style.top = `${nextTop}px`;
      toolbarEl.style.right = "auto";
      dockPos = { left: nextLeft, top: nextTop };
    };

    const onUp = (ev: PointerEvent) => {
      try {
        if (dragHandle.hasPointerCapture(ev.pointerId)) {
          dragHandle.releasePointerCapture(ev.pointerId);
        }
      } catch {
        // ignore
      }
      dragHandle.removeEventListener("pointermove", onMove);
      dragHandle.removeEventListener("pointerup", onUp);
      dragHandle.removeEventListener("pointercancel", onUp);
    };

    dragHandle.addEventListener("pointermove", onMove);
    dragHandle.addEventListener("pointerup", onUp);
    dragHandle.addEventListener("pointercancel", onUp);
  });

  document.body.append(toolbarEl);
  updateToolbarState();
}

function updateToolbarState(): void {
  if (!toolbarEl) return;

  toolbarEl.querySelectorAll<HTMLElement>("[data-tool-btn]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.toolBtn === currentTool);
  });

  toolbarEl.querySelectorAll<HTMLElement>("[data-layer-btn]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.layerBtn === currentLayer);
  });

  toolbarEl.querySelectorAll<HTMLElement>("[data-swatch]").forEach((sw) => {
    sw.classList.toggle("is-active", sw.dataset.swatch?.toLowerCase() === strokeColor.toLowerCase());
  });

  const colorInput = toolbarEl.querySelector<HTMLInputElement>(".doodle-dock__color-picker");
  if (colorInput && colorInput.value.toLowerCase() !== strokeColor.toLowerCase()) {
    colorInput.value = strokeColor;
  }

  const customWrap = toolbarEl.querySelector<HTMLElement>(".doodle-dock__custom-color");
  if (customWrap) {
    customWrap.style.borderColor = strokeColor;
  }

  const slider = toolbarEl.querySelector<HTMLInputElement>(".doodle-dock__slider");
  if (slider) slider.value = String(getActiveSize());

  const sizeLabel = toolbarEl.querySelector<HTMLElement>("[data-size-label]");
  if (sizeLabel) {
    sizeLabel.textContent = currentTool === "eraser" ? "Eraser Size" : "Brush Size";
  }

  const sizeVal = toolbarEl.querySelector<HTMLElement>("[data-doodle-size]");
  if (sizeVal) sizeVal.textContent = `${getActiveSize()}px`;

  const eraseBothRow = toolbarEl.querySelector<HTMLElement>("[data-erase-both]");
  if (eraseBothRow) {
    eraseBothRow.hidden = currentTool !== "eraser";
  }

  const undoBtn = toolbarEl.querySelector<HTMLButtonElement>("[data-doodle-undo]");
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;

  const redoBtn = toolbarEl.querySelector<HTMLButtonElement>("[data-doodle-redo]");
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}
