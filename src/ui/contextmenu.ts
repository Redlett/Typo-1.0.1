/**
 * Custom context menu for Typo editor:
 * - Right-click on an Image -> Copy Picture, Cut Picture, Duplicate Picture, Delete Picture, InDesign Text Wrap modes, Resize presets, Replace Picture
 * - Right-click on a Flagged Spelling/Grammar word -> 1-click Fixes, Ignore, Add to Dictionary, Define
 * - Right-click on Text / Page -> Cut Text, Copy Text, Paste Text, Paste Plain Text Only, Paste Picture, Define / Synonyms, Insert Page, Insert Picture
 */
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, closePopover, toast } from "./dom";
import { menu, type MenuItem } from "./pickers";
import {
  getIssueAtPos,
  applyIssueFix,
  ignoreIssueWord,
  addWordToUserDictionary,
  closeQuickFix,
} from "../editor/proofing";
import { openDictionary, getWordAtSelection } from "./dictionary";
import { openStickerStudioModal } from "./stickers";
import type { ImageWrapMode } from "../editor/image-node";
import { native } from "../core/native";
import { scheduleLayout } from "../core/page";
import {
  copySelectedImage,
  cutSelectedImage,
  duplicateSelectedImage,
  copySelectedText,
  cutSelectedText,
  pasteTextContent,
  pasteImageContent,
  insertImageWithAttrs,
} from "../core/clipboard";

let activeMenuEl: HTMLElement | null = null;

export function closeContextMenu(): void {
  activeMenuEl?.remove();
  activeMenuEl = null;
}

export async function insertImageDataUrl(editor: Editor, src: string): Promise<void> {
  await insertImageWithAttrs(editor, { src, wrap: "wrap-left" });
}

export async function insertPictureFromDialog(editor: Editor): Promise<void> {
  const file = await openDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
  });
  if (typeof file !== "string") return;
  try {
    const src = await native.readImage(file);
    await insertImageDataUrl(editor, src);
  } catch (e) {
    toast(String(e), "error");
  }
}

export function initContextMenu(editor: Editor): void {
  const workspace = document.getElementById("workspace")!;

  workspace.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePopover();
    closeQuickFix();
    closeContextMenu();

    const target = e.target as HTMLElement;
    const imgContainer = target.closest(".typo-image") as HTMLElement | null;

    const items: (MenuItem | "sep" | { heading: string })[] = [];

    // =========================================================================
    // 1. Right-clicked on an Image
    // =========================================================================
    if (imgContainer) {
      const pos = editor.view.posAtDOM(imgContainer, 0);
      if (typeof pos === "number" && pos >= 0) {
        try {
          const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos));
          editor.view.dispatch(tr);
        } catch {
          // ignore
        }
      }
      const attrs = editor.getAttributes("image");
      const currentWrap: ImageWrapMode = attrs.wrap || "wrap-left";

      const setWrap = (wrap: ImageWrapMode) => {
        editor.chain().focus().setImageWrap(wrap).run();
        scheduleLayout();
      };

      const resizePct = (ratio: number) => {
        const edEl = document.getElementById("editor");
        const colW = edEl ? edEl.clientWidth : 600;
        const imgEl = imgContainer.querySelector("img");
        const natW = imgEl?.naturalWidth || attrs.width || 320;
        const natH = imgEl?.naturalHeight || attrs.height || 240;
        const aspect = natH / Math.max(1, natW);
        const w = Math.max(48, Math.round(colW * ratio));
        const h = Math.max(32, Math.round(w * aspect));
        editor.chain().focus().updateAttributes("image", { width: w, height: h }).run();
        scheduleLayout();
      };

      items.push(
        { heading: "Picture Clipboard" },
        {
          label: "Copy Picture",
          icon: "Copy",
          hint: "Ctrl+C",
          onSelect: () => void copySelectedImage(editor),
        },
        {
          label: "Cut Picture",
          icon: "Scissors",
          hint: "Ctrl+X",
          onSelect: () => void cutSelectedImage(editor),
        },
        {
          label: "Duplicate Picture",
          icon: "CopyPlus",
          hint: "Ctrl+D",
          onSelect: () => void duplicateSelectedImage(editor),
        },
        {
          label: "Delete Picture",
          icon: "Trash2",
          hint: "Del",
          onSelect: () => {
            editor.chain().focus().deleteSelection().run();
            toast("Picture deleted", "info", 1800);
            scheduleLayout();
          },
        },
        "sep",
        { heading: "Picture Placement & Wrap" },
        {
          label: "Free-Roam: Drag Anywhere (In Front of Text)",
          icon: "Move",
          checked: currentWrap === "free-front",
          onSelect: () => setWrap("free-front"),
        },
        {
          label: "Free-Roam: Drag Anywhere (Behind Text)",
          icon: "Layers",
          checked: currentWrap === "free-behind",
          onSelect: () => setWrap("free-behind"),
        },
        "sep",
        {
          label: "Wrap Left (Text flows right)",
          icon: "AlignLeft",
          checked: currentWrap === "wrap-left",
          onSelect: () => setWrap("wrap-left"),
        },
        {
          label: "Wrap Right (Text flows left)",
          icon: "AlignRight",
          checked: currentWrap === "wrap-right",
          onSelect: () => setWrap("wrap-right"),
        },
        {
          label: "Center (Top & bottom break)",
          icon: "AlignCenter",
          checked: currentWrap === "center",
          onSelect: () => setWrap("center"),
        },
        {
          label: "Inline with Text",
          icon: "Baseline",
          checked: currentWrap === "inline",
          onSelect: () => setWrap("inline"),
        },
        "sep",
        { heading: "Picture Size" },
        { label: "Small (33% width)", icon: "Minimize2", onSelect: () => resizePct(0.33) },
        { label: "Medium (50% width)", icon: "Square", onSelect: () => resizePct(0.5) },
        { label: "Large (75% width)", icon: "Maximize2", onSelect: () => resizePct(0.75) },
        { label: "Full Column Width (100%)", icon: "RectangleHorizontal", onSelect: () => resizePct(1.0) },
        "sep",
        {
          label: "Replace Picture…",
          icon: "Image",
          onSelect: async () => {
            const file = await openDialog({
              multiple: false,
              filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
            });
            if (typeof file === "string") {
              const src = await native.readImage(file);
              editor.chain().focus().updateAttributes("image", { src }).run();
            }
          },
        },
      );
    } else {
      // =========================================================================
      // 2. Right-clicked on Text / Document Canvas
      // =========================================================================
      const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });

      // If no text is currently highlighted, place the caret at the right-clicked location
      // so Paste Text / Paste Picture inserts right where the user clicked.
      if (coords && editor.state.selection.empty) {
        try {
          const safePos = Math.max(0, Math.min(coords.pos, editor.state.doc.content.size));
          const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(safePos)));
          editor.view.dispatch(tr);
        } catch {
          // ignore
        }
      }

      const issue = coords ? getIssueAtPos(editor.state, coords.pos) : null;

      if (issue) {
        items.push({
          heading: `${issue.kind === "spelling" ? "Spelling" : "Grammar"}: ${issue.message}`,
        });
        for (const sug of issue.suggestions) {
          items.push({
            label: sug === " " ? "Replace with single space" : `Change to "${sug}"`,
            icon: "Check",
            onSelect: () => applyIssueFix(editor, issue, sug),
          });
        }
        items.push({
          label: "Ignore",
          icon: "EyeOff",
          onSelect: () => ignoreIssueWord(issue.text, editor),
        });
        if (issue.kind === "spelling") {
          items.push({
            label: `Add "${issue.text}" to Dictionary`,
            icon: "BookPlus",
            onSelect: () => addWordToUserDictionary(issue.text, editor),
          });
        }
        items.push("sep");
      }

      const wordAt = getWordAtSelection(editor);
      if (wordAt) {
        items.push(
          {
            label: `Define / Synonyms for "${wordAt.word.slice(0, 20)}"…`,
            icon: "BookOpen",
            hint: "Ctrl+Shift+D",
            onSelect: () => openDictionary(editor, wordAt.word),
          },
          {
            label: `Look up "${wordAt.word.slice(0, 18)}" in Chrome`,
            icon: "Globe",
            onSelect: () => void native.openUrl(`https://www.google.com/search?q=define+${encodeURIComponent(wordAt.word)}`),
          },
          "sep",
        );
      }

      const hasTextSel = !editor.state.selection.empty;
      items.push(
        { heading: "Clipboard (Text vs. Picture)" },
        {
          label: "Cut Text",
          icon: "Scissors",
          hint: "Ctrl+X",
          disabled: !hasTextSel,
          onSelect: () => void cutSelectedText(editor),
        },
        {
          label: "Copy Text",
          icon: "Copy",
          hint: "Ctrl+C",
          disabled: !hasTextSel,
          onSelect: () => void copySelectedText(editor),
        },
        {
          label: "Paste Text",
          icon: "ClipboardPaste",
          hint: "Ctrl+V",
          onSelect: () => void pasteTextContent(editor, false),
        },
        {
          label: "Paste Plain Text Only",
          icon: "Type",
          hint: "Ctrl+Shift+V",
          onSelect: () => void pasteTextContent(editor, true),
        },
        {
          label: "Paste Picture",
          icon: "ImagePlus",
          hint: "Ctrl+Alt+V",
          onSelect: () => void pasteImageContent(editor),
        },
        "sep",
        {
          label: "Add New Page",
          icon: "FilePlus2",
          hint: "Ctrl+Enter",
          onSelect: () => {
            editor.chain().focus().setPageBreak().run();
            scheduleLayout();
          },
        },
        {
          label: "Insert Picture from PC…",
          icon: "Image",
          onSelect: () => void insertPictureFromDialog(editor),
        },
        {
          label: "Insert Sticker…",
          icon: "Sticker",
          onSelect: () => openStickerStudioModal(editor),
        },
      );
    }

    const menuContent = menu(items);
    const root = document.getElementById("overlay-root")!;
    const wrapper = h("div", { class: "popover popover--in", role: "dialog" }, menuContent);
    root.append(wrapper);

    const r = wrapper.getBoundingClientRect();
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(e.clientY, window.innerHeight - r.height - 8));
    wrapper.style.left = `${left}px`;
    wrapper.style.top = `${top}px`;
    activeMenuEl = wrapper;

    const onDown = (ev: MouseEvent) => {
      if (!wrapper.contains(ev.target as Node)) {
        closeContextMenu();
        document.removeEventListener("mousedown", onDown, true);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        closeContextMenu();
        document.removeEventListener("keydown", onKey, true);
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 10);
  });
}
