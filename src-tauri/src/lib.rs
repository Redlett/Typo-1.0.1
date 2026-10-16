//! Typo core: file I/O, OpenXML engine, font discovery, themes, plugins and settings.

pub mod docx;
pub mod epub;
pub mod pdf;
pub mod spellcheck;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use docx::{DocDefaults, ImportedDocx, PageSettings};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Hard ceiling for any document we read, so a bogus file can't exhaust memory.
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

fn read_capped(path: &Path) -> CmdResult<Vec<u8>> {
    let meta = fs::metadata(path).map_err(err)?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("File is too large ({} MB).", meta.len() / 1024 / 1024));
    }
    fs::read(path).map_err(err)
}

/// Writes atomically: temp file in the same folder, then rename over the target.
/// A crash mid-save can never leave a half-written document behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> CmdResult<()> {
    let dir = path.parent().ok_or("Invalid path")?;
    let file_name = path.file_name().ok_or("Invalid path")?.to_string_lossy();
    let tmp = dir.join(format!(".{file_name}.typo-tmp"));
    fs::write(&tmp, bytes).map_err(err)?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })
}

// ---------------------------------------------------------------------------
// App folders
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    config: String,
    themes: String,
    plugins: String,
}

fn config_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn sub_dir(app: &AppHandle, name: &str) -> CmdResult<PathBuf> {
    let dir = config_dir(app)?.join(name);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

#[tauri::command]
fn app_paths(app: AppHandle) -> CmdResult<AppPaths> {
    Ok(AppPaths {
        config: config_dir(&app)?.to_string_lossy().into_owned(),
        themes: sub_dir(&app, "themes")?.to_string_lossy().into_owned(),
        plugins: sub_dir(&app, "plugins")?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn open_folder(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("Folder does not exist".into());
    }
    std::process::Command::new("explorer.exe").arg(p).spawn().map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_settings(app: AppHandle) -> CmdResult<Value> {
    let path = config_dir(&app)?.join("settings.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or(Value::Null)),
        Err(_) => Ok(Value::Null),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> CmdResult<()> {
    let path = config_dir(&app)?.join("settings.json");
    let s = serde_json::to_string_pretty(&settings).map_err(err)?;
    write_atomic(&path, s.as_bytes())
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

static FONT_CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// Every font family installed on the system (via DirectWrite), sorted.
#[tauri::command]
async fn list_fonts() -> CmdResult<Vec<String>> {
    if let Some(f) = FONT_CACHE.get() {
        return Ok(f.clone());
    }
    let fonts = tauri::async_runtime::spawn_blocking(|| {
        let mut families = font_kit::source::SystemSource::new()
            .all_families()
            .unwrap_or_default();
        families.retain(|f| !f.starts_with('@') && !f.trim().is_empty());
        families.sort_by_key(|a| a.to_lowercase());
        families.dedup();
        families
    })
    .await
    .map_err(err)?;
    let _ = FONT_CACHE.set(fonts.clone());
    Ok(fonts)
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedDocument {
    path: String,
    name: String,
    /// "docx" | "epub" | "pdf" | "html" | "md" | "txt"
    kind: String,
    /// Present for docx / epub / pdf.
    docx: Option<ImportedDocx>,
    /// Present for text-based formats.
    text: Option<String>,
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

#[tauri::command]
async fn open_document(path: String) -> CmdResult<OpenedDocument> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let ext = p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let bytes = read_capped(&p)?;
        let name = file_name(&p);
        match ext.as_str() {
            "docx" | "docm" | "dotx" => {
                let imported = docx::import_docx(&bytes)?;
                Ok(OpenedDocument { path, name, kind: "docx".into(), docx: Some(imported), text: None })
            }
            "epub" => {
                let imported = epub::import_epub(&bytes)?;
                Ok(OpenedDocument { path, name, kind: "epub".into(), docx: Some(imported), text: None })
            }
            "pdf" => {
                let parsed = pdf::parse_pdf_bytes(&bytes, &path, &name)?;
                Ok(OpenedDocument { path, name, kind: "pdf".into(), docx: Some(parsed.docx), text: None })
            }
            "doc" => Err("Legacy binary .doc files aren't supported. Re-save it as .docx in Word or LibreOffice first.".into()),
            "odt" => Err("OpenDocument (.odt) import is coming in a later version. Save it as .docx from LibreOffice for now.".into()),
            other => {
                let kind = match other {
                    "html" | "htm" => "html",
                    "md" | "markdown" => "md",
                    _ => "txt",
                };
                let text = String::from_utf8_lossy(&bytes).into_owned();
                Ok(OpenedDocument { path, name, kind: kind.into(), docx: None, text: Some(text) })
            }
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn save_docx(
    path: String,
    doc: Value,
    page: PageSettings,
    defaults: DocDefaults,
    title: String,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = docx::export_docx(&doc, &page, &defaults, &title)?;
        write_atomic(Path::new(&path), &bytes)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn save_epub(
    path: String,
    doc: Value,
    page: PageSettings,
    defaults: DocDefaults,
    title: String,
    author: Option<String>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = author.unwrap_or_else(|| "Typo Author".into());
        let bytes = epub::export_epub(&doc, &page, &defaults, &title, &auth)?;
        write_atomic(Path::new(&path), &bytes)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn save_text(path: String, contents: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || write_atomic(Path::new(&path), contents.as_bytes()))
        .await
        .map_err(err)?
}

/// Reads an image from disk and returns it as a data URL for embedding.
#[tauri::command]
async fn read_image(path: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let bytes = read_capped(&p)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("Image is larger than 64 MB.".into());
        }
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            "webp" => "image/webp",
            _ => return Err("Unsupported image type. Use PNG, JPEG, GIF, BMP or WebP.".into()),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(err)?
}

/// A file passed on the command line (e.g. "Open with Typo").
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

// ---------------------------------------------------------------------------
// Themes & plugins
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_user_themes(app: AppHandle) -> CmdResult<Vec<Value>> {
    let dir = sub_dir(&app, "themes")?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(err)?.flatten() {
        let p = entry.path();
        if p.extension().map(|e| e == "json").unwrap_or(false) {
            if let Ok(s) = fs::read_to_string(&p) {
                match serde_json::from_str::<Value>(&s) {
                    Ok(mut v) => {
                        if let Some(obj) = v.as_object_mut() {
                            obj.insert("_file".into(), Value::String(file_name(&p)));
                        }
                        out.push(v);
                    }
                    Err(e) => out.push(serde_json::json!({ "_file": file_name(&p), "_error": e.to_string() })),
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn write_user_theme(app: AppHandle, file: String, contents: String) -> CmdResult<()> {
    let safe: String = file
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    if safe.is_empty() || !safe.ends_with(".json") || safe.contains("..") {
        return Err("Invalid theme file name".into());
    }
    let path = sub_dir(&app, "themes")?.join(safe);
    write_atomic(&path, contents.as_bytes())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginBundle {
    folder: String,
    manifest: Value,
    code: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn list_plugins(app: AppHandle) -> CmdResult<Vec<PluginBundle>> {
    let dir = sub_dir(&app, "plugins")?;
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).map_err(err)?.flatten() {
        let folder = entry.path();
        if !folder.is_dir() {
            continue;
        }
        let folder_name = file_name(&folder);
        let manifest_path = folder.join("plugin.json");
        let manifest: Value = match fs::read_to_string(&manifest_path)
            .map_err(err)
            .and_then(|s| serde_json::from_str(&s).map_err(err))
        {
            Ok(m) => m,
            Err(e) => {
                out.push(PluginBundle { folder: folder_name, manifest: Value::Null, code: None, error: Some(format!("plugin.json: {e}")) });
                continue;
            }
        };
        let main = manifest.get("main").and_then(|m| m.as_str()).unwrap_or("main.js");
        // Keep plugins inside their own folder.
        let main_path = folder.join(main);
        let contained = main_path
            .canonicalize()
            .ok()
            .zip(folder.canonicalize().ok())
            .map(|(m, f)| m.starts_with(f))
            .unwrap_or(false);
        let (code, error) = if !contained {
            (None, Some(format!("main file '{main}' not found inside the plugin folder")))
        } else {
            match fs::read_to_string(&main_path) {
                Ok(c) => (Some(c), None),
                Err(e) => (None, Some(e.to_string())),
            }
        };
        out.push(PluginBundle { folder: folder_name, manifest, code, error });
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}

/// First-run seeding: an example theme and an example plugin so the folders are self-documenting.
fn seed_user_content(app: &AppHandle) -> CmdResult<()> {
    let themes = sub_dir(app, "themes")?;
    let example_theme = themes.join("example-tokyo-night.json");
    if fs::read_dir(&themes).map(|mut d| d.next().is_none()).unwrap_or(false) {
        fs::write(example_theme, include_str!("../seed/example-tokyo-night.json")).map_err(err)?;
    }
    let plugins = sub_dir(app, "plugins")?;
    let example_plugin = plugins.join("text-tools");
    if fs::read_dir(&plugins).map(|mut d| d.next().is_none()).unwrap_or(false) {
        fs::create_dir_all(&example_plugin).map_err(err)?;
        fs::write(example_plugin.join("plugin.json"), include_str!("../seed/text-tools/plugin.json")).map_err(err)?;
        fs::write(example_plugin.join("main.js"), include_str!("../seed/text-tools/main.js")).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app() {
    std::process::exit(0);
}

static WAS_MAXIMIZED_BEFORE_FULLSCREEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_window_fullscreen(window: tauri::Window, fullscreen: bool) -> CmdResult<()> {
    use std::sync::atomic::Ordering;
    if fullscreen {
        let was_max = window.is_maximized().unwrap_or(false);
        WAS_MAXIMIZED_BEFORE_FULLSCREEN.store(was_max, Ordering::SeqCst);
        if was_max {
            let _ = window.unmaximize();
        }
        window.set_fullscreen(true).map_err(err)?;
    } else {
        window.set_fullscreen(false).map_err(err)?;
        if WAS_MAXIMIZED_BEFORE_FULLSCREEN.swap(false, Ordering::SeqCst) {
            let _ = window.maximize();
        }
    }
    Ok(())
}

#[tauri::command]
async fn check_spelling(words: Vec<String>) -> CmdResult<Vec<spellcheck::NativeSpellError>> {
    tauri::async_runtime::spawn_blocking(move || spellcheck::check_words_native(words))
        .await
        .map_err(err)
}

#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http/https URLs are allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Prefer Google Chrome directly if installed, otherwise default browser via explorer/cmd start
        let chrome_paths = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        if let Some(chrome) = chrome_paths.iter().find(|p| Path::new(p).is_file()) {
            let _ = std::process::Command::new(chrome).arg(&url).spawn();
            return Ok(());
        }
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn save_autosave(app: AppHandle, draft: Value) -> CmdResult<()> {
    let path = config_dir(&app)?.join("autosave.json");
    let s = serde_json::to_string(&draft).map_err(err)?;
    write_atomic(&path, s.as_bytes())
}

#[tauri::command]
fn load_autosave(app: AppHandle) -> CmdResult<Value> {
    let path = config_dir(&app)?.join("autosave.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(serde_json::from_str(&s).unwrap_or(Value::Null)),
        Err(_) => Ok(Value::Null),
    }
}

#[tauri::command]
fn clear_autosave(app: AppHandle) -> CmdResult<()> {
    let path = config_dir(&app)?.join("autosave.json");
    let _ = fs::remove_file(path);
    Ok(())
}

#[tauri::command]
async fn export_pdf(
    app: AppHandle,
    path: String,
    doc: Value,
    page: PageSettings,
    defaults: DocDefaults,
    title: String,
    html: Option<String>,
) -> CmdResult<bool> {
    let tmp_dir = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        pdf::export_pdf_document(
            &tmp_dir,
            Path::new(&path),
            &doc,
            &page,
            &defaults,
            &title,
            html.as_deref(),
        )
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn parse_pdf_file(path: String) -> CmdResult<pdf::ParsedPdfDocument> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let bytes = read_capped(&p)?;
        let name = file_name(&p);
        pdf::parse_pdf_bytes(&bytes, &path, &name)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn convert_pdf_to_docx(pdf_path: String, docx_path: String) -> CmdResult<pdf::ParsedPdfDocument> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&pdf_path);
        let bytes = read_capped(&p)?;
        let name = file_name(&p);
        let parsed = pdf::parse_pdf_bytes(&bytes, &pdf_path, &name)?;
        let title = name.trim_end_matches(".pdf").trim_end_matches(".PDF");
        let docx_bytes = docx::export_docx(&parsed.docx.doc, &parsed.docx.page, &parsed.docx.defaults, title)?;
        write_atomic(Path::new(&docx_path), &docx_bytes)?;
        Ok(parsed)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn save_edited_pdf(
    app: AppHandle,
    path: String,
    pages: Vec<pdf::PdfEditorPage>,
) -> CmdResult<bool> {
    let tmp_dir = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        pdf::save_edited_pdf_document(&tmp_dir, Path::new(&path), &pages)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_name: String,
    pub release_notes: String,
    pub download_url: String,
    pub html_url: String,
    pub asset_name: String,
}

fn parse_semver_tuple(v: &str) -> (u32, u32, u32) {
    let cleaned = v.trim().trim_start_matches(['v', 'V']);
    let core = cleaned.split(['-', '+']).next().unwrap_or(cleaned);
    let mut parts = core.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

fn normalize_github_repo(raw: &str) -> Option<String> {
    let trimmed = raw
        .trim()
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let stripped = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("github.com/"))
        .unwrap_or(trimmed);
    let segments: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() >= 2 {
        let owner = segments[0];
        let repo = segments[1];
        if owner.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            && repo.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Some(format!("{owner}/{repo}"));
        }
    }
    None
}

#[tauri::command]
async fn check_app_update(repo: String) -> CmdResult<UpdateCheckResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let clean_repo = normalize_github_repo(&repo).ok_or_else(|| {
            "Enter a valid GitHub repository (e.g. username/typo-releases)".to_string()
        })?;
        let api_url = format!("https://api.github.com/repos/{clean_repo}/releases/latest");

        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;

        let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
        cmd.args([
            "-sL",
            "--max-time",
            "12",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: Typo-Desktop-App",
            &api_url,
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);

        let output = cmd.output().map_err(err)?;
        if !output.status.success() {
            return Err("Could not reach GitHub Releases API. Check your internet connection.".into());
        }
        let body_str = String::from_utf8_lossy(&output.stdout);
        let json: Value = serde_json::from_str(&body_str)
            .map_err(|_| "Invalid response from GitHub Releases API.".to_string())?;

        if let Some(msg) = json.get("message").and_then(Value::as_str) {
            if json.get("tag_name").is_none() {
                return Err(format!("GitHub repository '{clean_repo}': {msg}"));
            }
        }

        let tag_name = json
            .get("tag_name")
            .and_then(Value::as_str)
            .unwrap_or(&current_version)
            .trim()
            .trim_start_matches(['v', 'V'])
            .to_string();
        let release_name = json
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&tag_name)
            .to_string();
        let release_notes = json
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let html_url = json
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let mut download_url = String::new();
        let mut asset_name = String::new();
        if let Some(assets) = json.get("assets").and_then(Value::as_array) {
            // Prefer setup.exe installer first, or standalone Typo.exe second
            for a in assets {
                let name = a.get("name").and_then(Value::as_str).unwrap_or("");
                let url = a
                    .get("browser_download_url")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if name.to_ascii_lowercase().ends_with(".exe") && !url.is_empty() {
                    if download_url.is_empty()
                        || name.to_ascii_lowercase().contains("setup")
                    {
                        download_url = url.to_string();
                        asset_name = name.to_string();
                    }
                }
            }
        }

        let cur_tuple = parse_semver_tuple(&current_version);
        let lat_tuple = parse_semver_tuple(&tag_name);
        let update_available = lat_tuple > cur_tuple;

        Ok(UpdateCheckResult {
            current_version,
            latest_version: tag_name,
            update_available,
            release_name,
            release_notes,
            download_url,
            html_url,
            asset_name,
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn install_app_update(download_url: String, asset_name: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !download_url.starts_with("https://") {
            return Err("Update download URL must use HTTPS.".into());
        }
        let safe_name: String = asset_name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
            .collect();
        let file_name = if safe_name.to_ascii_lowercase().ends_with(".exe") {
            safe_name
        } else {
            "Typo_Update.exe".to_string()
        };

        let update_dir = std::env::temp_dir().join("Typo_Updates");
        fs::create_dir_all(&update_dir).map_err(err)?;
        let target_exe = update_dir.join(&file_name);

        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;

        let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
        cmd.args([
            "-sL",
            "--max-time",
            "180",
            "-H",
            "User-Agent: Typo-Desktop-App",
            "-o",
        ])
        .arg(&target_exe)
        .arg(&download_url);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);

        let status = cmd.status().map_err(err)?;
        if !status.success() {
            return Err("Failed to download update package.".into());
        }

        let meta = fs::metadata(&target_exe).map_err(err)?;
        if meta.len() < 1024 * 100 {
            return Err("Downloaded update package is incomplete or invalid.".into());
        }

        let is_installer = file_name.to_ascii_lowercase().contains("setup")
            || file_name.to_ascii_lowercase().contains("install");

        #[cfg(target_os = "windows")]
        {
            if is_installer {
                // Launch the NSIS setup installer and close Typo so it can overwrite cleanly
                std::process::Command::new(&target_exe)
                    .spawn()
                    .map_err(err)?;
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    std::process::exit(0);
                });
            } else if let Ok(current_exe) = std::env::current_exe() {
                // Standalone portable Typo.exe: swap executable via helper batch script & relaunch
                let bat_path = update_dir.join("apply_typo_update.cmd");
                let bat_script = format!(
                    "@echo off\r\nping 127.0.0.1 -n 2 > nul\r\ncopy /Y \"{}\" \"{}\" > nul\r\nstart \"\" \"{}\"\r\n",
                    target_exe.display(),
                    current_exe.display(),
                    current_exe.display()
                );
                fs::write(&bat_path, bat_script).map_err(err)?;
                std::process::Command::new("cmd")
                    .args(["/C", &bat_path.to_string_lossy()])
                    .creation_flags(0x08000000)
                    .spawn()
                    .map_err(err)?;
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_millis(450));
                    std::process::exit(0);
                });
            }
        }

        Ok(target_exe.to_string_lossy().into_owned())
    })
    .await
    .map_err(err)?
}

#[cfg(target_os = "windows")]
mod single_instance {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::process::CommandExt;

    type HWND = isize;
    type BOOL = i32;
    type DWORD = u32;
    type LPARAM = isize;

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(lpEnumFunc: extern "system" fn(HWND, LPARAM) -> BOOL, lParam: LPARAM) -> BOOL;
        fn IsWindowVisible(hWnd: HWND) -> BOOL;
        fn IsIconic(hWnd: HWND) -> BOOL;
        fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut DWORD) -> DWORD;
        fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> BOOL;
        fn SetForegroundWindow(hWnd: HWND) -> BOOL;
    }

    extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut pid: DWORD = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == std::process::id() || pid == 0 {
                return 1;
            }
            let mut buf = [0u16; 260];
            let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if len <= 0 {
                return 1;
            }
            let title = OsString::from_wide(&buf[..len as usize]).to_string_lossy().into_owned();
            if title == "Typo" || title.ends_with("— Typo") {
                let found = &mut *(lparam as *mut HWND);
                *found = hwnd;
                return 0;
            }
            1
        }
    }

    pub fn ensure_clean_launch(has_file_arg: bool) {
        unsafe {
            let mut existing_hwnd: HWND = 0;
            EnumWindows(enum_proc, &mut existing_hwnd as *mut HWND as LPARAM);
            if existing_hwnd != 0 && !has_file_arg {
                if IsIconic(existing_hwnd) != 0 {
                    ShowWindow(existing_hwnd, 9); // SW_RESTORE
                }
                SetForegroundWindow(existing_hwnd);
                std::process::exit(0);
            }
            if existing_hwnd == 0 {
                // Clear any lingering headless zombie typo.exe holding the WebView2 user-data lock
                let my_pid = std::process::id();
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/FI", &format!("PID ne {my_pid}"), "/IM", "typo.exe"])
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .output();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        single_instance::ensure_clean_launch(initial_file().is_some());
        let hw_accel = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("com.calamity.typo").join("settings.json"))
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("hardwareAcceleration").and_then(Value::as_bool))
            .unwrap_or(true);
        if hw_accel {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --enable-smooth-scrolling",
            );
        } else {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing",
            );
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                std::process::exit(0);
            }
        })
        .setup(|app| {
            let _ = seed_user_content(app.handle());
            // Warm the font cache in the background so the font picker opens instantly.
            tauri::async_runtime::spawn(async {
                let _ = list_fonts().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_paths,
            open_folder,
            load_settings,
            save_settings,
            list_fonts,
            open_document,
            save_docx,
            save_epub,
            save_text,
            read_image,
            initial_file,
            list_user_themes,
            write_user_theme,
            list_plugins,
            quit_app,
            set_window_fullscreen,
            check_spelling,
            open_url,
            save_autosave,
            load_autosave,
            clear_autosave,
            export_pdf,
            parse_pdf_file,
            convert_pdf_to_docx,
            save_edited_pdf,
            check_app_update,
            install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Typo");
}
