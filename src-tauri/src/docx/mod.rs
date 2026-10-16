//! OpenXML (.docx) engine: ProseMirror JSON <-> WordprocessingML.
//! See `docs/DOCUMENT_MODEL.md` for the JSON contract.

mod export;
mod import;

use serde::{Deserialize, Serialize};

pub use export::export_docx;
pub use import::import_docx;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Default for Margins {
    fn default() -> Self {
        Self { top: 1.0, right: 1.0, bottom: 1.0, left: 1.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageSettings {
    pub size: String,
    pub orientation: String,
    pub margins: Margins,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_numbers: Option<bool>,
}

impl Default for PageSettings {
    fn default() -> Self {
        Self {
            size: "A4".into(),
            orientation: "portrait".into(),
            margins: Margins::default(),
            header: None,
            footer: None,
            page_numbers: None,
        }
    }
}

impl PageSettings {
    /// Page size in twips (width, height), already swapped for landscape.
    pub fn dimensions_twips(&self) -> (u32, u32) {
        let (w, h) = match self.size.as_str() {
            "Letter" => (12240, 15840),
            "Legal" => (12240, 20160),
            "A5" => (8391, 11906),
            "Executive" => (10440, 15120),
            _ => (11906, 16838),
        };
        if self.orientation == "landscape" { (h, w) } else { (w, h) }
    }

    /// Best-effort reverse lookup from twips (portrait or landscape) to a named size.
    pub fn from_twips(w: u32, h: u32, landscape_hint: bool) -> (String, String) {
        let (short, long) = if w <= h { (w, h) } else { (h, w) };
        let candidates = [
            ("A4", 11906u32, 16838u32),
            ("Letter", 12240, 15840),
            ("Legal", 12240, 20160),
            ("A5", 8391, 11906),
            ("Executive", 10440, 15120),
        ];
        let mut best = ("A4", u32::MAX);
        for (name, cw, ch) in candidates {
            let d = short.abs_diff(cw) + long.abs_diff(ch);
            if d < best.1 {
                best = (name, d);
            }
        }
        let orient = if landscape_hint || w > h { "landscape" } else { "portrait" };
        (best.0.to_string(), orient.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocDefaults {
    pub font_family: String,
    /// Points.
    pub font_size: f64,
}

impl Default for DocDefaults {
    fn default() -> Self {
        Self { font_family: "Calibri".into(), font_size: 11.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDocx {
    pub doc: serde_json::Value,
    pub page: PageSettings,
    pub defaults: DocDefaults,
}
