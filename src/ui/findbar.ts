/** Find & Replace bar (slides under the ribbon). */
import { h, icon } from "./dom";
import { state } from "../core/state";
import { getSearch, setSearch, findNext, replaceCurrent, replaceAll } from "../editor/search";

let bar: HTMLElement;
let findInput: HTMLInputElement;
let replaceInput: HTMLInputElement;
let replaceRow: HTMLElement;
let countEl: HTMLElement;
let caseBtn: HTMLElement;
let wordBtn: HTMLElement;

export function initFindbar(): void {
  bar = document.getElementById("findbar")!;
  findInput = h("input", { class: "input findbar__input", placeholder: "Find in document", spellcheck: "false", "aria-label": "Find" }) as HTMLInputElement;
  replaceInput = h("input", { class: "input findbar__input", placeholder: "Replace with", spellcheck: "false", "aria-label": "Replace with" }) as HTMLInputElement;
  countEl = h("span", { class: "findbar__count" }, "");
  const btn = (ic: string, tip: string, fn: () => void, cls = "") => {
    const b = h("button", { class: `ibtn ${cls}`, type: "button", "data-tip": tip, "aria-label": tip }, icon(ic, 15));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", fn);
    return b;
  };
  caseBtn = btn("CaseSensitive", "Match case", () => {
    setSearch(state.editor, { caseSensitive: !getSearch(state.editor).caseSensitive });
    sync();
  });
  wordBtn = btn("WholeWord", "Whole words only", () => {
    setSearch(state.editor, { wholeWord: !getSearch(state.editor).wholeWord });
    sync();
  });
  const textBtn = (label: string, fn: () => void) => {
    const b = h("button", { class: "btn btn--sm", type: "button" }, label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", fn);
    return b;
  };
  replaceRow = h("div", { class: "findbar__row" },
    replaceInput,
    textBtn("Replace", () => { replaceCurrent(state.editor, replaceInput.value); sync(); }),
    textBtn("Replace all", () => {
      const n = replaceAll(state.editor, replaceInput.value);
      sync();
      countEl.textContent = n ? `Replaced ${n}` : "No matches";
    }),
  );
  bar.append(
    h("div", { class: "findbar__inner" },
      h("div", { class: "findbar__row" },
        icon("Search", 15),
        findInput,
        countEl,
        caseBtn,
        wordBtn,
        btn("ArrowUp", "Previous  (Shift+Enter)", () => { findNext(state.editor, -1); sync(); }),
        btn("ArrowDown", "Next  (Enter)", () => { findNext(state.editor, 1); sync(); }),
        btn("Replace", "Toggle replace  (Ctrl+H)", () => { replaceRow.hidden = !replaceRow.hidden; }),
        btn("X", "Close  (Esc)", closeFind),
      ),
      replaceRow,
    ),
  );

  findInput.addEventListener("input", () => {
    setSearch(state.editor, { term: findInput.value, index: -1 });
    sync();
  });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findNext(state.editor, e.shiftKey ? -1 : 1);
      sync();
    } else if (e.key === "Escape") closeFind();
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrent(state.editor, replaceInput.value);
      sync();
    } else if (e.key === "Escape") closeFind();
  });
}

function sync(): void {
  const s = getSearch(state.editor);
  countEl.textContent = !s.term ? "" : s.matches.length ? `${s.index >= 0 ? s.index + 1 : 0} of ${s.matches.length}` : "No results";
  caseBtn.classList.toggle("is-on", s.caseSensitive);
  wordBtn.classList.toggle("is-on", s.wholeWord);
}

export function openFind(withReplace: boolean): void {
  bar.hidden = false;
  replaceRow.hidden = !withReplace;
  const { from, to, empty } = state.editor.state.selection;
  if (!empty && to - from < 200) {
    findInput.value = state.editor.state.doc.textBetween(from, to, " ");
    setSearch(state.editor, { term: findInput.value, index: -1 });
  }
  sync();
  requestAnimationFrame(() => {
    (withReplace && findInput.value ? replaceInput : findInput).focus();
    findInput.select();
  });
}

export function closeFind(): void {
  bar.hidden = true;
  setSearch(state.editor, { term: "" });
  state.editor.commands.focus();
}

export function refreshFindCount(): void {
  if (!bar.hidden) sync();
}
