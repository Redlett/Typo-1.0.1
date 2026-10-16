/** Small DOM + UI primitives shared by the ribbon, backstage and dialogs. */
import { createElement as lucide, icons } from "lucide";

type IconName = keyof typeof icons;

export function icon(name: string, size = 16): SVGElement {
  const node = (icons as Record<string, any>)[name] ?? icons.Square;
  return lucide(node, { width: size, height: size, "stroke-width": 1.7, "aria-hidden": "true" });
}
export type { IconName };

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export function toast(message: string, kind: "info" | "error" | "success" = "info", ms = 2600): void {
  const root = document.getElementById("toast-root")!;
  const el = h("div", { class: `toast toast--${kind}`, role: "status" },
    icon(kind === "error" ? "CircleAlert" : kind === "success" ? "Check" : "Info", 15),
    h("span", {}, message),
  );
  root.append(el);
  requestAnimationFrame(() => el.classList.add("toast--in"));
  setTimeout(() => {
    el.classList.remove("toast--in");
    setTimeout(() => el.remove(), 200);
  }, ms);
}

// ---------------------------------------------------------------------------
// Popovers (dropdowns anchored to a control)
// ---------------------------------------------------------------------------

let openPopover: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

export function closePopover(): void {
  openPopover?.close();
}

export function popover(anchor: HTMLElement, content: HTMLElement, opts: { align?: "start" | "end"; onClose?: () => void } = {}): () => void {
  if (openPopover?.anchor === anchor) {
    closePopover();
    return () => {};
  }
  closePopover();
  const root = document.getElementById("overlay-root")!;
  const el = h("div", { class: "popover", role: "dialog" }, content);
  root.append(el);
  const r = anchor.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  let left = opts.align === "end" ? r.right - pr.width : r.left;
  left = Math.max(6, Math.min(left, window.innerWidth - pr.width - 6));
  let top = r.bottom + 4;
  if (top + pr.height > window.innerHeight - 6) top = Math.max(6, r.top - pr.height - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.classList.add("is-open");
  requestAnimationFrame(() => el.classList.add("popover--in"));

  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  function close() {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    anchor.classList.remove("is-open");
    el.remove();
    if (openPopover?.el === el) openPopover = null;
    opts.onClose?.();
  }
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  openPopover = { el, anchor, close };
  return close;
}

// ---------------------------------------------------------------------------
// Modal dialog (used for link / prompt style inputs)
// ---------------------------------------------------------------------------

export interface Field { name: string; label: string; value?: string; placeholder?: string; type?: string }

export function promptDialog(title: string, fields: Field[], okLabel = "OK"): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const root = document.getElementById("overlay-root")!;
    const inputs: Record<string, HTMLInputElement> = {};
    const form = h("form", { class: "modal" },
      h("h2", { class: "modal__title" }, title),
      ...fields.map((f) => {
        const input = h("input", { class: "input", name: f.name, type: f.type ?? "text", value: f.value ?? "", placeholder: f.placeholder ?? "", spellcheck: "false" });
        inputs[f.name] = input;
        return h("label", { class: "field" }, h("span", { class: "field__label" }, f.label), input);
      }),
      h("div", { class: "modal__actions" },
        h("button", { type: "button", class: "btn", onclick: () => done(null) }, "Cancel"),
        h("button", { type: "submit", class: "btn btn--primary" }, okLabel),
      ),
    );
    const scrim = h("div", { class: "scrim" }, form);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(inputs)) out[k] = v.value;
      done(out);
    });
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done(null);
    });
    scrim.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
    });
    function done(v: Record<string, string> | null) {
      scrim.remove();
      resolve(v);
    }
    root.append(scrim);
    requestAnimationFrame(() => {
      scrim.classList.add("scrim--in");
      const first = Object.values(inputs)[0];
      first?.focus();
      first?.select();
    });
  });
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: number | undefined;
  return ((...a: any[]) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  }) as T;
}
