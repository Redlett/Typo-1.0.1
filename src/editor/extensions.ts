/**
 * Custom TipTap extensions: paragraph formatting (line spacing, indent, Word
 * styles, independent line/selection alignment), page breaks, and Word-style keyboard shortcuts.
 */
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setBlockLineHeight: (value: string | null) => ReturnType;
      changeIndent: (delta: number) => ReturnType;
      setSpaceBefore: (value: string | null) => ReturnType;
      setSpaceAfter: (value: string | null) => ReturnType;
      setDropCap: (value: "dropped" | "margin" | null) => ReturnType;
      setStyleName: (value: "Title" | "Subtitle" | null) => ReturnType;
      smartAlign: (alignment: "left" | "center" | "right" | "justify") => ReturnType;
    };
    pageBreak: {
      setPageBreak: () => ReturnType;
    };
  }
}

const BLOCK_TYPES = ["paragraph", "heading"];

/**
 * Computes effective [from, to] range that excludes accidentally touched boundary edges
 * (e.g. 0 characters selected at the very end of the paragraph above or start of the paragraph below).
 */
function trimBoundaryRange(state: any): { effFrom: number; effTo: number } {
  const { from, to, empty, $from, $to } = state.selection;
  if (empty || $from.sameParent($to)) {
    return { effFrom: from, effTo: to };
  }
  let effFrom = from;
  let effTo = to;
  if ($from.parent.isTextblock && $from.parentOffset === $from.parent.content.size) {
    effFrom = Math.min(to, $from.after());
  }
  if ($to.parent.isTextblock && $to.parentOffset === 0) {
    effTo = Math.max(effFrom, $to.before());
  }
  return { effFrom, effTo };
}

export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => el.style.lineHeight || null,
            renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
          },
          indent: {
            default: null,
            parseHTML: (el) => {
              const v = parseInt(el.getAttribute("data-indent") ?? "", 10);
              return Number.isFinite(v) && v > 0 ? Math.min(v, 8) : null;
            },
            renderHTML: (attrs) =>
              attrs.indent ? { "data-indent": attrs.indent, style: `margin-left: ${attrs.indent * 0.5}in` } : {},
          },
          spaceBefore: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-space-before") || el.style.marginTop || null,
            renderHTML: (attrs) =>
              attrs.spaceBefore ? { "data-space-before": attrs.spaceBefore, style: `margin-top: ${attrs.spaceBefore}` } : {},
          },
          spaceAfter: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-space-after") || el.style.marginBottom || null,
            renderHTML: (attrs) =>
              attrs.spaceAfter ? { "data-space-after": attrs.spaceAfter, style: `margin-bottom: ${attrs.spaceAfter}` } : {},
          },
        },
      },
      {
        types: ["paragraph"],
        attributes: {
          styleName: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-style"),
            renderHTML: (attrs) => (attrs.styleName ? { "data-style": attrs.styleName } : {}),
          },
          dropCap: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-dropcap") || null,
            renderHTML: (attrs) => (attrs.dropCap ? { "data-dropcap": attrs.dropCap } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    const updateBlocks =
      (fn: (attrs: Record<string, any>, typeName: string) => Record<string, any> | null) =>
      ({ tr, state, dispatch }: any) => {
        const { effFrom, effTo } = trimBoundaryRange(state);
        let changed = false;
        state.doc.nodesBetween(effFrom, effTo, (node: any, pos: number) => {
          if (!BLOCK_TYPES.includes(node.type.name)) return true;
          const next = fn(node.attrs, node.type.name);
          if (next) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next });
            changed = true;
          }
          return false;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };

    return {
      setBlockLineHeight: (value) => updateBlocks(() => ({ lineHeight: value })),
      changeIndent: (delta) =>
        updateBlocks((attrs) => {
          const next = Math.max(0, Math.min(8, (attrs.indent ?? 0) + delta));
          return { indent: next || null };
        }),
      setSpaceBefore: (value) => updateBlocks(() => ({ spaceBefore: value })),
      setSpaceAfter: (value) => updateBlocks(() => ({ spaceAfter: value })),
      setDropCap: (value) =>
        updateBlocks((_a, type) => (type === "paragraph" ? { dropCap: value } : null)),
      setStyleName: (value) =>
        ({ chain }) =>
          chain()
            .setParagraph()
            .command(updateBlocks((_a, type) => (type === "paragraph" ? { styleName: value } : null)))
            .run(),

      smartAlign:
        (alignment) =>
        ({ tr, state, dispatch }: any) => {
          const { from, to, empty, $from, $to } = state.selection;

          // Case 1: Single textblock containing soft line breaks (<br> / hardBreak) OR a partial selection
          if ($from.sameParent($to) && BLOCK_TYPES.includes($from.parent.type.name)) {
            const parent = $from.parent;
            const blockStart = $from.start();

            // Collect any hardBreak (<br>) offsets inside this paragraph
            const hbOffsets: number[] = [];
            parent.forEach((child: any, offset: number) => {
              if (child.type.name === "hardBreak") {
                hbOffsets.push(offset);
              }
            });

            // 1A: If the paragraph has <br> hardBreaks, isolate the current visual line between hardBreaks
            if (hbOffsets.length > 0) {
              const relFrom = $from.parentOffset;
              const relTo = $to.parentOffset;
              let prevHb = -1;
              let nextHb = -1;
              for (const off of hbOffsets) {
                if (off < relFrom) prevHb = off;
                else if (off >= relTo && nextHb === -1) nextHb = off;
              }

              // Split after first (so earlier positions don't shift), then split before
              if (nextHb !== -1) {
                const posAfter = blockStart + nextHb;
                tr.delete(posAfter, posAfter + 1);
                tr.split(posAfter);
              }
              let targetBlockPos = $from.before();
              if (prevHb !== -1) {
                const posBefore = blockStart + prevHb;
                tr.delete(posBefore, posBefore + 1);
                tr.split(posBefore);
                targetBlockPos = posBefore + 1;
              }

              const targetNode = tr.doc.nodeAt(targetBlockPos);
              if (targetNode && BLOCK_TYPES.includes(targetNode.type.name)) {
                tr.setNodeMarkup(targetBlockPos, undefined, { ...targetNode.attrs, textAlign: alignment });
              }
              if (dispatch) dispatch(tr.scrollIntoView());
              return true;
            }

            // 1B: User highlighted a specific substring inside a paragraph that has unselected text before/after it
            const hasTextBefore = $from.parentOffset > 0 && parent.textBetween(0, $from.parentOffset).trim().length > 0;
            const hasTextAfter =
              $to.parentOffset < parent.content.size &&
              parent.textBetween($to.parentOffset, parent.content.size).trim().length > 0;

            if (!empty && (hasTextBefore || hasTextAfter)) {
              const selLen = to - from;
              if (hasTextAfter) {
                tr.split(to);
              }
              let targetBlockPos = $from.before();
              if (hasTextBefore) {
                tr.split(from);
                targetBlockPos = from + 1;
              }
              const targetNode = tr.doc.nodeAt(targetBlockPos);
              if (targetNode && BLOCK_TYPES.includes(targetNode.type.name)) {
                tr.setNodeMarkup(targetBlockPos, undefined, { ...targetNode.attrs, textAlign: alignment });
                const newStart = targetBlockPos + 1;
                const newEnd = Math.min(tr.doc.content.size, newStart + selLen);
                tr.setSelection(TextSelection.create(tr.doc, newStart, newEnd));
              }
              if (dispatch) dispatch(tr.scrollIntoView());
              return true;
            }
          }

          // Case 2: Standard single-block or multi-block alignment (with boundary trimming so top line is never dragged along)
          const { effFrom, effTo } = trimBoundaryRange(state);
          let changed = false;
          state.doc.nodesBetween(effFrom, effTo, (node: any, pos: number) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return true;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: alignment });
            changed = true;
            return false;
          });
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
    };
  },
});

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [
      { tag: "div[data-page-break]" },
      // Word / LibreOffice HTML uses CSS page breaks.
      { tag: "br[style*='page-break-before']" },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "page-break", contenteditable: "false" })];
  },

  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent([{ type: "pageBreak" }, { type: "paragraph" }]).run(),
    };
  },

  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});

/** Shortcuts that match Microsoft Word muscle memory. */
export const WordKeymap = Extension.create({
  name: "wordKeymap",
  addKeyboardShortcuts() {
    const e = () => this.editor;
    return {
      "Mod-e": () => e().commands.smartAlign("center"),
      "Mod-l": () => e().commands.smartAlign("left"),
      "Mod-r": () => e().commands.smartAlign("right"),
      "Mod-j": () => e().commands.smartAlign("justify"),
      "Mod-1": () => e().commands.setBlockLineHeight("1"),
      "Mod-2": () => e().commands.setBlockLineHeight("2"),
      "Mod-5": () => e().commands.setBlockLineHeight("1.5"),
      "Mod-Alt-1": () => e().commands.toggleHeading({ level: 1 }),
      "Mod-Alt-2": () => e().commands.toggleHeading({ level: 2 }),
      "Mod-Alt-3": () => e().commands.toggleHeading({ level: 3 }),
      "Mod-Shift-n": () => e().chain().setParagraph().setStyleName(null).run(),
      "Mod-=": () => e().commands.toggleSubscript(),
      "Mod-Shift-=": () => e().commands.toggleSuperscript(),
      "Mod-Space": () => e().chain().unsetAllMarks().run(),
      "Mod-m": () => (e().isActive("listItem") ? e().commands.sinkListItem("listItem") : e().commands.changeIndent(1)),
      "Mod-Shift-m": () => (e().isActive("listItem") ? e().commands.liftListItem("listItem") : e().commands.changeIndent(-1)),
    };
  },
});
