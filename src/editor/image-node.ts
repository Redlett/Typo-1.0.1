/**
 * Free-Roam + InDesign Image & Sticker NodeView for Typo.
 * Supports:
 * - True Free-Roam Drag-Anywhere positioning ("free-front", "free-behind") at exact (x, y) sheet coordinates
 * - Paragraph text-wrapping modes ("wrap-left", "wrap-right", "center", "inline")
 * - 4-corner aspect-locked resize handles with live dimension badge
 * - Rotation / tilt controls (-15°, +15°, 0°) for photos & stickers
 * - Floating mini-toolbar (free-roam layers, wrap modes, size presets, rotation, delete)
 */
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { h, icon, toast } from "../ui/dom";
import { scheduleLayout } from "../core/page";

export type ImageWrapMode = "free-front" | "free-behind" | "wrap-left" | "wrap-right" | "center" | "inline";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    typoImage: {
      setImageWrap: (wrap: ImageWrapMode) => ReturnType;
      deleteSelectedImage: () => ReturnType;
    };
  }
}

export const TypoImage = Image.extend({
  name: "image",
  inline: true,
  group: "inline",
  draggable: false,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = el.getAttribute("width") || el.style.width;
          return w ? parseInt(w, 10) || null : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (el) => {
          const hVal = el.getAttribute("height") || el.style.height;
          return hVal ? parseInt(hVal, 10) || null : null;
        },
        renderHTML: (attrs) => (attrs.height ? { height: attrs.height } : {}),
      },
      wrap: {
        default: "wrap-left" as ImageWrapMode,
        parseHTML: (el) => (el.getAttribute("data-wrap") as ImageWrapMode) || "wrap-left",
        renderHTML: (attrs) => ({ "data-wrap": attrs.wrap || "wrap-left" }),
      },
      x: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-x");
          return v !== null && v !== "" ? parseFloat(v) : null;
        },
        renderHTML: (attrs) => (typeof attrs.x === "number" ? { "data-x": String(Math.round(attrs.x)) } : {}),
      },
      y: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute("data-y");
          return v !== null && v !== "" ? parseFloat(v) : null;
        },
        renderHTML: (attrs) => (typeof attrs.y === "number" ? { "data-y": String(Math.round(attrs.y)) } : {}),
      },
      rotate: {
        default: 0,
        parseHTML: (el) => {
          const v = el.getAttribute("data-rotate");
          return v ? parseFloat(v) || 0 : 0;
        },
        renderHTML: (attrs) => (attrs.rotate ? { "data-rotate": String(attrs.rotate) } : {}),
      },
      sticker: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-sticker") === "true",
        renderHTML: (attrs) => (attrs.sticker ? { "data-sticker": "true" } : {}),
      },
      overlayLock: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-overlay-lock") === "true",
        renderHTML: (attrs) => (attrs.overlayLock ? { "data-overlay-lock": "true" } : {}),
      },
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setImageWrap:
        (wrap: ImageWrapMode) =>
        ({ commands }) =>
          commands.updateAttributes("image", {
            wrap,
            overlayLock: wrap === "free-front" || wrap === "free-behind",
            ...(wrap === "wrap-left" || wrap === "wrap-right" || wrap === "center" || wrap === "inline"
              ? { x: null, y: null }
              : {}),
          }),
      deleteSelectedImage:
        () =>
        ({ state, dispatch }) => {
          const { selection } = state;
          if (selection instanceof NodeSelection && selection.node.type.name === "image") {
            if (dispatch) dispatch(state.tr.deleteSelection().scrollIntoView());
            return true;
          }
          return false;
        },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentNode = node;

      const container = h("span", {
        class: "typo-image",
        contenteditable: "false",
        "data-wrap": currentNode.attrs.wrap || "wrap-left",
      });

      const frame = h("span", {
        class: "typo-image__frame",
      });

      const img = h("img", {
        class: "typo-image__img",
        src: currentNode.attrs.src,
        alt: currentNode.attrs.alt || "",
        title: currentNode.attrs.title || "",
        draggable: "false",
      }) as HTMLImageElement;

      const badge = h("span", { class: "typo-image__badge" });

      // Floating mini-toolbar
      const toolbar = h("div", { class: "typo-image__bar" });
      const mkBtn = (ic: string, tip: string, wrapVal: ImageWrapMode | null, onClick: () => void) => {
        const b = h(
          "button",
          {
            type: "button",
            class: "typo-image__btn",
            "data-tip": tip,
            "data-wrap-btn": wrapVal ?? "",
          },
          icon(ic, 14),
        );
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        });
        return b;
      };

      const setWrap = (wrap: ImageWrapMode) => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number") return;
        const isFree = wrap === "free-front" || wrap === "free-behind";
        let nextX = isFree ? currentNode.attrs.x : null;
        let nextY = isFree ? currentNode.attrs.y : null;

        const sheetEl = document.getElementById("sheet");
        const zoom = parseFloat(sheetEl?.style.getPropertyValue("zoom") || "1") || 1;
        const fRect = frame.getBoundingClientRect();
        const curW = currentNode.attrs.width || Math.round(fRect.width / zoom) || 120;
        const curH = currentNode.attrs.height || Math.round(fRect.height / zoom) || 120;

        if (isFree && (typeof nextX !== "number" || typeof nextY !== "number")) {
          if (sheetEl) {
            const sRect = sheetEl.getBoundingClientRect();
            nextX = Math.max(12, Math.round((fRect.left - sRect.left) / zoom));
            nextY = Math.max(12, Math.round((fRect.top - sRect.top) / zoom));
          } else {
            nextX = 120;
            nextY = 120;
          }
        }

        const updatedAttrs = {
          ...currentNode.attrs,
          width: curW,
          height: curH,
          wrap,
          overlayLock: isFree,
          x: nextX,
          y: nextY,
        };

        const state = editor.state;
        const tr = state.tr;
        const $pos = state.doc.resolve(pos);
        if (!isFree && $pos.parent.isTextblock && pos > $pos.start()) {
          const blockStart = $pos.start();
          const newImgNode = state.schema.nodes.image.create(updatedAttrs);
          tr.delete(pos, pos + currentNode.nodeSize);
          const mappedPos = tr.mapping.map(blockStart);
          tr.insert(mappedPos, newImgNode);
          try {
            tr.setSelection(NodeSelection.create(tr.doc, mappedPos));
          } catch {
            // ignore
          }
          editor.view.dispatch(tr);
        } else {
          tr.setNodeMarkup(pos, undefined, updatedAttrs);
          try {
            tr.setSelection(NodeSelection.create(tr.doc, pos));
          } catch {
            // ignore
          }
          editor.view.dispatch(tr);
          currentNode = editor.state.doc.nodeAt(pos) || currentNode;
          syncDOM();
        }
        scheduleLayout();
      };

      const rotateBy = (deltaDeg: number | null) => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number") return;
        const curRot = Number(currentNode.attrs.rotate) || 0;
        const nextRot = deltaDeg === null ? 0 : ((curRot + deltaDeg + 540) % 360) - 180;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, rotate: nextRot });
            tr.setSelection(NodeSelection.create(tr.doc, pos));
            return true;
          })
          .run();
      };

      const scaleToColumn = (ratio: number) => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number") return;
        const edEl = document.getElementById("editor");
        const colW = edEl ? edEl.clientWidth : 600;
        const natW = img.naturalWidth || currentNode.attrs.width || 320;
        const natH = img.naturalHeight || currentNode.attrs.height || 240;
        const aspect = natH / Math.max(1, natW);
        const w = Math.max(36, Math.round(colW * ratio));
        const hVal = Math.max(28, Math.round(w * aspect));
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, width: w, height: hVal });
            tr.setSelection(NodeSelection.create(tr.doc, pos));
            return true;
          })
          .run();
        scheduleLayout();
      };

      const removeSelf = () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number") return;
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(pos, pos + currentNode.nodeSize);
            return true;
          })
          .run();
        toast(currentNode.attrs.sticker ? "Sticker removed" : "Picture deleted", "info", 1600);
        scheduleLayout();
      };

      const btnLeft = mkBtn("AlignLeft", "InDesign Text Wrap: Wrap Left (Text flows down right side)", "wrap-left", () => setWrap("wrap-left"));
      const btnCenter = mkBtn("AlignCenter", "InDesign Text Wrap: Center (Part text above & below)", "center", () => setWrap("center"));
      const btnRight = mkBtn("AlignRight", "InDesign Text Wrap: Wrap Right (Text flows down left side)", "wrap-right", () => setWrap("wrap-right"));
      const btnFreeFront = mkBtn("Sparkles", "Overlay Mode: Float In Front of Text (Ignore text wrap)", "free-front", () => setWrap("free-front"));
      const btnFreeBehind = mkBtn("Layers", "Backdrop Mode: Float Behind Text (Watermark layer)", "free-behind", () => setWrap("free-behind"));
      const btnRotL = mkBtn("RotateCcw", "Tilt Counter-Clockwise (-15°)", null, () => rotateBy(-15));
      const btnRotR = mkBtn("RotateCw", "Tilt Clockwise (+15°)", null, () => rotateBy(15));

      const mkPct = (label: string, ratio: number) => {
        const b = h("button", { type: "button", class: "typo-image__btn typo-image__btn--txt", "data-tip": `Resize to ${label}` }, label);
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        b.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          scaleToColumn(ratio);
        });
        return b;
      };

      const btnDel = mkBtn("Trash2", "Delete (Del)", null, removeSelf);
      btnDel.classList.add("typo-image__btn--danger");

      toolbar.append(
        btnLeft,
        btnCenter,
        btnRight,
        h("span", { class: "typo-image__sep" }),
        btnFreeFront,
        btnFreeBehind,
        h("span", { class: "typo-image__sep" }),
        btnRotL,
        btnRotR,
        h("span", { class: "typo-image__sep" }),
        mkPct("25%", 0.25),
        mkPct("50%", 0.5),
        mkPct("100%", 1.0),
        h("span", { class: "typo-image__sep" }),
        btnDel,
      );

      // 4-corner resize handles
      const corners = ["nw", "ne", "sw", "se"] as const;
      const handles = corners.map((dir) => {
        const handle = h("span", { class: `typo-image__handle typo-image__handle--${dir}`, "data-dir": dir });
        handle.addEventListener("mousedown", (e) => startResize(e, dir));
        return handle;
      });

      frame.append(toolbar, img, badge, ...handles);
      container.append(frame);

      function syncDOM() {
        const wrap: ImageWrapMode = currentNode.attrs.wrap || "wrap-left";
        const isFree = wrap === "free-front" || wrap === "free-behind";
        container.setAttribute("data-wrap", wrap);
        container.classList.toggle("is-sticker", Boolean(currentNode.attrs.sticker));

        if (currentNode.attrs.src && img.getAttribute("src") !== currentNode.attrs.src) {
          img.src = currentNode.attrs.src;
        }
        img.alt = currentNode.attrs.alt || "";
        img.title = currentNode.attrs.title || "";
        const w = currentNode.attrs.width;
        const hVal = currentNode.attrs.height;
        if (w) {
          img.style.width = `${w}px`;
          frame.style.width = `${w}px`;
        } else {
          img.style.width = "";
          frame.style.width = "";
        }
        if (hVal) {
          img.style.height = `${hVal}px`;
        } else {
          img.style.height = "auto";
        }

        // Clear custom inline positioning before applying mode-specific styles
        container.style.left = "";
        container.style.top = "";
        container.style.width = "";
        container.style.height = "";
        container.style.paddingTop = "";
        container.style.paddingLeft = "";
        container.style.paddingRight = "";
        container.style.marginLeft = "";
        container.style.marginRight = "";
        container.style.marginTop = "";
        container.style.marginBottom = "";
        container.style.shapeOutside = "";
        frame.style.margin = "";

        if (isFree) {
          if (w) container.style.width = `${w}px`;
          if (typeof currentNode.attrs.x === "number" && typeof currentNode.attrs.y === "number") {
            container.style.left = `${currentNode.attrs.x}px`;
            container.style.top = `${currentNode.attrs.y}px`;
          }
        } else if (wrap === "center") {
          const offsetY = typeof currentNode.attrs.y === "number" ? Math.max(0, currentNode.attrs.y) : 0;
          const resolvedH = hVal || img.offsetHeight || w || 120;
          container.style.width = "100%";
          container.style.height = `${offsetY + resolvedH}px`;
          container.style.paddingTop = `${offsetY}px`;
          container.style.marginTop = "0px";
          container.style.marginBottom = "12px";
          container.style.marginLeft = "0px";
          container.style.marginRight = "0px";
          container.style.shapeOutside = `inset(${offsetY}px 0px 0px 0px)`;
          frame.style.margin = "0 auto";
        } else if (wrap === "wrap-left" || wrap === "wrap-right") {
          // InDesign-style wrap offset: exact same float + shape-outside inset box as wrapSpacer
          const offsetX = typeof currentNode.attrs.x === "number" ? Math.max(0, currentNode.attrs.x) : 0;
          const offsetY = typeof currentNode.attrs.y === "number" ? Math.max(0, currentNode.attrs.y) : 0;
          const resolvedW = w || img.offsetWidth || 160;
          const resolvedH = hVal || img.offsetHeight || resolvedW;

          container.style.width = `${resolvedW + offsetX}px`;
          container.style.height = `${offsetY + resolvedH}px`;
          container.style.paddingTop = `${offsetY}px`;
          if (wrap === "wrap-left" && offsetX > 0) {
            container.style.paddingLeft = `${offsetX}px`;
          } else if (wrap === "wrap-right" && offsetX > 0) {
            container.style.paddingRight = `${offsetX}px`;
          }
          container.style.marginTop = "0px";
          container.style.marginBottom = "8px";
          container.style.marginLeft = wrap === "wrap-right" ? "16px" : "0px";
          container.style.marginRight = wrap === "wrap-left" ? "16px" : "0px";
          container.style.shapeOutside = `inset(${offsetY}px 0px 0px 0px round 6px)`;
        } else {
          // inline mode
          if (w) container.style.width = `${w}px`;
        }

        const rot = Number(currentNode.attrs.rotate) || 0;
        img.style.transform = rot ? `rotate(${rot}deg)` : "";

        for (const b of toolbar.querySelectorAll<HTMLElement>("[data-wrap-btn]")) {
          b.classList.toggle("is-on", b.dataset.wrapBtn === wrap);
        }
      }

      function selectThisNode() {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos === "number") {
          const tr = editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos));
          editor.view.dispatch(tr);
          editor.view.focus();
        }
      }

      // --- 4-Corner Resize Interaction ---
      function startResize(e: MouseEvent, dir: "nw" | "ne" | "sw" | "se") {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectThisNode();

        const zoom = parseFloat(document.getElementById("sheet")?.style.getPropertyValue("zoom") || "1") || 1;
        const startX = e.clientX;
        const startY = e.clientY;
        const rect = img.getBoundingClientRect();
        const startW = (rect.width / zoom) || currentNode.attrs.width || img.naturalWidth || 200;
        const startH = (rect.height / zoom) || currentNode.attrs.height || img.naturalHeight || 160;
        const aspect = startH / Math.max(1, startW);
        const sheetEl = document.getElementById("sheet");
        const maxW = sheetEl ? sheetEl.clientWidth - 24 : 760;

        container.classList.add("is-resizing");
        badge.textContent = `${Math.round(startW)} × ${Math.round(startH)} px`;

        let nextW = Math.round(startW);
        let nextH = Math.round(startH);

        const onMove = (ev: MouseEvent) => {
          const dx = ((ev.clientX - startX) / zoom) * (dir.includes("w") ? -1 : 1);
          const dy = ((ev.clientY - startY) / zoom) * (dir.includes("n") ? -1 : 1);
          nextW = Math.max(28, Math.min(maxW, Math.round(startW + dx)));
          if (ev.shiftKey) {
            nextH = Math.max(28, Math.round(startH + dy));
          } else {
            nextH = Math.max(28, Math.round(nextW * aspect));
          }
          img.style.width = `${nextW}px`;
          img.style.height = `${nextH}px`;
          frame.style.width = `${nextW}px`;
          const wrap: ImageWrapMode = currentNode.attrs.wrap || "wrap-left";
          const offsetX = typeof currentNode.attrs.x === "number" ? Math.max(0, currentNode.attrs.x) : 0;
          const offsetY = typeof currentNode.attrs.y === "number" ? Math.max(0, currentNode.attrs.y) : 0;
          if (wrap === "wrap-left" || wrap === "wrap-right") {
            container.style.width = `${nextW + offsetX}px`;
            container.style.height = `${offsetY + nextH}px`;
          } else if (wrap === "center") {
            container.style.height = `${offsetY + nextH}px`;
          } else {
            container.style.width = `${nextW}px`;
          }
          badge.textContent = `${nextW} × ${nextH} px`;
        };

        const onUp = () => {
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", onUp, true);
          container.classList.remove("is-resizing");
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos === "number") {
            const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
              ...currentNode.attrs,
              width: nextW,
              height: nextH,
            });
            tr.setSelection(NodeSelection.create(tr.doc, pos));
            editor.view.dispatch(tr);
            currentNode = editor.state.doc.nodeAt(pos) || currentNode;
            syncDOM();
            scheduleLayout();
          }
        };

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
      }

      // --- InDesign Live Text-Wrap Runaround + Free-Roam Sticker/Overlay Drag ---
      img.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        selectThisNode();

        const sheetEl = document.getElementById("sheet");
        const editorEl = document.getElementById("editor");
        if (!sheetEl || !editorEl) return;
        const pmRoot = (editor.view?.dom as HTMLElement) || editorEl;
        const zoom = parseFloat(sheetEl.style.getPropertyValue("zoom") || "1") || 1;
        const sheetRect = sheetEl.getBoundingClientRect();
        const edRect = pmRoot.getBoundingClientRect();
        const startFrameRect = frame.getBoundingClientRect();

        const startX = e.clientX;
        const startY = e.clientY;
        const boxW = Math.max(28, Math.round((startFrameRect.width || img.offsetWidth || currentNode.attrs.width || 120) / zoom));
        const boxH = Math.max(28, Math.round((startFrameRect.height || img.offsetHeight || currentNode.attrs.height || 120) / zoom));

        const initialLeft = Math.round((startFrameRect.left - sheetRect.left) / zoom);
        const initialTop = Math.round((startFrameRect.top - sheetRect.top) / zoom);

        // Both Photos AND Stickers use InDesign Text-Wrap Runaround when dragged over/near text,
        // unless the user explicitly locked the item to Overlay (❐) or Behind Text (❏) on its toolbar!
        const isLockedOverlay =
          currentNode.attrs.wrap === "free-behind" ||
          Boolean(currentNode.attrs.overlayLock);

        let dragging = false;
        let nextX = initialLeft;
        let nextY = initialTop;
        let detectedWrap: ImageWrapMode = isLockedOverlay
          ? currentNode.attrs.wrap === "free-behind"
            ? "free-behind"
            : "free-front"
          : (currentNode.attrs.wrap === "free-front" ? "wrap-left" : (currentNode.attrs.wrap as ImageWrapMode)) || "wrap-left";

        // Live float spacer for real-time InDesign text reflow while dragging a photo or sticker
        let wrapSpacer: HTMLElement | null = null;
        let targetBlockEl: HTMLElement | null = null;
        let lastRelTopPx = 0;
        let horizontalMarginOffset = 0;
        let droppedOnEmptyCanvas = false;
        let observerStopped = false;

        const stopDomObserver = () => {
          if (!observerStopped) {
            try {
              (editor.view as any)?.domObserver?.stop?.();
              observerStopped = true;
            } catch {
              // ignore
            }
          }
        };

        const startDomObserver = () => {
          if (observerStopped) {
            try {
              (editor.view as any)?.domObserver?.start?.();
            } catch {
              // ignore
            }
            observerStopped = false;
          }
        };

        const getBlockProseText = (b: HTMLElement): string => {
          let text = "";
          for (const child of Array.from(b.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
              text += child.textContent || "";
            } else if (child instanceof HTMLElement) {
              if (child.classList.contains("typo-image") || child.classList.contains("typo-image__wrap-spacer")) {
                continue;
              }
              text += getBlockProseText(child);
            }
          }
          return text.trim();
        };

        const getTextBlocks = (): HTMLElement[] =>
          Array.from(pmRoot.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6"));

        const initialFlowBottom = Math.max(
          startFrameRect.bottom,
          ...getTextBlocks().map((b) => b.getBoundingClientRect().bottom),
        );

        const findTargetBlock = (
          clientTopY: number,
        ): { block: HTMLElement | null; relTopPx: number; offsetTop: number; isEmptyDoc: boolean } => {
          const allBlocks = getTextBlocks();
          const nonEmptyBlocks = allBlocks.filter((b) => getBlockProseText(b).length > 0);
          if (nonEmptyBlocks.length === 0) {
            return { block: allBlocks[0] || null, relTopPx: 0, offsetTop: 0, isEmptyDoc: true };
          }

          for (let i = 0; i < nonEmptyBlocks.length; i++) {
            const b = nonEmptyBlocks[i];
            const r = b.getBoundingClientRect();
            const nextB = nonEmptyBlocks[i + 1];
            const effectiveBottom = !nextB ? Math.max(r.bottom, initialFlowBottom) : r.bottom;
            const nextTop = nextB ? nextB.getBoundingClientRect().top : effectiveBottom + 48;
            const bottomLimit = nextB ? (r.bottom + nextTop) / 2 : effectiveBottom + 48;

            if (clientTopY < r.top) {
              return { block: b, relTopPx: 0, offsetTop: 0, isEmptyDoc: false };
            }
            if (clientTopY >= r.top && clientTopY <= bottomLimit) {
              const rawRelTop = Math.max(0, Math.round((clientTopY - r.top) / zoom));
              const snappedRelTop = rawRelTop < 4 ? 0 : rawRelTop;
              return { block: b, relTopPx: snappedRelTop, offsetTop: 0, isEmptyDoc: false };
            }
          }

          const last = nonEmptyBlocks[nonEmptyBlocks.length - 1];
          const lastRect = last.getBoundingClientRect();
          const effectiveLastBottom = Math.max(lastRect.bottom, initialFlowBottom);
          const pastBottom = Math.max(0, Math.round((clientTopY - effectiveLastBottom) / zoom));
          return {
            block: last,
            relTopPx: 0,
            offsetTop: pastBottom,
            isEmptyDoc: false,
          };
        };

        const onMove = (ev: MouseEvent) => {
          const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
          if (!dragging && dist < 4) return;
          if (!dragging) {
            dragging = true;
            stopDomObserver();
            container.classList.add("is-dragging");
            document.body.classList.add("is-dragging-image");
            container.setAttribute("data-wrap", isLockedOverlay ? detectedWrap : "free-front");
            container.style.width = `${boxW}px`;
            container.style.height = "";
            container.style.paddingTop = "";
            container.style.paddingLeft = "";
            container.style.paddingRight = "";
            container.style.marginLeft = "";
            container.style.marginRight = "";
            container.style.marginTop = "";
            container.style.marginBottom = "";
            container.style.shapeOutside = "";
            frame.style.width = `${boxW}px`;
            frame.style.margin = "";

            if (!isLockedOverlay) {
              wrapSpacer = document.createElement("span");
              wrapSpacer.className = "typo-image__wrap-spacer";
              wrapSpacer.setAttribute("contenteditable", "false");
            }
          }

          const dx = (ev.clientX - startX) / zoom;
          const dy = (ev.clientY - startY) / zoom;
          const maxLeft = Math.max(24, sheetEl.clientWidth - boxW - 12);
          const maxTop = Math.max(24, sheetEl.scrollHeight - boxH - 12);

          nextX = Math.round(Math.max(4, Math.min(maxLeft, initialLeft + dx)));
          nextY = Math.round(Math.max(4, Math.min(maxTop, initialTop + dy)));

          container.style.left = `${nextX}px`;
          container.style.top = `${nextY}px`;

          if (isLockedOverlay) {
            badge.textContent = `Overlay · X: ${nextX}px, Y: ${nextY}px`;
            return;
          }

          // --- InDesign Live Text-Wrap Calculation (1:1 parity with syncDOM on drop) ---
          const colLeft = Math.round((edRect.left - sheetRect.left) / zoom);
          const colWidth = Math.max(200, Math.round(edRect.width / zoom));
          const relCenterX = nextX + boxW / 2 - colLeft;
          const colCenterX = colWidth / 2;
          const maxHorizOffset = Math.max(0, colWidth - boxW);

          if (Math.abs(relCenterX - colCenterX) <= 18) {
            detectedWrap = "center";
            horizontalMarginOffset = 0;
          } else if (relCenterX < colCenterX) {
            detectedWrap = "wrap-left";
            horizontalMarginOffset = Math.max(0, Math.min(maxHorizOffset, nextX - colLeft));
          } else {
            detectedWrap = "wrap-right";
            const rightEdgeOffset = colLeft + colWidth - (nextX + boxW);
            horizontalMarginOffset = Math.max(0, Math.min(maxHorizOffset, rightEdgeOffset));
          }

          const photoScreenTop = startFrameRect.top + (ev.clientY - startY);
          const { block, relTopPx, offsetTop, isEmptyDoc } = findTargetBlock(photoScreenTop);
          targetBlockEl = block;
          lastRelTopPx = relTopPx;
          droppedOnEmptyCanvas = isEmptyDoc || offsetTop > 48;

          if (wrapSpacer && targetBlockEl && !droppedOnEmptyCanvas) {
            wrapSpacer.setAttribute("data-wrap", detectedWrap);
            if (detectedWrap === "center") {
              wrapSpacer.style.width = "100%";
              wrapSpacer.style.height = `${relTopPx + boxH}px`;
              wrapSpacer.style.float = "left";
              wrapSpacer.style.shapeOutside = `inset(${relTopPx}px 0px 0px 0px)`;
              wrapSpacer.style.marginTop = "0px";
              wrapSpacer.style.marginBottom = "12px";
              wrapSpacer.style.marginLeft = "0px";
              wrapSpacer.style.marginRight = "0px";
            } else {
              const horizPad = horizontalMarginOffset >= 2 ? horizontalMarginOffset : 0;
              wrapSpacer.style.float = detectedWrap === "wrap-left" ? "left" : "right";
              wrapSpacer.style.width = `${boxW + horizPad}px`;
              wrapSpacer.style.height = `${relTopPx + boxH}px`;
              wrapSpacer.style.shapeOutside = `inset(${relTopPx}px 0px 0px 0px round 6px)`;
              wrapSpacer.style.marginTop = "0px";
              wrapSpacer.style.marginBottom = "8px";
              wrapSpacer.style.marginLeft = detectedWrap === "wrap-right" ? "16px" : "0px";
              wrapSpacer.style.marginRight = detectedWrap === "wrap-left" ? "16px" : "0px";
            }
            if (targetBlockEl.firstChild !== wrapSpacer) {
              targetBlockEl.insertBefore(wrapSpacer, targetBlockEl.firstChild);
            }
          } else if (wrapSpacer && wrapSpacer.parentNode) {
            wrapSpacer.parentNode.removeChild(wrapSpacer);
          }

          const modeLabel = droppedOnEmptyCanvas
            ? `Free Position · X: ${nextX}px, Y: ${nextY}px`
            : detectedWrap === "wrap-left"
              ? "InDesign Wrap Right ◧"
              : detectedWrap === "wrap-right"
                ? "InDesign Wrap Left ◨"
                : "InDesign Part Text ⬒";
          badge.textContent = modeLabel;
          for (const b of toolbar.querySelectorAll<HTMLElement>("[data-wrap-btn]")) {
            b.classList.toggle("is-on", b.dataset.wrapBtn === (droppedOnEmptyCanvas ? "free-front" : detectedWrap));
          }
        };

        const onUp = () => {
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", onUp, true);
          if (wrapSpacer && wrapSpacer.parentNode) {
            wrapSpacer.parentNode.removeChild(wrapSpacer);
          }
          wrapSpacer = null;
          startDomObserver();

          if (!dragging) return;

          container.classList.remove("is-dragging");
          document.body.classList.remove("is-dragging-image");

          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos !== "number") return;

          if (isLockedOverlay || droppedOnEmptyCanvas) {
            const finalWrap: ImageWrapMode = isLockedOverlay ? detectedWrap : "free-front";
            const updatedAttrs = {
              ...currentNode.attrs,
              width: currentNode.attrs.width || boxW,
              height: currentNode.attrs.height || boxH,
              wrap: finalWrap,
              x: nextX,
              y: nextY,
            };
            const tr = editor.state.tr.setNodeMarkup(pos, undefined, updatedAttrs);
            try {
              tr.setSelection(NodeSelection.create(tr.doc, pos));
            } catch {
              // ignore
            }
            editor.view.dispatch(tr);
            currentNode = editor.state.doc.nodeAt(pos) || currentNode;
            syncDOM();
            scheduleLayout();
            return;
          }

          // Commit InDesign Text-Wrap Relocation to the start of targetBlockEl
          // using the exact same vertical (lastRelTopPx) & horizontal (horizontalMarginOffset) offsets as wrapSpacer
          const updatedAttrs = {
            ...currentNode.attrs,
            width: currentNode.attrs.width || boxW,
            height: currentNode.attrs.height || boxH,
            wrap: detectedWrap,
            overlayLock: false,
            x: detectedWrap === "center" ? null : horizontalMarginOffset >= 2 ? horizontalMarginOffset : null,
            y: lastRelTopPx > 0 ? lastRelTopPx : null,
          };

          const state = editor.state;
          let blockStartPos: number | null = null;

          if (targetBlockEl) {
            state.doc.descendants((n, nPos) => {
              if (blockStartPos !== null) return false;
              if (n.isTextblock && editor.view.nodeDOM(nPos) === targetBlockEl) {
                blockStartPos = nPos + 1;
                return false;
              }
              return true;
            });
            if (blockStartPos === null) {
              try {
                const domPos = editor.view.posAtDOM(targetBlockEl, 0);
                if (typeof domPos === "number" && domPos >= 0) {
                  const $p = state.doc.resolve(Math.max(0, Math.min(state.doc.content.size, domPos)));
                  blockStartPos = $p.parent.isTextblock ? $p.start() : domPos;
                }
              } catch {
                // fallback
              }
            }
          }

          const tr = state.tr;
          if (blockStartPos === null || blockStartPos === pos) {
            tr.setNodeMarkup(pos, undefined, updatedAttrs);
            try {
              tr.setSelection(NodeSelection.create(tr.doc, pos));
            } catch {
              // ignore
            }
            editor.view.dispatch(tr);
            currentNode = editor.state.doc.nodeAt(pos) || currentNode;
            syncDOM();
            scheduleLayout();
            return;
          }

          const newImgNode = state.schema.nodes.image.create(updatedAttrs);
          const $old = state.doc.resolve(pos);
          if (
            $old.parent.isTextblock &&
            $old.parent.childCount === 1 &&
            state.doc.childCount > 1 &&
            $old.start() !== blockStartPos
          ) {
            tr.delete($old.before(), $old.after());
          } else {
            tr.delete(pos, pos + currentNode.nodeSize);
          }
          const mappedInsertPos = tr.mapping.map(blockStartPos);
          tr.insert(mappedInsertPos, newImgNode);
          try {
            tr.setSelection(NodeSelection.create(tr.doc, mappedInsertPos));
          } catch {
            // ignore selection fallback
          }
          editor.view.dispatch(tr);
          scheduleLayout();
        };

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
      });

      syncDOM();

      return {
        dom: container,
        update: (updatedNode) => {
          if (updatedNode.type.name !== "image") return false;
          currentNode = updatedNode;
          syncDOM();
          return true;
        },
        selectNode: () => {
          container.classList.add("ProseMirror-selectednode");
        },
        deselectNode: () => {
          container.classList.remove("ProseMirror-selectednode");
        },
        stopEvent: (event) => {
          if (event.type === "contextmenu") return false;
          if (event.target instanceof HTMLElement && event.target.closest(".typo-image__bar, .typo-image__handle")) {
            return true;
          }
          return false;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

