/**
 * Theme engine. A theme is a flat set of colour tokens mapped onto CSS custom
 * properties. Built-in presets live here; user themes are JSON files in the
 * app's `themes/` folder and use exactly the same shape.
 */
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { native } from "./native";
import type {
  BackgroundBlur,
  BackgroundDim,
  BackgroundPreset,
  CustomThemeColors,
  PaperColorMode,
  PaperTexture,
} from "./settings";

export type ThemeMode = "dark" | "light";
export type Transparency = "none" | "mica" | "acrylic";

export interface ThemeColors {
  chrome: string;      // title bar + ribbon tab strip
  ribbon: string;      // ribbon body
  canvas: string;      // area behind the page
  page: string;        // the sheet of paper
  pageText: string;    // default ink on the page
  text: string;        // UI text
  textMuted: string;   // secondary UI text
  border: string;      // hairlines
  hover: string;       // hover wash
  active: string;      // pressed / toggled wash
  accent: string;      // signature colour
  accentStrong: string;
  accentText: string;  // text drawn on top of accent
  selection: string;   // text selection on the page
  input: string;       // input fields
  menu: string;        // popovers / dropdowns
  statusbar: string;
  shadow: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  transparency?: Transparency;
  /** Optional UI font override. */
  uiFont?: string;
  colors: ThemeColors;
  /** Set for themes loaded from disk. */
  source?: "builtin" | "user";
}

export const BUILTIN_THEMES: Theme[] = [
  {
    id: "office-graphite",
    name: "Office Graphite",
    mode: "dark",
    colors: {
      chrome: "#19191b",
      ribbon: "#242427",
      canvas: "#141416",
      page: "#202023",
      pageText: "#e6e6ea",
      text: "#ececf0",
      textMuted: "#9b9ba5",
      border: "rgba(255,255,255,0.08)",
      hover: "rgba(255,255,255,0.065)",
      active: "rgba(179,146,240,0.18)",
      accent: "#b392f0",
      accentStrong: "#9c77e6",
      accentText: "#170f24",
      selection: "rgba(179,146,240,0.32)",
      input: "#1b1b1e",
      menu: "#2a2a2e",
      statusbar: "#19191b",
      shadow: "rgba(0,0,0,0.5)",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    colors: {
      chrome: "#11111b",
      ribbon: "#181825",
      canvas: "#11111b",
      page: "#1e1e2e",
      pageText: "#cdd6f4",
      text: "#cdd6f4",
      textMuted: "#a6adc8",
      border: "rgba(205,214,244,0.09)",
      hover: "rgba(205,214,244,0.07)",
      active: "rgba(203,166,247,0.18)",
      accent: "#cba6f7",
      accentStrong: "#b48ef0",
      accentText: "#11111b",
      selection: "rgba(203,166,247,0.30)",
      input: "#1e1e2e",
      menu: "#24273a",
      statusbar: "#11111b",
      shadow: "rgba(0,0,0,0.55)",
    },
  },
  {
    id: "liquid-glass",
    name: "Liquid Glass",
    mode: "dark",
    transparency: "acrylic",
    colors: {
      chrome: "rgba(14, 20, 32, 0.38)",
      ribbon: "rgba(22, 30, 46, 0.44)",
      canvas: "rgba(10, 15, 26, 0.25)",
      page: "#182030",
      pageText: "#eef4fc",
      text: "#f0f6ff",
      textMuted: "#a8bbd4",
      border: "rgba(255, 255, 255, 0.16)",
      hover: "rgba(255, 255, 255, 0.11)",
      active: "rgba(103, 232, 249, 0.22)",
      accent: "#67e8f9",
      accentStrong: "#22d3ee",
      accentText: "#062028",
      selection: "rgba(103, 232, 249, 0.30)",
      input: "rgba(12, 18, 30, 0.48)",
      menu: "rgba(24, 32, 48, 0.88)",
      statusbar: "rgba(14, 20, 32, 0.42)",
      shadow: "rgba(0, 0, 0, 0.52)",
    },
  },
  {
    id: "evergreen-canopy",
    name: "Evergreen Canopy",
    mode: "dark",
    colors: {
      chrome: "#0d1612",
      ribbon: "#13211a",
      canvas: "#0a120e",
      page: "#16261e",
      pageText: "#e3f2e9",
      text: "#e6f4ec",
      textMuted: "#94b0a0",
      border: "rgba(163, 217, 185, 0.10)",
      hover: "rgba(163, 217, 185, 0.07)",
      active: "rgba(82, 183, 136, 0.20)",
      accent: "#52b788",
      accentStrong: "#40916c",
      accentText: "#071710",
      selection: "rgba(82, 183, 136, 0.30)",
      input: "#101c16",
      menu: "#192b22",
      statusbar: "#0d1612",
      shadow: "rgba(0, 0, 0, 0.56)",
    },
  },
  {
    id: "botanical-meadow",
    name: "Botanical Meadow",
    mode: "light",
    colors: {
      chrome: "#e3eee6",
      ribbon: "#f0f7f2",
      canvas: "#d8e6dc",
      page: "#fbfdf9",
      pageText: "#18281e",
      text: "#1b2e22",
      textMuted: "#567060",
      border: "rgba(24, 48, 34, 0.11)",
      hover: "rgba(45, 106, 79, 0.07)",
      active: "rgba(45, 106, 79, 0.15)",
      accent: "#2d6a4f",
      accentStrong: "#1b4332",
      accentText: "#ffffff",
      selection: "rgba(45, 106, 79, 0.22)",
      input: "#ffffff",
      menu: "#f9fcf9",
      statusbar: "#e3eee6",
      shadow: "rgba(16, 36, 24, 0.18)",
    },
  },
  {
    id: "oceanic-abyss",
    name: "Oceanic Abyss",
    mode: "dark",
    colors: {
      chrome: "#0a131f",
      ribbon: "#0f1d2e",
      canvas: "#070f19",
      page: "#132438",
      pageText: "#e2f1fc",
      text: "#e6f4ff",
      textMuted: "#8eaac4",
      border: "rgba(125, 211, 252, 0.10)",
      hover: "rgba(125, 211, 252, 0.07)",
      active: "rgba(56, 189, 248, 0.20)",
      accent: "#38bdf8",
      accentStrong: "#0284c7",
      accentText: "#051929",
      selection: "rgba(56, 189, 248, 0.30)",
      input: "#0c1826",
      menu: "#162940",
      statusbar: "#0a131f",
      shadow: "rgba(0, 0, 0, 0.58)",
    },
  },
  {
    id: "nordic-aurora",
    name: "Nordic Aurora",
    mode: "dark",
    colors: {
      chrome: "#121824",
      ribbon: "#192232",
      canvas: "#0e131d",
      page: "#1d283a",
      pageText: "#e5effa",
      text: "#eaf2fc",
      textMuted: "#95a7bf",
      border: "rgba(148, 197, 233, 0.10)",
      hover: "rgba(148, 197, 233, 0.07)",
      active: "rgba(79, 209, 197, 0.20)",
      accent: "#4fd1c5",
      accentStrong: "#319795",
      accentText: "#081c1b",
      selection: "rgba(79, 209, 197, 0.28)",
      input: "#151d2b",
      menu: "#212d42",
      statusbar: "#121824",
      shadow: "rgba(0, 0, 0, 0.54)",
    },
  },
  {
    id: "sakura-grove",
    name: "Sakura Grove",
    mode: "dark",
    colors: {
      chrome: "#181216",
      ribbon: "#221920",
      canvas: "#130e12",
      page: "#261c24",
      pageText: "#f5e6ee",
      text: "#f7eaf1",
      textMuted: "#b59aa8",
      border: "rgba(244, 143, 177, 0.10)",
      hover: "rgba(244, 143, 177, 0.07)",
      active: "rgba(244, 143, 177, 0.20)",
      accent: "#f48fb1",
      accentStrong: "#ec407a",
      accentText: "#240b14",
      selection: "rgba(244, 143, 177, 0.28)",
      input: "#1c141a",
      menu: "#2c2029",
      statusbar: "#181216",
      shadow: "rgba(0, 0, 0, 0.56)",
    },
  },
  {
    id: "desert-canyon",
    name: "Desert Canyon",
    mode: "dark",
    colors: {
      chrome: "#1a1310",
      ribbon: "#241b16",
      canvas: "#140e0c",
      page: "#281e18",
      pageText: "#f2e5dc",
      text: "#f5e9e0",
      textMuted: "#b59b8d",
      border: "rgba(231, 111, 81, 0.10)",
      hover: "rgba(231, 111, 81, 0.07)",
      active: "rgba(231, 111, 81, 0.20)",
      accent: "#e76f51",
      accentStrong: "#d65332",
      accentText: "#210c06",
      selection: "rgba(231, 111, 81, 0.28)",
      input: "#1e1612",
      menu: "#2f231d",
      statusbar: "#1a1310",
      shadow: "rgba(0, 0, 0, 0.56)",
    },
  },
  {
    id: "alpine-daylight",
    name: "Alpine Daylight",
    mode: "light",
    colors: {
      chrome: "#e6eef5",
      ribbon: "#f3f7fb",
      canvas: "#dce6f0",
      page: "#ffffff",
      pageText: "#16212b",
      text: "#182430",
      textMuted: "#5a6d80",
      border: "rgba(18, 42, 66, 0.10)",
      hover: "rgba(2, 132, 199, 0.06)",
      active: "rgba(2, 132, 199, 0.14)",
      accent: "#0284c7",
      accentStrong: "#0369a1",
      accentText: "#ffffff",
      selection: "rgba(2, 132, 199, 0.22)",
      input: "#ffffff",
      menu: "#ffffff",
      statusbar: "#e6eef5",
      shadow: "rgba(15, 35, 58, 0.17)",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    colors: {
      chrome: "#16161e",
      ribbon: "#1a1b26",
      canvas: "#13141c",
      page: "#1f2335",
      pageText: "#c0caf5",
      text: "#c0caf5",
      textMuted: "#7982a9",
      border: "rgba(192, 202, 245, 0.09)",
      hover: "rgba(192, 202, 245, 0.07)",
      active: "rgba(122, 162, 247, 0.20)",
      accent: "#7aa2f7",
      accentStrong: "#5d87e8",
      accentText: "#101524",
      selection: "rgba(122, 162, 247, 0.30)",
      input: "#16161e",
      menu: "#24283b",
      statusbar: "#16161e",
      shadow: "rgba(0, 0, 0, 0.56)",
    },
  },
  {
    id: "ink-ember",
    name: "Ink & Ember",
    mode: "dark",
    colors: {
      chrome: "#13110f",
      ribbon: "#1c1916",
      canvas: "#0f0d0b",
      page: "#1e1a16",
      pageText: "#eae1d4",
      text: "#ede5d9",
      textMuted: "#a69a89",
      border: "rgba(234,225,212,0.08)",
      hover: "rgba(234,225,212,0.06)",
      active: "rgba(224,164,88,0.18)",
      accent: "#e0a458",
      accentStrong: "#c98a3c",
      accentText: "#1a1208",
      selection: "rgba(224,164,88,0.28)",
      input: "#171411",
      menu: "#25211c",
      statusbar: "#13110f",
      shadow: "rgba(0,0,0,0.55)",
    },
  },
  {
    id: "paper-light",
    name: "Paper Light",
    mode: "light",
    colors: {
      chrome: "#ececef",
      ribbon: "#f8f8fa",
      canvas: "#e3e3e7",
      page: "#ffffff",
      pageText: "#1c1c1f",
      text: "#1e1e22",
      textMuted: "#6a6a73",
      border: "rgba(0,0,0,0.10)",
      hover: "rgba(0,0,0,0.05)",
      active: "rgba(123,79,214,0.14)",
      accent: "#7b4fd6",
      accentStrong: "#653cbf",
      accentText: "#ffffff",
      selection: "rgba(123,79,214,0.22)",
      input: "#ffffff",
      menu: "#ffffff",
      statusbar: "#ececef",
      shadow: "rgba(0,0,0,0.18)",
    },
  },
  {
    id: "graphite-monolith",
    name: "Graphite Monolith",
    mode: "dark",
    colors: {
      chrome: "#141414",
      ribbon: "#1d1d1d",
      canvas: "#0f0f0f",
      page: "#1a1a1a",
      pageText: "#e8e8e8",
      text: "#efefef",
      textMuted: "#969696",
      border: "rgba(255,255,255,0.09)",
      hover: "rgba(255,255,255,0.07)",
      active: "rgba(212,212,216,0.18)",
      accent: "#d4d4d8",
      accentStrong: "#a1a1aa",
      accentText: "#111111",
      selection: "rgba(212,212,216,0.28)",
      input: "#161616",
      menu: "#242424",
      statusbar: "#141414",
      shadow: "rgba(0,0,0,0.58)",
    },
  },
  {
    id: "silver-halide",
    name: "Silver Halide (Greytone)",
    mode: "light",
    colors: {
      chrome: "#d8dadf",
      ribbon: "#e6e8ec",
      canvas: "#cfd2d8",
      page: "#f7f8fa",
      pageText: "#18191b",
      text: "#1a1b1e",
      textMuted: "#5c6068",
      border: "rgba(0,0,0,0.12)",
      hover: "rgba(0,0,0,0.06)",
      active: "rgba(55,65,81,0.15)",
      accent: "#374151",
      accentStrong: "#1f2937",
      accentText: "#ffffff",
      selection: "rgba(55,65,81,0.22)",
      input: "#f3f4f6",
      menu: "#f9fafb",
      statusbar: "#d8dadf",
      shadow: "rgba(0,0,0,0.20)",
    },
  },
  {
    id: "alabaster-studio",
    name: "Alabaster Editorial",
    mode: "light",
    colors: {
      chrome: "#f2efe9",
      ribbon: "#faf8f5",
      canvas: "#e8e4dc",
      page: "#ffffff",
      pageText: "#1c1917",
      text: "#1c1917",
      textMuted: "#78716c",
      border: "rgba(28,25,23,0.10)",
      hover: "rgba(28,25,23,0.05)",
      active: "rgba(180,83,9,0.14)",
      accent: "#b45309",
      accentStrong: "#92400e",
      accentText: "#ffffff",
      selection: "rgba(180,83,9,0.20)",
      input: "#ffffff",
      menu: "#ffffff",
      statusbar: "#f2efe9",
      shadow: "rgba(28,25,23,0.15)",
    },
  },
  {
    id: "matcha-sage",
    name: "Matcha & Sage",
    mode: "light",
    colors: {
      chrome: "#dfe6dd",
      ribbon: "#eef3ec",
      canvas: "#d4ddd1",
      page: "#fafcf9",
      pageText: "#1d261d",
      text: "#1f291f",
      textMuted: "#5c6e5c",
      border: "rgba(31,41,31,0.11)",
      hover: "rgba(63,98,63,0.07)",
      active: "rgba(63,98,63,0.15)",
      accent: "#3f623f",
      accentStrong: "#2e482e",
      accentText: "#ffffff",
      selection: "rgba(63,98,63,0.22)",
      input: "#ffffff",
      menu: "#f8fbf7",
      statusbar: "#dfe6dd",
      shadow: "rgba(25,40,25,0.17)",
    },
  },
  {
    id: "solarized-daylight",
    name: "Solarized Daylight",
    mode: "light",
    colors: {
      chrome: "#eee8d5",
      ribbon: "#fdf6e3",
      canvas: "#e4decb",
      page: "#fdf6e3",
      pageText: "#073642",
      text: "#073642",
      textMuted: "#657b83",
      border: "rgba(7,54,66,0.12)",
      hover: "rgba(38,139,210,0.08)",
      active: "rgba(38,139,210,0.16)",
      accent: "#268bd2",
      accentStrong: "#1c6ca6",
      accentText: "#ffffff",
      selection: "rgba(38,139,210,0.22)",
      input: "#fffbf0",
      menu: "#fdf6e3",
      statusbar: "#eee8d5",
      shadow: "rgba(7,54,66,0.18)",
    },
  },
  {
    id: "custom-studio",
    name: "Custom Studio Palette",
    mode: "dark",
    colors: {
      chrome: "#16161d",
      ribbon: "#1f1f29",
      canvas: "#111116",
      page: "#1b1b24",
      pageText: "#ececf4",
      text: "#f0f0f6",
      textMuted: "#9898a8",
      border: "rgba(255,255,255,0.09)",
      hover: "rgba(255,255,255,0.07)",
      active: "rgba(180,142,173,0.20)",
      accent: "#b48ead",
      accentStrong: "#9c7395",
      accentText: "#140e13",
      selection: "rgba(180,142,173,0.30)",
      input: "#181820",
      menu: "#242430",
      statusbar: "#16161d",
      shadow: "rgba(0,0,0,0.55)",
    },
  },
];

export const DEFAULT_THEME_ID = "office-graphite";

const TOKEN_KEYS: (keyof ThemeColors)[] = [
  "chrome", "ribbon", "canvas", "page", "pageText", "text", "textMuted", "border", "hover",
  "active", "accent", "accentStrong", "accentText", "selection", "input", "menu", "statusbar", "shadow",
];

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

/** Validates a theme loaded from disk, filling gaps from the closest built-in. */
export function normalizeTheme(raw: unknown): Theme | string {
  if (!raw || typeof raw !== "object") return "not a JSON object";
  const r = raw as Record<string, unknown>;
  if ("_error" in r) return String(r._error);
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : null;
  if (!id || !name) return "missing \"id\" or \"name\"";
  const mode: ThemeMode = r.mode === "light" ? "light" : "dark";
  const base = BUILTIN_THEMES.find((t) => t.mode === mode)!;
  const colors = { ...base.colors };
  const rc = (r.colors ?? {}) as Record<string, unknown>;
  for (const k of TOKEN_KEYS) {
    const v = rc[k];
    if (typeof v === "string" && CSS.supports("color", v)) colors[k] = v;
  }
  const transparency: Transparency =
    r.transparency === "mica" || r.transparency === "acrylic" ? r.transparency : "none";
  return {
    id: "user:" + id,
    name,
    mode,
    transparency,
    uiFont: typeof r.uiFont === "string" ? r.uiFont : undefined,
    colors,
    source: "user",
  };
}

export const ACCENT_PRESETS: { id: string; label: string; color: string }[] = [
  { id: "", label: "Theme Default", color: "" },
  { id: "#b392f0", label: "Studio Violet", color: "#b392f0" },
  { id: "#cba6f7", label: "Catppuccin Mauve", color: "#cba6f7" },
  { id: "#67e8f9", label: "Liquid Cyan", color: "#67e8f9" },
  { id: "#52b788", label: "Forest Emerald", color: "#52b788" },
  { id: "#60a5fa", label: "Cobalt Blue", color: "#60a5fa" },
  { id: "#4fd1c5", label: "Nordic Teal", color: "#4fd1c5" },
  { id: "#e0a458", label: "Warm Amber", color: "#e0a458" },
  { id: "#f48fb1", label: "Sakura Blossom", color: "#f48fb1" },
  { id: "#e76f51", label: "Canyon Coral", color: "#e76f51" },
];

export const BACKDROP_PRESETS: { id: BackgroundPreset; label: string; badge?: string }[] = [
  { id: "none", label: "Theme Default" },
  { id: "liquid-prism", label: "Liquid Prism", badge: "Glass" },
  { id: "forest-mist", label: "Misty Pine Forest", badge: "Nature" },
  { id: "alpine-lake", label: "Alpine Lake Dawn", badge: "Nature" },
  { id: "ocean-depths", label: "Oceanic Reef", badge: "Nature" },
  { id: "aurora-sky", label: "Nordic Aurora", badge: "Nature" },
  { id: "sakura-dusk", label: "Sakura Twilight", badge: "Nature" },
  { id: "custom", label: "Custom Photo", badge: "Photo" },
];

const SCENIC_SVGS: Record<Exclude<BackgroundPreset, "none" | "custom">, string> = {
  "liquid-prism": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#07111e"/>
        <stop offset="45%" stop-color="#0f1f38"/>
        <stop offset="100%" stop-color="#091a26"/>
      </linearGradient>
      <radialGradient id="orb1" cx="22%" cy="24%" r="48%">
        <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.55"/>
        <stop offset="55%" stop-color="#0284c7" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#0284c7" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="orb2" cx="80%" cy="28%" r="46%">
        <stop offset="0%" stop-color="#a855f7" stop-opacity="0.48"/>
        <stop offset="55%" stop-color="#6366f1" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="orb3" cx="52%" cy="82%" r="50%">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.44"/>
        <stop offset="55%" stop-color="#0ea5e9" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#bg)"/>
    <circle cx="360" cy="240" r="680" fill="url(#orb1)"/>
    <circle cx="1260" cy="280" r="640" fill="url(#orb2)"/>
    <circle cx="840" cy="820" r="720" fill="url(#orb3)"/>
    <path d="M-100,620 C320,460 640,780 1080,540 C1340,400 1520,560 1720,480 L1720,1050 L-100,1050 Z" fill="rgba(255,255,255,0.035)"/>
    <path d="M-100,320 C260,500 760,160 1220,420 C1420,530 1580,380 1720,440" fill="none" stroke="rgba(103,232,249,0.22)" stroke-width="2.5"/>
  </svg>`,
  "forest-mist": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0c1c17"/>
        <stop offset="45%" stop-color="#1b3b30"/>
        <stop offset="80%" stop-color="#2d5a47"/>
        <stop offset="100%" stop-color="#0d1f18"/>
      </linearGradient>
      <radialGradient id="sun" cx="68%" cy="22%" r="42%">
        <stop offset="0%" stop-color="#a7f3d0" stop-opacity="0.38"/>
        <stop offset="50%" stop-color="#52b788" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#52b788" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#sky)"/>
    <circle cx="1080" cy="220" r="560" fill="url(#sun)"/>
    <path d="M0,560 L180,430 L340,520 L540,370 L760,510 L980,360 L1190,480 L1410,350 L1600,470 L1600,1000 L0,1000 Z" fill="#17352b" opacity="0.75"/>
    <rect y="500" width="1600" height="180" fill="rgba(209,250,229,0.08)"/>
    <path d="M0,670 L140,560 L290,640 L480,490 L690,630 L890,480 L1120,620 L1340,500 L1600,610 L1600,1000 L0,1000 Z" fill="#112820" opacity="0.9"/>
    <path d="M0,790 L110,700 L240,770 L390,660 L560,780 L740,650 L940,770 L1150,660 L1380,760 L1600,680 L1600,1000 L0,1000 Z" fill="#091712"/>
  </svg>`,
  "alpine-lake": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="asky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0f1e36"/>
        <stop offset="48%" stop-color="#1e4268"/>
        <stop offset="68%" stop-color="#4ea8de"/>
        <stop offset="100%" stop-color="#0b1d2e"/>
      </linearGradient>
      <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2b6b94"/>
        <stop offset="45%" stop-color="#163b5c"/>
        <stop offset="100%" stop-color="#091929"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="640" fill="url(#asky)"/>
    <circle cx="420" cy="240" r="95" fill="rgba(224,242,254,0.22)"/>
    <path d="M0,640 L210,360 L410,540 L670,260 L920,530 L1180,300 L1430,520 L1600,390 L1600,640 Z" fill="#183452"/>
    <path d="M670,260 L775,400 L690,385 L620,430 Z" fill="rgba(224,242,254,0.32)"/>
    <path d="M1180,300 L1270,420 L1190,400 L1130,440 Z" fill="rgba(224,242,254,0.28)"/>
    <rect y="640" width="1600" height="360" fill="url(#lake)"/>
    <path d="M0,640 L1600,640" stroke="rgba(186,230,253,0.35)" stroke-width="2"/>
  </svg>`,
  "ocean-depths": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#06283d"/>
        <stop offset="45%" stop-color="#081c30"/>
        <stop offset="100%" stop-color="#030b14"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="8%" r="65%">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
        <stop offset="55%" stop-color="#0284c7" stop-opacity="0.15"/>
        <stop offset="100%" stop-color="#0284c7" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#sea)"/>
    <circle cx="800" cy="60" r="820" fill="url(#glow)"/>
    <polygon points="350,0 520,0 780,1000 120,1000" fill="rgba(56,189,248,0.06)"/>
    <polygon points="720,0 920,0 1240,1000 580,1000" fill="rgba(103,232,249,0.05)"/>
    <polygon points="1080,0 1220,0 1560,1000 980,1000" fill="rgba(56,189,248,0.04)"/>
    <circle cx="340" cy="680" r="4" fill="#67e8f9" opacity="0.5"/>
    <circle cx="1180" cy="540" r="5" fill="#38bdf8" opacity="0.45"/>
    <circle cx="920" cy="760" r="3.5" fill="#67e8f9" opacity="0.55"/>
  </svg>`,
  "aurora-sky": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="nsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#070b14"/>
        <stop offset="55%" stop-color="#0f1b2d"/>
        <stop offset="100%" stop-color="#0b1520"/>
      </linearGradient>
      <linearGradient id="aur1" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0"/>
        <stop offset="30%" stop-color="#34d399" stop-opacity="0.42"/>
        <stop offset="65%" stop-color="#22d3ee" stop-opacity="0.38"/>
        <stop offset="100%" stop-color="#818cf8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#nsky)"/>
    <path d="M-100,280 Q420,80 860,260 T1700,180 L1700,480 Q1180,320 740,460 T-100,420 Z" fill="url(#aur1)"/>
    <path d="M-100,420 Q520,220 980,380 T1700,300 L1700,560 Q1120,440 680,560 T-100,520 Z" fill="url(#aur1)" opacity="0.65"/>
    <path d="M0,820 L220,640 L450,780 L740,580 L1040,770 L1320,610 L1600,760 L1600,1000 L0,1000 Z" fill="#09101a"/>
  </svg>`,
  "sakura-dusk": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="ssky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#160f1d"/>
        <stop offset="45%" stop-color="#331c36"/>
        <stop offset="78%" stop-color="#6e3556"/>
        <stop offset="100%" stop-color="#1c101b"/>
      </linearGradient>
      <radialGradient id="sglow" cx="72%" cy="34%" r="44%">
        <stop offset="0%" stop-color="#f48fb1" stop-opacity="0.42"/>
        <stop offset="60%" stop-color="#ce93d8" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#ce93d8" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1600" height="1000" fill="url(#ssky)"/>
    <circle cx="1140" cy="340" r="520" fill="url(#sglow)"/>
    <circle cx="1140" cy="340" r="88" fill="rgba(252,228,236,0.28)"/>
    <path d="M0,690 Q360,540 780,670 T1600,600 L1600,1000 L0,1000 Z" fill="#231324" opacity="0.85"/>
    <path d="M0,800 Q480,690 960,790 T1600,740 L1600,1000 L0,1000 Z" fill="#140b15"/>
  </svg>`,
};

function isLightHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.56;
}

let currentEffect: Transparency = "none";
let cachedCustomBgPath = "";
let cachedCustomBgUrl = "";
let cachedCustomPaperTexPath = "";
let cachedCustomPaperTexUrl = "";

export async function pickCustomBackgroundPhoto(): Promise<string | null> {
  const file = await openDialog({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (typeof file !== "string" || !file.trim()) return null;
  return file.trim();
}

export async function pickCustomPaperTexture(): Promise<string | null> {
  const file = await openDialog({
    multiple: false,
    filters: [{ name: "Paper Texture Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (typeof file !== "string" || !file.trim()) return null;
  return file.trim();
}

function ensureBackdropElement(): HTMLElement {
  let el = document.getElementById("app-backdrop");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-backdrop";
    el.setAttribute("aria-hidden", "true");
    const media = document.createElement("div");
    media.className = "app-backdrop__media";
    const veil = document.createElement("div");
    veil.className = "app-backdrop__veil";
    el.append(media, veil);
    const app = document.getElementById("app") ?? document.body;
    app.prepend(el);
  }
  return el;
}

export interface ThemeApplyOptions {
  paperPreview: boolean;
  paperColor?: PaperColorMode;
  customPaperColor?: string;
  customAccent?: string;
  customThemeColors?: CustomThemeColors;
  uiDensity?: "compact" | "comfortable" | "spacious";
  uiScale?: number;
  uiFont?: "system" | "inter" | "mono" | "serif" | "custom";
  customUiFont?: string;
  paperTexture?: PaperTexture;
  customPaperTexturePath?: string;
  paperShadow?: "subtle" | "studio" | "deep";
  showRuler?: boolean;
  showMarginGuides?: boolean;
  proofUnderlineStyle?: "wavy" | "dotted" | "solid";
  backgroundPreset?: BackgroundPreset;
  customBackgroundPath?: string;
  backgroundBlur?: BackgroundBlur;
  backgroundDim?: BackgroundDim;
  liquidGlassUi?: boolean;
}

export async function applyTheme(
  theme: Theme,
  opts: ThemeApplyOptions,
): Promise<void> {
  const root = document.documentElement;
  let effectiveMode: ThemeMode = theme.mode;
  const c = { ...theme.colors };

  // Dynamic Custom Studio Palette built from the live color pickers
  if (theme.id === "custom-studio" && opts.customThemeColors) {
    const ct = opts.customThemeColors;
    const isLight = isLightHex(ct.chrome);
    effectiveMode = isLight ? "light" : "dark";
    c.chrome = ct.chrome;
    c.ribbon = ct.ribbon;
    c.canvas = ct.canvas;
    c.page = ct.page;
    c.pageText = ct.pageText || (isLightHex(ct.page) ? "#18181b" : "#ececf4");
    c.text = ct.text || (isLight ? "#18181b" : "#f0f0f6");
    c.textMuted = `color-mix(in srgb, ${c.text} 62%, ${c.chrome})`;
    c.border = isLight ? "rgba(0,0,0,0.11)" : "rgba(255,255,255,0.10)";
    c.hover = isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.075)";
    c.accent = ct.accent;
    c.accentStrong = `color-mix(in srgb, ${ct.accent} 82%, #000)`;
    c.active = `color-mix(in srgb, ${ct.accent} 20%, transparent)`;
    c.selection = `color-mix(in srgb, ${ct.accent} 30%, transparent)`;
    c.accentText = isLightHex(ct.accent) ? "#12101a" : "#ffffff";
    c.input = `color-mix(in srgb, ${ct.chrome} 75%, ${ct.ribbon})`;
    c.menu = `color-mix(in srgb, ${ct.ribbon} 88%, ${isLight ? "#fff" : "#000"})`;
    c.statusbar = ct.chrome;
    c.shadow = isLight ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.56)";
    // Also keep the builtin card preview synchronized
    theme.mode = effectiveMode;
    Object.assign(theme.colors, c);
  }

  const mode = opts.paperColor ?? (opts.paperPreview ? "white" : "auto");
  let pageIsLight = effectiveMode === "light" || isLightHex(c.page);

  if (mode === "white" || opts.paperPreview) {
    c.page = "#ffffff";
    c.pageText = "#18181b";
    pageIsLight = true;
  } else if (mode === "sepia") {
    c.page = "#fbf7ee";
    c.pageText = "#241e16";
    pageIsLight = true;
  } else if (mode === "parchment" || (mode === "auto" && opts.paperTexture === "parchment")) {
    c.page = "#f2e2c4";
    c.pageText = "#2a1b0e";
    pageIsLight = true;
  } else if (mode === "mist") {
    c.page = "#e8eaed";
    c.pageText = "#1e2024";
    pageIsLight = true;
  } else if (mode === "custom") {
    const customHex = (opts.customPaperColor ?? "#18222d").trim();
    c.page = CSS.supports("color", customHex) ? customHex : "#18222d";
    pageIsLight = isLightHex(c.page);
    c.pageText = pageIsLight ? "#18181b" : "#e6e6ea";
  }

  const customAcc = (opts.customAccent ?? "").trim();
  if (customAcc && CSS.supports("color", customAcc)) {
    c.accent = customAcc;
    c.accentStrong = `color-mix(in srgb, ${customAcc} 84%, #000)`;
    c.active = `color-mix(in srgb, ${customAcc} 20%, transparent)`;
    c.selection = `color-mix(in srgb, ${customAcc} 30%, transparent)`;
    c.accentText = isLightHex(customAcc) ? "#12101a" : "#ffffff";
  }

  for (const k of TOKEN_KEYS) root.style.setProperty(`--${kebab(k)}`, c[k]);

  const fontChoice = opts.uiFont ?? "system";
  const customFontName = (opts.customUiFont ?? "").trim().replace(/^["']+|["']+$/g, "");
  let uiFontStack = "var(--ui-font-base)";
  if (fontChoice === "custom" && customFontName) {
    uiFontStack = `"${customFontName}", var(--ui-font-base)`;
  } else if (fontChoice === "inter") {
    uiFontStack = `"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
  } else if (fontChoice === "mono") {
    uiFontStack = `var(--mono-font)`;
  } else if (fontChoice === "serif") {
    uiFontStack = `"Georgia", "Cambria", "Times New Roman", serif`;
  } else if (theme.uiFont) {
    uiFontStack = `"${theme.uiFont}", var(--ui-font-base)`;
  }
  root.style.setProperty("--ui-font", uiFontStack);

  const rawScale = Number(opts.uiScale) || 100;
  const clampedScale = Math.max(75, Math.min(130, rawScale));
  root.style.setProperty("--ui-scale", String(clampedScale / 100));

  // Custom Paper Texture from PC
  let effectivePaperTexture: PaperTexture = opts.paperTexture ?? "smooth";
  const customTexPath = (opts.customPaperTexturePath ?? "").trim();
  if (effectivePaperTexture === "custom") {
    if (customTexPath) {
      if (cachedCustomPaperTexPath !== customTexPath || !cachedCustomPaperTexUrl) {
        try {
          cachedCustomPaperTexUrl = await native.readImage(customTexPath);
          cachedCustomPaperTexPath = customTexPath;
        } catch (e) {
          console.warn("Failed to load custom paper texture:", e);
          cachedCustomPaperTexUrl = "";
        }
      }
      if (cachedCustomPaperTexUrl) {
        root.style.setProperty("--custom-paper-tex", `url("${cachedCustomPaperTexUrl}")`);
      } else {
        effectivePaperTexture = "smooth";
        root.style.removeProperty("--custom-paper-tex");
      }
    } else {
      effectivePaperTexture = "smooth";
      root.style.removeProperty("--custom-paper-tex");
    }
  } else {
    root.style.removeProperty("--custom-paper-tex");
  }

  root.dataset.themeMode = effectiveMode;
  root.dataset.pageMode = pageIsLight ? "light" : "dark";
  root.dataset.paperColor = mode;
  root.dataset.density = opts.uiDensity ?? "comfortable";
  root.dataset.paperTexture = effectivePaperTexture;
  root.dataset.paperShadow = opts.paperShadow ?? "studio";
  root.dataset.ruler = opts.showRuler !== false ? "on" : "off";
  root.dataset.marginGuides = opts.showMarginGuides ? "on" : "off";
  root.dataset.proofStyle = opts.proofUnderlineStyle ?? "wavy";

  // Determine effective backdrop & Liquid Glass state
  const rawPreset: BackgroundPreset = opts.backgroundPreset ?? "none";
  const customPath = (opts.customBackgroundPath ?? "").trim();
  let effectivePreset: BackgroundPreset = rawPreset;
  if (rawPreset === "none" && theme.id === "liquid-glass") {
    effectivePreset = "liquid-prism";
  }
  if (effectivePreset === "custom" && !customPath) {
    effectivePreset = theme.id === "liquid-glass" ? "liquid-prism" : "none";
  }

  const backdropEl = ensureBackdropElement();
  const mediaEl = backdropEl.querySelector(".app-backdrop__media") as HTMLElement;

  if (effectivePreset === "custom" && customPath) {
    if (cachedCustomBgPath !== customPath || !cachedCustomBgUrl) {
      try {
        cachedCustomBgUrl = await native.readImage(customPath);
        cachedCustomBgPath = customPath;
      } catch (e) {
        console.warn("Failed to load custom background photo:", e);
        cachedCustomBgUrl = "";
      }
    }
    if (cachedCustomBgUrl) {
      mediaEl.innerHTML = "";
      mediaEl.style.backgroundImage = `url("${cachedCustomBgUrl}")`;
    } else {
      effectivePreset = theme.id === "liquid-glass" ? "liquid-prism" : "none";
    }
  }

  if (effectivePreset !== "custom" && effectivePreset !== "none") {
    mediaEl.style.backgroundImage = "none";
    const svg = SCENIC_SVGS[effectivePreset] ?? SCENIC_SVGS["liquid-prism"];
    if (mediaEl.dataset.scenic !== effectivePreset) {
      mediaEl.innerHTML = svg;
      mediaEl.dataset.scenic = effectivePreset;
    }
  } else if (effectivePreset === "none") {
    mediaEl.style.backgroundImage = "none";
    mediaEl.innerHTML = "";
    mediaEl.dataset.scenic = "";
  } else {
    mediaEl.dataset.scenic = "custom";
  }

  const isLiquidGlass =
    theme.id === "liquid-glass" ||
    theme.transparency === "acrylic" ||
    theme.transparency === "mica" ||
    Boolean(opts.liquidGlassUi) ||
    effectivePreset !== "none";

  root.dataset.backdrop = effectivePreset;
  root.dataset.bgBlur = opts.backgroundBlur ?? "soft";
  root.dataset.bgDim = opts.backgroundDim ?? "balanced";
  root.dataset.glass = isLiquidGlass ? "on" : "off";

  const transparency = theme.transparency ?? "none";
  root.dataset.transparency = transparency;

  // Native window material — only touch it when it changes.
  if (transparency !== currentEffect) {
    currentEffect = transparency;
    try {
      const win = getCurrentWindow();
      if (transparency === "none") await win.clearEffects();
      else await win.setEffects({ effects: [transparency === "mica" ? Effect.Mica : Effect.Acrylic] });
    } catch {
      /* effects unsupported on this OS build — our internal Liquid Glass engine renders regardless */
    }
  }
  try {
    await getCurrentWindow().setTheme(theme.mode === "light" ? "light" : "dark");
  } catch {
    /* ignore */
  }
}

/** Template written when the user clicks "New theme from current". */
export function themeToJson(theme: Theme, id: string, name: string): string {
  return JSON.stringify(
    { id, name, mode: theme.mode, transparency: theme.transparency ?? "none", colors: theme.colors },
    null,
    2,
  );
}
