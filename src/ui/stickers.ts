/**
 * Sticker Studio for Typo:
 * - 4 built-in vector SVG sticker packs (Cozy Cat & Gamer, Medieval & Dark Academia,
 *   Editorial & Washi Tape, Y2K & Cyber Charms)
 * - Custom Sticker Pack importer (+ Import Sticker from PC…)
 * - Drops stickers directly onto the current page in Free-Roam ("free-front") mode
 *   so they can be dragged, resized, and tilted anywhere on the sheet without moving text.
 */
import type { Editor } from "@tiptap/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, icon, toast } from "./dom";
import { native } from "../core/native";
import { settings, saveSettings } from "../core/settings";
import { scheduleLayout } from "../core/page";

export interface StickerDef {
  id: string;
  name: string;
  pack: "cozy" | "medieval" | "planner" | "cyber";
  width?: number;
  svg: string;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

export const BUILTIN_STICKERS: StickerDef[] = [
  // --- Pack 1: Cozy Cat & Gamer ---
  {
    id: "cozy-cat",
    name: "Smug Black Cat",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <circle cx="60" cy="62" r="46" fill="#2b2638" stroke="#fff" stroke-width="5"/>
      <polygon points="24,46 18,14 46,30" fill="#2b2638" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <polygon points="96,46 102,14 74,30" fill="#2b2638" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <polygon points="26,42 22,22 42,32" fill="#f48fb1"/>
      <polygon points="94,42 98,22 78,32" fill="#f48fb1"/>
      <ellipse cx="43" cy="60" rx="7" ry="8" fill="#ffd166"/>
      <ellipse cx="77" cy="60" rx="7" ry="8" fill="#ffd166"/>
      <ellipse cx="43" cy="60" rx="2.5" ry="6" fill="#16131d"/>
      <ellipse cx="77" cy="60" rx="2.5" ry="6" fill="#16131d"/>
      <polygon points="56,70 64,70 60,75" fill="#f48fb1"/>
      <path d="M48,78 Q54,84 60,77 Q66,84 72,78" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="32" cy="72" rx="6" ry="3.5" fill="#f48fb1" opacity="0.65"/>
      <ellipse cx="88" cy="72" rx="6" ry="3.5" fill="#f48fb1" opacity="0.65"/>
    </svg>`,
  },
  {
    id: "boba-tea",
    name: "Boba Milk Tea",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <rect x="54" y="10" width="12" height="34" rx="4" fill="#ff8fa3" stroke="#fff" stroke-width="4"/>
      <path d="M30,38 L90,38 L82,104 C81,109 76,112 70,112 L50,112 C44,112 39,109 38,104 Z" fill="#f3d5b5" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
      <ellipse cx="60" cy="38" rx="33" ry="8" fill="#fff0f3" stroke="#fff" stroke-width="4"/>
      <path d="M34,58 Q48,64 60,58 T86,58 L82,102 L38,102 Z" fill="#d4a373"/>
      <circle cx="46" cy="94" r="5" fill="#2b1d14"/><circle cx="60" cy="96" r="5" fill="#2b1d14"/><circle cx="73" cy="93" r="5" fill="#2b1d14"/>
      <circle cx="52" cy="84" r="5" fill="#2b1d14"/><circle cx="67" cy="85" r="5" fill="#2b1d14"/>
      <circle cx="48" cy="68" r="3" fill="#2b1d14"/><circle cx="72" cy="68" r="3" fill="#2b1d14"/>
      <path d="M56,71 Q60,75 64,71" fill="none" stroke="#2b1d14" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: "gamer-pad",
    name: "Retro Gamepad",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M26,42 L94,42 C106,42 112,56 108,76 L102,94 C98,104 86,104 80,94 L72,82 L48,82 L40,94 C34,104 22,104 18,94 L12,76 C8,56 14,42 26,42 Z" fill="#7aa2f7" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
      <path d="M36,54 L36,70 M28,62 L44,62" stroke="#1a1b26" stroke-width="5" stroke-linecap="round"/>
      <circle cx="86" cy="56" r="5" fill="#f7768e"/>
      <circle cx="76" cy="66" r="5" fill="#ff9e64"/>
      <circle cx="94" cy="66" r="5" fill="#9ece6a"/>
      <circle cx="85" cy="75" r="5" fill="#e0af68"/>
    </svg>`,
  },
  {
    id: "coffee-mug",
    name: "Late Night Espresso",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M78,52 L92,52 C101,52 104,60 104,68 C104,76 100,84 91,84 L78,84" fill="none" stroke="#cba6f7" stroke-width="8" stroke-linecap="round"/>
      <rect x="24" y="42" width="58" height="56" rx="14" fill="#cba6f7" stroke="#fff" stroke-width="5"/>
      <ellipse cx="53" cy="44" rx="26" ry="7" fill="#4a2c18"/>
      <path d="M40,28 Q44,18 40,12 M54,26 Q58,16 54,10 M66,28 Q70,18 66,12" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M44,68 L48,72 L44,76 M62,68 L58,72 L62,76" fill="none" stroke="#1e1e2e" stroke-width="3" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: "pixel-heart",
    name: "8-Bit Heart Charm",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M60,102 L22,64 C8,50 12,26 32,22 C44,20 54,28 60,38 C66,28 76,20 88,22 C108,26 112,50 98,64 Z" fill="#f43f5e" stroke="#fff" stroke-width="6" stroke-linejoin="round"/>
      <path d="M32,34 C26,38 24,46 28,52" fill="none" stroke="#fda4af" stroke-width="5" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: "sparkles-badge",
    name: "Starlight Sparkles",
    pack: "cozy",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M60,10 L70,46 L106,56 L70,66 L60,102 L50,66 L14,56 L50,46 Z" fill="#ffd166" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <path d="M92,16 L96,28 L108,32 L96,36 L92,48 L88,36 L76,32 L88,28 Z" fill="#f48fb1" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M28,74 L31,84 L41,87 L31,90 L28,100 L25,90 L15,87 L25,84 Z" fill="#67e8f9" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
    </svg>`,
  },

  // --- Pack 2: Medieval & Dark Academia ---
  {
    id: "crimson-wax-seal",
    name: "Crimson Wax Seal",
    pack: "medieval",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M60,8 C74,6 82,16 94,22 C106,28 114,42 110,58 C108,72 112,86 100,96 C88,106 76,112 60,112 C44,112 30,108 20,96 C10,84 8,70 10,56 C12,42 18,28 30,20 C42,12 48,10 60,8 Z" fill="#8b1e24" stroke="#590d12" stroke-width="3"/>
      <circle cx="60" cy="60" r="34" fill="#721419" stroke="#b83239" stroke-width="2.5"/>
      <circle cx="60" cy="60" r="29" fill="none" stroke="#d4af37" stroke-width="1.5" stroke-dasharray="3 3"/>
      <path d="M60,38 L66,52 L82,54 L70,64 L74,80 L60,71 L46,80 L50,64 L38,54 L54,52 Z" fill="#d4af37"/>
    </svg>`,
  },
  {
    id: "royal-gold-seal",
    name: "Guild Gold Crest",
    pack: "medieval",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M24,18 L96,18 L96,62 C96,88 60,106 60,106 C60,106 24,88 24,62 Z" fill="#1e293b" stroke="#d4af37" stroke-width="5" stroke-linejoin="round"/>
      <path d="M32,26 L88,26 L88,60 C88,80 60,96 60,96 C60,96 32,80 32,60 Z" fill="none" stroke="#eab308" stroke-width="1.5"/>
      <path d="M60,34 L68,52 L86,52 L72,62 L77,80 L60,69 L43,80 L48,62 L34,52 L52,52 Z" fill="#eab308"/>
    </svg>`,
  },
  {
    id: "quill-ink",
    name: "Feather Quill & Ink",
    pack: "medieval",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M98,14 C72,18 46,42 36,78 L24,104 L30,106 L44,82 C72,74 96,46 98,14 Z" fill="#f5ebe0" stroke="#4a3525" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M96,16 L26,104" stroke="#4a3525" stroke-width="2.5"/>
      <rect x="18" y="84" width="34" height="24" rx="4" fill="#2b2118" stroke="#d4af37" stroke-width="2.5"/>
      <rect x="24" y="78" width="22" height="7" rx="2" fill="#d4af37"/>
    </svg>`,
  },
  {
    id: "botanical-fern",
    name: "Pressed Botanical Leaf",
    pack: "medieval",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M24,100 Q56,60 94,18" fill="none" stroke="#3f623f" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="44" cy="72" rx="16" ry="7" transform="rotate(-35 44 72)" fill="#527952"/>
      <ellipse cx="62" cy="52" rx="16" ry="7" transform="rotate(-35 62 52)" fill="#527952"/>
      <ellipse cx="78" cy="34" rx="14" ry="6" transform="rotate(-35 78 34)" fill="#659165"/>
      <ellipse cx="54" cy="82" rx="16" ry="7" transform="rotate(-15 54 82)" fill="#3f623f"/>
      <ellipse cx="72" cy="62" rx="16" ry="7" transform="rotate(-15 72 62)" fill="#3f623f"/>
      <ellipse cx="88" cy="42" rx="13" ry="6" transform="rotate(-15 88 42)" fill="#527952"/>
    </svg>`,
  },
  {
    id: "crescent-alchemical",
    name: "Celestial Moon & Stars",
    pack: "medieval",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M74,18 C46,20 26,42 26,68 C26,94 48,110 76,106 C56,98 46,82 46,62 C46,42 58,26 74,18 Z" fill="#eab308" stroke="#713f12" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="86,36 89,44 98,47 89,50 86,58 83,50 74,47 83,44" fill="#eab308"/>
      <polygon points="72,68 74,73 80,75 74,77 72,82 70,77 64,75 70,73" fill="#eab308"/>
    </svg>`,
  },
  {
    id: "scroll-banner",
    name: "Parchment Ribbon",
    pack: "medieval",
    width: 150,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 70">
      <path d="M18,18 L162,18 L150,35 L162,52 L18,52 L30,35 Z" fill="#f2e2c4" stroke="#5c4028" stroke-width="3.5" stroke-linejoin="round"/>
      <line x1="38" y1="26" x2="142" y2="26" stroke="#8c6849" stroke-width="1.5" stroke-dasharray="4 3"/>
      <line x1="38" y1="44" x2="142" y2="44" stroke="#8c6849" stroke-width="1.5" stroke-dasharray="4 3"/>
    </svg>`,
  },

  // --- Pack 3: Editorial & Planner Washi ---
  {
    id: "washi-gold",
    name: "Gold Foil Washi Tape",
    pack: "planner",
    width: 140,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 54">
      <path d="M8,8 L172,8 L168,18 L174,27 L167,36 L172,46 L8,46 L13,36 L6,27 L12,18 Z" fill="#f3d5b5" opacity="0.92" stroke="#d4a373" stroke-width="2"/>
      <circle cx="36" cy="27" r="4" fill="#d4af37"/><circle cx="68" cy="27" r="4" fill="#d4af37"/><circle cx="100" cy="27" r="4" fill="#d4af37"/><circle cx="132" cy="27" r="4" fill="#d4af37"/>
    </svg>`,
  },
  {
    id: "washi-plaid",
    name: "Pastel Grid Washi Tape",
    pack: "planner",
    width: 140,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 54">
      <path d="M8,8 L172,8 L168,18 L174,27 L167,36 L172,46 L8,46 L13,36 L6,27 L12,18 Z" fill="#fbcfe8" opacity="0.9" stroke="#f472b6" stroke-width="2"/>
      <line x1="12" y1="20" x2="168" y2="20" stroke="#f472b6" stroke-width="2" opacity="0.5"/>
      <line x1="12" y1="34" x2="168" y2="34" stroke="#f472b6" stroke-width="2" opacity="0.5"/>
      <line x1="45" y1="8" x2="45" y2="46" stroke="#f472b6" stroke-width="2" opacity="0.5"/>
      <line x1="90" y1="8" x2="90" y2="46" stroke="#f472b6" stroke-width="2" opacity="0.5"/>
      <line x1="135" y1="8" x2="135" y2="46" stroke="#f472b6" stroke-width="2" opacity="0.5"/>
    </svg>`,
  },
  {
    id: "stamp-approved",
    name: "APPROVED Ink Stamp",
    pack: "planner",
    width: 136,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 72">
      <rect x="8" y="8" width="164" height="56" rx="8" fill="none" stroke="#10b981" stroke-width="5"/>
      <rect x="14" y="14" width="152" height="44" rx="4" fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="6 3"/>
      <text x="90" y="44" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="24" letter-spacing="3" fill="#10b981">APPROVED</text>
    </svg>`,
  },
  {
    id: "stamp-top-secret",
    name: "TOP SECRET Stamp",
    pack: "planner",
    width: 136,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 72">
      <rect x="8" y="8" width="164" height="56" rx="8" fill="none" stroke="#ef4444" stroke-width="5"/>
      <rect x="14" y="14" width="152" height="44" rx="4" fill="none" stroke="#ef4444" stroke-width="2" stroke-dasharray="6 3"/>
      <text x="90" y="44" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="22" letter-spacing="2.5" fill="#ef4444">TOP SECRET</text>
    </svg>`,
  },
  {
    id: "sticky-note-pin",
    name: "Pinned Sticky Note",
    pack: "planner",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M18,22 L102,22 L102,84 L82,104 L18,104 Z" fill="#fef08a" stroke="#eab308" stroke-width="3" stroke-linejoin="round"/>
      <path d="M82,104 L82,84 L102,84 Z" fill="#fde047" stroke="#eab308" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="60" cy="20" r="8" fill="#ef4444" stroke="#fff" stroke-width="2"/>
      <line x1="32" y1="48" x2="88" y2="48" stroke="#a16207" stroke-width="3" stroke-linecap="round"/>
      <line x1="32" y1="64" x2="84" y2="64" stroke="#a16207" stroke-width="3" stroke-linecap="round"/>
      <line x1="32" y1="80" x2="68" y2="80" stroke="#a16207" stroke-width="3" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: "check-seal",
    name: "Verified Ribbon Badge",
    pack: "planner",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="44" fill="#3b82f6" stroke="#fff" stroke-width="5"/>
      <path d="M40,60 L54,74 L82,46" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  },

  // --- Pack 4: Y2K & Cyber Charms ---
  {
    id: "holo-star",
    name: "Y2K Chrome Star",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <defs>
        <linearGradient id="holo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#67e8f9"/>
          <stop offset="50%" stop-color="#c084fc"/>
          <stop offset="100%" stop-color="#f472b6"/>
        </linearGradient>
      </defs>
      <polygon points="60,8 73,42 110,45 81,69 90,105 60,85 30,105 39,69 10,45 47,42" fill="url(#holo)" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
    </svg>`,
  },
  {
    id: "retro-floppy",
    name: "3.5″ Floppy Disk",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <path d="M18,16 L88,16 L104,32 L104,104 L18,104 Z" fill="#6366f1" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
      <rect x="34" y="16" width="44" height="30" rx="3" fill="#e2e8f0"/>
      <rect x="62" y="21" width="10" height="20" rx="2" fill="#334155"/>
      <rect x="28" y="60" width="64" height="44" rx="4" fill="#fff"/>
      <line x1="36" y1="74" x2="84" y2="74" stroke="#94a3b8" stroke-width="3"/>
      <line x1="36" y1="86" x2="84" y2="86" stroke="#94a3b8" stroke-width="3"/>
    </svg>`,
  },
  {
    id: "cyber-planet",
    name: "Neon Ringed Planet",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="32" fill="#a855f7" stroke="#fff" stroke-width="4"/>
      <ellipse cx="60" cy="60" rx="52" ry="15" transform="rotate(-22 60 60)" fill="none" stroke="#67e8f9" stroke-width="6"/>
    </svg>`,
  },
  {
    id: "sakura-blossom",
    name: "Sakura Petal Charm",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <circle cx="60" cy="30" r="20" fill="#fbcfe8" stroke="#f472b6" stroke-width="3"/>
      <circle cx="88" cy="50" r="20" fill="#fbcfe8" stroke="#f472b6" stroke-width="3"/>
      <circle cx="78" cy="84" r="20" fill="#fbcfe8" stroke="#f472b6" stroke-width="3"/>
      <circle cx="42" cy="84" r="20" fill="#fbcfe8" stroke="#f472b6" stroke-width="3"/>
      <circle cx="32" cy="50" r="20" fill="#fbcfe8" stroke="#f472b6" stroke-width="3"/>
      <circle cx="60" cy="60" r="12" fill="#fde047"/>
    </svg>`,
  },
  {
    id: "lightning-bolt",
    name: "High Voltage Bolt",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <polygon points="68,10 24,66 56,66 46,110 96,50 62,50" fill="#facc15" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
    </svg>`,
  },
  {
    id: "crystal-gem",
    name: "Arcane Mana Crystal",
    pack: "cyber",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <polygon points="60,10 92,38 78,106 42,106 28,38" fill="#38bdf8" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
      <polygon points="60,10 74,40 60,106 46,40" fill="#bae6fd" opacity="0.65"/>
    </svg>`,
  },
];

export function insertStickerOnPage(
  editor: Editor,
  src: string,
  name: string,
  width = 92,
): void {
  const sheet = document.getElementById("sheet");
  const canvas = document.getElementById("canvas");
  const zoom = parseFloat(sheet?.style.getPropertyValue("zoom") || "1") || 1;
  let x = 480;
  let y = 140;
  if (sheet && canvas) {
    const sRect = sheet.getBoundingClientRect();
    const cRect = canvas.getBoundingClientRect();
    const visibleTop = Math.max(40, (cRect.top - sRect.top) / zoom + 90);
    x = Math.round(Math.max(60, Math.min(sheet.clientWidth - width - 40, sheet.clientWidth * 0.68 + (Math.random() * 40 - 20))));
    y = Math.round(visibleTop + (Math.random() * 40 - 20));
  }

  editor
    .chain()
    .focus()
    .insertContent({
      type: "image",
      attrs: {
        src,
        alt: name,
        title: `${name} (Drag anywhere on page)`,
        width,
        wrap: "free-front",
        x,
        y,
        rotate: 0,
        sticker: true,
      },
    })
    .run();

  scheduleLayout();
  toast(`Placed "${name}" sticker — drag anywhere on the page!`, "success", 2000);
}

export async function importCustomStickerFromPc(onImported?: () => void): Promise<void> {
  const file = await openDialog({
    multiple: false,
    filters: [{ name: "Sticker Images", extensions: ["png", "svg", "webp", "gif", "jpg", "jpeg"] }],
  });
  if (typeof file !== "string" || !file.trim()) return;
  try {
    const dataUrl = await native.readImage(file.trim());
    const baseName = file
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || "Custom Sticker";
    if (!Array.isArray(settings.customStickers)) settings.customStickers = [];
    settings.customStickers.unshift({
      id: "stk-" + Date.now(),
      name: baseName,
      src: dataUrl,
    });
    saveSettings();
    onImported?.();
    toast(`Added "${baseName}" to My Stickers pack`, "success", 1800);
  } catch (e) {
    toast(`Could not load sticker image: ${e}`, "error", 3000);
  }
}

export function openStickerStudioModal(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".sticker-scrim")?.remove();

  type PackFilter = "all" | "cozy" | "medieval" | "planner" | "cyber" | "custom";
  let activePack: PackFilter = "all";

  const close = () => {
    scrim.remove();
    editor.commands.focus();
  };

  const tabsHost = h("div", { class: "studio-tabs", style: { marginBottom: "12px" } });
  const gridHost = h("div", { class: "sticker-grid" });

  const packs: { id: PackFilter; label: string }[] = [
    { id: "all", label: "All Packs" },
    { id: "cozy", label: "Cozy Cat & Gamer" },
    { id: "medieval", label: "Medieval & Wax Seals" },
    { id: "planner", label: "Washi & Stamps" },
    { id: "cyber", label: "Y2K & Charms" },
    { id: "custom", label: "My Stickers" },
  ];

  const renderContent = () => {
    tabsHost.replaceChildren(
      ...packs.map((p) =>
        h(
          "button",
          {
            type: "button",
            class: "studio-tab" + (activePack === p.id ? " is-active" : ""),
            onclick: () => {
              activePack = p.id;
              renderContent();
            },
          },
          p.label,
          p.id === "custom" && settings.customStickers?.length
            ? h("span", { class: "studio-tab__badge" }, String(settings.customStickers.length))
            : null,
        ),
      ),
    );

    gridHost.replaceChildren();

    const customItems = settings.customStickers || [];
    if (activePack === "custom" || activePack === "all") {
      for (const cs of customItems) {
        const card = h(
          "div",
          { class: "sticker-card" },
          h(
            "button",
            {
              type: "button",
              class: "sticker-card__main",
              onclick: () => {
                insertStickerOnPage(editor, cs.src, cs.name, 96);
                close();
              },
            },
            h("img", { src: cs.src, alt: cs.name, class: "sticker-card__img" }),
            h("span", { class: "sticker-card__name" }, cs.name),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sticker-card__del",
              "data-tip": "Remove from My Stickers",
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                settings.customStickers = settings.customStickers.filter((x) => x.id !== cs.id);
                saveSettings();
                renderContent();
              },
            },
            "×",
          ),
        );
        gridHost.append(card);
      }
    }

    if (activePack !== "custom") {
      const filtered = BUILTIN_STICKERS.filter((s) => activePack === "all" || s.pack === activePack);
      for (const s of filtered) {
        const url = svgToDataUrl(s.svg);
        const card = h(
          "button",
          {
            type: "button",
            class: "sticker-card sticker-card--btn",
            onclick: () => {
              insertStickerOnPage(editor, url, s.name, s.width || 92);
              close();
            },
          },
          h("img", { src: url, alt: s.name, class: "sticker-card__img" }),
          h("span", { class: "sticker-card__name" }, s.name),
        );
        gridHost.append(card);
      }
    }

    if (activePack === "custom" && customItems.length === 0) {
      gridHost.append(
        h(
          "div",
          { style: { gridColumn: "1 / -1", padding: "24px", textAlign: "center", color: "var(--text-muted)" } },
          "No custom stickers imported yet. Click '+ Import Sticker from PC…' below to add any transparent PNG, SVG, WebP, or GIF!",
        ),
      );
    }
  };

  renderContent();

  const scrim = h(
    "div",
    {
      class: "scrim sticker-scrim",
      onmousedown: (e: MouseEvent) => {
        if (e.target === scrim) close();
      },
    },
    h(
      "div",
      { class: "modal sticker-modal" },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          icon("Sparkles", 18),
          h("h2", { class: "modal__title", style: { margin: "0" } }, "Sticker Studio & Packs"),
        ),
        h("button", { type: "button", class: "ibtn", onclick: close }, icon("X", 16)),
      ),
      h(
        "p",
        { style: { margin: "0 0 10px", fontSize: "12px", color: "var(--text-muted)" } },
        "Click any sticker to place it on your page. Drag onto paragraphs to automatically part and wrap text (InDesign Runaround), drag to blank space for Free-Roam, or click ❐ Overlay on its toolbar to float over text.",
      ),
      tabsHost,
      gridHost,
      h(
        "div",
        { class: "modal__actions", style: { justifyContent: "space-between", marginTop: "14px" } },
        h(
          "button",
          {
            type: "button",
            class: "btn",
            onclick: () =>
              void importCustomStickerFromPc(() => {
                activePack = "custom";
                renderContent();
              }),
          },
          icon("ImagePlus", 14),
          "+ Import Sticker from PC…",
        ),
        h("button", { type: "button", class: "btn btn--primary", onclick: close }, "Close"),
      ),
    ),
  );

  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}
