/** Find & Replace: highlights every match with decorations and tracks a current match. */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface SearchState {
  term: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: { from: number; to: number }[];
  index: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>("typoSearch");

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(doc: PMNode, term: string, caseSensitive: boolean, wholeWord: boolean) {
  const out: { from: number; to: number }[] = [];
  if (!term) return out;
  const flags = caseSensitive ? "g" : "gi";
  const src = wholeWord ? `(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])` : escapeRegex(term);
  const re = new RegExp(src, flags + "u");
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // One string per textblock; leaf inline nodes become a single placeholder char
    // so string offsets map 1:1 onto document positions.
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text : "\ufffc".repeat(child.nodeSize);
    });
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length });
      if (out.length > 20000) return false;
    }
    return false;
  });
  return out;
}

function build(doc: PMNode, term: string, caseSensitive: boolean, wholeWord: boolean, index: number): SearchState {
  const matches = findMatches(doc, term, caseSensitive, wholeWord);
  const idx = matches.length ? Math.min(Math.max(index, 0), matches.length - 1) : -1;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, { class: i === idx ? "search-hit search-hit--current" : "search-hit" }),
  );
  return { term, caseSensitive, wholeWord, matches, index: idx, decorations: DecorationSet.create(doc, decos) };
}

const empty = (): SearchState => ({
  term: "",
  caseSensitive: false,
  wholeWord: false,
  matches: [],
  index: -1,
  decorations: DecorationSet.empty,
});

export const Search = Extension.create({
  name: "typoSearch",
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: empty,
          apply(tr: Transaction, prev: SearchState, _old: EditorState, state: EditorState): SearchState {
            const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
            if (meta) {
              const term = meta.term ?? prev.term;
              const cs = meta.caseSensitive ?? prev.caseSensitive;
              const ww = meta.wholeWord ?? prev.wholeWord;
              return build(state.doc, term, cs, ww, meta.index ?? prev.index);
            }
            if (tr.docChanged && prev.term) return build(state.doc, prev.term, prev.caseSensitive, prev.wholeWord, prev.index);
            return prev;
          },
        },
        props: {
          decorations(state) {
            return searchKey.getState(state)?.decorations;
          },
        },
      }),
    ];
  },
});

export function getSearch(editor: Editor): SearchState {
  return searchKey.getState(editor.state) ?? empty();
}

export function setSearch(editor: Editor, patch: Partial<Pick<SearchState, "term" | "caseSensitive" | "wholeWord" | "index">>) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, patch));
}

function focusMatch(editor: Editor, i: number) {
  const s = getSearch(editor);
  const m = s.matches[i];
  if (!m) return;
  const tr = editor.state.tr.setMeta(searchKey, { index: i }).setSelection(TextSelection.create(editor.state.doc, m.from, m.to));
  editor.view.dispatch(tr.scrollIntoView());
}

export function findNext(editor: Editor, dir: 1 | -1 = 1) {
  const s = getSearch(editor);
  if (!s.matches.length) return;
  const n = s.matches.length;
  // Start from the cursor if the current index is stale.
  let i = s.index;
  if (i < 0) {
    const head = editor.state.selection.from;
    i = s.matches.findIndex((m) => m.from >= head);
    if (i < 0) i = 0;
    focusMatch(editor, i);
    return;
  }
  focusMatch(editor, (i + dir + n) % n);
}

export function replaceCurrent(editor: Editor, replacement: string) {
  const s = getSearch(editor);
  const m = s.matches[s.index];
  if (!m) return findNext(editor, 1);
  const tr = editor.state.tr.insertText(replacement, m.from, m.to);
  editor.view.dispatch(tr);
  // After the doc change the plugin rebuilds matches; move to the next one at the same index.
  const after = getSearch(editor);
  if (after.matches.length) focusMatch(editor, Math.min(s.index, after.matches.length - 1));
}

export function replaceAll(editor: Editor, replacement: string): number {
  const s = getSearch(editor);
  if (!s.matches.length) return 0;
  let tr = editor.state.tr;
  for (let i = s.matches.length - 1; i >= 0; i--) {
    const m = s.matches[i];
    tr = tr.insertText(replacement, m.from, m.to);
  }
  editor.view.dispatch(tr);
  return s.matches.length;
}
