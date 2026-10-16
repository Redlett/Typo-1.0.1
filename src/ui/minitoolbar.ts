/**
 * Floating Mini-Toolbar on text selection (Word / Linear / Notion style).
 * Appears right above highlighted text when mouseup or Shift+arrow selection completes.
 */
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { h, icon } from "./dom";
import { stepSize } from "./pickers";
import { insertLink } from "./tabs";

let barEl: HTMLElement | null = null;
let isMouseDown = false;

export function initMiniToolbar(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  barEl = h("div", { class: "mini-toolbar", role: "toolbar", "aria-label": "Quick formatting" });
  barEl.hidden = true;
  root.append(barEl);

  const mkBtn = (
    ic: string,
    tip: string,
    onClick: () => void,
    isActive?: () => boolean,
  ): { el: HTMLButtonElement; sync: () => void } => {
    const b = h(
      "button",
      { class: "mini-toolbar__btn", type: "button", "data-tip": tip, "aria-label": tip },
      icon(ic, 14),
    ) as HTMLButtonElement;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      syncAll();
    });
    return {
      el: b,
      sync: () => {
        if (isActive) b.classList.toggle("is-on", Boolean(isActive()));
      },
    };
  };

  const controls = [
    mkBtn("Bold", "Bold (Ctrl+B)", () => editor.chain().focus().toggleBold().run(), () => editor.isActive("bold")),
    mkBtn("Italic", "Italic (Ctrl+I)", () => editor.chain().focus().toggleItalic().run(), () => editor.isActive("italic")),
    mkBtn("Underline", "Underline (Ctrl+U)", () => editor.chain().focus().toggleUnderline().run(), () => editor.isActive("underline")),
    mkBtn("Strikethrough", "Strikethrough", () => editor.chain().focus().toggleStrike().run(), () => editor.isActive("strike")),
    "sep" as const,
    mkBtn("AArrowUp", "Grow Font", () => stepSize(editor, 1)),
    mkBtn("AArrowDown", "Shrink Font", () => stepSize(editor, -1)),
    "sep" as const,
    mkBtn(
      "Highlighter",
      "Highlight Selection",
      () => {
        if (editor.isActive("highlight")) editor.chain().focus().unsetHighlight().run();
        else editor.chain().focus().setHighlight({ color: "#fde047" }).run();
      },
      () => editor.isActive("highlight"),
    ),
    mkBtn(
      "Heading1",
      "Heading 1",
      () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      () => editor.isActive("heading", { level: 1 }),
    ),
    mkBtn(
      "Heading2",
      "Heading 2",
      () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      () => editor.isActive("heading", { level: 2 }),
    ),
    mkBtn(
      "Code",
      "Inline Code",
      () => editor.chain().focus().toggleCode().run(),
      () => editor.isActive("code"),
    ),
    mkBtn(
      "Link",
      "Insert Link (Ctrl+K)",
      () => {
        hideMiniToolbar();
        void insertLink(editor);
      },
      () => editor.isActive("link"),
    ),
  ];

  const syncFns: (() => void)[] = [];
  for (const c of controls) {
    if (c === "sep") {
      barEl.append(h("div", { class: "mini-toolbar__sep" }));
    } else {
      barEl.append(c.el);
      syncFns.push(c.sync);
    }
  }

  function syncAll() {
    for (const fn of syncFns) fn();
  }

  function updatePosition() {
    if (!barEl || isMouseDown) return;
    const { selection } = editor.state;
    if (
      selection.empty ||
      selection instanceof NodeSelection ||
      !editor.view.hasFocus()
    ) {
      hideMiniToolbar();
      return;
    }
    const text = editor.state.doc.textBetween(selection.from, selection.to, "").trim();
    if (!text) {
      hideMiniToolbar();
      return;
    }
    const domSel = window.getSelection();
    if (!domSel || domSel.rangeCount === 0) {
      hideMiniToolbar();
      return;
    }
    const range = domSel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideMiniToolbar();
      return;
    }

    syncAll();
    barEl.hidden = false;
    const bw = barEl.offsetWidth || 310;
    const bh = barEl.offsetHeight || 36;
    let left = Math.round(rect.left + rect.width / 2 - bw / 2);
    left = Math.max(10, Math.min(left, window.innerWidth - bw - 10));
    let top = Math.round(rect.top - bh - 10);
    if (top < 78) {
      top = Math.round(rect.bottom + 10);
    }
    barEl.style.left = `${left}px`;
    barEl.style.top = `${top}px`;
  }

  document.addEventListener("mousedown", (e) => {
    if (barEl && barEl.contains(e.target as Node)) return;
    isMouseDown = true;
    hideMiniToolbar();
  });

  document.addEventListener("mouseup", () => {
    isMouseDown = false;
    setTimeout(updatePosition, 20);
  });

  editor.view.dom.addEventListener("keyup", (e) => {
    if (e.key.startsWith("Arrow") || e.key === "Shift") {
      updatePosition();
    } else if (e.key === "Escape") {
      hideMiniToolbar();
    }
  });

  document.getElementById("canvas")?.addEventListener("scroll", () => hideMiniToolbar(), { passive: true });
}

export function hideMiniToolbar(): void {
  if (barEl) barEl.hidden = true;
}
