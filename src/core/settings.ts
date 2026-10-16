/** Persistent user settings (stored as settings.json in the app config folder). */
import { native, type PageSettings } from "./native";
import { DEFAULT_THEME_ID } from "./themes";

export interface RecentFile { path: string; name: string; time: number }
export interface RecentProject { path: string; name: string; time: number }

export type PaperColorMode = "auto" | "white" | "sepia" | "mist" | "parchment" | "custom";
export type UiDensity = "compact" | "comfortable" | "spacious";
export type UiFontChoice = "system" | "inter" | "mono" | "serif" | "custom";
export type PaperTexture =
  | "smooth"
  | "parchment"
  | "linen"
  | "grain"
  | "cotton"
  | "vintage"
  | "lined"
  | "dots"
  | "blueprint"
  | "custom";
export type PaperShadow = "subtle" | "studio" | "deep";
export type ProofUnderlineStyle = "wavy" | "dotted" | "solid";
export type CanvasViewMode = "single" | "spread" | "web" | "booklet";
export type BackgroundPreset =
  | "none"
  | "custom"
  | "liquid-prism"
  | "forest-mist"
  | "alpine-lake"
  | "ocean-depths"
  | "aurora-sky"
  | "sakura-dusk";
export type BackgroundBlur = "none" | "soft" | "frosted";
export type BackgroundDim = "light" | "balanced" | "deep";

export interface CustomThemeColors {
  mode: "dark" | "light";
  chrome: string;
  ribbon: string;
  canvas: string;
  page: string;
  pageText: string;
  text: string;
  accent: string;
}

export interface SavedMarginPreset {
  id: string;
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CustomStickerItem {
  id: string;
  name: string;
  src: string;
}

export interface CustomSnippetItem {
  id: string;
  title: string;
  text: string;
}

export interface Settings {
  themeId: string;
  paperPreview: boolean;
  paperColor: PaperColorMode;
  customPaperColor: string;
  ribbonCollapsed: boolean;
  outlineOpen: boolean;
  wordGoal: number;
  zoom: number;
  defaultFont: string;
  defaultFontSize: number;
  defaultPage: PageSettings;
  spellcheck: boolean;
  hardwareAcceleration: boolean;
  customAccent: string;
  customThemeColors: CustomThemeColors;
  uiDensity: UiDensity;
  uiScale: number;
  uiFont: UiFontChoice;
  customUiFont: string;
  paperTexture: PaperTexture;
  customPaperTexturePath: string;
  paperShadow: PaperShadow;
  showRuler: boolean;
  rulerSymmetric: boolean;
  savedMarginPresets: SavedMarginPreset[];
  showMarginGuides: boolean;
  proofUnderlineStyle: ProofUnderlineStyle;
  canvasViewMode: CanvasViewMode;
  scratchpadOpen: boolean;
  scratchpadText: string;
  typewriterScroll: boolean;
  customStickers: CustomStickerItem[];
  customSnippets: CustomSnippetItem[];
  backgroundPreset: BackgroundPreset;
  customBackgroundPath: string;
  backgroundBlur: BackgroundBlur;
  backgroundDim: BackgroundDim;
  liquidGlassUi: boolean;
  userDictionary: string[];
  strictOfflinePrivacy: boolean;
  updateRepo: string;
  autoCheckUpdates: boolean;
  activeProjectFolder: string;
  projectSidebarOpen: boolean;
  recentProjects: RecentProject[];
  printColorMode: "color" | "bw";
  printBwWhitePaper: boolean;
  recent: RecentFile[];
  plugins: Record<string, boolean>;
}

export const DEFAULT_CUSTOM_THEME: CustomThemeColors = {
  mode: "dark",
  chrome: "#16161d",
  ribbon: "#1f1f29",
  canvas: "#111116",
  page: "#1b1b24",
  pageText: "#ececf4",
  text: "#f0f0f6",
  accent: "#b48ead",
};

export const DEFAULT_SETTINGS: Settings = {
  themeId: DEFAULT_THEME_ID,
  paperPreview: false,
  paperColor: "auto",
  customPaperColor: "#18222d",
  ribbonCollapsed: false,
  outlineOpen: false,
  wordGoal: 0,
  zoom: 1,
  defaultFont: "Calibri",
  defaultFontSize: 11,
  defaultPage: { size: "A4", orientation: "portrait", margins: { top: 1, right: 1, bottom: 1, left: 1 }, header: "", footer: "", pageNumbers: false },
  spellcheck: true,
  hardwareAcceleration: true,
  customAccent: "",
  customThemeColors: structuredClone(DEFAULT_CUSTOM_THEME),
  uiDensity: "comfortable",
  uiScale: 100,
  uiFont: "system",
  customUiFont: "",
  paperTexture: "smooth",
  customPaperTexturePath: "",
  paperShadow: "studio",
  showRuler: true,
  rulerSymmetric: true,
  savedMarginPresets: [],
  showMarginGuides: false,
  proofUnderlineStyle: "wavy",
  canvasViewMode: "single",
  scratchpadOpen: false,
  scratchpadText: "",
  typewriterScroll: false,
  customStickers: [],
  customSnippets: [
    { id: "sig", title: "Editorial Sign-off", text: "Respectfully submitted,\n— Lead Author" },
    { id: "conf", title: "Confidentiality Notice", text: "CONFIDENTIAL — For internal review and authorized distribution only." },
  ],
  backgroundPreset: "none",
  customBackgroundPath: "",
  backgroundBlur: "soft",
  backgroundDim: "balanced",
  liquidGlassUi: false,
  userDictionary: [],
  strictOfflinePrivacy: true,
  updateRepo: "Redlett/Typo-1.0.1",
  autoCheckUpdates: true,
  activeProjectFolder: "",
  projectSidebarOpen: false,
  recentProjects: [],
  printColorMode: "color",
  printBwWhitePaper: false,
  recent: [],
  plugins: {},
};

export const settings: Settings = structuredClone(DEFAULT_SETTINGS);

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = (await native.loadSettings()) as Partial<Settings> | null;
    if (raw && typeof raw === "object") {
      Object.assign(settings, DEFAULT_SETTINGS, raw);
      if (!settings.updateRepo) settings.updateRepo = DEFAULT_SETTINGS.updateRepo;
      if (!Array.isArray(settings.userDictionary)) settings.userDictionary = [];
      if (!Array.isArray(settings.savedMarginPresets)) settings.savedMarginPresets = [];
      if (!Array.isArray(settings.customStickers)) settings.customStickers = [];
      if (!Array.isArray(settings.recentProjects)) settings.recentProjects = [];
      if (!Array.isArray(settings.customSnippets)) settings.customSnippets = structuredClone(DEFAULT_SETTINGS.customSnippets);
      if (!settings.customThemeColors || typeof settings.customThemeColors !== "object") {
        settings.customThemeColors = structuredClone(DEFAULT_CUSTOM_THEME);
      } else {
        settings.customThemeColors = { ...DEFAULT_CUSTOM_THEME, ...settings.customThemeColors };
      }
      if (raw.paperPreview && !raw.paperColor) settings.paperColor = "white";
      if ((settings.paperColor as string) === "dark") settings.paperColor = "auto";
      if (settings.themeId === "mica-glass") settings.themeId = "liquid-glass";
    }
  } catch (e) {
    console.warn("settings load failed", e);
  }
  return settings;
}

let saveTimer: number | undefined;
/** Debounced so rapid UI changes (zoom slider) don't hammer the disk. */
export function saveSettings(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    native.saveSettings(settings).catch((e) => console.warn("settings save failed", e));
  }, 250);
}

export function pushRecent(path: string, name: string): void {
  settings.recent = [{ path, name, time: Date.now() }, ...settings.recent.filter((r) => r.path !== path)].slice(0, 15);
  saveSettings();
}

export function removeRecent(path: string): void {
  settings.recent = settings.recent.filter((r) => r.path !== path);
  saveSettings();
}

export function clearRecent(): void {
  settings.recent = [];
  saveSettings();
}

export function pushRecentProject(path: string, name: string): void {
  settings.recentProjects = [
    { path, name, time: Date.now() },
    ...settings.recentProjects.filter((p) => p.path.toLowerCase() !== path.toLowerCase()),
  ].slice(0, 20);
  saveSettings();
}

export function removeRecentProject(path: string): void {
  settings.recentProjects = settings.recentProjects.filter((p) => p.path.toLowerCase() !== path.toLowerCase());
  if (settings.activeProjectFolder.toLowerCase() === path.toLowerCase()) {
    settings.activeProjectFolder = "";
    settings.projectSidebarOpen = false;
  }
  saveSettings();
}
