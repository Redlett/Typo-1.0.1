/** Ribbon pickers: font family, font size, colour palettes, table grid, menus. */
import type { Editor } from "@tiptap/core";
import { h, icon, popover, closePopover } from "./dom";
import { state } from "../core/state";

// ---------------------------------------------------------------------------
// Generic menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  render?: () => HTMLElement;
}

export function menu(items: (MenuItem | "sep" | { heading: string })[]): HTMLElement {
  const el = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    if (it === "sep") {
      el.append(h("div", { class: "menu__sep" }));
      continue;
    }
    if ("heading" in it) {
      el.append(h("div", { class: "menu__heading" }, it.heading));
      continue;
    }
    const btn = h(
      "button",
      {
        class: "menu__item" + (it.checked ? " is-checked" : "") + (it.disabled ? " is-disabled" : ""),
        type: "button",
        role: "menuitem",
        disabled: it.disabled ?? false,
      },
      h("span", { class: "menu__icon" }, it.checked ? icon("Check", 14) : it.icon ? icon(it.icon, 15) : null),
      it.render ? it.render() : h("span", { class: "menu__label" }, it.label),
      it.hint ? h("span", { class: "menu__hint" }, it.hint) : null,
    );
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (it.disabled) return;
      closePopover();
      it.onSelect();
    });
    el.append(btn);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Font family
// ---------------------------------------------------------------------------

function firstFamily(css: string | null | undefined): string | null {
  if (!css) return null;
  return css.split(",")[0].trim().replace(/^["']|["']$/g, "") || null;
}

export function currentFont(editor: Editor): string {
  return firstFamily(editor.getAttributes("textStyle").fontFamily) ?? state.defaults.fontFamily;
}

function quoteFamily(f: string): string {
  return /^[\w-]+$/.test(f) ? f : `"${f.replace(/"/g, "")}"`;
}

export function fontPicker(editor: Editor): { el: HTMLElement; update: () => void } {
  const input = h("input", { class: "combo__input", spellcheck: "false", "aria-label": "Font", "data-tip": "Font  (Ctrl+Shift+F)" }) as HTMLInputElement;
  const caret = h("button", { class: "combo__caret", type: "button", tabindex: "-1", "aria-label": "Show fonts" }, icon("ChevronDown", 12));
  const el = h("div", { class: "combo combo--font" }, input, caret);

  const apply = (family: string) => {
    editor.chain().focus().setFontFamily(quoteFamily(family)).run();
  };

  const open = (filter = "") => {
    const list = h("div", { class: "fontlist", role: "listbox" });
    const search = h("input", { class: "input fontlist__search", placeholder: `Search ${state.fonts.length} fonts`, spellcheck: "false", value: filter }) as HTMLInputElement;
    const current = currentFont(editor);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const t = e.target as HTMLElement;
          t.style.fontFamily = quoteFamily(t.dataset.font!);
          io.unobserve(t);
        }
      }
    }, { root: list });

    const render = () => {
      list.replaceChildren();
      const q = search.value.trim().toLowerCase();
      const fonts = q ? state.fonts.filter((f) => f.toLowerCase().includes(q)) : state.fonts;
      const frag = document.createDocumentFragment();
      for (const f of fonts.slice(0, 1500)) {
        const item = h("button", { class: "fontlist__item" + (f === current ? " is-checked" : ""), type: "button", "data-font": f, role: "option" }, f);
        item.addEventListener("mousedown", (e) => e.preventDefault());
        item.addEventListener("click", () => {
          closePopover();
          apply(f);
        });
        frag.append(item);
        io.observe(item);
      }
      if (!fonts.length) frag.append(h("div", { class: "fontlist__empty" }, "No matching fonts"));
      list.append(frag);
    };
    search.addEventListener("input", render);
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = list.querySelector<HTMLElement>(".fontlist__item");
        if (first) first.click();
      }
    });
    render();
    popover(el, h("div", { class: "fontpanel" }, search, list), { onClose: () => io.disconnect() });
    requestAnimationFrame(() => {
      search.focus();
      list.querySelector(".is-checked")?.scrollIntoView({ block: "center" });
    });
  };

  caret.addEventListener("mousedown", (e) => e.preventDefault());
  caret.addEventListener("click", () => open());
  input.addEventListener("click", () => {
    input.select();
    open();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value.trim();
      const match = state.fonts.find((f) => f.toLowerCase() === v.toLowerCase()) ?? state.fonts.find((f) => f.toLowerCase().startsWith(v.toLowerCase()));
      if (match) {
        closePopover();
        apply(match);
      } else {
        editor.commands.focus();
      }
    } else if (e.key === "Escape") {
      closePopover();
      editor.commands.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      open(input.value);
    }
  });

  const update = () => {
    if (document.activeElement === input) return;
    const f = currentFont(editor);
    input.value = f;
    input.style.fontFamily = quoteFamily(f);
  };
  return { el, update };
}

// ---------------------------------------------------------------------------
// Font size
// ---------------------------------------------------------------------------

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 60, 72];
const HEADING_PT: Record<number, number> = { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 };

export function currentSize(editor: Editor): number {
  const raw = editor.getAttributes("textStyle").fontSize as string | undefined;
  if (raw) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return raw.endsWith("px") ? Math.round(n * 0.75 * 2) / 2 : n;
  }
  if (editor.isActive("heading")) return HEADING_PT[editor.getAttributes("heading").level as number] ?? state.defaults.fontSize;
  const style = editor.getAttributes("paragraph").styleName;
  if (style === "Title") return 28;
  if (style === "Subtitle") return 15;
  return state.defaults.fontSize;
}

export function stepSize(editor: Editor, dir: 1 | -1): void {
  const cur = currentSize(editor);
  const next = dir > 0 ? FONT_SIZES.find((s) => s > cur) ?? Math.min(cur + 12, 400) : [...FONT_SIZES].reverse().find((s) => s < cur) ?? Math.max(cur - 1, 1);
  editor.chain().focus().setFontSize(`${next}pt`).run();
}

export function sizePicker(editor: Editor): { el: HTMLElement; update: () => void } {
  const input = h("input", { class: "combo__input", inputmode: "decimal", "aria-label": "Font size", "data-tip": "Font size  (Ctrl+Shift+P)" }) as HTMLInputElement;
  const caret = h("button", { class: "combo__caret", type: "button", tabindex: "-1", "aria-label": "Show sizes" }, icon("ChevronDown", 12));
  const el = h("div", { class: "combo combo--size" }, input, caret);
  const apply = (n: number) => {
    if (!Number.isFinite(n) || n < 1 || n > 1638) return;
    editor.chain().focus().setFontSize(`${n}pt`).run();
  };
  const openSizes = () => {
    const cur = currentSize(editor);
    popover(el, menu(FONT_SIZES.map((s) => ({ label: String(s), checked: s === cur, onSelect: () => apply(s) }))));
  };
  caret.addEventListener("mousedown", (e) => e.preventDefault());
  caret.addEventListener("click", openSizes);
  input.addEventListener("click", () => {
    input.select();
    openSizes();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      closePopover();
      apply(parseFloat(input.value));
    } else if (e.key === "Escape") {
      closePopover();
      editor.commands.focus();
    }
  });
  const update = () => {
    if (document.activeElement === input) return;
    input.value = String(currentSize(editor));
  };
  return { el, update };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function mix(hex: string, target: [number, number, number], t: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (target[0] - r) * t, g + (target[1] - g) * t, b + (target[2] - b) * t);
}

const BASE_COLORS = ["#ffffff", "#000000", "#e7e6e6", "#44546a", "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47"];
const STANDARD = ["#c00000", "#ff0000", "#ffc000", "#ffff00", "#92d050", "#00b050", "#00b0f0", "#0070c0", "#002060", "#7030a0"];

export function colorPalette(opts: { onPick: (c: string | null) => void; automaticLabel: string; current?: string | null }): HTMLElement {
  const swatch = (c: string) => {
    const b = h("button", { class: "swatch" + (opts.current?.toLowerCase() === c ? " is-checked" : ""), type: "button", style: { background: c }, "data-tip": c, "aria-label": c });
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      closePopover();
      opts.onPick(c);
    });
    return b;
  };
  const grid = h("div", { class: "palette__grid" });
  BASE_COLORS.forEach((c) => grid.append(swatch(c)));
  // Tints and shades, Office-style: white darkens, black lightens, colours get 3 tints + 2 shades.
  const WHITE: [number, number, number] = [255, 255, 255];
  const BLACK: [number, number, number] = [0, 0, 0];
  const rows: [[number, number, number], number][] = [[WHITE, 0.8], [WHITE, 0.6], [WHITE, 0.4], [BLACK, 0.25], [BLACK, 0.5]];
  const whiteSteps = [0.05, 0.15, 0.25, 0.35, 0.5];
  const blackSteps = [0.5, 0.35, 0.25, 0.15, 0.05];
  rows.forEach(([target, t], i) => {
    BASE_COLORS.forEach((c) => {
      if (c === "#ffffff") grid.append(swatch(mix(c, BLACK, whiteSteps[i])));
      else if (c === "#000000") grid.append(swatch(mix(c, WHITE, blackSteps[i])));
      else grid.append(swatch(mix(c, target, t)));
    });
  });
  const std = h("div", { class: "palette__grid" });
  STANDARD.forEach((c) => std.append(swatch(c)));

  const auto = h("button", { class: "palette__auto", type: "button" }, h("span", { class: "swatch swatch--auto" }), opts.automaticLabel);
  auto.addEventListener("mousedown", (e) => e.preventDefault());
  auto.addEventListener("click", () => {
    closePopover();
    opts.onPick(null);
  });
  const custom = h("input", { type: "color", class: "palette__custom-input", value: opts.current && /^#[0-9a-f]{6}$/i.test(opts.current) ? opts.current : "#b392f0" }) as HTMLInputElement;
  custom.addEventListener("change", () => {
    closePopover();
    opts.onPick(custom.value);
  });
  const customLabel = h("label", { class: "palette__custom" }, icon("Palette", 15), "More colours…", custom);

  return h("div", { class: "palette" },
    auto,
    h("div", { class: "palette__heading" }, "Theme colours"),
    grid,
    h("div", { class: "palette__heading" }, "Standard colours"),
    std,
    customLabel,
  );
}

/** Highlights tuned to stay readable with dark ink (the page forces dark text on highlights). */
export const HIGHLIGHTS = [
  { c: "#ffff00", n: "Yellow" }, { c: "#fff59d", n: "Soft yellow" }, { c: "#b9f6ca", n: "Mint" }, { c: "#a5f3fc", n: "Cyan" },
  { c: "#fbcfe8", n: "Pink" }, { c: "#fed7aa", n: "Peach" }, { c: "#ddd6fe", n: "Lavender" }, { c: "#fecaca", n: "Rose" },
  { c: "#d9f99d", n: "Lime" }, { c: "#e5e5e5", n: "Gray" },
];

export function highlightPalette(onPick: (c: string | null) => void): HTMLElement {
  const grid = h("div", { class: "palette__grid palette__grid--5" });
  for (const { c, n } of HIGHLIGHTS) {
    const b = h("button", { class: "swatch swatch--lg", type: "button", style: { background: c }, "data-tip": n, "aria-label": n });
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      closePopover();
      onPick(c);
    });
    grid.append(b);
  }
  const none = h("button", { class: "palette__auto", type: "button" }, icon("Eraser", 15), "No highlight");
  none.addEventListener("mousedown", (e) => e.preventDefault());
  none.addEventListener("click", () => {
    closePopover();
    onPick(null);
  });
  return h("div", { class: "palette" }, grid, none);
}

// ---------------------------------------------------------------------------
// Table grid
// ---------------------------------------------------------------------------

export function tableGrid(onPick: (rows: number, cols: number) => void): HTMLElement {
  const ROWS = 8, COLS = 10;
  const label = h("div", { class: "tgrid__label" }, "Insert table");
  const grid = h("div", { class: "tgrid__cells", style: { gridTemplateColumns: `repeat(${COLS}, 18px)` } });
  const cells: HTMLElement[] = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const cell = h("button", { class: "tgrid__cell", type: "button", "data-r": r, "data-c": c, "aria-label": `${r + 1} by ${c + 1}` });
      cell.addEventListener("mousedown", (e) => e.preventDefault());
      cells.push(cell);
      grid.append(cell);
    }
  grid.addEventListener("mouseover", (e) => {
    const t = e.target as HTMLElement;
    if (!t.dataset.r) return;
    const R = +t.dataset.r!, C = +t.dataset.c!;
    for (const cell of cells) cell.classList.toggle("is-on", +cell.dataset.r! <= R && +cell.dataset.c! <= C);
    label.textContent = `${C + 1} × ${R + 1} table`;
  });
  grid.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t.dataset.r) return;
    closePopover();
    onPick(+t.dataset.r! + 1, +t.dataset.c! + 1);
  });
  return h("div", { class: "tgrid" }, label, grid);
}
