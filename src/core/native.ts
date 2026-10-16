/** Typed wrappers around the Rust commands. */
import { invoke } from "@tauri-apps/api/core";

export interface Margins { top: number; right: number; bottom: number; left: number }
export type PageSizeName = "A4" | "Letter" | "Legal" | "A5" | "Executive";
export type PageBorderStyle = "none" | "thin" | "double" | "accent";
export interface PageSettings {
  size: PageSizeName;
  orientation: "portrait" | "landscape";
  margins: Margins;
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
  differentFirstPage?: boolean;
  columns?: number;
  columnRule?: boolean;
  watermark?: string;
  pageBorder?: PageBorderStyle;
  hyphenation?: boolean;
  baselineGrid?: boolean;
}
export interface DocDefaults { fontFamily: string; fontSize: number }
export interface ImportedDocx { doc: any; page: PageSettings; defaults: DocDefaults }
export interface OpenedDocument {
  path: string;
  name: string;
  kind: "docx" | "epub" | "pdf" | "html" | "md" | "txt";
  docx?: ImportedDocx | null;
  text?: string | null;
}
export interface PdfPageBlock {
  id: string;
  kind: "heading1" | "heading2" | "heading3" | "paragraph" | "image";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right" | "justify";
  bgColor?: string;
  color: string;
  imageSrc?: string;
  originalText?: string;
  originalX?: number;
  originalY?: number;
  originalWidth?: number;
  originalHeight?: number;
  bgPatchColor?: string;
}
export interface PdfDeletedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}
export interface PdfInkPoint {
  x: number;
  y: number;
}
export interface PdfAnnotation {
  id: string;
  kind: "textbox" | "highlight" | "stamp" | "ink" | "image" | "whiteout" | "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  bgColor?: string;
  fontFamily?: string;
  fontSize: number;
  bold: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right" | "justify";
  stampType?: string;
  imageSrc?: string;
  points: PdfInkPoint[];
  strokeWidth: number;
}
export interface PdfEditorPage {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  blocks: PdfPageBlock[];
  annotations: PdfAnnotation[];
  backgroundImage?: string;
  cleanBackgroundImage?: string;
  deletedRects?: PdfDeletedRect[];
}
export interface ParsedPdfDocument {
  path: string;
  name: string;
  pageCount: number;
  pages: PdfEditorPage[];
  docx: ImportedDocx;
  pdfBase64?: string;
}
export interface AppPaths { config: string; themes: string; plugins: string }
export interface PluginBundle { folder: string; manifest: any; code?: string | null; error?: string | null }
export interface NativeSpellError { word: string; suggestions: string[] }
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseNotes: string;
  downloadUrl: string;
  htmlUrl: string;
  assetName: string;
}

export const native = {
  appPaths: () => invoke<AppPaths>("app_paths"),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  loadSettings: () => invoke<unknown>("load_settings"),
  saveSettings: (settings: unknown) => invoke<void>("save_settings", { settings }),
  listFonts: () => invoke<string[]>("list_fonts"),
  openDocument: (path: string) => invoke<OpenedDocument>("open_document", { path }),
  saveDocx: (path: string, doc: unknown, page: PageSettings, defaults: DocDefaults, title: string) =>
    invoke<void>("save_docx", { path, doc, page, defaults, title }),
  saveEpub: (path: string, doc: unknown, page: PageSettings, defaults: DocDefaults, title: string, author?: string) =>
    invoke<void>("save_epub", { path, doc, page, defaults, title, author }),
  exportPdf: (path: string, doc: unknown, page: PageSettings, defaults: DocDefaults, title: string, html?: string) =>
    invoke<boolean>("export_pdf", { path, doc, page, defaults, title, html }),
  parsePdfFile: (path: string) => invoke<ParsedPdfDocument>("parse_pdf_file", { path }),
  convertPdfToDocx: (pdfPath: string, docxPath: string) =>
    invoke<ParsedPdfDocument>("convert_pdf_to_docx", { pdfPath, docxPath }),
  saveEditedPdf: (path: string, pages: PdfEditorPage[]) =>
    invoke<boolean>("save_edited_pdf", { path, pages }),
  saveText: (path: string, contents: string) => invoke<void>("save_text", { path, contents }),
  readImage: (path: string) => invoke<string>("read_image", { path }),
  initialFile: () => invoke<string | null>("initial_file"),
  listUserThemes: () => invoke<unknown[]>("list_user_themes"),
  writeUserTheme: (file: string, contents: string) => invoke<void>("write_user_theme", { file, contents }),
  listPlugins: () => invoke<PluginBundle[]>("list_plugins"),
  checkSpelling: (words: string[]) => invoke<NativeSpellError[]>("check_spelling", { words }),
  saveAutosave: (draft: unknown) => invoke<void>("save_autosave", { draft }),
  loadAutosave: () => invoke<any>("load_autosave"),
  clearAutosave: () => invoke<void>("clear_autosave"),
  quitApp: () => invoke<void>("quit_app"),
  setFullscreen: (fullscreen: boolean) => invoke<void>("set_window_fullscreen", { fullscreen }),
  checkAppUpdate: (repo: string) => invoke<UpdateCheckResult>("check_app_update", { repo }),
  installAppUpdate: (downloadUrl: string, assetName: string) =>
    invoke<string>("install_app_update", { downloadUrl, assetName }),
};

/** Page sizes in inches (portrait). */
export const PAGE_SIZES: Record<PageSizeName, { w: number; h: number; label: string }> = {
  A4: { w: 8.27, h: 11.69, label: "A4 · 210 × 297 mm" },
  Letter: { w: 8.5, h: 11, label: "Letter · 8.5 × 11 in" },
  Legal: { w: 8.5, h: 14, label: "Legal · 8.5 × 14 in" },
  A5: { w: 5.83, h: 8.27, label: "A5 · 148 × 210 mm" },
  Executive: { w: 7.25, h: 10.5, label: "Executive · 7.25 × 10.5 in" },
};

export const MARGIN_PRESETS: Record<string, Margins> = {
  Normal: { top: 1, right: 1, bottom: 1, left: 1 },
  Narrow: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
  Moderate: { top: 1, right: 0.75, bottom: 1, left: 0.75 },
  Wide: { top: 1, right: 2, bottom: 1, left: 2 },
};
