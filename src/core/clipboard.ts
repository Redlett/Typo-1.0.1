/**
 * Differentiated Text vs. Image Clipboard Engine for Typo.
 * Provides:
 * - Distinct Copy/Cut/Duplicate for Pictures vs. Text
 * - Explicit "Paste Text", "Paste Plain Text Only", and "Paste Picture" actions
 * - Native Windows OS clipboard image reading (via @tauri-apps/plugin-clipboard-manager `readImage`)
 * - Smart Ctrl+V disambiguation so Office/Word text copies (which attach bitmap previews) paste as text,
 *   while screenshots (Win+Shift+S), browser "Copy Image", and in-app copied pictures paste as images.
 */
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import {
  readText as tauriReadText,
  writeText as tauriWriteText,
  readImage as tauriReadImage,
} from "@tauri-apps/plugin-clipboard-manager";
import type { ImageWrapMode } from "../editor/image-node";
import { scheduleLayout } from "./page";
import { toast } from "../ui/dom";

export interface CopiedImagePayload {
  src: string;
  width?: number | null;
  height?: number | null;
  wrap?: ImageWrapMode;
  x?: number | null;
  y?: number | null;
}

let copiedImageBuffer: CopiedImagePayload | null = null;
let lastCopiedKind: "text" | "image" | null = null;

export function getLastCopiedKind(): "text" | "image" | null {
  return lastCopiedKind;
}

export function setLastCopiedKind(kind: "text" | "image" | null): void {
  lastCopiedKind = kind;
}

export function getCopiedImageBuffer(): CopiedImagePayload | null {
  return copiedImageBuffer;
}

/** Returns the currently selected image node's attributes if an image is selected in the editor. */
export function getSelectedImageAttrs(editor: Editor): CopiedImagePayload | null {
  const sel = editor.state.selection as any;
  if (sel?.node?.type?.name === "image") {
    const a = sel.node.attrs || {};
    return {
      src: String(a.src || ""),
      width: a.width ?? null,
      height: a.height ?? null,
      wrap: (a.wrap as ImageWrapMode) || "wrap-left",
      x: a.x ?? null,
      y: a.y ?? null,
    };
  }
  if (editor.isActive("image")) {
    const a = editor.getAttributes("image");
    if (a?.src) {
      return {
        src: String(a.src),
        width: a.width ?? null,
        height: a.height ?? null,
        wrap: (a.wrap as ImageWrapMode) || "wrap-left",
        x: a.x ?? null,
        y: a.y ?? null,
      };
    }
  }
  return null;
}

export function isImageSelected(editor: Editor): boolean {
  return Boolean(getSelectedImageAttrs(editor));
}

export function hasSelectionOrImage(editor: Editor): boolean {
  return !editor.state.selection.empty || isImageSelected(editor);
}

/** Inserts an image into the editor with optional width/height/wrap attributes. */
export async function insertImageWithAttrs(
  editor: Editor,
  payload: CopiedImagePayload,
): Promise<void> {
  if (!payload.src) return;
  let width = payload.width ?? undefined;
  let height = payload.height ?? undefined;

  if (!width || !height) {
    const dims = await new Promise<{ w: number; h: number }>((res) => {
      const img = new window.Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = payload.src;
    });
    const sheet = document.getElementById("editor");
    const maxW = Math.max(120, Math.round((sheet?.clientWidth || 600) * 0.42));
    const scale = dims.w > maxW ? maxW / dims.w : 1;
    width = Math.round(dims.w * scale) || undefined;
    height = Math.round(dims.h * scale) || undefined;
  }

  const wrap: ImageWrapMode = payload.wrap || "wrap-left";

  editor
    .chain()
    .focus()
    .command(({ tr, state }) => {
      const $from = state.selection.$from;
      const insertPos = $from.parent.isTextblock ? $from.start() : state.selection.from;
      const safePos = Math.max(0, Math.min(insertPos, tr.doc.content.size));
      const imgNode = state.schema.nodes.image.create({
        src: payload.src,
        width,
        height,
        wrap,
        x: payload.x ?? null,
        y: payload.y ?? null,
      });
      tr.insert(safePos, imgNode);
      try {
        tr.setSelection(NodeSelection.create(tr.doc, safePos));
      } catch {
        // ignore selection fallback
      }
      return true;
    })
    .run();
  scheduleLayout();
}

/** Copies the currently selected picture to both the internal image buffer and system clipboard. */
export async function copySelectedImage(editor: Editor): Promise<boolean> {
  const attrs = getSelectedImageAttrs(editor);
  if (!attrs || !attrs.src) return false;

  copiedImageBuffer = { ...attrs };
  lastCopiedKind = "image";

  // Also write PNG blob to browser/OS clipboard if supported
  try {
    const res = await fetch(attrs.src);
    const blob = await res.blob();
    if (blob.type === "image/png" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    }
  } catch {
    // Internal buffer is already populated
  }

  toast("Copied picture to clipboard", "success", 1600);
  return true;
}

/** Cuts the currently selected picture. */
export async function cutSelectedImage(editor: Editor): Promise<boolean> {
  const ok = await copySelectedImage(editor);
  if (!ok) return false;
  editor.chain().focus().deleteSelection().run();
  scheduleLayout();
  toast("Cut picture to clipboard", "info", 1600);
  return true;
}

/** Duplicates the currently selected picture right in the document. */
export async function duplicateSelectedImage(editor: Editor): Promise<boolean> {
  const attrs = getSelectedImageAttrs(editor);
  if (!attrs || !attrs.src) return false;
  const clone: CopiedImagePayload = {
    ...attrs,
    x: typeof attrs.x === "number" ? attrs.x + 20 : null,
    y: typeof attrs.y === "number" ? attrs.y + 20 : null,
  };
  await insertImageWithAttrs(editor, clone);
  toast("Duplicated picture", "success", 1500);
  return true;
}

/** Copies the selected text to the OS clipboard. */
export async function copySelectedText(editor: Editor): Promise<boolean> {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  const plain = editor.state.doc.textBetween(from, to, "\n");
  lastCopiedKind = "text";
  editor.commands.focus();
  try {
    document.execCommand("copy");
  } catch {
    // ignore
  }
  if (plain) {
    await tauriWriteText(plain).catch(() => {});
  }
  toast("Copied text to clipboard", "success", 1400);
  return true;
}

/** Cuts the selected text to the OS clipboard. */
export async function cutSelectedText(editor: Editor): Promise<boolean> {
  const { from, to, empty } = editor.state.selection;
  if (empty) return false;
  const plain = editor.state.doc.textBetween(from, to, "\n");
  lastCopiedKind = "text";
  if (plain) {
    await tauriWriteText(plain).catch(() => {});
  }
  editor.commands.focus();
  const ok = document.execCommand("cut");
  if (!ok) {
    editor.chain().focus().deleteSelection().run();
  }
  scheduleLayout();
  toast("Cut text to clipboard", "info", 1400);
  return true;
}

/** Smart Copy: copies Picture if an image is selected, otherwise copies Text. */
export async function copySelectionOrImage(editor: Editor): Promise<void> {
  if (isImageSelected(editor)) {
    await copySelectedImage(editor);
  } else {
    await copySelectedText(editor);
  }
}

/** Smart Cut: cuts Picture if an image is selected, otherwise cuts Text. */
export async function cutSelectionOrImage(editor: Editor): Promise<void> {
  if (isImageSelected(editor)) {
    await cutSelectedImage(editor);
  } else {
    await cutSelectedText(editor);
  }
}

/** Reads an OS clipboard image via Tauri native clipboard plugin or Web Clipboard API as a PNG data URL. */
async function readOsClipboardImageDataUrl(): Promise<string | null> {
  // 1. Try native Tauri OS clipboard image reader (works with Win+Shift+S screenshots & copied images without permission prompts)
  try {
    const img = await tauriReadImage();
    const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
    if (rgba && size.width > 0 && size.height > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d")!;
      const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      const imageData = new ImageData(clamped, size.width, size.height);
      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL("image/png");
    }
  } catch {
    // No native bitmap on clipboard or unsupported format
  }

  // 2. Try navigator.clipboard.read() for image/* blobs
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          const dataUrl = await new Promise<string | null>((res) => {
            const reader = new FileReader();
            reader.onload = () => res(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => res(null);
            reader.readAsDataURL(blob);
          });
          if (dataUrl) return dataUrl;
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Explicitly pastes ONLY text (never pastes an image).
 * @param plainOnly When true, strips all formatting and inserts plain text.
 */
export async function pasteTextContent(editor: Editor, plainOnly = false): Promise<void> {
  try {
    if (!plainOnly && navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            const blob = await item.getType("text/html");
            const rawHtml = await blob.text();
            // Strip any <img> tags so "Paste Text" strictly inserts text only
            const cleanHtml = rawHtml.replace(/<img\b[^>]*>/gi, "").trim();
            if (cleanHtml) {
              editor.chain().focus().insertContent(cleanHtml).run();
              scheduleLayout();
              toast("Pasted formatted text", "success", 1400);
              return;
            }
          }
        }
      } catch {
        // Fall back to plain text below
      }
    }

    let text = await tauriReadText().catch(() => "");
    if (!text && navigator.clipboard?.readText) {
      text = await navigator.clipboard.readText().catch(() => "");
    }
    if (!text) {
      toast("No text found on clipboard", "info", 1800);
      return;
    }

    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length === 1) {
      editor.chain().focus().insertContent({ type: "text", text: lines[0] }).run();
    } else {
      editor
        .chain()
        .focus()
        .insertContent(
          lines.map((l) => ({
            type: "paragraph",
            content: l ? [{ type: "text", text: l }] : [],
          })),
        )
        .run();
    }
    scheduleLayout();
    toast(plainOnly ? "Pasted plain text" : "Pasted text", "success", 1400);
  } catch {
    toast("Couldn't read text from clipboard", "error", 2000);
  }
}

/**
 * Explicitly pastes ONLY a picture from the clipboard (or internal copied picture buffer).
 * Never inserts text.
 */
export async function pasteImageContent(editor: Editor): Promise<void> {
  // 1. If user most recently copied an image inside Typo, paste it with its exact dimensions & wrap mode
  if (lastCopiedKind === "image" && copiedImageBuffer?.src) {
    await insertImageWithAttrs(editor, copiedImageBuffer);
    toast("Pasted picture", "success", 1600);
    return;
  }

  // 2. Check OS clipboard for a screenshot (Win+Shift+S) or copied image from outside Typo
  const osDataUrl = await readOsClipboardImageDataUrl();
  if (osDataUrl) {
    await insertImageWithAttrs(editor, { src: osDataUrl, wrap: "wrap-left" });
    toast("Pasted picture from clipboard", "success", 1600);
    return;
  }

  // 3. Fallback to any previously copied Typo picture in this session
  if (copiedImageBuffer?.src) {
    await insertImageWithAttrs(editor, copiedImageBuffer);
    toast("Pasted picture", "success", 1600);
    return;
  }

  toast("No picture found on clipboard — copy an image or take a screenshot (Win+Shift+S) first", "info", 2800);
}

/**
 * Smart Paste (used by the main Paste button):
 * - If the last copy action was an image inside Typo, pastes that image.
 * - If the OS clipboard has text, pastes text.
 * - Otherwise if the OS clipboard has an image (screenshot / Copy Image), pastes that image.
 */
export async function smartPaste(editor: Editor): Promise<void> {
  if (lastCopiedKind === "image" && copiedImageBuffer?.src) {
    await pasteImageContent(editor);
    return;
  }
  const text = await tauriReadText().catch(() => "");
  if (text && text.trim().length > 0) {
    await pasteTextContent(editor, false);
    return;
  }
  const osImg = await readOsClipboardImageDataUrl();
  if (osImg) {
    await insertImageWithAttrs(editor, { src: osImg, wrap: "wrap-left" });
    toast("Pasted picture from clipboard", "success", 1600);
    return;
  }
  if (copiedImageBuffer?.src) {
    await pasteImageContent(editor);
    return;
  }
  toast("Clipboard is empty", "info", 1600);
}
