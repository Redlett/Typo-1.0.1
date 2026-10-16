import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createEditor } from "./editor";
import { state, emit, on, setDirty } from "./core/state";
import { loadSettings, settings, saveSettings } from "./core/settings";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, applyTheme, normalizeTheme, type Theme } from "./core/themes";
import { native } from "./core/native";
import { initPage, applyPage, setZoom, scheduleLayout } from "./core/page";
import {
  newDocument,
  openFile,
  openPath,
  save,
  saveAs,
  printDocument,
  confirmDiscard,
  createNewTab,
  closeTab,
  getActiveTabId,
} from "./core/document";
import { loadPlugins } from "./core/plugins";
import { Ribbon } from "./ui/ribbon";
import { buildTabs, insertLink } from "./ui/tabs";
import { initTitlebar, initStatusbar } from "./ui/chrome";
import { initFindbar, openFind, refreshFindCount } from "./ui/findbar";
import { initBackstage, openBackstage, closeBackstage, isBackstageOpen } from "./ui/backstage";
import { stepSize } from "./ui/pickers";
import { toast, closePopover } from "./ui/dom";
import { initContextMenu, closeContextMenu, insertImageDataUrl } from "./ui/contextmenu";
import {
  getLastCopiedKind,
  setLastCopiedKind,
  isImageSelected,
  copySelectedImage,
  cutSelectedImage,
  duplicateSelectedImage,
  pasteTextContent,
  pasteImageContent,
  insertNormalizedText,
} from "./core/clipboard";
import { initMiniToolbar } from "./ui/minitoolbar";
import { openDictionary, openProofingPanel } from "./ui/dictionary";
import { initOutline, toggleOutline, toggleFocusMode, isFocusMode } from "./ui/outline";

let themes: Theme[] = [...BUILTIN_THEMES.map((t) => ({ ...t, source: "builtin" as const }))];

async function reloadUserThemes(): Promise<void> {
  try {
    const raw = await native.listUserThemes();
    const user: Theme[] = [];
    for (const r of raw) {
      const t = normalizeTheme(r);
      if (typeof t === "string") toast(`Theme ${(r as any)?._file ?? ""}: ${t}`, "error", 4000);
      else user.push(t);
    }
    themes = [...BUILTIN_THEMES.map((t) => ({ ...t, source: "builtin" as const })), ...user];
  } catch (e) {
    console.warn(e);
  }
}

function currentTheme(): Theme {
  return themes.find((t) => t.id === settings.themeId) ?? themes.find((t) => t.id === DEFAULT_THEME_ID)!;
}

function syncTheme(): Promise<void> {
  return applyTheme(currentTheme(), {
    paperPreview: settings.paperPreview,
    paperColor: settings.paperColor,
    customPaperColor: settings.customPaperColor,
    customAccent: settings.customAccent,
    customThemeColors: settings.customThemeColors,
    uiDensity: settings.uiDensity,
    uiScale: settings.uiScale,
    uiFont: settings.uiFont,
    customUiFont: settings.customUiFont,
    paperTexture: settings.paperTexture,
    customPaperTexturePath: settings.customPaperTexturePath,
    paperShadow: settings.paperShadow,
    showRuler: settings.showRuler,
    showMarginGuides: settings.showMarginGuides,
    proofUnderlineStyle: settings.proofUnderlineStyle,
    backgroundPreset: settings.backgroundPreset,
    customBackgroundPath: settings.customBackgroundPath,
    backgroundBlur: settings.backgroundBlur,
    backgroundDim: settings.backgroundDim,
    liquidGlassUi: settings.liquidGlassUi,
  });
}

async function setTheme(id: string): Promise<void> {
  settings.themeId = id;
  saveSettings();
  await syncTheme();
  emit("theme:change", id);
}

async function boot(): Promise<void> {
  await loadSettings();
  document.documentElement.classList.toggle("is-gpu-accel", settings.hardwareAcceleration !== false);
  await reloadUserThemes();
  await syncTheme();

  state.page = structuredClone(settings.defaultPage);
  state.defaults = { fontFamily: settings.defaultFont, fontSize: settings.defaultFontSize };

  // --- editor ---------------------------------------------------------------
  const ribbonHost = document.getElementById("ribbon")!;
  const ribbon = new Ribbon(ribbonHost);
  let statusRefresh = () => {};

  const editor = createEditor(
    document.getElementById("editor")!,
    () => {
      setDirty(true);
      emit("document:change");
      ribbon.refresh();
      statusRefresh();
      refreshFindCount();
      scheduleLayout();
      if (settings.typewriterScroll) {
        requestAnimationFrame(() => {
          try {
            const canvas = document.getElementById("canvas");
            if (!canvas) return;
            const pos = editor.state.selection.from;
            const coords = editor.view.coordsAtPos(pos);
            const cRect = canvas.getBoundingClientRect();
            const targetY = cRect.top + cRect.height * 0.45;
            const delta = coords.top - targetY;
            if (Math.abs(delta) > 18) {
              canvas.scrollBy({ top: delta, behavior: "smooth" });
            }
          } catch {
            /* ignore */
          }
        });
      }
    },
    () => {
      ribbon.refresh();
      statusRefresh();
      emit("selection:change");
    },
  );
  state.editor = editor;
  editor.view.dom.setAttribute("spellcheck", "false");
  on("document:change", () => setDirty(true));

  // --- Differentiated Text vs. Picture Clipboard Handling -------------------
  window.addEventListener(
    "copy",
    () => {
      if (!isImageSelected(editor)) setLastCopiedKind("text");
    },
    true,
  );
  window.addEventListener(
    "cut",
    () => {
      if (!isImageSelected(editor)) setLastCopiedKind("text");
    },
    true,
  );
  window.addEventListener(
    "paste",
    (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("input, textarea, .pdf-studio")) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      const plainText = e.clipboardData?.getData("text/plain") ?? "";
      const htmlText = e.clipboardData?.getData("text/html") ?? "";
      const htmlHasStandaloneImg = /<img\b/i.test(htmlText) && plainText.trim().length === 0;

      // If clipboard has text and wasn't explicitly copied as an image inside Typo,
      // normalize web tables, tabs, multi-space gaps, and long paragraphs so text
      // wraps and paginates cleanly across pages without weird gaps or cutoffs.
      if (plainText.trim().length > 0 && !htmlHasStandaloneImg && getLastCopiedKind() !== "image") {
        if (plainText.length > 200 || /[\t\u00A0\n]| {2,}/.test(plainText) || /<table\b/i.test(htmlText)) {
          e.preventDefault();
          e.stopPropagation();
          insertNormalizedText(editor, plainText);
        }
        return;
      }

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (!blob) continue;
          e.preventDefault();
          e.stopPropagation();
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") {
              void insertImageDataUrl(editor, reader.result);
              toast("Pasted picture from clipboard", "success", 1800);
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    },
    true,
  );

  // --- chrome ---------------------------------------------------------------
  initPage();
  initOutline();
  initTitlebar(() => void requestClose());
  ribbon.onFile = () => openBackstage("home");
  ribbon.onCollapseChange = (v) => {
    settings.ribbonCollapsed = v;
  };
  buildTabs(ribbon, editor, {
    applyTheme: () => void syncTheme(),
    openThemes: () => openBackstage("themes"),
  });
  settings.ribbonCollapsed = false;
  ribbon.setCollapsed(false);
  initFindbar();
  statusRefresh = initStatusbar(() => void syncTheme()).refresh;
  initContextMenu(editor);
  initMiniToolbar(editor);
  initBackstage({
    themes: () => themes,
    currentThemeId: () => currentTheme().id,
    setTheme: (id) => void setTheme(id),
    applyCustomization: () => {
      void syncTheme();
      ribbon.refresh();
      statusRefresh();
    },
    reloadThemes: async () => {
      await reloadUserThemes();
      await syncTheme();
    },
    reloadPlugins: () => loadPlugins(ribbon, editor),
  });
  on("page:change", () => {
    ribbon.refresh();
    statusRefresh();
  });
  on("document:open", () => {
    ribbon.refresh();
    statusRefresh();
  });
  on("document:new", () => {
    ribbon.refresh();
    statusRefresh();
  });
  on("proofing:update", () => {
    ribbon.refresh();
    statusRefresh();
  });

  applyPage();
  ribbon.refresh();
  statusRefresh();

  // --- Auto-Save Draft Vault (every 6 seconds when dirty) -------------------
  setInterval(() => {
    if (!state.dirty || !state.editor) return;
    const words = state.editor.storage.characterCount.words() as number;
    const hasImages = Boolean(state.editor.view.dom.querySelector("img"));
    if (words === 0 && !hasImages) return;
    const payload = {
      name: state.name,
      path: state.path,
      page: state.page,
      defaults: state.defaults,
      doc: state.editor.getJSON(),
      time: Date.now(),
    };
    void native.saveAutosave(payload).catch(() => {});
  }, 6000);

  // --- keyboard -------------------------------------------------------------
  // Never let the webview reload/navigate: that would silently discard the document.
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const inEditor = editor.view.dom.contains(e.target as Node);
    if (e.key === "F5" || (e.ctrlKey && k === "r" && (e.shiftKey || !inEditor)) || (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) {
      e.preventDefault();
    }
  }, true);
  // Suppress default browser context menu outside inputs (workspace uses our custom context menu).
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("input, textarea")) e.preventDefault();
  });
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "F7") {
      e.preventDefault();
      openProofingPanel(editor);
      ribbon.refresh();
      return;
    }
    if (e.key === "F11") {
      e.preventDefault();
      toggleFocusMode();
      ribbon.refresh();
      return;
    }
    if (e.key === "Escape") {
      if (isBackstageOpen()) {
        closeBackstage();
        return;
      }
      if (isFocusMode()) {
        toggleFocusMode(false);
        ribbon.refresh();
        return;
      }
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    const run = (fn: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
      closeContextMenu();
      fn();
    };
    if (k === "s" && e.shiftKey) return run(() => saveAs("docx"));
    if (k === "s") return run(() => save());
    if (k === "o" && e.shiftKey) return run(() => { toggleOutline(); ribbon.refresh(); });
    if (k === "o") return run(() => openFile());
    if (k === "n") return run(() => newDocument());
    if (k === "t" && !e.shiftKey) return run(() => createNewTab());
    if (k === "w" && !e.shiftKey) return run(() => void closeTab(getActiveTabId()));
    if (k === "p" && !e.shiftKey) return run(() => printDocument());
    if (k === "f" && !e.shiftKey) return run(() => openFind(false));
    if (k === "h") return run(() => openFind(true));
    if (k === "k") return run(() => insertLink(editor));
    if (k === "d" && e.shiftKey) return run(() => openDictionary(editor));
    const inInput = Boolean(
      (e.target as HTMLElement | null)?.closest(
        "input, textarea, [contenteditable='true']:not(.ProseMirror), .pdf-studio",
      ),
    );
    if (!inInput) {
      if (k === "v" && e.shiftKey && !e.altKey) return run(() => void pasteTextContent(editor, true));
      if (k === "v" && e.altKey && !e.shiftKey) return run(() => void pasteImageContent(editor));
      if (k === "c" && !e.shiftKey && !e.altKey && isImageSelected(editor)) return run(() => void copySelectedImage(editor));
      if (k === "x" && !e.shiftKey && !e.altKey && isImageSelected(editor)) return run(() => void cutSelectedImage(editor));
      if (k === "d" && !e.shiftKey && !e.altKey && isImageSelected(editor)) return run(() => void duplicateSelectedImage(editor));
    }
    if (e.key === "F1") return run(() => ribbon.setCollapsed(!ribbon.collapsed));
    if (e.key === "]") return run(() => stepSize(editor, 1));
    if (e.key === "[") return run(() => stepSize(editor, -1));
    if (e.key === "0" && !e.shiftKey) return run(() => setZoom(1));
    if (e.key === "-" && !e.shiftKey) return run(() => setZoom(settings.zoom - 0.1));
    if ((e.key === "=" || e.key === "+") && !e.shiftKey) return run(() => setZoom(settings.zoom + 0.1));
    if (k === "f" && e.shiftKey) return run(() => document.querySelector<HTMLInputElement>(".combo--font .combo__input")?.focus());
    if (k === "p" && e.shiftKey) return run(() => document.querySelector<HTMLInputElement>(".combo--size .combo__input")?.focus());
  }, true);

  // Smooth Precision Touchpad Pinch-to-Zoom & Ctrl + Mouse Wheel Zoom
  window.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isBackstageOpen()) return;
      e.preventDefault();
      // Distinguish continuous trackpad pinch gestures (small or fractional deltaY)
      // from discrete mouse wheel notches (larger integer steps).
      const absDelta = Math.abs(e.deltaY);
      const isTrackpadPinch = absDelta < 48 || !Number.isInteger(e.deltaY);
      const factor = isTrackpadPinch
        ? Math.exp(-e.deltaY * 0.012)
        : e.deltaY < 0
          ? 1.08
          : 1 / 1.08;
      setZoom((settings.zoom || 1) * factor, true, {
        clientX: e.clientX,
        clientY: e.clientY,
      });
    },
    { passive: false, capture: true },
  );

  // Two-Finger Multi-Touch Screen Pinch-to-Zoom
  const canvasEl = document.getElementById("canvas")!;
  let touchPinchStartDist = 0;
  let touchPinchStartZoom = 1;

  const getTouchDist = (t0: Touch, t1: Touch) =>
    Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

  canvasEl.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        touchPinchStartDist = getTouchDist(e.touches[0], e.touches[1]);
        touchPinchStartZoom = settings.zoom || 1;
      }
    },
    { passive: true },
  );

  canvasEl.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (e.touches.length !== 2 || touchPinchStartDist <= 10) return;
      e.preventDefault();
      const curDist = getTouchDist(e.touches[0], e.touches[1]);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const nextZoom = touchPinchStartZoom * (curDist / touchPinchStartDist);
      setZoom(nextZoom, true, { clientX: midX, clientY: midY });
    },
    { passive: false },
  );

  canvasEl.addEventListener(
    "touchend",
    (e: TouchEvent) => {
      if (e.touches.length < 2) {
        touchPinchStartDist = 0;
      }
    },
    { passive: true },
  );

  // Click on the grey canvas outside the sheet -> put the caret at the end (Word behaviour).
  document.getElementById("canvas")!.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (target.id === "canvas" || target.id === "sheet-wrap") {
      e.preventDefault();
      editor.commands.focus("end");
    } else if (target.id === "sheet" || target.id === "editor") {
      editor.commands.focus();
    }
  });

  // --- window lifecycle -----------------------------------------------------
  const win = getCurrentWindow();
  let closing = false;
  async function requestClose() {
    if (closing) return;
    closing = true;
    try {
      if (await confirmDiscard()) {
        await native.quitApp().catch(() => win.destroy());
      }
    } finally {
      closing = false;
    }
  }
  await win.onCloseRequested(async (event) => {
    event.preventDefault();
    await requestClose();
  });

  // Drag & drop: documents open, images insert at the caret.
  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const paths = event.payload.paths;
    const doc = paths.find((p) => /\.(docx|docm|dotx|md|markdown|txt|html?)$/i.test(p));
    const imgs = paths.filter((p) => /\.(png|jpe?g|gif|bmp|webp)$/i.test(p));
    if (doc) {
      if (await confirmDiscard()) await openPath(doc);
    } else if (imgs.length) {
      for (const p of imgs) {
        try {
          const src = await native.readImage(p);
          await insertImageDataUrl(editor, src);
        } catch (e) {
          toast(String(e), "error");
        }
      }
    }
  });

  // --- first paint, then background work ------------------------------------
  await newDocument(true);
  const initial = await native.initialFile().catch(() => null);
  if (!initial) {
    openBackstage("home");
  }
  requestAnimationFrame(() => {
    win.show().then(() => win.setFocus()).catch(() => {});
    document.documentElement.classList.add("is-ready");
  });

  native.listFonts().then((fonts) => {
    state.fonts = fonts;
    ribbon.refresh();
  }).catch((e) => console.warn("font scan failed", e));

  loadPlugins(ribbon, editor).catch((e) => console.warn(e));

  if (initial) {
    closeBackstage();
    await openPath(initial);
  } else {
    void native.clearAutosave().catch(() => {});
  }

  // Optional background startup update check (only runs if a release repo is configured)
  if (settings.autoCheckUpdates !== false && settings.updateRepo?.trim()) {
    window.setTimeout(async () => {
      try {
        const res = await native.checkAppUpdate(settings.updateRepo.trim());
        if (res.updateAvailable) {
          toast(
            `New Typo v${res.latestVersion} update available! Open File → About to install in 1 click.`,
            "info",
            6000,
          );
        }
      } catch {
        /* ignore offline or unconfigured repo */
      }
    }, 2200);
  }
}

boot().catch((e) => {
  console.error(e);
  getCurrentWindow().show().catch(() => {});
  document.body.insertAdjacentHTML("beforeend", `<pre class="boot-error">Typo failed to start:\n${String(e?.stack ?? e)}</pre>`);
});
