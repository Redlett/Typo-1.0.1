import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, FontFamily, FontSize, Color } from "@tiptap/extension-text-style";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { CharacterCount } from "@tiptap/extensions";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { Extension } from "@tiptap/core";
import { ParagraphFormat, PageBreak, WordKeymap } from "./extensions";
import { Search } from "./search";
import { TypoImage } from "./image-node";
import { Proofing } from "./proofing";

/** Cell background colour for tables (round-trips to DOCX w:shd). */
const TableCellBackground = Extension.create({
  name: "tableCellBackground",
  addGlobalAttributes() {
    return [
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          backgroundColor: {
            default: null,
            parseHTML: (el) => el.style.backgroundColor || el.getAttribute("data-bg") || null,
            renderHTML: (a) => (a.backgroundColor ? { style: `background-color: ${a.backgroundColor}`, "data-bg": a.backgroundColor } : {}),
          },
        },
      },
    ];
  },
});

export function createEditor(element: HTMLElement, onUpdate: () => void, onSelection: () => void): Editor {
  return new Editor({
    element,
    autofocus: "start",
    injectCSS: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" },
        dropcursor: { width: 2, class: "drop-cursor" },
        undoRedo: { depth: 500, newGroupDelay: 400 },
      }),
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Highlight.configure({ multicolor: true }),
      Subscript,
      Superscript,
      TextAlign.configure({ types: ["heading", "paragraph"], alignments: ["left", "center", "right", "justify"] }),
      TableKit.configure({ table: { resizable: true, cellMinWidth: 40, lastColumnResizable: true } }),
      TableCellBackground,
      TaskList,
      TaskItem.configure({ nested: true }),
      TypoImage.configure({
        inline: true,
        allowBase64: true,
      }),
      CharacterCount,
      ParagraphFormat,
      PageBreak,
      WordKeymap,
      Search,
      Proofing,
    ],
    content: "<p></p>",
    onUpdate,
    onSelectionUpdate: onSelection,
    onTransaction: ({ transaction }) => {
      if (!transaction.docChanged) onSelection();
    },
  });
}
