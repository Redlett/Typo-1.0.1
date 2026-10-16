/// <reference types="vite/client" />
/**
 * Acrobat / Foxit Pro-Grade Built-In PDF Studio Suite for Typo.
 *
 * Features:
 * - Full-Window Dedicated Suite Workspace (never closes on accidental outside clicks or Escape)
 * - Persistent in-memory session state so switching back to Word Processor never loses PDF progress
 * - Dual-Layer PDF.js 2x HiDPI Rendering:
 *   1. `backgroundImage`: Full pixel-accurate visual slide/page render
 *   2. `cleanBackgroundImage`: Text-free graphics/vectors/shapes background layer so editing, moving,
 *      or deleting any PDF text block reveals the exact underlying slide graphics with ZERO ghost letters
 *      and ZERO grey boxes
 * - Automatic Embedded PDF Photo Detection:
 *   Intercepts PDF.js canvas `drawImage` calls during page rendering to extract every embedded photo's
 *   exact [x, y, width, height] bounding box and high-res image data so users can select, move, resize,
 *   replace, duplicate, or delete photos already inside the PDF
 * - Direct Inline On-Page Text Editing (`contenteditable`) + 8-point resize handles
 * - Dedicated Top Formatting Ribbon (Font Family, Size, B/I/U, Alignment, Text Color, Fill Color, Undo/Redo, Zoom)
 * - Left Pages & Layers/Objects Dock + Right Properties Inspector Dock + Custom Right-Click Context Menu
 * - One-click "Save PDF (.pdf)", "PDF to Word (.docx)", and "Open in Word Processor"
 */
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { h, icon, toast } from "./dom";
import {
  native,
  type ImportedDocx,
  type PdfAnnotation,
  type PdfEditorPage,
  type PdfInkPoint,
  type PdfPageBlock,
} from "../core/native";
import { state } from "../core/state";
import { loadImportedDocxIntoNewTab } from "../core/document";

// Configure PDF.js worker once
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfToolMode =
  | "select"
  | "edit-text"
  | "textbox"
  | "image"
  | "whiteout"
  | "highlight"
  | "draw"
  | "stamp";

const PDF_FONTS = [
  "Calibri",
  "Segoe UI",
  "Arial",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Consolas",
];

const STAMP_PRESETS: { label: string; color: string }[] = [
  { label: "APPROVED", color: "#16a34a" },
  { label: "CONFIDENTIAL", color: "#dc2626" },
  { label: "DRAFT", color: "#d97706" },
  { label: "SIGNED", color: "#2563eb" },
  { label: "FINAL", color: "#7c3aed" },
  { label: "URGENT", color: "#e11d48" },
];

const HIGHLIGHT_COLORS: { label: string; value: string; hex: string }[] = [
  { label: "Yellow", value: "rgba(250, 204, 21, 0.42)", hex: "#facc15" },
  { label: "Green", value: "rgba(74, 222, 128, 0.38)", hex: "#4ade80" },
  { label: "Cyan", value: "rgba(56, 189, 248, 0.38)", hex: "#38bdf8" },
  { label: "Pink", value: "rgba(244, 114, 182, 0.38)", hex: "#f472b6" },
  { label: "Orange", value: "rgba(251, 146, 60, 0.38)", hex: "#fb923c" },
];

const INK_COLORS: { label: string; hex: string }[] = [
  { label: "Charcoal Black", hex: "#111827" },
  { label: "Royal Blue", hex: "#1d4ed8" },
  { label: "Crimson Red", hex: "#dc2626" },
  { label: "Emerald Green", hex: "#15803d" },
  { label: "Purple", hex: "#7c3aed" },
  { label: "Pure White", hex: "#ffffff" },
];

// Persistent session cache so switching between PDF Studio and Word Processor never loses edits
interface PdfSuiteSession {
  pdfName: string;
  pdfSourcePath: string | null;
  pages: PdfEditorPage[];
  activePageIdx: number;
  zoom: number;
}

let savedSuiteSession: PdfSuiteSession | null = null;
let activeStudioOverlay: HTMLElement | null = null;
let uidCounter = 1;

function nextId(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    "#" +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Samples the clean background canvas and visual canvas to find:
 * 1. `bgHex`: the dominant clean background color (from `cleanCtx`, unaffected by text ink!)
 * 2. `fgHex`: the dominant high-contrast text ink color (from `visualCtx` compared to `cleanCtx`)
 */
function sampleBlockColorsFromDualCanvas(
  visualCtx: CanvasRenderingContext2D,
  cleanCtx: CanvasRenderingContext2D,
  canvasW: number,
  canvasH: number,
  x: number,
  y: number,
  w: number,
  h: number,
): { bgHex: string; fgHex: string } {
  try {
    const sx = Math.max(0, Math.min(canvasW - 2, Math.floor(x)));
    const sy = Math.max(0, Math.min(canvasH - 2, Math.floor(y)));
    const sw = Math.max(2, Math.min(canvasW - sx, Math.ceil(w)));
    const sh = Math.max(2, Math.min(canvasH - sy, Math.ceil(h)));

    const cleanData = cleanCtx.getImageData(sx, sy, sw, sh).data;
    const visData = visualCtx.getImageData(sx, sy, sw, sh).data;

    // 1. Sample interior of `cleanData` (which has NO text ink!) for true background color
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgCount = 0;
    const stepX = Math.max(1, Math.floor(sw / 14));
    const stepY = Math.max(1, Math.floor(sh / 8));
    for (let py = 0; py < sh; py += stepY) {
      for (let px = 0; px < sw; px += stepX) {
        const idx = (py * sw + px) * 4;
        bgR += cleanData[idx];
        bgG += cleanData[idx + 1];
        bgB += cleanData[idx + 2];
        bgCount++;
      }
    }
    if (bgCount === 0) return { bgHex: "#ffffff", fgHex: "#1c1c1f" };
    bgR /= bgCount;
    bgG /= bgCount;
    bgB /= bgCount;
    const bgHex = rgbToHex(bgR, bgG, bgB);

    // 2. Compare `visData` vs `cleanData` to find the true glyph ink color
    let bestDist = 0;
    let fgR = 28;
    let fgG = 28;
    let fgB = 31;
    for (let py = 1; py < sh - 1; py += Math.max(1, Math.floor(sh / 12))) {
      for (let px = 1; px < sw - 1; px += Math.max(1, Math.floor(sw / 20))) {
        const idx = (py * sw + px) * 4;
        const r = visData[idx];
        const g = visData[idx + 1];
        const b = visData[idx + 2];
        const dist = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
        if (dist > bestDist) {
          bestDist = dist;
          fgR = r;
          fgG = g;
          fgB = b;
        }
      }
    }
    const fgHex = bestDist > 45 ? rgbToHex(fgR, fgG, fgB) : "#1c1c1f";
    return { bgHex, fgHex };
  } catch {
    return { bgHex: "#ffffff", fgHex: "#1c1c1f" };
  }
}

/**
 * Renders every PDF page visually via Mozilla PDF.js with:
 * 1. Full 2x HiDPI visual render (`backgroundImage`)
 * 2. Text-free 2x HiDPI clean graphics/background render (`cleanBackgroundImage`)
 * 3. Automatic Embedded PDF Photo detection (`drawImage` interception with exact page coordinates)
 * 4. Accurate top-down text block extraction (fixing sans-serif detection, kerning pairs, and bounding boxes)
 */
export async function renderPdfPagesWithPdfJs(
  pdfBase64: string,
  fallbackPages: PdfEditorPage[],
): Promise<PdfEditorPage[]> {
  try {
    const data = base64ToUint8Array(pdfBase64);
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdfDoc = await loadingTask.promise;
    const outPages: PdfEditorPage[] = [];

    for (let pNum = 1; pNum <= pdfDoc.numPages; pNum++) {
      const page = await pdfDoc.getPage(pNum);
      const rawVp = page.getViewport({ scale: 1.0 });

      // Normalize oversized presentation dimensions (e.g. 1920x1080) to comfortable point dimensions (~780pt wide)
      const maxDim = Math.max(rawVp.width, rawVp.height);
      const displayScale = maxDim > 860 ? 780 / maxDim : maxDim < 320 ? 640 / maxDim : 1.0;
      const vp = page.getViewport({ scale: displayScale });
      const widthPt = Math.round(vp.width * 100) / 100;
      const heightPt = Math.round(vp.height * 100) / 100;

      const hiScale = 2.0;
      const renderVp = page.getViewport({ scale: displayScale * hiScale });

      // --- Pass 1: Full Visual Canvas + Embedded Photo Capture --------------
      const visualCanvas = document.createElement("canvas");
      visualCanvas.width = Math.round(renderVp.width);
      visualCanvas.height = Math.round(renderVp.height);
      const visualCtx = visualCanvas.getContext("2d")!;
      visualCtx.fillStyle = "#ffffff";
      visualCtx.fillRect(0, 0, visualCanvas.width, visualCanvas.height);

      interface CapturedEmbeddedImage {
        x: number;
        y: number;
        width: number;
        height: number;
        dataUrl: string;
      }
      const capturedImages: CapturedEmbeddedImage[] = [];
      const origDrawImage = visualCtx.drawImage.bind(visualCtx);

      (visualCtx as any).drawImage = function (...args: any[]) {
        try {
          const imgSource = args[0];
          let dx = 0;
          let dy = 0;
          let dw = 0;
          let dh = 0;
          if (args.length === 3) {
            dx = args[1];
            dy = args[2];
            dw = imgSource?.width || 0;
            dh = imgSource?.height || 0;
          } else if (args.length === 5) {
            dx = args[1];
            dy = args[2];
            dw = args[3];
            dh = args[4];
          } else if (args.length >= 9) {
            dx = args[5];
            dy = args[6];
            dw = args[7];
            dh = args[8];
          }

          const m = visualCtx.getTransform();
          const corners = [
            { x: dx, y: dy },
            { x: dx + dw, y: dy },
            { x: dx, y: dy + dh },
            { x: dx + dw, y: dy + dh },
          ].map((pt) => ({
            x: (m.a * pt.x + m.c * pt.y + m.e) / hiScale,
            y: (m.b * pt.x + m.d * pt.y + m.f) / hiScale,
          }));

          const minX = Math.max(0, Math.min(...corners.map((c) => c.x)));
          const maxX = Math.min(widthPt, Math.max(...corners.map((c) => c.x)));
          const minY = Math.max(0, Math.min(...corners.map((c) => c.y)));
          const maxY = Math.min(heightPt, Math.max(...corners.map((c) => c.y)));
          const boxW = Math.round((maxX - minX) * 10) / 10;
          const boxH = Math.round((maxY - minY) * 10) / 10;

          // Ignore tiny icons (< 20pt) and full-slide background fills (> 92% of slide area)
          const isFullSlideBg = boxW >= widthPt * 0.92 && boxH >= heightPt * 0.92;
          if (boxW >= 20 && boxH >= 20 && !isFullSlideBg && imgSource) {
            const srcW = Number(imgSource.width || imgSource.naturalWidth || Math.round(boxW * 2));
            const srcH = Number(imgSource.height || imgSource.naturalHeight || Math.round(boxH * 2));
            if (srcW >= 16 && srcH >= 16) {
              const tmpC = document.createElement("canvas");
              tmpC.width = Math.min(1200, srcW);
              tmpC.height = Math.min(1200, srcH);
              const tmpCtx = tmpC.getContext("2d");
              if (tmpCtx) {
                tmpCtx.drawImage(imgSource, 0, 0, tmpC.width, tmpC.height);
                const dataUrl = tmpC.toDataURL("image/png");
                // Deduplicate overlapping draws of the same image rect
                const dup = capturedImages.some(
                  (ci) =>
                    Math.abs(ci.x - minX) < 6 &&
                    Math.abs(ci.y - minY) < 6 &&
                    Math.abs(ci.width - boxW) < 6 &&
                    Math.abs(ci.height - boxH) < 6,
                );
                if (!dup && capturedImages.length < 24) {
                  capturedImages.push({
                    x: Math.round(minX * 10) / 10,
                    y: Math.round(minY * 10) / 10,
                    width: boxW,
                    height: boxH,
                    dataUrl,
                  });
                }
              }
            }
          }
        } catch {
          // Ignore image capture errors and always let normal canvas rendering proceed
        }
        return (origDrawImage as any)(...args);
      };

      await page.render({
        canvasContext: visualCtx,
        viewport: renderVp,
        canvas: visualCanvas,
      }).promise;

      const backgroundImage = visualCanvas.toDataURL("image/png");

      // --- Pass 2: Clean Background Canvas (Graphics/Shapes Only, No Text) --
      const cleanCanvas = document.createElement("canvas");
      cleanCanvas.width = visualCanvas.width;
      cleanCanvas.height = visualCanvas.height;
      const cleanCtx = cleanCanvas.getContext("2d")!;
      cleanCtx.fillStyle = "#ffffff";
      cleanCtx.fillRect(0, 0, cleanCanvas.width, cleanCanvas.height);
      // Silence text drawing on `cleanCtx` so only slide backgrounds, boxes, lines, and graphics render
      cleanCtx.fillText = () => {};
      cleanCtx.strokeText = () => {};

      await page.render({
        canvasContext: cleanCtx,
        viewport: renderVp,
        canvas: cleanCanvas,
      }).promise;

      const cleanBackgroundImage = cleanCanvas.toDataURL("image/png");

      // --- Extract Exact Positioned Text Spans ------------------------------
      const textContent = await page.getTextContent();
      interface RawSpan {
        x: number;
        endX: number;
        y: number;
        fontSize: number;
        fontFamily: string;
        bold: boolean;
        italic: boolean;
        text: string;
      }

      const rawSpans: RawSpan[] = [];
      const stylesMap: Record<string, any> = (textContent as any).styles || {};

      for (const item of textContent.items as any[]) {
        if (!item || typeof item.str !== "string") continue;
        const str = item.str.replace(/\0/g, "");
        if (!str.trim()) continue;

        const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
        const fontH = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 12;
        const fontSize = Math.max(6.5, Math.min(84, Math.round(fontH * 10) / 10));
        const x = Math.max(2, Math.min(widthPt - 8, tx[4]));
        // `tx[5]` is baseline Y in top-down viewport coordinates
        const y = Math.max(2, Math.min(heightPt - 8, tx[5] - fontSize * 0.84));
        const itemW = Math.max(
          fontSize * 0.35,
          typeof item.width === "number" && item.width > 0
            ? item.width * displayScale
            : str.length * fontSize * 0.52,
        );

        const styleObj = stylesMap[item.fontName] || {};
        const rawFamily = `${styleObj.fontFamily || ""} ${item.fontName || ""}`;
        const bold = /bold|black|heavy|demi/i.test(rawFamily);
        const italic = /italic|oblique/i.test(rawFamily);

        // Careful: "sans-serif" contains the substring "serif"! Check !/sans/i first!
        let fontFamily = "Calibri";
        if (/mono|courier|consolas|menlo|fira\s*code/i.test(rawFamily)) {
          fontFamily = "Consolas";
        } else if (!/sans/i.test(rawFamily) && /serif|times|georgia|garamond|cambria|palatino|minion/i.test(rawFamily)) {
          fontFamily = "Georgia";
        } else if (/arial|helvetica/i.test(rawFamily)) {
          fontFamily = "Arial";
        } else if (/segoe|inter|roboto/i.test(rawFamily)) {
          fontFamily = "Segoe UI";
        }

        rawSpans.push({
          x,
          endX: x + itemW,
          y,
          fontSize,
          fontFamily,
          bold,
          italic,
          text: str,
        });
      }

      // --- Step 1: Cluster spans into horizontal lines by baseline Y --------
      interface SpanLineCluster {
        y: number;
        maxFs: number;
        spans: RawSpan[];
      }
      const sortedByY = [...rawSpans].sort((a, b) => a.y - b.y);
      const lineClusters: SpanLineCluster[] = [];
      for (const sp of sortedByY) {
        let matched: SpanLineCluster | null = null;
        for (const cl of lineClusters) {
          const tol = Math.max(cl.maxFs, sp.fontSize) * 0.48;
          if (Math.abs(sp.y - cl.y) <= tol) {
            matched = cl;
            break;
          }
        }
        if (matched) {
          matched.spans.push(sp);
          matched.maxFs = Math.max(matched.maxFs, sp.fontSize);
          // Running average of Y
          matched.y =
            matched.spans.reduce((acc, s) => acc + s.y, 0) / matched.spans.length;
        } else {
          lineClusters.push({ y: sp.y, maxFs: sp.fontSize, spans: [sp] });
        }
      }
      lineClusters.sort((a, b) => a.y - b.y);

      // --- Step 2: Within each line cluster, sort strictly by X and merge ---
      interface MergedLine {
        x: number;
        endX: number;
        y: number;
        fontSize: number;
        fontFamily: string;
        bold: boolean;
        italic: boolean;
        text: string;
      }

      const lines: MergedLine[] = [];
      for (const cl of lineClusters) {
        cl.spans.sort((a, b) => a.x - b.x);
        let cur: MergedLine | null = null;
        for (const sp of cl.spans) {
          if (!cur) {
            cur = { ...sp };
            continue;
          }
          const maxFs = Math.max(cur.fontSize, sp.fontSize);
          const gap = sp.x - cur.endX;
          // Only split into a separate horizontal column if there is a large positive gap (> 3.2x font size).
          // NEVER split on negative or small gaps (which are kerning pairs like "Ide"+"a" or "usuall"+"y"!).
          if (gap <= maxFs * 3.2) {
            if (gap > maxFs * 0.15 && !cur.text.endsWith(" ") && !sp.text.startsWith(" ")) {
              cur.text += " ";
            }
            cur.text += sp.text;
            cur.x = Math.min(cur.x, sp.x);
            cur.endX = Math.max(cur.endX, sp.endX);
            if (sp.fontSize > cur.fontSize) {
              cur.fontSize = sp.fontSize;
              cur.fontFamily = sp.fontFamily;
            }
            cur.bold = cur.bold || sp.bold;
            cur.italic = cur.italic || sp.italic;
          } else {
            lines.push({ ...cur, text: cur.text.trim() });
            cur = { ...sp };
          }
        }
        if (cur && cur.text.trim()) {
          lines.push({ ...cur, text: cur.text.trim() });
        }
      }

      // --- Step 3: Merge consecutive lines into cohesive paragraph blocks ---
      const blocks: PdfPageBlock[] = [];
      let seq = 1;
      for (const ln of lines) {
        const clean = ln.text.replace(/\s+/g, " ").trim();
        if (!clean) continue;

        const kind: PdfPageBlock["kind"] =
          ln.fontSize >= 20
            ? "heading1"
            : ln.fontSize >= 15 && ln.bold && clean.length < 90
              ? "heading2"
              : ln.bold && clean.length < 80 && !clean.endsWith(".")
                ? "heading3"
                : "paragraph";

        const prev = blocks[blocks.length - 1];
        if (prev && prev.kind !== "image") {
          const vGap = ln.y - (prev.y + prev.height);
          const sameAlign = Math.abs(prev.x - ln.x) <= 32;
          const sameSize = Math.abs(prev.fontSize - ln.fontSize) <= 1.8;
          if (
            prev.kind === kind &&
            sameAlign &&
            sameSize &&
            prev.bold === ln.bold &&
            vGap >= -8 &&
            vGap <= ln.fontSize * 1.5
          ) {
            if (prev.text.endsWith("-") && prev.text.length > 2) {
              prev.text = prev.text.slice(0, -1) + clean;
            } else {
              prev.text += "\n" + clean;
            }
            // Union bounding box across ALL lines in the paragraph so left-hand letters are never left outside!
            const minX = Math.min(prev.x, ln.x);
            const maxX = Math.max(prev.x + prev.width, ln.endX + 8);
            prev.x = minX;
            prev.width = Math.min(widthPt - minX - 6, Math.max(40, maxX - minX));
            prev.height = Math.max(
              prev.height + ln.fontSize * 1.24,
              ln.y - prev.y + ln.fontSize * 1.35,
            );
            prev.originalText = prev.text;
            prev.originalX = prev.x;
            prev.originalWidth = prev.width;
            prev.originalHeight = prev.height;
            continue;
          }
        }

        const bw = Math.min(
          widthPt - ln.x - 6,
          Math.max(48, Math.round(ln.endX - ln.x + 12)),
        );
        const bh = Math.round(ln.fontSize * 1.38);

        blocks.push({
          id: `p${pNum}-b${seq++}`,
          kind,
          text: clean,
          x: Math.round(ln.x * 10) / 10,
          y: Math.round(ln.y * 10) / 10,
          width: bw,
          height: bh,
          fontSize: ln.fontSize,
          fontFamily: ln.fontFamily,
          bold: ln.bold,
          italic: ln.italic,
          underline: false,
          align: "left",
          color: "#1c1c1f",
          originalText: clean,
          originalX: Math.round(ln.x * 10) / 10,
          originalY: Math.round(ln.y * 10) / 10,
          originalWidth: bw,
          originalHeight: bh,
          bgPatchColor: "#ffffff",
        });
      }

      // Sample accurate background & text ink colors for each text block
      for (const blk of blocks) {
        if (blk.kind === "image") continue;
        const { bgHex, fgHex } = sampleBlockColorsFromDualCanvas(
          visualCtx,
          cleanCtx,
          visualCanvas.width,
          visualCanvas.height,
          blk.x * hiScale,
          blk.y * hiScale,
          blk.width * hiScale,
          blk.height * hiScale,
        );
        blk.bgPatchColor = bgHex;
        blk.color = fgHex;
      }

      // Add captured embedded PDF photos as interactive image blocks!
      for (const ci of capturedImages) {
        const { bgHex } = sampleBlockColorsFromDualCanvas(
          visualCtx,
          cleanCtx,
          visualCanvas.width,
          visualCanvas.height,
          Math.max(0, (ci.x - 4) * hiScale),
          Math.max(0, (ci.y - 4) * hiScale),
          (ci.width + 8) * hiScale,
          12 * hiScale,
        );
        blocks.push({
          id: `p${pNum}-img${seq++}`,
          kind: "image",
          text: "",
          x: ci.x,
          y: ci.y,
          width: ci.width,
          height: ci.height,
          fontSize: 12,
          fontFamily: "Calibri",
          bold: false,
          italic: false,
          color: "#1c1c1f",
          imageSrc: ci.dataUrl,
          originalText: "embedded",
          originalX: ci.x,
          originalY: ci.y,
          originalWidth: ci.width,
          originalHeight: ci.height,
          bgPatchColor: bgHex,
        });
      }

      const finalBlocks =
        blocks.length > 0 ? blocks : fallbackPages[pNum - 1]?.blocks || [];

      outPages.push({
        pageNumber: pNum,
        widthPt,
        heightPt,
        rotation: 0,
        blocks: finalBlocks,
        annotations: [],
        backgroundImage,
        cleanBackgroundImage,
        deletedRects: [],
      });
    }

    return outPages.length > 0 ? outPages : fallbackPages;
  } catch (err) {
    console.warn("PDF.js visual render fallback:", err);
    return fallbackPages;
  }
}

/**
 * Builds an editable ProseMirror `ImportedDocx` from `PdfEditorPage[]` for "Open in Word Processor" & "PDF to Word (.docx)".
 */
export function buildDocxFromPdfPages(pages: PdfEditorPage[]): ImportedDocx {
  const content: any[] = [];
  for (let pIdx = 0; pIdx < pages.length; pIdx++) {
    const p = pages[pIdx];
    if (pIdx > 0) {
      content.push({ type: "pageBreak" });
    }
    if (p.backgroundImage) {
      content.push({
        type: "image",
        attrs: {
          src: p.backgroundImage,
          width: Math.min(680, Math.round(p.widthPt * 0.92)),
          wrap: "center",
        },
      });
    }
    const items: { y: number; node: any }[] = [];
    for (const b of p.blocks) {
      if (b.kind === "image" && b.imageSrc && !p.backgroundImage) {
        items.push({
          y: b.y,
          node: {
            type: "image",
            attrs: {
              src: b.imageSrc,
              width: Math.min(620, Math.round(b.width)),
              wrap: "center",
            },
          },
        });
        continue;
      }
      const txt = b.text.trim();
      if (!txt) continue;
      const marks: any[] = [];
      if (b.bold && !b.kind.startsWith("heading")) marks.push({ type: "bold" });
      if (b.italic) marks.push({ type: "italic" });
      const textNode = marks.length > 0 ? { type: "text", text: txt, marks } : { type: "text", text: txt };
      const node =
        b.kind === "heading1"
          ? { type: "heading", attrs: { level: 1 }, content: [textNode] }
          : b.kind === "heading2"
            ? { type: "heading", attrs: { level: 2 }, content: [textNode] }
            : b.kind === "heading3"
              ? { type: "heading", attrs: { level: 3 }, content: [textNode] }
              : { type: "paragraph", content: [textNode] };
      items.push({ y: b.y, node });
    }
    for (const ann of p.annotations) {
      if (ann.kind === "textbox" && ann.text.trim()) {
        items.push({
          y: ann.y,
          node: {
            type: "paragraph",
            content: [{ type: "text", text: ann.text.trim() }],
          },
        });
      } else if (ann.kind === "image" && ann.imageSrc) {
        items.push({
          y: ann.y,
          node: {
            type: "image",
            attrs: {
              src: ann.imageSrc,
              width: Math.min(620, Math.round(ann.width)),
              wrap: "center",
            },
          },
        });
      }
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) content.push(it.node);
  }
  if (content.length === 0) content.push({ type: "paragraph" });
  const first = pages[0];
  const isLandscape = first ? first.widthPt > first.heightPt : false;
  return {
    doc: { type: "doc", content },
    page: {
      size: "A4",
      orientation: isLandscape ? "landscape" : "portrait",
      margins: { top: 0.75, right: 0.75, bottom: 0.75, left: 0.75 },
    },
    defaults: { fontFamily: "Calibri", fontSize: 11 },
  };
}

/**
 * Composites any modified/deleted text block patches from `cleanBackgroundImage` onto `backgroundImage`
 * so the exported `.pdf` file has the exact same zero-ghost visual appearance as the live studio canvas.
 */
async function preparePagesForPdfExport(pages: PdfEditorPage[]): Promise<PdfEditorPage[]> {
  const out: PdfEditorPage[] = [];
  for (const p of pages) {
    const clone: PdfEditorPage = JSON.parse(JSON.stringify(p));
    if (p.backgroundImage && p.cleanBackgroundImage) {
      try {
        const loadImg = (src: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });
        const [visImg, cleanImg] = await Promise.all([
          loadImg(p.backgroundImage),
          loadImg(p.cleanBackgroundImage),
        ]);
        const c = document.createElement("canvas");
        c.width = visImg.width;
        c.height = visImg.height;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(visImg, 0, 0);

        const scaleX = c.width / p.widthPt;
        const scaleY = c.height / p.heightPt;

        // 1. Apply clean background crops for any deleted rects
        for (const dr of p.deletedRects ?? []) {
          const sx = Math.max(0, (dr.x - 4) * scaleX);
          const sy = Math.max(0, (dr.y - 4) * scaleY);
          const sw = Math.min(c.width - sx, (dr.width + 8) * scaleX);
          const sh = Math.min(c.height - sy, (dr.height + 8) * scaleY);
          if (dr.color === "__clean__") {
            ctx.drawImage(cleanImg, sx, sy, sw, sh, sx, sy, sw, sh);
          } else {
            ctx.fillStyle = dr.color || "#ffffff";
            ctx.fillRect(sx, sy, sw, sh);
          }
        }

        // 2. Apply clean background crops for any modified/moved text blocks
        for (const b of p.blocks) {
          if (b.kind === "image") continue;
          const isMod =
            b.originalText !== undefined &&
            (b.text !== b.originalText ||
              Math.abs((b.originalX ?? b.x) - b.x) > 1.5 ||
              Math.abs((b.originalY ?? b.y) - b.y) > 1.5);
          if (isMod) {
            const ox = b.originalX ?? b.x;
            const oy = b.originalY ?? b.y;
            const ow = b.originalWidth ?? b.width;
            const oh = b.originalHeight ?? b.height;
            const sx = Math.max(0, (ox - 5) * scaleX);
            const sy = Math.max(0, (oy - 5) * scaleY);
            const sw = Math.min(c.width - sx, (ow + 10) * scaleX);
            const sh = Math.min(c.height - sy, (oh + 10) * scaleY);
            ctx.drawImage(cleanImg, sx, sy, sw, sh, sx, sy, sw, sh);
          }
        }

        clone.backgroundImage = c.toDataURL("image/png");
        // Clear `bgPatchColor` to transparent on modified text blocks since `backgroundImage` now has the clean graphic composite!
        for (const b of clone.blocks) {
          if (b.kind !== "image" && !b.bgColor) {
            b.bgPatchColor = "transparent";
          }
        }
        clone.deletedRects = (clone.deletedRects ?? []).filter((dr) => dr.color !== "__clean__");
      } catch {
        // Fallback to standard patch rects if image load fails
      }
    }
    delete clone.cleanBackgroundImage;
    out.push(clone);
  }
  return out;
}

/**
 * Converts the currently active TipTap Word document into `PdfEditorPage[]` when user clicks "Load Current Doc".
 */
function buildPdfPagesFromCurrentEditor(): PdfEditorPage[] {
  const blocks: PdfPageBlock[] = [];
  let curY = 72;
  let seq = 1;

  const docJson = state.editor?.getJSON() as any;
  const nodes: any[] = docJson?.content ?? [];
  const pages: PdfEditorPage[] = [];

  const pushPage = (pageBlocks: PdfPageBlock[]) => {
    pages.push({
      pageNumber: pages.length + 1,
      widthPt: 595.28,
      heightPt: 841.89,
      rotation: 0,
      blocks:
        pageBlocks.length > 0
          ? pageBlocks
          : [
              {
                id: nextId("blk"),
                kind: "paragraph",
                text: "Double-click any text to edit inline, or use the top ribbon to add text boxes, images, highlights, or signatures.",
                x: 72,
                y: 72,
                width: 450,
                height: 36,
                fontSize: 12,
                fontFamily: state.defaults.fontFamily || "Calibri",
                bold: false,
                italic: false,
                color: "#1c1c1f",
              },
            ],
      annotations: [],
      deletedRects: [],
    });
  };

  let currentBlocks: PdfPageBlock[] = blocks;

  const extractText = (n: any): { text: string; bold: boolean; italic: boolean } => {
    let text = "";
    let bold = false;
    let italic = false;
    const walk = (item: any) => {
      if (!item) return;
      if (item.type === "text" && typeof item.text === "string") {
        text += item.text;
        if (Array.isArray(item.marks)) {
          for (const m of item.marks) {
            if (m.type === "bold") bold = true;
            if (m.type === "italic") italic = true;
          }
        }
      }
      if (Array.isArray(item.content)) {
        item.content.forEach(walk);
      }
    };
    walk(n);
    return { text: text.trim(), bold, italic };
  };

  for (const n of nodes) {
    if (n.type === "pageBreak") {
      pushPage(currentBlocks);
      currentBlocks = [];
      curY = 72;
      continue;
    }
    if (n.type === "image" && n.attrs?.src) {
      const w = Math.min(440, Number(n.attrs.width) || 260);
      const h = Math.round(w * 0.65);
      if (curY + h > 760 && currentBlocks.length > 0) {
        pushPage(currentBlocks);
        currentBlocks = [];
        curY = 72;
      }
      currentBlocks.push({
        id: `eb-${seq++}`,
        kind: "image",
        text: "",
        x: 72,
        y: curY,
        width: w,
        height: h,
        fontSize: 11,
        fontFamily: "Calibri",
        bold: false,
        italic: false,
        color: "#1c1c1f",
        imageSrc: String(n.attrs.src),
      });
      curY += h + 18;
      continue;
    }

    const { text, bold, italic } = extractText(n);
    if (!text) continue;

    let kind: PdfPageBlock["kind"] = "paragraph";
    let fontSize = state.defaults.fontSize || 11;
    let isBold = bold;
    if (n.type === "heading") {
      const lvl = Number(n.attrs?.level) || 1;
      kind = (lvl === 1 ? "heading1" : lvl === 2 ? "heading2" : "heading3") as PdfPageBlock["kind"];
      fontSize = lvl === 1 ? 20 : lvl === 2 ? 15 : 13;
      isBold = true;
    }

    const estLines = Math.max(1, Math.ceil(text.length / 72));
    const bh = Math.round(estLines * fontSize * 1.42 + 6);
    if (curY + bh > 770 && currentBlocks.length > 0) {
      pushPage(currentBlocks);
      currentBlocks = [];
      curY = 72;
    }

    currentBlocks.push({
      id: `eb-${seq++}`,
      kind,
      text,
      x: 72,
      y: curY,
      width: 450,
      height: bh,
      fontSize,
      fontFamily: state.defaults.fontFamily || "Calibri",
      bold: isBold,
      italic,
      color: "#1c1c1f",
    });
    curY += bh + 10;
  }

  pushPage(currentBlocks);
  return pages;
}

/**
 * Opens the Acrobat / Foxit Pro-Grade Built-In PDF Studio Suite.
 * - Restores the previous PDF Studio session if one is active (so zero progress is ever lost!),
 *   or prompts to choose a `.pdf` file from disk if no session exists yet.
 */
export async function openPdfEditorStudio(initialPdfPath?: string): Promise<void> {
  if (activeStudioOverlay) {
    activeStudioOverlay.remove();
    activeStudioOverlay = null;
  }

  let pdfName = savedSuiteSession?.pdfName || `${state.name || "Document"}.pdf`;
  let pdfSourcePath: string | null = initialPdfPath ?? savedSuiteSession?.pdfSourcePath ?? null;
  let pages: PdfEditorPage[] = savedSuiteSession?.pages ? savedSuiteSession.pages : [];
  let activePageIdx = savedSuiteSession?.activePageIdx ?? 0;
  let zoom = savedSuiteSession?.zoom ?? 1.0;

  if (!initialPdfPath && pages.length === 0) {
    const picked = await openDialog({
      title: "Select a PDF to Open in PDF Studio Suite",
      multiple: false,
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    });
    if (picked && typeof picked === "string") {
      initialPdfPath = picked;
    }
  }

  if (initialPdfPath) {
    try {
      toast("Loading PDF into PDF Studio Suite…", "info", 1600);
      const parsed = await native.parsePdfFile(initialPdfPath);
      pdfName = parsed.name;
      pdfSourcePath = parsed.path;
      pages = parsed.pdfBase64
        ? await renderPdfPagesWithPdfJs(parsed.pdfBase64, parsed.pages)
        : parsed.pages;
      activePageIdx = 0;
      zoom = 1.0;
    } catch (e) {
      toast(`Failed to parse PDF: ${e}`, "error", 3500);
      if (pages.length === 0) pages = buildPdfPagesFromCurrentEditor();
    }
  } else if (pages.length === 0) {
    pages = buildPdfPagesFromCurrentEditor();
  }

  let activeTool: PdfToolMode = "select";
  let selectedItemId: string | null = null;
  let inlineEditingId: string | null = null;
  let leftDockTab: "pages" | "layers" = "pages";
  let activeStampPreset = STAMP_PRESETS[0];
  let activeHighlightColor = HIGHLIGHT_COLORS[0].value;
  let activeInkColor = INK_COLORS[1].hex;

  // --- Undo / Redo History Stack -------------------------------------------
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  const snapshotState = () => {
    try {
      const snap = JSON.stringify({ pages, activePageIdx });
      if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== snap) {
        undoStack.push(snap);
        if (undoStack.length > 35) undoStack.shift();
        redoStack.length = 0;
      }
    } catch {
      /* ignore */
    }
  };

  const persistSession = () => {
    savedSuiteSession = {
      pdfName,
      pdfSourcePath,
      pages,
      activePageIdx,
      zoom,
    };
  };

  // Take initial snapshot & persist session
  snapshotState();
  persistSession();

  const performUndo = () => {
    if (undoStack.length <= 1) {
      toast("Nothing to undo", "info", 1200);
      return;
    }
    const current = undoStack.pop()!;
    redoStack.push(current);
    const prev = JSON.parse(undoStack[undoStack.length - 1]);
    pages = prev.pages;
    activePageIdx = Math.min(prev.activePageIdx ?? 0, pages.length - 1);
    selectedItemId = null;
    inlineEditingId = null;
    persistSession();
    renderAll();
  };

  const performRedo = () => {
    if (redoStack.length === 0) {
      toast("Nothing to redo", "info", 1200);
      return;
    }
    const nextSnap = redoStack.pop()!;
    undoStack.push(nextSnap);
    const restored = JSON.parse(nextSnap);
    pages = restored.pages;
    activePageIdx = Math.min(restored.activePageIdx ?? 0, pages.length - 1);
    selectedItemId = null;
    inlineEditingId = null;
    persistSession();
    renderAll();
  };

  // --- Full-Window Suite Container (Never closes on outside clicks!) --------
  const backdrop = h("div", { class: "pdf-studio-backdrop" });
  const modal = h("div", {
    class: "pdf-studio pdf-studio--suite",
    role: "application",
    "aria-label": "Typo PDF Studio Suite",
  });

  // Floating Context Menu inside PDF Studio
  let suiteContextMenuEl: HTMLElement | null = null;
  const closeSuiteContextMenu = () => {
    if (suiteContextMenuEl) {
      suiteContextMenuEl.remove();
      suiteContextMenuEl = null;
    }
  };

  const closeStudio = () => {
    closeSuiteContextMenu();
    persistSession();
    window.removeEventListener("keydown", onKeyDown, true);
    backdrop.remove();
    activeStudioOverlay = null;
  };

  // Helper to get currently selected block or annotation
  const getSelectedObject = (): {
    block?: PdfPageBlock;
    ann?: PdfAnnotation;
    page: PdfEditorPage;
  } | null => {
    const curPage = pages[activePageIdx];
    if (!curPage || !selectedItemId) return null;
    const block = curPage.blocks.find((b) => b.id === selectedItemId);
    if (block) return { block, page: curPage };
    const ann = curPage.annotations.find((a) => a.id === selectedItemId);
    if (ann) return { ann, page: curPage };
    return null;
  };

  // Helper to delete any block or annotation cleanly (preserving background layer)
  const deleteObjectById = (itemId: string) => {
    const curPage = pages[activePageIdx];
    if (!curPage) return;
    const blk = curPage.blocks.find((b) => b.id === itemId);
    if (blk) {
      snapshotState();
      if (curPage.backgroundImage && blk.originalX !== undefined && blk.originalY !== undefined) {
        if (!curPage.deletedRects) curPage.deletedRects = [];
        curPage.deletedRects.push({
          x: blk.originalX,
          y: blk.originalY,
          width: blk.originalWidth ?? blk.width,
          height: blk.originalHeight ?? blk.height,
          // Use cleanBackgroundImage crop for text blocks, or sampled background color for embedded photos
          color: blk.kind === "image" ? blk.bgPatchColor || "#ffffff" : "__clean__",
        });
      }
      curPage.blocks = curPage.blocks.filter((b) => b.id !== itemId);
      if (selectedItemId === itemId) selectedItemId = null;
      if (inlineEditingId === itemId) inlineEditingId = null;
      snapshotState();
      persistSession();
      renderAll();
      toast(blk.kind === "image" ? "Removed photo from PDF page" : "Deleted text block", "info", 1500);
      return;
    }
    const ann = curPage.annotations.find((a) => a.id === itemId);
    if (ann) {
      snapshotState();
      curPage.annotations = curPage.annotations.filter((a) => a.id !== itemId);
      if (selectedItemId === itemId) selectedItemId = null;
      if (inlineEditingId === itemId) inlineEditingId = null;
      snapshotState();
      persistSession();
      renderAll();
      toast("Removed item from PDF page", "info", 1500);
    }
  };

  // Helper to duplicate selected block or annotation
  const duplicateObjectById = (itemId: string) => {
    const curPage = pages[activePageIdx];
    if (!curPage) return;
    const blk = curPage.blocks.find((b) => b.id === itemId);
    if (blk) {
      snapshotState();
      const copy: PdfPageBlock = {
        ...JSON.parse(JSON.stringify(blk)),
        id: nextId(blk.kind === "image" ? "img" : "blk"),
        x: Math.min(curPage.widthPt - 40, blk.x + 18),
        y: Math.min(curPage.heightPt - 30, blk.y + 18),
        originalText: undefined,
        originalX: undefined,
        originalY: undefined,
        originalWidth: undefined,
        originalHeight: undefined,
      };
      curPage.blocks.push(copy);
      selectedItemId = copy.id;
      snapshotState();
      persistSession();
      renderAll();
      toast("Duplicated item on page", "success", 1400);
      return;
    }
    const ann = curPage.annotations.find((a) => a.id === itemId);
    if (ann) {
      snapshotState();
      const copy: PdfAnnotation = {
        ...JSON.parse(JSON.stringify(ann)),
        id: nextId(ann.kind),
        x: Math.min(curPage.widthPt - 40, ann.x + 18),
        y: Math.min(curPage.heightPt - 30, ann.y + 18),
      };
      curPage.annotations.push(copy);
      selectedItemId = copy.id;
      snapshotState();
      persistSession();
      renderAll();
      toast("Duplicated item on page", "success", 1400);
    }
  };

  // Helper to replace an image block or image annotation with a new file from PC
  const replaceImageObject = async (itemId: string) => {
    const curPage = pages[activePageIdx];
    if (!curPage) return;
    const picked = await openDialog({
      title: "Select Replacement Picture",
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] }],
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const dataUrl = await native.readImage(picked);
      snapshotState();
      const blk = curPage.blocks.find((b) => b.id === itemId && b.kind === "image");
      if (blk) {
        blk.imageSrc = dataUrl;
        blk.originalText = "modified";
      } else {
        const ann = curPage.annotations.find((a) => a.id === itemId && a.kind === "image");
        if (ann) ann.imageSrc = dataUrl;
      }
      snapshotState();
      persistSession();
      renderAll();
      toast("Picture replaced", "success", 1600);
    } catch (e) {
      toast(`Could not load image: ${e}`, "error", 3000);
    }
  };

  // Keyboard shortcuts inside PDF Studio Suite (Undo, Redo, Delete, Duplicate, Zoom)
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const inInputOrEditable = Boolean(
      target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable),
    );

    // Never close PDF Studio on Escape — Escape only exits inline text editing or deselects!
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSuiteContextMenu();
      if (inlineEditingId) {
        inlineEditingId = null;
        snapshotState();
        persistSession();
        renderAll();
      } else if (selectedItemId) {
        selectedItemId = null;
        renderInspector();
        renderRibbon();
        renderCanvas();
      } else if (activeTool !== "select") {
        activeTool = "select";
        renderRibbon();
        renderCanvas();
      }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (mod && k === "s") {
      e.preventDefault();
      e.stopPropagation();
      void triggerSavePdf();
      return;
    }

    if (inInputOrEditable) return;

    if (mod && k === "z" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      performUndo();
      return;
    }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      e.stopPropagation();
      performRedo();
      return;
    }
    if (mod && k === "d" && selectedItemId) {
      e.preventDefault();
      e.stopPropagation();
      duplicateObjectById(selectedItemId);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedItemId) {
      e.preventDefault();
      e.stopPropagation();
      deleteObjectById(selectedItemId);
      return;
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  // --- UI Slots -------------------------------------------------------------
  const headerSlot = h("div", { class: "pdf-studio__header" });
  const ribbonSlot = h("div", { class: "pdf-studio__ribbon" });
  const leftDockSlot = h("div", { class: "pdf-studio__thumbs" });
  const canvasWrapSlot = h("div", { class: "pdf-studio__stage" });
  const rightInspectorSlot = h("div", { class: "pdf-studio__right-dock" });
  const footerSlot = h("div", { class: "pdf-studio__footer" });

  // Ctrl + Mouse Wheel Zoom inside PDF Studio canvas stage
  canvasWrapSlot.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      zoom = Math.max(0.5, Math.min(2.4, Math.round((zoom + delta) * 100) / 100));
      persistSession();
      renderHeader();
      renderCanvas();
    },
    { passive: false },
  );

  // --- 1. Top Suite Header Bar ----------------------------------------------
  const renderHeader = () => {
    headerSlot.replaceChildren();

    const openPdfBtn = h(
      "button",
      { class: "btn btn--sm", type: "button", "data-tip": "Open another PDF file from your computer" },
      icon("FolderOpen", 14),
      "Open PDF…",
    );
    openPdfBtn.addEventListener("click", async () => {
      const picked = await openDialog({
        title: "Open PDF in Typo PDF Studio Suite",
        multiple: false,
        filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
      });
      if (!picked || typeof picked !== "string") return;
      try {
        toast("Rendering PDF pages…", "info", 1400);
        const parsed = await native.parsePdfFile(picked);
        pdfName = parsed.name;
        pdfSourcePath = parsed.path;
        pages = parsed.pdfBase64
          ? await renderPdfPagesWithPdfJs(parsed.pdfBase64, parsed.pages)
          : parsed.pages;
        activePageIdx = 0;
        selectedItemId = null;
        inlineEditingId = null;
        undoStack.length = 0;
        redoStack.length = 0;
        snapshotState();
        persistSession();
        renderAll();
        toast(`Opened ${parsed.name} (${pages.length} pages)`, "success", 2200);
      } catch (e) {
        toast(`Failed to open PDF: ${e}`, "error", 4000);
      }
    });

    const undoBtn = h(
      "button",
      {
        class: "btn btn--sm",
        type: "button",
        "data-tip": "Undo (Ctrl+Z)",
        disabled: undoStack.length <= 1 ? "" : null,
      },
      icon("Undo2", 14),
    );
    undoBtn.addEventListener("click", performUndo);

    const redoBtn = h(
      "button",
      {
        class: "btn btn--sm",
        type: "button",
        "data-tip": "Redo (Ctrl+Y)",
        disabled: redoStack.length === 0 ? "" : null,
      },
      icon("Redo2", 14),
    );
    redoBtn.addEventListener("click", performRedo);

    const zoomOutBtn = h("button", { class: "btn btn--sm", type: "button", "data-tip": "Zoom Out" }, icon("Minus", 13));
    zoomOutBtn.addEventListener("click", () => {
      zoom = Math.max(0.5, Math.round((zoom - 0.1) * 100) / 100);
      persistSession();
      renderHeader();
      renderCanvas();
    });
    const zoomResetBtn = h(
      "button",
      { class: "btn btn--sm", type: "button", "data-tip": "Reset Zoom to 100%" },
      `${Math.round(zoom * 100)}%`,
    );
    zoomResetBtn.addEventListener("click", () => {
      zoom = 1.0;
      persistSession();
      renderHeader();
      renderCanvas();
    });
    const zoomInBtn = h("button", { class: "btn btn--sm", type: "button", "data-tip": "Zoom In" }, icon("Plus", 13));
    zoomInBtn.addEventListener("click", () => {
      zoom = Math.min(2.4, Math.round((zoom + 0.1) * 100) / 100);
      persistSession();
      renderHeader();
      renderCanvas();
    });

    const savePdfTopBtn = h(
      "button",
      { class: "btn btn--sm btn--primary", type: "button", "data-tip": "Save edited PDF to disk (.pdf)" },
      icon("Save", 14),
      "Save PDF",
    );
    savePdfTopBtn.addEventListener("click", () => void triggerSavePdf());

    const backToWordBtn = h(
      "button",
      {
        class: "btn btn--sm",
        type: "button",
        "data-tip": "Return to Word Processor (your PDF Studio work stays saved in session)",
      },
      icon("ArrowLeft", 14),
      "Back to Word Processor",
    );
    backToWordBtn.addEventListener("click", closeStudio);

    headerSlot.append(
      h(
        "div",
        { class: "pdf-studio__brand" },
        h("span", { class: "pdf-studio__badge" }, icon("FileText", 14), "PDF STUDIO SUITE"),
        h("strong", { class: "pdf-studio__filename" }, pdfName),
        h("span", { class: "pdf-studio__meta" }, `${pages.length} ${pages.length === 1 ? "page" : "pages"}`),
      ),
      h(
        "div",
        { class: "pdf-studio__hactions" },
        openPdfBtn,
        h("div", { class: "pdf-ribbon-sep" }),
        undoBtn,
        redoBtn,
        h("div", { class: "pdf-ribbon-sep" }),
        zoomOutBtn,
        zoomResetBtn,
        zoomInBtn,
        h("div", { class: "pdf-ribbon-sep" }),
        savePdfTopBtn,
        backToWordBtn,
      ),
    );
  };

  // --- 2. Dedicated Acrobat / Foxit Pro Top Formatting Ribbon ---------------
  const renderRibbon = () => {
    ribbonSlot.replaceChildren();
    const curPage = pages[activePageIdx];
    const sel = getSelectedObject();
    const selTextObj =
      sel?.block && sel.block.kind !== "image"
        ? sel.block
        : sel?.ann && sel.ann.kind === "textbox"
          ? sel.ann
          : null;
    const selImgObj =
      sel?.block && sel.block.kind === "image"
        ? sel.block
        : sel?.ann && sel.ann.kind === "image"
          ? sel.ann
          : null;

    // Group A: Suite Tools
    const makeToolBtn = (mode: PdfToolMode, iconName: string, label: string, tip: string) => {
      const btn = h(
        "button",
        {
          class: "pdf-tool-btn" + (activeTool === mode ? " is-active" : ""),
          type: "button",
          "data-tip": tip,
        },
        icon(iconName, 14),
        h("span", {}, label),
      );
      btn.addEventListener("click", () => {
        activeTool = mode;
        renderRibbon();
        renderInspector();
        renderCanvas();
      });
      return btn;
    };

    const addTextBoxBtn = h(
      "button",
      { class: "pdf-tool-btn", type: "button", "data-tip": "Insert a new movable & resizable Text Box on this page" },
      icon("Type", 14),
      h("span", {}, "Add Text Box"),
    );
    addTextBoxBtn.addEventListener("click", () => {
      if (!curPage) return;
      snapshotState();
      const ann: PdfAnnotation = {
        id: nextId("tb"),
        kind: "textbox",
        x: Math.round(curPage.widthPt * 0.2),
        y: Math.round(curPage.heightPt * 0.2),
        width: 240,
        height: 36,
        text: "Double-click to type text…",
        color: "#111827",
        bgColor: "transparent",
        fontFamily: "Calibri",
        fontSize: 14,
        bold: false,
        italic: false,
        underline: false,
        align: "left",
        points: [],
        strokeWidth: 1,
      };
      curPage.annotations.push(ann);
      selectedItemId = ann.id;
      inlineEditingId = ann.id;
      activeTool = "select";
      snapshotState();
      persistSession();
      renderAll();
    });

    const addImageBtn = h(
      "button",
      { class: "pdf-tool-btn", type: "button", "data-tip": "Insert a picture from your PC onto this PDF page" },
      icon("ImagePlus", 14),
      h("span", {}, "Add Picture"),
    );
    addImageBtn.addEventListener("click", async () => {
      if (!curPage) return;
      const picked = await openDialog({
        title: "Insert Picture onto PDF Page",
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] }],
      });
      if (!picked || typeof picked !== "string") return;
      try {
        const dataUrl = await native.readImage(picked);
        snapshotState();
        const ann: PdfAnnotation = {
          id: nextId("img"),
          kind: "image",
          x: 90,
          y: 110,
          width: 220,
          height: 150,
          text: "",
          color: "",
          fontSize: 12,
          bold: false,
          imageSrc: dataUrl,
          points: [],
          strokeWidth: 1,
        };
        curPage.annotations.push(ann);
        selectedItemId = ann.id;
        activeTool = "select";
        snapshotState();
        persistSession();
        renderAll();
      } catch (e) {
        toast(`Could not load image: ${e}`, "error", 3000);
      }
    });

    const addWhiteoutBtn = h(
      "button",
      {
        class: "pdf-tool-btn" + (activeTool === "whiteout" ? " is-active" : ""),
        type: "button",
        "data-tip": "Click or drag on the page to place a clean Whiteout / Eraser cover patch over any graphic or area",
      },
      icon("Eraser", 14),
      h("span", {}, "Whiteout / Erase"),
    );
    addWhiteoutBtn.addEventListener("click", () => {
      activeTool = activeTool === "whiteout" ? "select" : "whiteout";
      renderRibbon();
      renderInspector();
      renderCanvas();
    });

    const addStampBtn = h(
      "button",
      { class: "pdf-tool-btn", type: "button", "data-tip": `Place "${activeStampPreset.label}" stamp on page` },
      icon("Stamp", 14),
      h("span", {}, `Stamp: ${activeStampPreset.label}`),
    );
    addStampBtn.addEventListener("click", () => {
      if (!curPage) return;
      snapshotState();
      const ann: PdfAnnotation = {
        id: nextId("st"),
        kind: "stamp",
        x: Math.round(curPage.widthPt * 0.35),
        y: Math.round(curPage.heightPt * 0.16),
        width: 170,
        height: 44,
        text: activeStampPreset.label,
        stampType: activeStampPreset.label,
        color: activeStampPreset.color,
        fontSize: 15,
        bold: true,
        points: [],
        strokeWidth: 2,
      };
      curPage.annotations.push(ann);
      selectedItemId = ann.id;
      activeTool = "select";
      snapshotState();
      persistSession();
      renderAll();
    });

    const toolsRow = h(
      "div",
      { class: "pdf-ribbon-row" },
      makeToolBtn("select", "MousePointer", "Select / Move", "Select, move, or resize any text block, embedded photo, or annotation"),
      makeToolBtn("edit-text", "FilePen", "Edit Text Inline", "Click any text on the PDF page to edit it directly in-place"),
      addTextBoxBtn,
      addImageBtn,
      addWhiteoutBtn,
      makeToolBtn("highlight", "Highlighter", "Highlight", "Click or drag on the page to place a highlighter bar"),
      makeToolBtn("draw", "PenTool", "Draw / Sign", "Draw freehand ink or sign directly on the page"),
      addStampBtn,
    );

    // Group B: Contextual Typography & Object Formatting Bar
    const formatRow = h("div", { class: "pdf-ribbon-row pdf-ribbon-row--format" });

    if (selTextObj) {
      // Font Family Select
      const curFont = (selTextObj as any).fontFamily || "Calibri";
      const fontSelect = h(
        "select",
        { class: "input pdf-ribbon-select", title: "Font Family" },
        ...PDF_FONTS.map((ff) =>
          h("option", { value: ff, selected: ff.toLowerCase() === curFont.toLowerCase() ? "selected" : null }, ff),
        ),
      ) as HTMLSelectElement;
      fontSelect.addEventListener("change", () => {
        snapshotState();
        (selTextObj as any).fontFamily = fontSelect.value;
        // Mark block as modified so live font renders
        if ("originalText" in selTextObj && selTextObj.originalText === selTextObj.text) {
          selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        }
        snapshotState();
        persistSession();
        renderCanvas();
        renderInspector();
      });

      // Font Size Controls
      const curSize = Math.round((selTextObj.fontSize || 12) * 10) / 10;
      const decSizeBtn = h("button", { class: "btn btn--sm", type: "button", "data-tip": "Decrease Font Size" }, "A−");
      decSizeBtn.addEventListener("click", () => {
        snapshotState();
        selTextObj.fontSize = Math.max(6, Math.round((selTextObj.fontSize - 1) * 10) / 10);
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderRibbon();
        renderCanvas();
        renderInspector();
      });

      const sizeInput = h("input", {
        class: "input pdf-ribbon-num",
        type: "number",
        min: "6",
        max: "96",
        step: "0.5",
        value: String(curSize),
        title: "Font Size (pt)",
      }) as HTMLInputElement;
      sizeInput.addEventListener("change", () => {
        const v = parseFloat(sizeInput.value);
        if (!Number.isFinite(v)) return;
        snapshotState();
        selTextObj.fontSize = Math.max(6, Math.min(96, v));
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderCanvas();
        renderInspector();
      });

      const incSizeBtn = h("button", { class: "btn btn--sm", type: "button", "data-tip": "Increase Font Size" }, "A+");
      incSizeBtn.addEventListener("click", () => {
        snapshotState();
        selTextObj.fontSize = Math.min(96, Math.round((selTextObj.fontSize + 1) * 10) / 10);
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderRibbon();
        renderCanvas();
        renderInspector();
      });

      // Bold / Italic / Underline
      const boldBtn = h(
        "button",
        { class: "btn btn--sm" + (selTextObj.bold ? " btn--primary" : ""), type: "button", "data-tip": "Bold" },
        h("strong", {}, "B"),
      );
      boldBtn.addEventListener("click", () => {
        snapshotState();
        selTextObj.bold = !selTextObj.bold;
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderRibbon();
        renderCanvas();
        renderInspector();
      });

      const italicBtn = h(
        "button",
        { class: "btn btn--sm" + ((selTextObj as any).italic ? " btn--primary" : ""), type: "button", "data-tip": "Italic" },
        h("em", {}, "I"),
      );
      italicBtn.addEventListener("click", () => {
        snapshotState();
        (selTextObj as any).italic = !(selTextObj as any).italic;
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderRibbon();
        renderCanvas();
        renderInspector();
      });

      const underlineBtn = h(
        "button",
        { class: "btn btn--sm" + ((selTextObj as any).underline ? " btn--primary" : ""), type: "button", "data-tip": "Underline" },
        h("span", { style: { textDecoration: "underline" } }, "U"),
      );
      underlineBtn.addEventListener("click", () => {
        snapshotState();
        (selTextObj as any).underline = !(selTextObj as any).underline;
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        snapshotState();
        persistSession();
        renderRibbon();
        renderCanvas();
        renderInspector();
      });

      // Alignment (Left / Center / Right)
      const curAlign = (selTextObj as any).align || "left";
      const makeAlignBtn = (al: "left" | "center" | "right", ic: string, tip: string) => {
        const b = h(
          "button",
          { class: "btn btn--sm" + (curAlign === al ? " btn--primary" : ""), type: "button", "data-tip": tip },
          icon(ic, 13),
        );
        b.addEventListener("click", () => {
          snapshotState();
          (selTextObj as any).align = al;
          if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
          snapshotState();
          persistSession();
          renderRibbon();
          renderCanvas();
          renderInspector();
        });
        return b;
      };

      // Text Color Picker
      const colorInput = h("input", {
        type: "color",
        value: /^#[0-9a-fA-F]{6}$/.test(selTextObj.color || "") ? selTextObj.color : "#1c1c1f",
        title: "Text Color",
        style: { width: "28px", height: "28px", padding: "0", border: "none", background: "transparent", cursor: "pointer" },
      }) as HTMLInputElement;
      colorInput.addEventListener("input", () => {
        selTextObj.color = colorInput.value;
        if ("originalText" in selTextObj) selTextObj.originalX = (selTextObj.originalX ?? selTextObj.x) - 0.01;
        persistSession();
        renderCanvas();
      });

      // Edit Inline Button
      const editInlineBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Type directly inside this text box on the page" },
        icon("FilePen", 13),
        "Edit Inline",
      );
      editInlineBtn.addEventListener("click", () => {
        inlineEditingId = selTextObj.id;
        renderCanvas();
      });

      const dupBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Duplicate Selected Text (Ctrl+D)" },
        icon("Copy", 13),
        "Duplicate",
      );
      dupBtn.addEventListener("click", () => duplicateObjectById(selTextObj.id));

      const delBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Delete Selected Text (Del)" },
        icon("Trash2", 13),
        "Delete",
      );
      delBtn.addEventListener("click", () => deleteObjectById(selTextObj.id));

      formatRow.append(
        h("span", { class: "pdf-insp__label" }, "Text Formatting:"),
        fontSelect,
        decSizeBtn,
        sizeInput,
        incSizeBtn,
        h("div", { class: "pdf-ribbon-sep" }),
        boldBtn,
        italicBtn,
        underlineBtn,
        h("div", { class: "pdf-ribbon-sep" }),
        makeAlignBtn("left", "AlignLeft", "Align Left"),
        makeAlignBtn("center", "AlignCenter", "Align Center"),
        makeAlignBtn("right", "AlignRight", "Align Right"),
        h("div", { class: "pdf-ribbon-sep" }),
        h("span", { class: "pdf-insp__label" }, "Color:"),
        colorInput,
        h("div", { class: "pdf-ribbon-sep" }),
        editInlineBtn,
        dupBtn,
        delBtn,
      );
    } else if (selImgObj) {
      const replaceBtn = h(
        "button",
        { class: "btn btn--sm btn--primary", type: "button" },
        icon("ImagePlus", 13),
        "Replace Picture…",
      );
      replaceBtn.addEventListener("click", () => void replaceImageObject(selImgObj.id));

      const scaleDownBtn = h("button", { class: "btn btn--sm", type: "button" }, "Smaller −10%");
      scaleDownBtn.addEventListener("click", () => {
        snapshotState();
        selImgObj.width = Math.max(24, Math.round(selImgObj.width * 0.9));
        selImgObj.height = Math.max(24, Math.round(selImgObj.height * 0.9));
        snapshotState();
        persistSession();
        renderCanvas();
        renderInspector();
      });

      const scaleUpBtn = h("button", { class: "btn btn--sm", type: "button" }, "Larger +10%");
      scaleUpBtn.addEventListener("click", () => {
        snapshotState();
        selImgObj.width = Math.min(760, Math.round(selImgObj.width * 1.1));
        selImgObj.height = Math.min(760, Math.round(selImgObj.height * 1.1));
        snapshotState();
        persistSession();
        renderCanvas();
        renderInspector();
      });

      const dupBtn = h("button", { class: "btn btn--sm", type: "button" }, icon("Copy", 13), "Duplicate (Ctrl+D)");
      dupBtn.addEventListener("click", () => duplicateObjectById(selImgObj.id));

      const delBtn = h("button", { class: "btn btn--sm", type: "button" }, icon("Trash2", 13), "Remove Photo (Del)");
      delBtn.addEventListener("click", () => deleteObjectById(selImgObj.id));

      formatRow.append(
        h("span", { class: "pdf-insp__label" }, icon("Image", 14), "Selected PDF Picture:"),
        replaceBtn,
        scaleDownBtn,
        scaleUpBtn,
        dupBtn,
        delBtn,
      );
    } else if (activeTool === "draw") {
      const colorBtns = INK_COLORS.map((c) => {
        const b = h("button", {
          class: "pdf-swatch" + (activeInkColor === c.hex ? " is-active" : ""),
          type: "button",
          style: { background: c.hex, border: c.hex === "#ffffff" ? "1px solid #94a3b8" : undefined },
          "data-tip": c.label,
        });
        b.addEventListener("click", () => {
          activeInkColor = c.hex;
          renderRibbon();
        });
        return b;
      });
      const clearInkBtn = h("button", { class: "btn btn--sm", type: "button" }, icon("Trash2", 13), "Clear Ink on Page");
      clearInkBtn.addEventListener("click", () => {
        if (!curPage) return;
        snapshotState();
        curPage.annotations = curPage.annotations.filter((a) => a.kind !== "ink");
        snapshotState();
        persistSession();
        renderAll();
      });
      formatRow.append(
        h("span", { class: "pdf-insp__label" }, icon("PenTool", 13), "Draw / Signature Ink Color:"),
        h("div", { class: "pdf-insp__swatches" }, ...colorBtns),
        clearInkBtn,
      );
    } else if (activeTool === "highlight") {
      const hlBtns = HIGHLIGHT_COLORS.map((c) => {
        const b = h("button", {
          class: "pdf-swatch" + (activeHighlightColor === c.value ? " is-active" : ""),
          type: "button",
          style: { background: c.hex },
          "data-tip": `${c.label} Highlight`,
        });
        b.addEventListener("click", () => {
          activeHighlightColor = c.value;
          renderRibbon();
        });
        return b;
      });
      formatRow.append(
        h("span", { class: "pdf-insp__label" }, icon("Highlighter", 13), "Highlight Color (Click or drag on page):"),
        h("div", { class: "pdf-insp__swatches" }, ...hlBtns),
      );
    } else {
      const stampPills = STAMP_PRESETS.map((sp) => {
        const b = h(
          "button",
          {
            class: "pdf-stamp-chip" + (activeStampPreset.label === sp.label ? " is-active" : ""),
            type: "button",
            style: { borderColor: sp.color, color: sp.color },
          },
          sp.label,
        );
        b.addEventListener("click", () => {
          activeStampPreset = sp;
          renderRibbon();
        });
        return b;
      });
      formatRow.append(
        h("span", { class: "pdf-insp__label" }, "Stamp Preset:"),
        h("div", { class: "pdf-insp__stamps" }, ...stampPills),
        h(
          "span",
          { class: "pdf-insp__hint" },
          "Click any text or embedded photo on the slide to move/resize it · Double-click text to edit directly on the page.",
        ),
      );
    }

    ribbonSlot.append(toolsRow, formatRow);
  };

  // --- 3. Left Dock: Pages & Page Layers / Objects --------------------------
  const renderLeftDock = () => {
    leftDockSlot.replaceChildren();
    const curPage = pages[activePageIdx];

    const tabSwitch = h(
      "div",
      { class: "pdf-dock-tabs" },
      h(
        "button",
        {
          class: "pdf-dock-tab" + (leftDockTab === "pages" ? " is-active" : ""),
          type: "button",
          onClick: () => {
            leftDockTab = "pages";
            renderLeftDock();
          },
        },
        icon("Files", 13),
        `Pages (${pages.length})`,
      ),
      h(
        "button",
        {
          class: "pdf-dock-tab" + (leftDockTab === "layers" ? " is-active" : ""),
          type: "button",
          onClick: () => {
            leftDockTab = "layers";
            renderLeftDock();
          },
        },
        icon("Layers", 13),
        `Objects (${(curPage?.blocks.length ?? 0) + (curPage?.annotations.length ?? 0)})`,
      ),
    );
    leftDockSlot.append(tabSwitch);

    if (leftDockTab === "pages") {
      const orgBar = h("div", { class: "pdf-org-bar" });
      const moveUpBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Move page up", disabled: activePageIdx <= 0 ? "" : null },
        icon("ArrowUp", 13),
      );
      moveUpBtn.addEventListener("click", () => {
        if (activePageIdx <= 0) return;
        snapshotState();
        const tmp = pages[activePageIdx - 1];
        pages[activePageIdx - 1] = pages[activePageIdx];
        pages[activePageIdx] = tmp;
        pages.forEach((p, i) => (p.pageNumber = i + 1));
        activePageIdx--;
        snapshotState();
        persistSession();
        renderAll();
      });

      const moveDownBtn = h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          "data-tip": "Move page down",
          disabled: activePageIdx >= pages.length - 1 ? "" : null,
        },
        icon("ArrowDown", 13),
      );
      moveDownBtn.addEventListener("click", () => {
        if (activePageIdx >= pages.length - 1) return;
        snapshotState();
        const tmp = pages[activePageIdx + 1];
        pages[activePageIdx + 1] = pages[activePageIdx];
        pages[activePageIdx] = tmp;
        pages.forEach((p, i) => (p.pageNumber = i + 1));
        activePageIdx++;
        snapshotState();
        persistSession();
        renderAll();
      });

      const rotateBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Rotate page 90°" },
        icon("RotateCw", 13),
      );
      rotateBtn.addEventListener("click", () => {
        if (!curPage) return;
        snapshotState();
        curPage.rotation = (curPage.rotation + 90) % 360;
        snapshotState();
        persistSession();
        renderAll();
      });

      const addPageBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", "data-tip": "Insert blank page after current page" },
        icon("Plus", 13),
      );
      addPageBtn.addEventListener("click", () => {
        snapshotState();
        const newPage: PdfEditorPage = {
          pageNumber: activePageIdx + 2,
          widthPt: curPage ? curPage.widthPt : 595.28,
          heightPt: curPage ? curPage.heightPt : 841.89,
          rotation: 0,
          blocks: [
            {
              id: nextId("blk"),
              kind: "paragraph",
              text: "New Page — double-click to edit text.",
              x: 72,
              y: 72,
              width: 450,
              height: 28,
              fontSize: 14,
              fontFamily: "Calibri",
              bold: false,
              italic: false,
              color: "#1c1c1f",
            },
          ],
          annotations: [],
          deletedRects: [],
        };
        pages.splice(activePageIdx + 1, 0, newPage);
        pages.forEach((p, i) => (p.pageNumber = i + 1));
        activePageIdx++;
        snapshotState();
        persistSession();
        renderAll();
      });

      const deletePageBtn = h(
        "button",
        {
          class: "btn btn--sm",
          type: "button",
          "data-tip": "Delete current page",
          disabled: pages.length <= 1 ? "" : null,
        },
        icon("Trash2", 13),
      );
      deletePageBtn.addEventListener("click", () => {
        if (pages.length <= 1) return;
        snapshotState();
        pages.splice(activePageIdx, 1);
        pages.forEach((p, i) => (p.pageNumber = i + 1));
        activePageIdx = Math.min(activePageIdx, pages.length - 1);
        selectedItemId = null;
        inlineEditingId = null;
        snapshotState();
        persistSession();
        renderAll();
      });

      orgBar.append(moveUpBtn, moveDownBtn, rotateBtn, addPageBtn, deletePageBtn);
      leftDockSlot.append(orgBar);

      const list = h("div", { class: "pdf-thumb-list" });
      pages.forEach((p, idx) => {
        const isAct = idx === activePageIdx;
        const isLandscape = p.widthPt > p.heightPt;
        const thumbSheet = p.backgroundImage
          ? h(
              "div",
              {
                class: "pdf-thumb__sheet pdf-thumb__sheet--visual",
                style: { aspectRatio: `${p.widthPt} / ${p.heightPt}`, height: isLandscape ? "76px" : "108px" },
              },
              h("img", {
                src: p.backgroundImage,
                draggable: "false",
                style: { width: "100%", height: "100%", objectFit: "contain", borderRadius: "3px" },
              }),
            )
          : h(
              "div",
              { class: "pdf-thumb__sheet" },
              ...p.blocks
                .filter((b) => b.kind !== "image" && b.text.trim())
                .slice(0, 4)
                .map((b) => h("div", { class: "pdf-thumb__line" }, b.text.slice(0, 36))),
            );

        const card = h(
          "button",
          {
            class: "pdf-thumb" + (isAct ? " is-active" : ""),
            type: "button",
          },
          thumbSheet,
          h(
            "div",
            { class: "pdf-thumb__meta" },
            h("strong", {}, `Page ${idx + 1}`),
            h("span", {}, `${p.blocks.length + p.annotations.length} items`),
          ),
        );
        card.addEventListener("click", () => {
          activePageIdx = idx;
          selectedItemId = null;
          inlineEditingId = null;
          persistSession();
          renderAll();
        });
        list.append(card);
      });
      leftDockSlot.append(list);
    } else {
      // Page Layers / Objects List
      const layerList = h("div", { class: "pdf-layer-list" });
      if (!curPage || (curPage.blocks.length === 0 && curPage.annotations.length === 0)) {
        layerList.append(h("div", { class: "pdf-layer-empty" }, "No objects on this page."));
      } else {
        for (const blk of curPage.blocks) {
          const isSel = selectedItemId === blk.id;
          const isImg = blk.kind === "image";
          const row = h(
            "div",
            { class: "pdf-layer-item" + (isSel ? " is-active" : "") },
            icon(isImg ? "Image" : "Type", 13),
            h(
              "span",
              { class: "pdf-layer-item__label" },
              isImg ? "Embedded PDF Photo" : blk.text.slice(0, 28) || "(Empty Text)",
            ),
            h(
              "button",
              {
                class: "pdf-layer-item__del",
                type: "button",
                title: "Delete this object",
                onClick: (e: MouseEvent) => {
                  e.stopPropagation();
                  deleteObjectById(blk.id);
                },
              },
              icon("Trash2", 12),
            ),
          );
          row.addEventListener("click", () => {
            selectedItemId = blk.id;
            renderAll();
          });
          layerList.append(row);
        }
        for (const ann of curPage.annotations) {
          const isSel = selectedItemId === ann.id;
          const label =
            ann.kind === "textbox"
              ? `Text Box: ${ann.text.slice(0, 22)}`
              : ann.kind === "image"
                ? "Added Picture"
                : ann.kind === "whiteout"
                  ? "Whiteout Patch"
                  : ann.kind === "highlight"
                    ? "Highlight Bar"
                    : ann.kind === "stamp"
                      ? `Stamp: ${ann.stampType || ann.text}`
                      : "Signature / Ink";
          const row = h(
            "div",
            { class: "pdf-layer-item" + (isSel ? " is-active" : "") },
            icon(ann.kind === "image" ? "Image" : ann.kind === "ink" ? "PenTool" : "Square", 13),
            h("span", { class: "pdf-layer-item__label" }, label),
            h(
              "button",
              {
                class: "pdf-layer-item__del",
                type: "button",
                title: "Delete this item",
                onClick: (e: MouseEvent) => {
                  e.stopPropagation();
                  deleteObjectById(ann.id);
                },
              },
              icon("Trash2", 12),
            ),
          );
          row.addEventListener("click", () => {
            selectedItemId = ann.id;
            renderAll();
          });
          layerList.append(row);
        }
      }
      leftDockSlot.append(layerList);
    }
  };

  // --- 4. Right Properties Inspector Dock -----------------------------------
  const renderInspector = () => {
    rightInspectorSlot.replaceChildren();
    const curPage = pages[activePageIdx];
    const sel = getSelectedObject();

    const titleEl = h("div", { class: "pdf-studio__side-title" }, "Properties & Inspector");
    rightInspectorSlot.append(titleEl);

    if (!sel && curPage) {
      const textCount = curPage.blocks.filter((b) => b.kind !== "image").length;
      const imgCount =
        curPage.blocks.filter((b) => b.kind === "image").length +
        curPage.annotations.filter((a) => a.kind === "image").length;
      rightInspectorSlot.append(
        h(
          "div",
          { class: "pdf-prop-card" },
          h("div", { class: "pdf-prop-card__title" }, `Page ${activePageIdx + 1} Summary`),
          h("div", { class: "pdf-prop-row" }, h("span", {}, "Dimensions"), h("strong", {}, `${Math.round(curPage.widthPt)} × ${Math.round(curPage.heightPt)} pt`)),
          h("div", { class: "pdf-prop-row" }, h("span", {}, "Editable Text Blocks"), h("strong", {}, String(textCount))),
          h("div", { class: "pdf-prop-row" }, h("span", {}, "Photos / Images"), h("strong", {}, String(imgCount))),
          h("div", { class: "pdf-prop-row" }, h("span", {}, "Annotations"), h("strong", {}, String(curPage.annotations.length))),
        ),
        h(
          "div",
          { class: "pdf-prop-card" },
          h("div", { class: "pdf-prop-card__title" }, "Quick Guide"),
          h("p", { class: "pdf-prop-help" }, "• Click any text block or photo on the PDF to select, move, or resize it with handles."),
          h("p", { class: "pdf-prop-help" }, "• Double-click any text block to type directly on the PDF slide in-place."),
          h("p", { class: "pdf-prop-help" }, "• Click any embedded photo to move, resize, replace, or delete it."),
          h("p", { class: "pdf-prop-help" }, "• Right-click anywhere on the page for quick clipboard & object actions."),
        ),
      );
      return;
    }

    const targetObj: any = sel?.block || sel?.ann;
    if (!targetObj) return;

    const isImage = targetObj.kind === "image";
    const isText = targetObj.kind !== "image" && ("fontFamily" in targetObj || targetObj.kind === "textbox");

    // Card 1: Content / Picture Actions
    if (isText) {
      const textarea = h("textarea", {
        class: "input pdf-prop-textarea",
        rows: "4",
        placeholder: "Type text content…",
      }) as HTMLTextAreaElement;
      textarea.value = targetObj.text || "";
      textarea.addEventListener("input", () => {
        targetObj.text = textarea.value;
        if ("originalText" in targetObj && targetObj.originalX === undefined) {
          targetObj.originalX = targetObj.x;
        }
        persistSession();
        // Update live text node on canvas without losing textarea focus
        const liveEl = canvasWrapSlot.querySelector<HTMLElement>(`[data-pdf-id="${targetObj.id}"] .pdf-item__content`);
        if (liveEl) {
          liveEl.textContent = textarea.value;
        } else {
          renderCanvas();
        }
      });
      textarea.addEventListener("change", () => {
        snapshotState();
        persistSession();
      });

      const editInlineBtn = h(
        "button",
        { class: "btn btn--sm btn--primary", type: "button", style: { width: "100%", justifyContent: "center" } },
        icon("FilePen", 13),
        "Edit Directly on Page",
      );
      editInlineBtn.addEventListener("click", () => {
        inlineEditingId = targetObj.id;
        renderCanvas();
      });

      rightInspectorSlot.append(
        h(
          "div",
          { class: "pdf-prop-card" },
          h("div", { class: "pdf-prop-card__title" }, "Text Content"),
          textarea,
          editInlineBtn,
        ),
      );
    } else if (isImage) {
      const replaceBtn = h(
        "button",
        { class: "btn btn--sm btn--primary", type: "button", style: { width: "100%", justifyContent: "center" } },
        icon("ImagePlus", 13),
        "Replace Picture from PC…",
      );
      replaceBtn.addEventListener("click", () => void replaceImageObject(targetObj.id));

      const dupImgBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", style: { width: "100%", justifyContent: "center" } },
        icon("Copy", 13),
        "Duplicate Picture (Ctrl+D)",
      );
      dupImgBtn.addEventListener("click", () => duplicateObjectById(targetObj.id));

      const delImgBtn = h(
        "button",
        { class: "btn btn--sm", type: "button", style: { width: "100%", justifyContent: "center", color: "#ef4444" } },
        icon("Trash2", 13),
        "Remove Photo from Page",
      );
      delImgBtn.addEventListener("click", () => deleteObjectById(targetObj.id));

      rightInspectorSlot.append(
        h(
          "div",
          { class: "pdf-prop-card" },
          h("div", { class: "pdf-prop-card__title" }, "Picture Controls"),
          targetObj.imageSrc
            ? h("img", {
                src: targetObj.imageSrc,
                style: {
                  width: "100%",
                  maxHeight: "110px",
                  objectFit: "contain",
                  background: "#ffffff",
                  borderRadius: "4px",
                  border: "1px solid var(--border)",
                },
              })
            : null,
          replaceBtn,
          dupImgBtn,
          delImgBtn,
        ),
      );
    }

    // Card 2: Geometry (X, Y, Width, Height)
    const makeCoordInput = (label: string, prop: "x" | "y" | "width" | "height") => {
      const inp = h("input", {
        class: "input pdf-prop-num",
        type: "number",
        value: String(Math.round(targetObj[prop] || 0)),
      }) as HTMLInputElement;
      inp.addEventListener("change", () => {
        const val = parseFloat(inp.value);
        if (!Number.isFinite(val)) return;
        snapshotState();
        targetObj[prop] = Math.max(prop === "width" || prop === "height" ? 16 : 0, Math.round(val));
        snapshotState();
        persistSession();
        renderCanvas();
      });
      return h("label", { class: "pdf-prop-coord" }, h("span", {}, label), inp);
    };

    const resetOrigBtn =
      targetObj.originalX !== undefined
        ? h(
            "button",
            { class: "btn btn--sm", type: "button", style: { width: "100%", justifyContent: "center" } },
            icon("RotateCcw", 13),
            "Reset to Original PDF Spot",
          )
        : null;
    if (resetOrigBtn) {
      resetOrigBtn.addEventListener("click", () => {
        snapshotState();
        targetObj.x = targetObj.originalX;
        targetObj.y = targetObj.originalY;
        targetObj.width = targetObj.originalWidth ?? targetObj.width;
        targetObj.height = targetObj.originalHeight ?? targetObj.height;
        if (targetObj.kind !== "image" && targetObj.originalText !== undefined) {
          targetObj.text = targetObj.originalText;
        }
        snapshotState();
        persistSession();
        renderAll();
      });
    }

    const delObjBtn = h(
      "button",
      { class: "btn btn--sm", type: "button", style: { width: "100%", justifyContent: "center" } },
      icon("Trash2", 13),
      "Delete Selected Object",
    );
    delObjBtn.addEventListener("click", () => deleteObjectById(targetObj.id));

    rightInspectorSlot.append(
      h(
        "div",
        { class: "pdf-prop-card" },
        h("div", { class: "pdf-prop-card__title" }, "Position & Size (pt)"),
        h(
          "div",
          { class: "pdf-prop-grid" },
          makeCoordInput("X", "x"),
          makeCoordInput("Y", "y"),
          makeCoordInput("W", "width"),
          makeCoordInput("H", "height"),
        ),
        resetOrigBtn,
        delObjBtn,
      ),
    );
  };

  // --- 5. Main Interactive PDF Page Canvas ----------------------------------
  const renderCanvas = () => {
    closeSuiteContextMenu();
    canvasWrapSlot.replaceChildren();
    const curPage = pages[activePageIdx];
    if (!curPage) return;

    const isRotated = curPage.rotation % 180 !== 0;
    const pw = isRotated ? curPage.heightPt : curPage.widthPt;
    const ph = isRotated ? curPage.widthPt : curPage.heightPt;
    const hasBg = Boolean(curPage.backgroundImage);

    const sheet = h("div", {
      class: "pdf-canvas-sheet",
      style: {
        width: `${pw}px`,
        height: `${ph}px`,
        zoom: String(zoom),
        cursor:
          activeTool === "draw"
            ? "crosshair"
            : activeTool === "highlight" || activeTool === "whiteout"
              ? "cell"
              : activeTool === "edit-text"
                ? "text"
                : "default",
      },
    });

    // 0. Render high-DPI visual PDF background image
    if (curPage.backgroundImage) {
      sheet.append(
        h("img", {
          class: "pdf-canvas-bg",
          src: curPage.backgroundImage,
          draggable: "false",
          style: {
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            objectFit: "fill",
            pointerEvents: "none",
            userSelect: "none",
          },
        }),
      );
    }

    // Helper: Creates a seamless background mask patch over `[ox, oy, ow, oh]`
    // using `curPage.cleanBackgroundImage` (text-free slide graphics!) when available!
    const appendSeamlessMaskPatch = (
      ox: number,
      oy: number,
      ow: number,
      oh: number,
      mode: "clean" | "color",
      fallbackColor: string,
    ) => {
      const pad = 5;
      const px = Math.max(0, ox - pad);
      const py = Math.max(0, oy - pad);
      const pwRect = Math.min(pw - px, ow + pad * 2);
      const phRect = Math.min(ph - py, oh + pad * 2);

      if (mode === "clean" && curPage.cleanBackgroundImage) {
        sheet.append(
          h("div", {
            style: {
              position: "absolute",
              left: `${px}px`,
              top: `${py}px`,
              width: `${pwRect}px`,
              height: `${phRect}px`,
              backgroundImage: `url("${curPage.cleanBackgroundImage}")`,
              backgroundSize: `${pw}px ${ph}px`,
              backgroundPosition: `-${px}px -${py}px`,
              backgroundRepeat: "no-repeat",
              pointerEvents: "none",
            },
          }),
        );
      } else {
        sheet.append(
          h("div", {
            style: {
              position: "absolute",
              left: `${px}px`,
              top: `${py}px`,
              width: `${pwRect}px`,
              height: `${phRect}px`,
              background: fallbackColor || "#ffffff",
              pointerEvents: "none",
            },
          }),
        );
      }
    };

    // 0b. Render cover patches for deleted blocks on visual PDF pages
    for (const dr of curPage.deletedRects ?? []) {
      appendSeamlessMaskPatch(
        dr.x,
        dr.y,
        dr.width,
        dr.height,
        dr.color === "__clean__" ? "clean" : "color",
        dr.color === "__clean__" ? "#ffffff" : dr.color || "#ffffff",
      );
    }

    // Clicking empty sheet area (deselects or places Highlight / Whiteout / Ink)
    sheet.addEventListener("mousedown", (e) => {
      closeSuiteContextMenu();
      if (e.button !== 0) return;
      if (e.target !== sheet) return;

      const rect = sheet.getBoundingClientRect();
      const clickX = Math.round((e.clientX - rect.left) / zoom);
      const clickY = Math.round((e.clientY - rect.top) / zoom);

      if (activeTool === "highlight" || activeTool === "whiteout") {
        snapshotState();
        const isWo = activeTool === "whiteout";
        const ann: PdfAnnotation = {
          id: nextId(isWo ? "wo" : "hl"),
          kind: isWo ? "whiteout" : "highlight",
          x: Math.max(4, clickX),
          y: Math.max(4, clickY),
          width: isWo ? 140 : 180,
          height: isWo ? 36 : 22,
          text: "",
          color: isWo ? "#ffffff" : activeHighlightColor,
          fontSize: 12,
          bold: false,
          points: [],
          strokeWidth: 1,
        };
        curPage.annotations.push(ann);
        selectedItemId = ann.id;

        // Allow drag-sizing the highlight/whiteout rectangle on creation
        const onMove = (me: MouseEvent) => {
          const curX = Math.round((me.clientX - rect.left) / zoom);
          const curY = Math.round((me.clientY - rect.top) / zoom);
          ann.width = Math.max(24, curX - clickX);
          ann.height = Math.max(14, curY - clickY);
          renderCanvas();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          activeTool = "select";
          snapshotState();
          persistSession();
          renderAll();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        renderAll();
        return;
      }

      if (activeTool === "draw") {
        snapshotState();
        const pts: PdfInkPoint[] = [{ x: clickX, y: clickY }];
        const ann: PdfAnnotation = {
          id: nextId("ink"),
          kind: "ink",
          x: 0,
          y: 0,
          width: pw,
          height: ph,
          text: "",
          color: activeInkColor,
          fontSize: 12,
          bold: false,
          points: pts,
          strokeWidth: 2.4,
        };
        curPage.annotations.push(ann);

        const onMove = (me: MouseEvent) => {
          const r = sheet.getBoundingClientRect();
          pts.push({
            x: Math.max(0, Math.min(pw, (me.clientX - r.left) / zoom)),
            y: Math.max(0, Math.min(ph, (me.clientY - r.top) / zoom)),
          });
          renderCanvas();
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          snapshotState();
          persistSession();
          renderLeftDock();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return;
      }

      // Commit any active inline edit and deselect without losing edits
      if (inlineEditingId || selectedItemId) {
        inlineEditingId = null;
        selectedItemId = null;
        snapshotState();
        persistSession();
        renderRibbon();
        renderInspector();
        renderLeftDock();
        renderCanvas();
      }
    });

    // Clicking dark stage around the page sheet also commits & deselects safely (never closes studio!)
    canvasWrapSlot.onmousedown = (e: MouseEvent) => {
      if (e.target === canvasWrapSlot) {
        closeSuiteContextMenu();
        if (inlineEditingId || selectedItemId) {
          inlineEditingId = null;
          selectedItemId = null;
          snapshotState();
          persistSession();
          renderRibbon();
          renderInspector();
          renderLeftDock();
          renderCanvas();
        }
      }
    };

    // Custom Right-Click Context Menu inside PDF Studio
    sheet.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      closeSuiteContextMenu();

      const targetEl = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-pdf-id]");
      const itemId = targetEl?.getAttribute("data-pdf-id") || null;
      if (itemId) {
        selectedItemId = itemId;
        renderRibbon();
        renderInspector();
      }

      const rect = sheet.getBoundingClientRect();
      const clickX = Math.round((e.clientX - rect.left) / zoom);
      const clickY = Math.round((e.clientY - rect.top) / zoom);

      const sel = getSelectedObject();
      const menuEl = h("div", {
        class: "popover popover--in pdf-context-menu",
        style: {
          left: `${Math.min(window.innerWidth - 220, e.clientX)}px`,
          top: `${Math.min(window.innerHeight - 260, e.clientY)}px`,
        },
      });
      const list = h("div", { class: "menu" });

      const addMenuItem = (label: string, ic: string, hint: string, fn: () => void) => {
        const b = h(
          "button",
          { class: "menu__item", type: "button" },
          h("span", { class: "menu__icon" }, icon(ic, 14)),
          h("span", { class: "menu__label" }, label),
          hint ? h("span", { class: "menu__hint" }, hint) : null,
        );
        b.addEventListener("click", () => {
          closeSuiteContextMenu();
          fn();
        });
        list.append(b);
      };

      if (sel?.block || sel?.ann) {
        const obj: any = sel.block || sel.ann;
        if (obj.kind === "image") {
          addMenuItem("Replace Picture…", "ImagePlus", "", () => void replaceImageObject(obj.id));
          addMenuItem("Duplicate Picture", "Copy", "Ctrl+D", () => duplicateObjectById(obj.id));
          list.append(h("div", { class: "menu__sep" }));
          addMenuItem("Remove Picture from Page", "Trash2", "Del", () => deleteObjectById(obj.id));
        } else {
          addMenuItem("Edit Text Inline on Page", "FilePen", "Dbl-Click", () => {
            inlineEditingId = obj.id;
            renderCanvas();
          });
          addMenuItem("Copy Text", "Copy", "Ctrl+C", () => {
            void tauriWriteText(obj.text || "").catch(() => {});
            toast("Copied text to clipboard", "success", 1300);
          });
          addMenuItem("Duplicate Text Block", "CopyPlus", "Ctrl+D", () => duplicateObjectById(obj.id));
          list.append(h("div", { class: "menu__sep" }));
          addMenuItem("Delete Text Block", "Trash2", "Del", () => deleteObjectById(obj.id));
        }
      } else {
        addMenuItem("Add Text Box Here", "Type", "", () => {
          snapshotState();
          const ann: PdfAnnotation = {
            id: nextId("tb"),
            kind: "textbox",
            x: Math.max(12, clickX),
            y: Math.max(12, clickY),
            width: 220,
            height: 34,
            text: "Type text…",
            color: "#111827",
            fontFamily: "Calibri",
            fontSize: 14,
            bold: false,
            points: [],
            strokeWidth: 1,
          };
          curPage.annotations.push(ann);
          selectedItemId = ann.id;
          inlineEditingId = ann.id;
          snapshotState();
          persistSession();
          renderAll();
        });
        addMenuItem("Insert Picture Here…", "ImagePlus", "", () => addImageBtnClickAt(clickX, clickY));
        addMenuItem("Place Whiteout Patch Here", "Eraser", "", () => {
          snapshotState();
          const ann: PdfAnnotation = {
            id: nextId("wo"),
            kind: "whiteout",
            x: Math.max(8, clickX - 50),
            y: Math.max(8, clickY - 16),
            width: 120,
            height: 36,
            text: "",
            color: "#ffffff",
            fontSize: 12,
            bold: false,
            points: [],
            strokeWidth: 1,
          };
          curPage.annotations.push(ann);
          selectedItemId = ann.id;
          snapshotState();
          persistSession();
          renderAll();
        });
      }

      menuEl.append(list);
      modal.append(menuEl);
      suiteContextMenuEl = menuEl;
    });

    const addImageBtnClickAt = async (cx: number, cy: number) => {
      const picked = await openDialog({
        title: "Insert Picture onto PDF Page",
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"] }],
      });
      if (!picked || typeof picked !== "string") return;
      try {
        const dataUrl = await native.readImage(picked);
        snapshotState();
        const ann: PdfAnnotation = {
          id: nextId("img"),
          kind: "image",
          x: Math.max(12, cx - 80),
          y: Math.max(12, cy - 60),
          width: 200,
          height: 140,
          text: "",
          color: "",
          fontSize: 12,
          bold: false,
          imageSrc: dataUrl,
          points: [],
          strokeWidth: 1,
        };
        curPage.annotations.push(ann);
        selectedItemId = ann.id;
        snapshotState();
        persistSession();
        renderAll();
      } catch (e) {
        toast(`Could not load image: ${e}`, "error", 3000);
      }
    };

    // Helper: Attach drag-to-move AND 4-corner/side resize handles to any object on the PDF page
    const attachInteractiveHandles = (
      el: HTMLElement,
      itemId: string,
      obj: {
        x: number;
        y: number;
        width: number;
        height: number;
        originalX?: number;
        originalY?: number;
        originalWidth?: number;
        originalHeight?: number;
        originalText?: string;
        kind?: string;
      },
      allowInlineTextEdit: boolean,
    ) => {
      el.setAttribute("data-pdf-id", itemId);

      // Double-click to enter direct inline on-page text editing
      if (allowInlineTextEdit) {
        el.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          selectedItemId = itemId;
          inlineEditingId = itemId;
          renderRibbon();
          renderInspector();
          renderCanvas();
        });
      }

      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (activeTool === "draw") return;
        if ((e.target as HTMLElement | null)?.classList.contains("pdf-resize-handle")) return;
        if (inlineEditingId === itemId) {
          // Let user move cursor or select text inside active inline editor
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        closeSuiteContextMenu();

        if (activeTool === "edit-text" && allowInlineTextEdit) {
          selectedItemId = itemId;
          inlineEditingId = itemId;
          renderRibbon();
          renderInspector();
          renderCanvas();
          return;
        }

        const wasSelected = selectedItemId === itemId;
        selectedItemId = itemId;
        if (inlineEditingId && inlineEditingId !== itemId) {
          inlineEditingId = null;
        }

        const startX = e.clientX;
        const startY = e.clientY;
        const origX = obj.x;
        const origY = obj.y;
        let moved = false;

        const onMove = (me: MouseEvent) => {
          const dx = (me.clientX - startX) / zoom;
          const dy = (me.clientY - startY) / zoom;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
          if (!moved) return;
          const nx = Math.max(2, Math.min(pw - 20, Math.round(origX + dx)));
          const ny = Math.max(2, Math.min(ph - 16, Math.round(origY + dy)));
          obj.x = nx;
          obj.y = ny;
          el.style.left = `${nx}px`;
          el.style.top = `${ny}px`;
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          if (moved) {
            snapshotState();
            persistSession();
          }
          if (moved || !wasSelected) {
            renderRibbon();
            renderInspector();
            renderLeftDock();
            renderCanvas();
          }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });

      // Add resize handles when selected and not inline-editing
      if (selectedItemId === itemId && inlineEditingId !== itemId) {
        const dirs = ["nw", "ne", "sw", "se", "e", "w"] as const;
        for (const dir of dirs) {
          const handle = h("div", { class: `pdf-resize-handle pdf-resize-handle--${dir}` });
          handle.addEventListener("mousedown", (he: MouseEvent) => {
            he.stopPropagation();
            he.preventDefault();
            const startX = he.clientX;
            const startY = he.clientY;
            const sx = obj.x;
            const sy = obj.y;
            const sw = obj.width;
            const sh = obj.height;

            const onMove = (me: MouseEvent) => {
              const dx = (me.clientX - startX) / zoom;
              const dy = (me.clientY - startY) / zoom;
              if (dir.includes("e")) obj.width = Math.max(28, Math.round(sw + dx));
              if (dir.includes("s")) obj.height = Math.max(18, Math.round(sh + dy));
              if (dir.includes("w")) {
                const nw = Math.max(28, Math.round(sw - dx));
                obj.x = Math.round(sx + (sw - nw));
                obj.width = nw;
              }
              if (dir.includes("n")) {
                const nh = Math.max(18, Math.round(sh - dy));
                obj.y = Math.round(sy + (sh - nh));
                obj.height = nh;
              }
              if (obj.kind === "image" && obj.originalText === "embedded") {
                obj.originalText = "modified";
              }
              el.style.left = `${obj.x}px`;
              el.style.top = `${obj.y}px`;
              el.style.width = `${obj.width}px`;
              el.style.height = `${obj.height}px`;
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
              snapshotState();
              persistSession();
              renderInspector();
              renderCanvas();
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          });
          el.append(handle);
        }
      }
    };

    // 1. Render Whiteout / Redact & Highlight Annotations
    for (const ann of curPage.annotations) {
      if (ann.kind !== "highlight" && ann.kind !== "whiteout" && ann.kind !== "rect") continue;
      const isSel = selectedItemId === ann.id;
      const boxEl = h("div", {
        class: `pdf-item pdf-item--${ann.kind}` + (isSel ? " is-selected" : ""),
        style: {
          left: `${ann.x}px`,
          top: `${ann.y}px`,
          width: `${ann.width}px`,
          height: `${ann.height}px`,
          background:
            ann.kind === "whiteout"
              ? ann.color || "#ffffff"
              : ann.color || "rgba(250, 204, 21, 0.42)",
        },
        title: ann.kind === "whiteout" ? "Whiteout / Cover Patch (drag or resize)" : "Highlight (drag or resize)",
      });
      attachInteractiveHandles(boxEl, ann.id, ann, false);
      sheet.append(boxEl);
    }

    // 2. Render Extracted / Editable PDF Blocks (Both Embedded Photos & Text Blocks)
    for (const blk of curPage.blocks) {
      const isSel = selectedItemId === blk.id;
      const isInline = inlineEditingId === blk.id;

      if (blk.kind === "image" && blk.imageSrc) {
        const imgModified =
          hasBg &&
          (Math.abs((blk.originalX ?? blk.x) - blk.x) > 1.5 ||
            Math.abs((blk.originalY ?? blk.y) - blk.y) > 1.5 ||
            Math.abs((blk.originalWidth ?? blk.width) - blk.width) > 1.5 ||
            Math.abs((blk.originalHeight ?? blk.height) - blk.height) > 1.5 ||
            blk.originalText === "modified");

        if (hasBg && (imgModified || isSel) && blk.originalX !== undefined && blk.originalY !== undefined) {
          appendSeamlessMaskPatch(
            blk.originalX,
            blk.originalY,
            blk.originalWidth ?? blk.width,
            blk.originalHeight ?? blk.height,
            "color",
            blk.bgPatchColor || "#ffffff",
          );
        }

        const showLiveImg = !hasBg || imgModified || isSel;
        const imgWrap = h(
          "div",
          {
            class:
              "pdf-item pdf-item--image" +
              (isSel ? " is-selected" : "") +
              (!showLiveImg ? " is-overlay" : ""),
            style: {
              left: `${blk.x}px`,
              top: `${blk.y}px`,
              width: `${blk.width}px`,
              height: `${blk.height}px`,
            },
            title: "Embedded PDF Picture — Click to move, resize, replace, or delete",
          },
          showLiveImg
            ? h("img", {
                src: blk.imageSrc,
                draggable: "false",
                style: { width: "100%", height: "100%", objectFit: "fill" },
              })
            : null,
        );
        attachInteractiveHandles(imgWrap, blk.id, blk, false);
        sheet.append(imgWrap);
        continue;
      }

      const isModified =
        hasBg &&
        blk.originalText !== undefined &&
        (blk.text !== blk.originalText ||
          Math.abs((blk.originalX ?? blk.x) - blk.x) > 0.005 ||
          Math.abs((blk.originalY ?? blk.y) - blk.y) > 0.005);

      // When modified, selected, or inline-editing on a visual PDF page, mask the original spot
      // using the Text-Free Clean Background Layer (`cleanBackgroundImage`) so ZERO ghost letters remain!
      if (hasBg && (isModified || isSel || isInline)) {
        const ox = blk.originalX ?? blk.x;
        const oy = blk.originalY ?? blk.y;
        const ow = blk.originalWidth ?? blk.width;
        const oh = blk.originalHeight ?? blk.height;
        appendSeamlessMaskPatch(ox, oy, ow, oh, "clean", blk.bgPatchColor || "#ffffff");
      }

      const showLiveText = !hasBg || isModified || isSel || isInline;
      const contentEl = h(
        "div",
        {
          class: "pdf-item__content",
          contenteditable: isInline ? "true" : "false",
          spellcheck: "false",
          style: {
            outline: "none",
            width: "100%",
            minHeight: "100%",
            cursor: isInline ? "text" : "inherit",
            userSelect: isInline ? "text" : "none",
          },
        },
        blk.text,
      );

      if (isInline) {
        contentEl.addEventListener("input", () => {
          blk.text = contentEl.innerText;
          persistSession();
          // Sync right inspector textarea without re-rendering canvas
          const ta = rightInspectorSlot.querySelector<HTMLTextAreaElement>(".pdf-prop-textarea");
          if (ta && document.activeElement !== ta) ta.value = blk.text;
        });
        contentEl.addEventListener("blur", () => {
          snapshotState();
          persistSession();
        });
        requestAnimationFrame(() => {
          contentEl.focus();
        });
      }

      const blkEl = h(
        "div",
        {
          class:
            "pdf-item pdf-item--block" +
            (isSel ? " is-selected" : "") +
            (isInline ? " is-inline-editing" : "") +
            (!showLiveText ? " is-overlay" : ""),
          style: {
            left: `${blk.x}px`,
            top: `${blk.y}px`,
            width: `${blk.width}px`,
            minHeight: `${blk.height}px`,
            fontSize: `${blk.fontSize}px`,
            fontFamily: `"${blk.fontFamily}", Calibri, sans-serif`,
            fontWeight: blk.bold ? "700" : "400",
            fontStyle: blk.italic ? "italic" : "normal",
            textDecoration: blk.underline ? "underline" : "none",
            textAlign: blk.align || "left",
            color: showLiveText ? blk.color || "#1c1c1f" : "transparent",
            background: showLiveText && blk.bgColor ? blk.bgColor : "transparent",
          },
          title: isInline
            ? "Typing directly on PDF page (click outside when done)"
            : "Click to select/move · Double-click to edit text directly on page",
        },
        contentEl,
      );
      attachInteractiveHandles(blkEl, blk.id, blk, true);
      sheet.append(blkEl);
    }

    // 3. Render Annotations (Textboxes, Stamps, Added Images, Freehand Ink)
    for (const ann of curPage.annotations) {
      if (ann.kind === "highlight" || ann.kind === "whiteout" || ann.kind === "rect") continue;
      const isSel = selectedItemId === ann.id;
      const isInline = inlineEditingId === ann.id;

      if (ann.kind === "textbox") {
        const contentEl = h(
          "div",
          {
            class: "pdf-item__content",
            contenteditable: isInline ? "true" : "false",
            spellcheck: "false",
            style: {
              outline: "none",
              width: "100%",
              minHeight: "100%",
              cursor: isInline ? "text" : "inherit",
              userSelect: isInline ? "text" : "none",
            },
          },
          ann.text,
        );
        if (isInline) {
          contentEl.addEventListener("input", () => {
            ann.text = contentEl.innerText;
            persistSession();
            const ta = rightInspectorSlot.querySelector<HTMLTextAreaElement>(".pdf-prop-textarea");
            if (ta && document.activeElement !== ta) ta.value = ann.text;
          });
          contentEl.addEventListener("blur", () => {
            snapshotState();
            persistSession();
          });
          requestAnimationFrame(() => contentEl.focus());
        }

        const tbEl = h(
          "div",
          {
            class:
              "pdf-item pdf-item--textbox" +
              (isSel ? " is-selected" : "") +
              (isInline ? " is-inline-editing" : ""),
            style: {
              left: `${ann.x}px`,
              top: `${ann.y}px`,
              width: `${ann.width}px`,
              minHeight: `${ann.height}px`,
              fontFamily: `"${ann.fontFamily || "Calibri"}", Calibri, sans-serif`,
              fontSize: `${ann.fontSize || 14}px`,
              fontWeight: ann.bold ? "700" : "400",
              fontStyle: ann.italic ? "italic" : "normal",
              textDecoration: ann.underline ? "underline" : "none",
              textAlign: ann.align || "left",
              color: ann.color || "#111827",
              background: ann.bgColor || "transparent",
            },
            title: "Click to move/resize · Double-click to type inside",
          },
          contentEl,
        );
        attachInteractiveHandles(tbEl, ann.id, ann, true);
        sheet.append(tbEl);
        continue;
      }

      if (ann.kind === "stamp") {
        const stEl = h(
          "div",
          {
            class: "pdf-item pdf-item--stamp" + (isSel ? " is-selected" : ""),
            style: {
              left: `${ann.x}px`,
              top: `${ann.y}px`,
              borderColor: ann.color || "#dc2626",
              color: ann.color || "#dc2626",
            },
          },
          ann.stampType || ann.text || "APPROVED",
        );
        attachInteractiveHandles(stEl, ann.id, ann, false);
        sheet.append(stEl);
        continue;
      }

      if (ann.kind === "image" && ann.imageSrc) {
        const imEl = h(
          "div",
          {
            class: "pdf-item pdf-item--image" + (isSel ? " is-selected" : ""),
            style: {
              left: `${ann.x}px`,
              top: `${ann.y}px`,
              width: `${ann.width}px`,
              height: `${ann.height}px`,
            },
          },
          h("img", {
            src: ann.imageSrc,
            draggable: "false",
            style: { width: "100%", height: "100%", objectFit: "contain" },
          }),
        );
        attachInteractiveHandles(imEl, ann.id, ann, false);
        sheet.append(imEl);
        continue;
      }
    }

    // 4. Render Freehand Ink / Signatures SVG Overlay
    const inkAnns = curPage.annotations.filter((a) => a.kind === "ink" && a.points.length >= 2);
    if (inkAnns.length > 0) {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "pdf-ink-layer");
      svg.setAttribute("viewBox", `0 0 ${pw} ${ph}`);
      svg.style.width = `${pw}px`;
      svg.style.height = `${ph}px`;

      for (const ink of inkAnns) {
        const path = document.createElementNS(svgNS, "path");
        const d = ink.points
          .map((pt, idx) => `${idx === 0 ? "M" : "L"} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
          .join(" ");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", ink.color || "#1d4ed8");
        path.setAttribute("stroke-width", String(ink.strokeWidth || 2.4));
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      }
      sheet.append(svg);
    }

    canvasWrapSlot.append(sheet);
  };

  // --- Save PDF Action ------------------------------------------------------
  const triggerSavePdf = async () => {
    const outPath = await saveDialog({
      title: "Save Edited PDF Document",
      defaultPath: pdfSourcePath || pdfName || "Edited_Document.pdf",
      filters: [{ name: "PDF Document (.pdf)", extensions: ["pdf"] }],
    });
    if (!outPath) return;
    try {
      toast("Compositing & saving PDF…", "info", 1600);
      const exportPages = await preparePagesForPdfExport(pages);
      await native.saveEditedPdf(outPath, exportPages);
      toast("Saved PDF successfully!", "success", 2800);
    } catch (e) {
      toast(`Failed to save PDF: ${e}`, "error", 4000);
    }
  };

  // --- 6. Bottom Suite Status & Export Bar ----------------------------------
  const renderFooter = () => {
    footerSlot.replaceChildren();

    const openInWordBtn = h(
      "button",
      {
        class: "btn",
        type: "button",
        "data-tip": "Convert this PDF into an editable Word Processor tab inside Typo",
      },
      icon("FileEdit", 14),
      "Open in Word Processor",
    );
    openInWordBtn.addEventListener("click", () => {
      try {
        const imported = buildDocxFromPdfPages(pages);
        const tabTitle = pdfName.replace(/\.pdf$/i, "");
        loadImportedDocxIntoNewTab(imported, tabTitle, true);
        closeStudio();
        toast(`Opened "${tabTitle}" in Word Processor`, "success", 2600);
      } catch (e) {
        toast(`Conversion failed: ${e}`, "error", 3500);
      }
    });

    const exportDocxBtn = h(
      "button",
      {
        class: "btn",
        type: "button",
        "data-tip": "Convert & save this PDF directly as a Microsoft Word (.docx) file",
      },
      icon("FileSpreadsheet", 14),
      "PDF to Word (.docx)…",
    );
    exportDocxBtn.addEventListener("click", async () => {
      const defaultDocx = (pdfSourcePath || pdfName).replace(/\.pdf$/i, "") + ".docx";
      const outPath = await saveDialog({
        title: "Export PDF as Word Document (.docx)",
        defaultPath: defaultDocx,
        filters: [{ name: "Word Document (.docx)", extensions: ["docx"] }],
      });
      if (!outPath) return;
      try {
        const imported = buildDocxFromPdfPages(pages);
        await native.saveDocx(
          outPath,
          imported.doc,
          imported.page,
          imported.defaults,
          pdfName.replace(/\.pdf$/i, ""),
        );
        toast("Converted & saved as Word (.docx)!", "success", 2800);
      } catch (e) {
        toast(`PDF to Word export failed: ${e}`, "error", 4000);
      }
    });

    const savePdfBtn = h(
      "button",
      {
        class: "btn btn--primary",
        type: "button",
        "data-tip": "Save your edited PDF pages, photos, text, and annotations to a .pdf file",
      },
      icon("Download", 14),
      "Save PDF (.pdf)…",
    );
    savePdfBtn.addEventListener("click", () => void triggerSavePdf());

    footerSlot.append(
      h(
        "div",
        { class: "pdf-studio__fmeta" },
        `Page ${activePageIdx + 1} of ${pages.length} · Zoom ${Math.round(zoom * 100)}% · Session Auto-Saved (Undo: Ctrl+Z · Redo: Ctrl+Y · Duplicate: Ctrl+D · Delete: Del)`,
      ),
      h("div", { class: "pdf-studio__factions" }, openInWordBtn, exportDocxBtn, savePdfBtn),
    );
  };

  const renderAll = () => {
    renderHeader();
    renderRibbon();
    renderLeftDock();
    renderInspector();
    renderCanvas();
    renderFooter();
  };

  renderAll();

  const bodyArea = h(
    "div",
    { class: "pdf-studio__body pdf-studio__body--suite" },
    leftDockSlot,
    canvasWrapSlot,
    rightInspectorSlot,
  );
  modal.append(headerSlot, ribbonSlot, bodyArea, footerSlot);
  backdrop.append(modal);
  document.body.append(backdrop);
  activeStudioOverlay = backdrop;
}

export const openPdfEditorModal = openPdfEditorStudio;
