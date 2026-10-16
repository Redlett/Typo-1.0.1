/**
 * Ribbon engine. Built-in tabs and plugins use the same API:
 *   ribbon.addTab(id, label) -> tab.addGroup(label) -> group.large()/stack()/custom()
 * Every control can expose an `update()` that re-syncs active/disabled state with
 * the editor selection; updates are batched into one animation frame.
 */
import { h, icon, popover, closePopover } from "./dom";

export interface ButtonOpts {
  id?: string;
  icon: string;
  label: string;
  /** Tooltip; shortcut is appended automatically. */
  tip?: string;
  shortcut?: string;
  onClick?: (ev: MouseEvent, el: HTMLElement) => void;
  /** Makes it a split button: main click = onClick, caret = dropdown. */
  dropdown?: (anchor: HTMLElement) => HTMLElement;
  isActive?: () => boolean;
  isEnabled?: () => boolean;
  /** Small buttons hide their label unless set. */
  showLabel?: boolean;
  /** Optional colour bar under the icon (text colour / highlight). */
  swatch?: () => string | null;
}

type Updater = () => void;

export class RibbonGroup {
  readonly el: HTMLElement;
  private body: HTMLElement;
  constructor(private ribbon: Ribbon, label: string) {
    this.body = h("div", { class: "rgroup__body" });
    this.el = h("div", { class: "rgroup" }, this.body, h("div", { class: "rgroup__label" }, label));
  }

  /** Big icon-over-label button (Paste, Table, Picture …). */
  large(opts: ButtonOpts): HTMLElement {
    const el = this.ribbon.makeButton(opts, "large");
    this.body.append(el);
    return el;
  }

  /** A vertical stack of rows of small controls. Returns a row factory. */
  stack(rows: number = 2): HTMLElement[] {
    const col = h("div", { class: "rstack" });
    const out: HTMLElement[] = [];
    for (let i = 0; i < rows; i++) {
      const row = h("div", { class: "rrow" });
      col.append(row);
      out.push(row);
    }
    this.body.append(col);
    return out;
  }

  small(row: HTMLElement, opts: ButtonOpts): HTMLElement {
    const el = this.ribbon.makeButton(opts, "small");
    row.append(el);
    return el;
  }

  custom(el: HTMLElement, update?: Updater, row?: HTMLElement): HTMLElement {
    (row ?? this.body).append(el);
    if (update) this.ribbon.addUpdater(update);
    return el;
  }

  separator(row?: HTMLElement): void {
    (row ?? this.body).append(h("div", { class: "rsep" }));
  }
}

export class RibbonTab {
  readonly panel: HTMLElement;
  readonly button: HTMLButtonElement;
  constructor(private ribbon: Ribbon, readonly id: string, label: string) {
    this.panel = h("div", { class: "rpanel", role: "tabpanel", "data-tab": id });
    this.button = h("button", { class: "rtab", role: "tab", "data-tab": id, type: "button" }, label);
  }
  addGroup(label: string): RibbonGroup {
    const g = new RibbonGroup(this.ribbon, label);
    this.panel.append(g.el);
    return g;
  }
}

export class Ribbon {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private bodyEl: HTMLElement;
  private rightEl: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private tabs = new Map<string, RibbonTab>();
  private updaters = new Set<Updater>();
  private raf = 0;
  active = "home";
  collapsed = false;
  onFile: () => void = () => {};
  onCollapseChange: (v: boolean) => void = () => {};

  constructor(host: HTMLElement) {
    this.tabsEl = h("div", { class: "rtabs", role: "tablist" });
    this.rightEl = h("div", { class: "rtabs__right" });
    this.bodyEl = h("div", { class: "rbody" });
    this.toggleBtn = h(
      "button",
      {
        class: "rtab-toggle",
        type: "button",
        "data-tip": "Show or hide the Ribbon UI  (Ctrl+F1)",
        "aria-label": "Toggle Ribbon UI",
        onclick: () => this.setCollapsed(!this.collapsed),
      },
      icon("ChevronUp", 13),
      h("span", { class: "rtab-toggle__label" }, "Hide UI"),
    ) as HTMLButtonElement;
    this.toggleBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.rightEl.append(this.toggleBtn);

    const fileBtn = h("button", { class: "rtab rtab--file", type: "button", onclick: () => { closePopover(); this.onFile(); } }, "File");
    fileBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.el = host;
    host.append(h("div", { class: "rtabbar" }, fileBtn, this.tabsEl, this.rightEl), this.bodyEl);

    installTooltips();
  }

  addTab(id: string, label: string): RibbonTab {
    const existing = this.tabs.get(id);
    if (existing) return existing;
    const tab = new RibbonTab(this, id, label);
    this.tabs.set(id, tab);
    this.tabsEl.append(tab.button);
    this.bodyEl.append(tab.panel);
    tab.button.addEventListener("mousedown", (e) => e.preventDefault());
    tab.button.addEventListener("click", () => {
      closePopover();
      if (this.collapsed) {
        this.setCollapsed(false);
      }
      this.select(id);
    });
    const isActive = id === this.active;
    tab.panel.hidden = !isActive;
    tab.button.classList.toggle("is-active", isActive);
    tab.button.setAttribute("aria-selected", String(isActive));
    return tab;
  }

  removeTab(id: string): void {
    const t = this.tabs.get(id);
    if (!t) return;
    t.button.remove();
    t.panel.remove();
    this.tabs.delete(id);
    if (this.active === id) this.select("home");
  }

  addRight(el: HTMLElement): void {
    this.rightEl.insertBefore(el, this.toggleBtn);
  }

  select(id: string): void {
    if (!this.tabs.has(id)) return;
    this.active = id;
    for (const [tid, t] of this.tabs) {
      const on = tid === id;
      t.button.classList.toggle("is-active", on);
      t.button.setAttribute("aria-selected", String(on));
      t.panel.hidden = !on;
    }
  }

  setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.el.classList.toggle("ribbon--collapsed", v);
    this.toggleBtn.classList.toggle("is-collapsed", v);
    this.toggleBtn.replaceChildren(
      icon(v ? "ChevronDown" : "ChevronUp", 13),
      h("span", { class: "rtab-toggle__label" }, v ? "Show UI" : "Hide UI"),
    );
    this.onCollapseChange(v);
  }

  addUpdater(fn: Updater): void {
    this.updaters.add(fn);
  }

  /** Schedules a state refresh of every control (batched per frame). */
  refresh(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      for (const u of this.updaters) {
        try {
          u();
        } catch (e) {
          console.error(e);
        }
      }
    });
  }

  makeButton(opts: ButtonOpts, size: "large" | "small"): HTMLElement {
    const tip = opts.tip ?? opts.label;
    const tipText = opts.shortcut ? `${tip}  (${opts.shortcut})` : tip;
    const iconEl = icon(opts.icon, size === "large" ? 24 : 16);
    const swatch = opts.swatch ? h("span", { class: "rbtn__swatch" }) : null;
    const isSplit = !!opts.dropdown && !!opts.onClick;
    const isMenu = !!opts.dropdown && !opts.onClick;
    const showLabel = size === "large" ? !isSplit : !!opts.showLabel;
    const main = h("button", { class: `rbtn rbtn--${size}${isMenu ? " rbtn--menu" : ""}`, type: "button", "data-tip": tipText, "aria-label": opts.label, "aria-haspopup": isMenu ? "true" : null },
      h("span", { class: "rbtn__icon" }, iconEl, swatch),
      showLabel ? h("span", { class: "rbtn__label" }, opts.label, isMenu && size === "large" ? icon("ChevronDown", 11) : null) : null,
      isMenu && size === "small" ? h("span", { class: "rbtn__chev" }, icon("ChevronDown", 11)) : null,
    );
    // Keep the editor selection when clicking ribbon controls.
    main.addEventListener("mousedown", (e) => e.preventDefault());
    let root: HTMLElement = main;
    const buttons: HTMLButtonElement[] = [main as HTMLButtonElement];

    if (isMenu) {
      main.addEventListener("click", () => popover(main, opts.dropdown!(main)));
    } else if (isSplit) {
      const caret = h("button", { class: `rbtn rbtn--caret rbtn--caret-${size}`, type: "button", "data-tip": `${opts.label} options`, "aria-label": `${opts.label} options`, "aria-haspopup": "true" },
        size === "large" ? h("span", { class: "rbtn__label" }, opts.label) : null,
        icon("ChevronDown", size === "large" ? 11 : 12),
      );
      caret.addEventListener("mousedown", (e) => e.preventDefault());
      root = h("div", { class: `rsplit rsplit--${size}` }, main, caret);
      caret.addEventListener("click", () => popover(root, opts.dropdown!(root)));
      buttons.push(caret as HTMLButtonElement);
    }
    if (opts.onClick) main.addEventListener("click", (e) => opts.onClick!(e, main));

    if (opts.isActive || opts.isEnabled || opts.swatch) {
      this.addUpdater(() => {
        if (opts.isActive) main.classList.toggle("is-on", !!opts.isActive());
        if (opts.isEnabled) {
          const en = opts.isEnabled();
          root.classList.toggle("is-disabled", !en);
          for (const b of buttons) b.disabled = !en;
        }
        if (swatch && opts.swatch) {
          const c = opts.swatch();
          swatch.style.background = c ?? "transparent";
          swatch.classList.toggle("is-empty", !c);
        }
      });
    }
    return root;
  }
}

// ---------------------------------------------------------------------------
// Tooltips: one shared element, 450 ms delay, no layout thrash.
// ---------------------------------------------------------------------------

let tooltipsInstalled = false;
function installTooltips(): void {
  if (tooltipsInstalled) return;
  tooltipsInstalled = true;
  const tip = h("div", { class: "tooltip", role: "tooltip" });
  document.body.append(tip);
  let timer: number | undefined;
  let current: HTMLElement | null = null;
  const hide = () => {
    clearTimeout(timer);
    tip.classList.remove("tooltip--in");
    current = null;
  };
  document.addEventListener("mouseover", (e) => {
    const t = (e.target as HTMLElement).closest?.("[data-tip]") as HTMLElement | null;
    if (t === current) return;
    hide();
    if (!t || t.classList.contains("is-open")) return;
    current = t;
    timer = window.setTimeout(() => {
      if (!current?.isConnected) return;
      tip.textContent = current.dataset.tip ?? "";
      const r = current.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      const left = Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, window.innerWidth - tr.width - 6));
      const top = r.bottom + 6 + tr.height > window.innerHeight ? r.top - tr.height - 6 : r.bottom + 6;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.classList.add("tooltip--in");
    }, 450);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("blur", hide);
}
