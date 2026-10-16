//! WordprocessingML (.docx) -> ProseMirror JSON reader.
//!
//! Designed for real-world files produced by Word, Google Docs and
//! LibreOffice. Unknown or malformed constructs degrade gracefully; only an
//! unreadable zip or main document part is reported as an error.

use super::{DocDefaults, ImportedDocx, Margins, PageSettings};
use base64::Engine as _;
use roxmltree::{Document, Node};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

const W_NS: [&str; 2] = [
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const R_NS: [&str; 2] = [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
];

/// Total uncompressed bytes we are willing to read from one package.
const MAX_TOTAL: u64 = 512 * 1024 * 1024;
/// Largest single image part.
const MAX_IMAGE: u64 = 64 * 1024 * 1024;
/// Largest single XML part.
const MAX_XML: u64 = 256 * 1024 * 1024;
/// Recursion guard for nested tables / content controls.
const MAX_DEPTH: usize = 48;

/// Convert a `.docx` package into ProseMirror JSON plus page settings.
pub fn import_docx(bytes: &[u8]) -> Result<ImportedDocx, String> {
    let zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Not a valid .docx file: {e}"))?;
    let mut pkg = Package::new(zip);

    let main_path = pkg
        .read_text("_rels/.rels")
        .and_then(|x| {
            parse_rels(&x, "")
                .into_values()
                .find(|r| !r.external && r.kind.ends_with("/officeDocument"))
                .map(|r| r.target)
        })
        .unwrap_or_else(|| "word/document.xml".to_string());
    let (xml, main_path) = match pkg.read_text(&main_path) {
        Some(x) => (x, main_path),
        None => (
            pkg.read_text("word/document.xml").ok_or("The file has no readable document part (word/document.xml).")?,
            "word/document.xml".to_string(),
        ),
    };
    let doc = Document::parse(&xml).map_err(|e| format!("The document part is malformed: {e}"))?;

    let (dir, file) = main_path.rsplit_once('/').unwrap_or(("", main_path.as_str()));
    let rels_path = if dir.is_empty() { format!("_rels/{file}.rels") } else { format!("{dir}/_rels/{file}.rels") };
    let rels = pkg.read_text(&rels_path).map(|x| parse_rels(&x, dir)).unwrap_or_default();
    let part_for = |suffix: &str, fallback: &str| -> String {
        rels.values()
            .find(|r| !r.external && r.kind.ends_with(suffix))
            .map(|r| r.target.clone())
            .unwrap_or_else(|| resolve_path(dir, fallback))
    };
    let theme_path = part_for("/theme", "theme/theme1.xml");
    let styles_path = part_for("/styles", "styles.xml");
    let numbering_path = part_for("/numbering", "numbering.xml");

    let theme = pkg.read_text(&theme_path).map(|x| parse_theme(&x)).unwrap_or_default();
    let styles = pkg.read_text(&styles_path).map(|x| Styles::parse(&x, &theme)).unwrap_or_default();
    let numbering = pkg.read_text(&numbering_path).map(|x| Numbering::parse(&x)).unwrap_or_default();
    let defaults = styles.doc_defaults();

    let mut conv = Conv {
        pkg,
        rels,
        styles,
        numbering,
        theme,
        defaults: defaults.clone(),
        images: HashMap::new(),
        fields: Vec::new(),
        counters: HashMap::new(),
        depth: 0,
    };

    let body = doc.root_element().children().find(|n| is(*n, "body"));
    let mut blocks = match body {
        Some(b) => {
            let mut flats = Vec::new();
            conv.block_flats(b, &mut flats);
            conv.group(flats)
        }
        None => Vec::new(),
    };
    if blocks.is_empty() {
        blocks.push(json!({ "type": "paragraph" }));
    }
    let mut page = body
        .map(|b| section_settings(b, &mut conv.pkg, &conv.rels))
        .unwrap_or_default();
    if let Some(doodle_xml) = conv.pkg.read_text("customXml/typo_doodles.xml") {
        if let Ok(ddoc) = Document::parse(&doodle_xml) {
            let root = ddoc.root_element();
            if let Some(u) = root.attribute("under").filter(|s| !s.is_empty()) {
                page.doodle_under = Some(u.to_string());
            }
            if let Some(o) = root.attribute("over").filter(|s| !s.is_empty()) {
                page.doodle_over = Some(o.to_string());
            }
        }
    }

    Ok(ImportedDocx { doc: json!({ "type": "doc", "content": blocks }), page, defaults })
}

// ---------------------------------------------------------------------------
// Package access
// ---------------------------------------------------------------------------

struct Package<'b> {
    zip: zip::ZipArchive<Cursor<&'b [u8]>>,
    names: HashMap<String, String>,
    budget: u64,
}

impl<'b> Package<'b> {
    fn new(zip: zip::ZipArchive<Cursor<&'b [u8]>>) -> Self {
        let names = zip
            .file_names()
            .map(|n| (n.trim_start_matches('/').replace('\\', "/").to_ascii_lowercase(), n.to_string()))
            .collect();
        Self { zip, names, budget: MAX_TOTAL }
    }

    fn read(&mut self, name: &str, limit: u64) -> Option<Vec<u8>> {
        let key = name.trim_start_matches('/').replace('\\', "/").to_ascii_lowercase();
        let actual = self.names.get(&key).or_else(|| self.names.get(&percent_decode(&key)))?.clone();
        let file = self.zip.by_name(&actual).ok()?;
        let cap = limit.min(self.budget);
        let mut data = Vec::new();
        file.take(cap.saturating_add(1)).read_to_end(&mut data).ok()?;
        if data.len() as u64 > cap {
            return None;
        }
        self.budget -= data.len() as u64;
        Some(data)
    }

    fn read_text(&mut self, name: &str) -> Option<String> {
        decode_text(self.read(name, MAX_XML)?)
    }
}

fn decode_text(bytes: Vec<u8>) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return Some(String::from_utf8_lossy(rest).into_owned());
    }
    let utf16 = |data: &[u8], le: bool| -> String {
        let units: Vec<u16> = data
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return Some(utf16(rest, true));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return Some(utf16(rest, false));
    }
    Some(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

struct Rel {
    kind: String,
    target: String,
    external: bool,
}

fn parse_rels(xml: &str, base_dir: &str) -> HashMap<String, Rel> {
    let mut out = HashMap::new();
    let Ok(doc) = Document::parse(xml) else { return out };
    for n in doc.root_element().children().filter(|n| is(*n, "Relationship")) {
        let (Some(id), Some(target)) = (n.attribute("Id"), n.attribute("Target")) else { continue };
        let external = n.attribute("TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("External"));
        let target = if external { target.to_string() } else { resolve_path(base_dir, target) };
        out.insert(id.to_string(), Rel { kind: n.attribute("Type").unwrap_or("").to_string(), target, external });
    }
    out
}

fn resolve_path(base: &str, target: &str) -> String {
    let target = target.split('#').next().unwrap_or(target);
    let joined = if let Some(abs) = target.strip_prefix('/') {
        abs.to_string()
    } else if base.is_empty() {
        target.to_string()
    } else {
        format!("{base}/{target}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 0 && i + 2 <= bytes.len() - 1 {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

fn is(n: Node, name: &str) -> bool {
    n.is_element() && n.tag_name().name() == name
}

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| is(*c, name))
}

/// Attribute in the WordprocessingML namespace (transitional or strict), with
/// a fallback to an un-namespaced attribute of the same local name.
fn wattr<'a>(n: Node<'a, '_>, name: &str) -> Option<&'a str> {
    let mut fallback = None;
    for a in n.attributes() {
        if a.name() != name {
            continue;
        }
        match a.namespace() {
            Some(ns) if W_NS.contains(&ns) => return Some(a.value()),
            None => fallback = Some(a.value()),
            _ => {}
        }
    }
    fallback
}

fn wval<'a>(n: Node<'a, '_>) -> Option<&'a str> {
    wattr(n, "val")
}

fn rattr<'a>(n: Node<'a, '_>, name: &str) -> Option<&'a str> {
    n.attributes().find(|a| a.name() == name && a.namespace().is_some_and(|ns| R_NS.contains(&ns))).map(|a| a.value())
}

/// OOXML on/off property: absent `w:val` means on.
fn on(n: Node) -> bool {
    match wval(n) {
        None => true,
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "none"),
    }
}

fn parse_i64(s: &str) -> Option<i64> {
    let s = s.trim();
    s.parse::<i64>().ok().or_else(|| s.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f.round() as i64))
}

fn node_type(v: &Value) -> &str {
    v.get("type").and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// Theme / styles / numbering
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Theme {
    minor: Option<String>,
    major: Option<String>,
}

fn parse_theme(xml: &str) -> Theme {
    let mut t = Theme::default();
    let Ok(doc) = Document::parse(xml) else { return t };
    let face = |n: Node| child(n, "latin").and_then(|l| l.attribute("typeface")).filter(|f| !f.is_empty()).map(str::to_string);
    for n in doc.descendants() {
        if is(n, "minorFont") && t.minor.is_none() {
            t.minor = face(n);
        } else if is(n, "majorFont") && t.major.is_none() {
            t.major = face(n);
        }
    }
    t
}

impl Theme {
    fn font(&self, theme_ref: &str) -> Option<String> {
        if theme_ref.starts_with("major") {
            Some(self.major.clone().unwrap_or_else(|| "Calibri Light".to_string()))
        } else if theme_ref.starts_with("minor") {
            Some(self.minor.clone().unwrap_or_else(|| "Calibri".to_string()))
        } else {
            None
        }
    }
}

#[derive(Default, Clone, Debug)]
struct RunProps {
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
    strike: Option<bool>,
    /// 1 = superscript, -1 = subscript, 0 = baseline.
    vert: Option<i8>,
    color: Option<String>,
    /// Points.
    size: Option<f64>,
    font: Option<String>,
    highlight: Option<String>,
    shd: Option<String>,
    vanish: Option<bool>,
}

impl RunProps {
    fn overlay(&mut self, o: &RunProps) {
        macro_rules! take {
            ($($f:ident),*) => { $( if o.$f.is_some() { self.$f = o.$f.clone(); } )* };
        }
        take!(bold, italic, underline, strike, vert, color, size, font, highlight, shd, vanish);
    }

    /// Paragraph-style properties worth carrying into run marks.
    fn inheritable(&self) -> RunProps {
        RunProps {
            bold: self.bold,
            italic: self.italic,
            color: self.color.clone(),
            size: self.size,
            font: self.font.clone(),
            ..Default::default()
        }
    }
}

fn parse_rpr(n: Node, theme: &Theme) -> RunProps {
    let mut p = RunProps::default();
    for c in n.children().filter(Node::is_element) {
        match c.tag_name().name() {
            "b" => p.bold = Some(on(c)),
            "i" => p.italic = Some(on(c)),
            "u" => p.underline = Some(wval(c).map_or(true, |v| v != "none")),
            "strike" => p.strike = Some(on(c)),
            "dstrike" => {
                if on(c) {
                    p.strike = Some(true);
                } else if p.strike.is_none() {
                    p.strike = Some(false);
                }
            }
            "vertAlign" => {
                p.vert = Some(match wval(c) {
                    Some("superscript") => 1,
                    Some("subscript") => -1,
                    _ => 0,
                })
            }
            "color" => p.color = wval(c).map(str::to_string),
            "sz" => p.size = wval(c).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| *v > 0.0).map(|v| v / 2.0),
            "rFonts" => {
                let font = wattr(c, "ascii")
                    .or_else(|| wattr(c, "hAnsi"))
                    .filter(|f| !f.is_empty())
                    .map(str::to_string)
                    .or_else(|| wattr(c, "asciiTheme").or_else(|| wattr(c, "hAnsiTheme")).and_then(|t| theme.font(t)));
                if font.is_some() {
                    p.font = font;
                }
            }
            "highlight" => p.highlight = wval(c).map(str::to_string),
            "shd" => p.shd = wattr(c, "fill").map(str::to_string),
            "vanish" => p.vanish = Some(on(c)),
            _ => {}
        }
    }
    p
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum ParaClass {
    Normal,
    Heading(u8),
    Title,
    Subtitle,
    Quote,
    Code,
}

struct StyleDef {
    /// Lower-cased display name.
    name: String,
    based_on: Option<String>,
    rpr: RunProps,
    outline: Option<u8>,
    num_id: Option<i64>,
    ilvl: Option<usize>,
    jc: Option<String>,
    ind_left: Option<i64>,
    line: Option<i64>,
}

#[derive(Default)]
struct Styles {
    map: HashMap<String, StyleDef>,
    default_para: Option<String>,
    doc_rpr: RunProps,
    doc_line: Option<i64>,
}

fn is_code_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("code") || n.contains("preformatted") || n.contains("source") || n.contains("verbatim")
}

impl Styles {
    fn parse(xml: &str, theme: &Theme) -> Styles {
        let mut s = Styles::default();
        let Ok(doc) = Document::parse(xml) else { return s };
        for top in doc.root_element().children().filter(Node::is_element) {
            match top.tag_name().name() {
                "docDefaults" => {
                    if let Some(rpr) = child(top, "rPrDefault").and_then(|n| child(n, "rPr")) {
                        s.doc_rpr = parse_rpr(rpr, theme);
                    }
                    s.doc_line = child(top, "pPrDefault")
                        .and_then(|n| child(n, "pPr"))
                        .and_then(|n| child(n, "spacing"))
                        .and_then(|n| wattr(n, "line"))
                        .and_then(parse_i64);
                }
                "style" => {
                    let Some(id) = wattr(top, "styleId") else { continue };
                    let kind = wattr(top, "type").unwrap_or("paragraph");
                    if kind == "paragraph" && wattr(top, "default").is_some_and(|d| d == "1" || d == "true") {
                        s.default_para = Some(id.to_string());
                    }
                    let ppr = child(top, "pPr");
                    let numpr = ppr.and_then(|p| child(p, "numPr"));
                    let def = StyleDef {
                        name: child(top, "name").and_then(wval).unwrap_or("").trim().to_ascii_lowercase(),
                        based_on: child(top, "basedOn").and_then(wval).map(str::to_string),
                        rpr: child(top, "rPr").map(|r| parse_rpr(r, theme)).unwrap_or_default(),
                        outline: ppr.and_then(|p| child(p, "outlineLvl")).and_then(wval).and_then(|v| v.parse().ok()),
                        num_id: numpr.and_then(|n| child(n, "numId")).and_then(wval).and_then(parse_i64),
                        ilvl: numpr.and_then(|n| child(n, "ilvl")).and_then(wval).and_then(|v| v.parse().ok()),
                        jc: ppr.and_then(|p| child(p, "jc")).and_then(wval).map(str::to_string),
                        ind_left: ppr
                            .and_then(|p| child(p, "ind"))
                            .and_then(|i| wattr(i, "left").or_else(|| wattr(i, "start")))
                            .and_then(parse_i64),
                        line: ppr.and_then(|p| child(p, "spacing")).and_then(|n| wattr(n, "line")).and_then(parse_i64),
                    };
                    s.map.insert(id.to_string(), def);
                }
                _ => {}
            }
        }
        if s.default_para.is_none() && s.map.contains_key("Normal") {
            s.default_para = Some("Normal".to_string());
        }
        s
    }

    /// Style chain from the given style up through `basedOn` (leaf first).
    fn chain(&self, id: &str) -> Vec<(&str, &StyleDef)> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = Some(id);
        while let Some(c) = cur {
            if out.len() > 32 || !seen.insert(c) {
                break;
            }
            let Some((key, def)) = self.map.get_key_value(c) else { break };
            out.push((key.as_str(), def));
            cur = def.based_on.as_deref();
        }
        out
    }

    fn resolved_rpr(&self, id: &str) -> RunProps {
        let mut r = RunProps::default();
        for (_, s) in self.chain(id).iter().rev() {
            r.overlay(&s.rpr);
        }
        r
    }

    fn classify(&self, id: &str) -> ParaClass {
        for (sid, s) in self.chain(id) {
            let lid = sid.to_ascii_lowercase();
            if s.name == "title" || lid == "title" {
                return ParaClass::Title;
            }
            if s.name == "subtitle" || lid == "subtitle" {
                return ParaClass::Subtitle;
            }
            for cand in [s.name.as_str(), lid.as_str()] {
                if let Some(rest) = cand.strip_prefix("heading") {
                    if let Ok(n) = rest.trim().parse::<u8>() {
                        if (1..=9).contains(&n) {
                            return ParaClass::Heading(n.min(6));
                        }
                    }
                }
            }
            if let Some(o) = s.outline {
                if o <= 5 {
                    return ParaClass::Heading(o + 1);
                }
            }
            if s.name.contains("quote") || s.name == "block text" {
                return ParaClass::Quote;
            }
            if is_code_name(&s.name) {
                return ParaClass::Code;
            }
        }
        ParaClass::Normal
    }

    fn jc(&self, id: &str) -> Option<String> {
        self.chain(id).into_iter().find_map(|(_, s)| s.jc.clone())
    }

    fn num(&self, id: &str) -> (Option<i64>, Option<usize>) {
        let chain = self.chain(id);
        (chain.iter().find_map(|(_, s)| s.num_id), chain.iter().find_map(|(_, s)| s.ilvl))
    }

    fn ind_left(&self, id: &str) -> Option<i64> {
        self.chain(id).into_iter().find_map(|(_, s)| s.ind_left)
    }

    fn default_line(&self) -> i64 {
        self.default_para
            .as_deref()
            .and_then(|d| self.chain(d).into_iter().find_map(|(_, s)| s.line))
            .or(self.doc_line)
            .unwrap_or(240)
    }

    fn doc_defaults(&self) -> DocDefaults {
        let mut r = self.doc_rpr.clone();
        if let Some(dp) = &self.default_para {
            r.overlay(&self.resolved_rpr(dp));
        }
        DocDefaults {
            font_family: r.font.unwrap_or_else(|| "Times New Roman".to_string()),
            font_size: r.size.unwrap_or(10.0),
        }
    }
}

#[derive(Clone)]
struct Level {
    fmt: String,
    start: i64,
}

struct AbstractNum {
    levels: HashMap<usize, Level>,
    style_link: Option<String>,
}

struct NumDef {
    abstract_id: String,
    /// ilvl -> (startOverride, level override)
    overrides: HashMap<usize, (Option<i64>, Option<Level>)>,
}

#[derive(Default)]
struct Numbering {
    abstracts: HashMap<String, AbstractNum>,
    nums: HashMap<i64, NumDef>,
}

fn parse_level(lvl: Node) -> Level {
    let fmt = child(lvl, "numFmt")
        .or_else(|| {
            lvl.descendants()
                .find(|d| is(*d, "numFmt") && d.ancestors().any(|a| is(a, "Fallback")))
                .or_else(|| lvl.descendants().find(|d| is(*d, "numFmt")))
        })
        .and_then(wval)
        .unwrap_or("decimal")
        .to_string();
    let start = child(lvl, "start").and_then(wval).and_then(parse_i64).unwrap_or(1);
    Level { fmt, start }
}

impl Numbering {
    fn parse(xml: &str) -> Numbering {
        let mut n = Numbering::default();
        let Ok(doc) = Document::parse(xml) else { return n };
        for top in doc.root_element().children().filter(Node::is_element) {
            match top.tag_name().name() {
                "abstractNum" => {
                    let Some(id) = wattr(top, "abstractNumId") else { continue };
                    let mut levels = HashMap::new();
                    for lvl in top.children().filter(|c| is(*c, "lvl")) {
                        let ilvl = wattr(lvl, "ilvl").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                        levels.insert(ilvl, parse_level(lvl));
                    }
                    let style_link = child(top, "numStyleLink").and_then(wval).map(str::to_string);
                    n.abstracts.insert(id.to_string(), AbstractNum { levels, style_link });
                }
                "num" => {
                    let Some(id) = wattr(top, "numId").and_then(parse_i64) else { continue };
                    let Some(abs) = child(top, "abstractNumId").and_then(wval) else { continue };
                    let mut overrides = HashMap::new();
                    for ov in top.children().filter(|c| is(*c, "lvlOverride")) {
                        let ilvl = wattr(ov, "ilvl").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
                        let start = child(ov, "startOverride").and_then(wval).and_then(parse_i64);
                        let lvl = child(ov, "lvl").map(parse_level);
                        overrides.insert(ilvl, (start, lvl));
                    }
                    n.nums.insert(id, NumDef { abstract_id: abs.to_string(), overrides });
                }
                _ => {}
            }
        }
        n
    }

    fn abstract_level(&self, abs: &str, ilvl: usize, styles: &Styles, depth: u8) -> Option<Level> {
        let a = self.abstracts.get(abs)?;
        if let Some(l) = a.levels.get(&ilvl) {
            return Some(l.clone());
        }
        let link = a.style_link.as_deref()?;
        if depth > 4 {
            return None;
        }
        let num = styles.map.get(link)?.num_id?;
        let def = self.nums.get(&num)?;
        self.abstract_level(&def.abstract_id, ilvl, styles, depth + 1)
    }

    /// Effective level definition for (numId, ilvl). `None` if the numId is unknown.
    fn level(&self, num: i64, ilvl: usize, styles: &Styles) -> Option<Level> {
        let def = self.nums.get(&num)?;
        let ov = def.overrides.get(&ilvl);
        let mut lvl = ov
            .and_then(|o| o.1.clone())
            .or_else(|| self.abstract_level(&def.abstract_id, ilvl, styles, 0))
            .unwrap_or(Level { fmt: "bullet".to_string(), start: 1 });
        if let Some(start) = ov.and_then(|o| o.0) {
            lvl.start = start;
        }
        Some(lvl)
    }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

enum Inl {
    Text(String, Vec<Value>),
    Node(Value),
    PageBreak,
    Hr,
}

struct Para {
    node: Value,
    quote: bool,
    list: Option<(i64, usize)>,
    /// Effective left indent in twips (direct or from the paragraph style).
    ind_left: i64,
    /// A plain `paragraph` node (not heading/title) that may continue a list item.
    plain: bool,
}

enum Flat {
    Para(Para),
    Code(String),
    Block(Value),
}

#[derive(Clone, Copy, PartialEq)]
enum ListKind {
    Bullet,
    Task,
    Ordered(&'static str),
}

struct OpenList {
    num: i64,
    ilvl: usize,
    kind: ListKind,
    start: i64,
    items: Vec<(Option<bool>, Vec<Value>)>,
}

impl OpenList {
    fn into_node(self) -> Value {
        let ty = match self.kind {
            ListKind::Bullet => "bulletList",
            ListKind::Task => "taskList",
            ListKind::Ordered(_) => "orderedList",
        };
        let items: Vec<Value> = self
            .items
            .into_iter()
            .map(|(checked, mut blocks)| {
                if blocks.first().map(node_type) != Some("paragraph") {
                    blocks.insert(0, json!({ "type": "paragraph" }));
                }
                match (self.kind, checked) {
                    (ListKind::Task, c) => json!({ "type": "taskItem", "attrs": { "checked": c.unwrap_or(false) }, "content": blocks }),
                    _ => json!({ "type": "listItem", "content": blocks }),
                }
            })
            .collect();
        match self.kind {
            ListKind::Ordered(t) => json!({ "type": ty, "attrs": { "start": self.start, "type": t }, "content": items }),
            _ => json!({ "type": ty, "content": items }),
        }
    }
}

#[derive(Default)]
struct Field {
    instr: String,
    separated: bool,
    link: Option<String>,
}

struct RunCtx<'c> {
    link: Option<String>,
    /// Paragraph-style run properties inherited below run props.
    base: &'c RunProps,
    /// Style-defined props of headings/titles; equal direct values are dropped.
    reference: &'c RunProps,
}

struct Conv<'b> {
    pkg: Package<'b>,
    rels: HashMap<String, Rel>,
    styles: Styles,
    numbering: Numbering,
    theme: Theme,
    defaults: DocDefaults,
    images: HashMap<String, Option<String>>,
    fields: Vec<Field>,
    counters: HashMap<(i64, usize), i64>,
    depth: usize,
}

impl Conv<'_> {
    // -- block level --------------------------------------------------------

    fn block_flats(&mut self, node: Node, flats: &mut Vec<Flat>) {
        if self.depth > MAX_DEPTH {
            return;
        }
        self.depth += 1;
        for c in node.children().filter(Node::is_element) {
            match c.tag_name().name() {
                "p" => self.paragraph(c, flats),
                "tbl" => {
                    if let Some(t) = self.table(c) {
                        flats.push(Flat::Block(t));
                    }
                }
                "sdt" => {
                    if let Some(sc) = child(c, "sdtContent") {
                        self.block_flats(sc, flats);
                    }
                }
                "sdtContent" | "customXml" | "ins" | "moveTo" | "smartTag" => self.block_flats(c, flats),
                _ => {}
            }
        }
        self.depth -= 1;
    }

    fn paragraph(&mut self, p: Node, flats: &mut Vec<Flat>) {
        let ppr = child(p, "pPr");
        let style_id = ppr
            .and_then(|n| child(n, "pStyle"))
            .and_then(wval)
            .map(str::to_string)
            .or_else(|| self.styles.default_para.clone())
            .unwrap_or_default();
        let sid = style_id.as_str();
        let mut class = self.styles.classify(sid);
        if class == ParaClass::Normal {
            if let Some(o) = ppr.and_then(|n| child(n, "outlineLvl")).and_then(wval).and_then(|v| v.parse::<u8>().ok()) {
                if o <= 5 {
                    class = ParaClass::Heading(o + 1);
                }
            }
        }

        // Numbering (direct or inherited from the paragraph style).
        let (style_num, style_ilvl) = self.styles.num(sid);
        let numpr = ppr.and_then(|n| child(n, "numPr"));
        let num_id = numpr.and_then(|n| child(n, "numId")).and_then(wval).and_then(parse_i64).or(style_num);
        let ilvl = numpr
            .and_then(|n| child(n, "ilvl"))
            .and_then(wval)
            .and_then(|v| v.parse::<usize>().ok())
            .or(style_ilvl)
            .unwrap_or(0)
            .min(8);
        let list = match (num_id, class) {
            (Some(id), ParaClass::Normal | ParaClass::Quote)
                if id > 0 && self.numbering.level(id, ilvl, &self.styles).is_some() =>
            {
                Some((id, ilvl))
            }
            _ => None,
        };

        let base = if class == ParaClass::Normal { self.styles.resolved_rpr(sid).inheritable() } else { RunProps::default() };
        let reference = match class {
            ParaClass::Heading(_) | ParaClass::Title | ParaClass::Subtitle => self.styles.resolved_rpr(sid),
            _ => RunProps::default(),
        };

        if ppr.and_then(|n| child(n, "pageBreakBefore")).is_some_and(on) {
            flats.push(Flat::Block(json!({ "type": "pageBreak" })));
        }

        let ctx = RunCtx { link: None, base: &base, reference: &reference };
        let mut items = Vec::new();
        self.inline_children(p, &ctx, &mut items);

        if class == ParaClass::Code {
            let mut text = String::new();
            for it in &items {
                match it {
                    Inl::Text(s, _) => text.push_str(s),
                    Inl::Node(n) if node_type(n) == "hardBreak" => text.push('\n'),
                    Inl::PageBreak => text.push('\n'),
                    _ => {}
                }
            }
            flats.push(Flat::Code(text));
            return;
        }

        let has_visible = items.iter().any(|i| match i {
            Inl::Text(s, _) => !s.trim().is_empty(),
            Inl::Node(n) => node_type(n) == "image",
            _ => false,
        });
        let has_break = items.iter().any(|i| matches!(i, Inl::PageBreak));
        let has_hr = items.iter().any(|i| matches!(i, Inl::Hr));
        let bottom_border = ppr
            .and_then(|n| child(n, "pBdr"))
            .and_then(|b| child(b, "bottom"))
            .is_some_and(|b| !matches!(wval(b), Some("none" | "nil")));
        if !has_visible && !has_break && (has_hr || bottom_border) && list.is_none() {
            flats.push(Flat::Block(json!({ "type": "horizontalRule" })));
            return;
        }

        // Paragraph attributes.
        let mut attrs = Map::new();
        let jc = ppr.and_then(|n| child(n, "jc")).and_then(wval).map(str::to_string).or_else(|| self.styles.jc(sid));
        if let Some(a) = jc.as_deref().and_then(map_jc) {
            attrs.insert("textAlign".into(), json!(a));
        }
        if let Some(lh) = ppr.and_then(|n| child(n, "spacing")).and_then(|s| self.line_height(s)) {
            attrs.insert("lineHeight".into(), json!(lh));
        }
        let direct_left = ppr
            .and_then(|n| child(n, "ind"))
            .and_then(|i| wattr(i, "left").or_else(|| wattr(i, "start")))
            .and_then(parse_i64);
        if list.is_none() {
            if let Some(left) = direct_left {
                let steps = (left as f64 / 720.0).round().clamp(0.0, 8.0) as i64;
                if steps > 0 {
                    attrs.insert("indent".into(), json!(steps));
                }
            }
        }
        let kind = match class {
            ParaClass::Heading(n) => {
                attrs.insert("level".into(), json!(n.clamp(1, 6)));
                "heading"
            }
            ParaClass::Title => {
                attrs.insert("styleName".into(), json!("Title"));
                "paragraph"
            }
            ParaClass::Subtitle => {
                attrs.insert("styleName".into(), json!("Subtitle"));
                "paragraph"
            }
            _ => "paragraph",
        };
        let ind_left = direct_left.or_else(|| self.styles.ind_left(sid)).unwrap_or(0);
        let plain = kind == "paragraph" && !attrs.contains_key("styleName");
        let quote = class == ParaClass::Quote;

        // Split at page breaks.
        let mut pieces: Vec<Vec<Inl>> = vec![Vec::new()];
        for it in items {
            match it {
                Inl::PageBreak => pieces.push(Vec::new()),
                Inl::Hr => {}
                other => {
                    if let Some(last) = pieces.last_mut() {
                        last.push(other);
                    }
                }
            }
        }
        let split = pieces.len() > 1;
        for (i, piece) in pieces.into_iter().enumerate() {
            if i > 0 {
                flats.push(Flat::Block(json!({ "type": "pageBreak" })));
            }
            let content = build_content(piece);
            if split && content.is_empty() {
                continue;
            }
            let mut node = json!({ "type": kind });
            if !attrs.is_empty() {
                node["attrs"] = Value::Object(attrs.clone());
            }
            if !content.is_empty() {
                node["content"] = Value::Array(content);
            }
            flats.push(Flat::Para(Para { node, quote, list: if i == 0 { list } else { None }, ind_left, plain }));
        }
    }

    fn line_height(&self, spacing: Node) -> Option<String> {
        let line = wattr(spacing, "line").and_then(parse_i64)?;
        let rule = wattr(spacing, "lineRule").unwrap_or("auto");
        if rule != "auto" || line <= 0 {
            return None;
        }
        if (line - self.styles.default_line()).abs() <= 1 {
            return None;
        }
        Some(fmt_num((line as f64 / 240.0 * 100.0).round() / 100.0))
    }

    // -- grouping: lists, quotes, code blocks -------------------------------

    fn group(&mut self, flats: Vec<Flat>) -> Vec<Value> {
        let mut out = Vec::new();
        let mut stack: Vec<OpenList> = Vec::new();
        let mut code: Option<String> = None;
        let mut quote: Vec<Value> = Vec::new();

        for flat in flats {
            if !matches!(flat, Flat::Code(_)) {
                flush_code(&mut code, &mut out);
            }
            let quote_para = matches!(&flat, Flat::Para(p) if p.quote && p.list.is_none());
            if !quote_para {
                flush_quote(&mut quote, &mut out);
            }
            match flat {
                Flat::Code(line) => {
                    close_all(&mut stack, &mut out);
                    code = Some(match code.take() {
                        Some(mut c) => {
                            c.push('\n');
                            c.push_str(&line);
                            c
                        }
                        None => line,
                    });
                }
                Flat::Para(p) if p.list.is_some() => self.list_add(&mut stack, &mut out, p),
                Flat::Para(p) if p.quote => {
                    close_all(&mut stack, &mut out);
                    quote.push(p.node);
                }
                Flat::Para(p) => {
                    let target = if p.plain { continuation_target(&stack, p.ind_left) } else { None };
                    match target {
                        Some(i) => {
                            while stack.len() > i + 1 {
                                close_top(&mut stack, &mut out);
                            }
                            let mut node = p.node;
                            remove_attr(&mut node, "indent");
                            if let Some(item) = stack[i].items.last_mut() {
                                item.1.push(node);
                            }
                        }
                        None => {
                            close_all(&mut stack, &mut out);
                            out.push(p.node);
                        }
                    }
                }
                Flat::Block(b) => {
                    close_all(&mut stack, &mut out);
                    out.push(b);
                }
            }
        }
        flush_code(&mut code, &mut out);
        flush_quote(&mut quote, &mut out);
        close_all(&mut stack, &mut out);
        out
    }

    fn list_add(&mut self, stack: &mut Vec<OpenList>, out: &mut Vec<Value>, p: Para) {
        let Some((num, ilvl)) = p.list else { return };
        while stack.last().is_some_and(|t| t.ilvl > ilvl) {
            close_top(stack, out);
        }
        if stack.last().is_some_and(|t| t.ilvl == ilvl && t.num != num) {
            close_top(stack, out);
        }

        let count = self.counters.get(&(num, ilvl)).copied().unwrap_or(0);
        self.counters.retain(|(n, l), _| !(*n == num && *l > ilvl));
        self.counters.insert((num, ilvl), count + 1);

        let mut node = p.node;
        remove_attr(&mut node, "indent");
        let checked = task_prefix(&node);

        if stack.last().is_none_or(|t| t.ilvl < ilvl) {
            let level = self
                .numbering
                .level(num, ilvl, &self.styles)
                .unwrap_or(Level { fmt: "bullet".to_string(), start: 1 });
            let kind = match level.fmt.as_str() {
                "bullet" | "none" => {
                    if checked.is_some() {
                        ListKind::Task
                    } else {
                        ListKind::Bullet
                    }
                }
                f => ListKind::Ordered(ordered_type(f)),
            };
            stack.push(OpenList { num, ilvl, kind, start: level.start + count, items: Vec::new() });
        }
        let Some(top) = stack.last_mut() else { return };
        if top.kind == ListKind::Task {
            strip_task_prefix(&mut node);
            top.items.push((Some(checked.unwrap_or(false)), vec![node]));
        } else {
            top.items.push((None, vec![node]));
        }
    }

    // -- inline level -------------------------------------------------------

    fn inline_children(&mut self, node: Node, ctx: &RunCtx, out: &mut Vec<Inl>) {
        for c in node.children().filter(Node::is_element) {
            match c.tag_name().name() {
                "r" => self.run(c, ctx, out),
                "hyperlink" => {
                    let link = self.hyperlink_href(c).or_else(|| ctx.link.clone());
                    let sub = RunCtx { link, base: ctx.base, reference: ctx.reference };
                    self.inline_children(c, &sub, out);
                }
                "fldSimple" => {
                    let link = wattr(c, "instr").and_then(parse_field_link).or_else(|| ctx.link.clone());
                    let sub = RunCtx { link, base: ctx.base, reference: ctx.reference };
                    self.inline_children(c, &sub, out);
                }
                "sdt" => {
                    if let Some(sc) = child(c, "sdtContent") {
                        self.inline_children(sc, ctx, out);
                    }
                }
                "ins" | "smartTag" | "customXml" | "moveTo" | "dir" | "bdo" | "sdtContent" => {
                    self.inline_children(c, ctx, out)
                }
                "oMath" | "oMathPara" => {
                    let text: String = c.descendants().filter(|d| is(*d, "t")).filter_map(|d| d.text()).collect();
                    if !text.is_empty() {
                        out.push(Inl::Text(text, Vec::new()));
                    }
                }
                _ => {}
            }
        }
    }

    fn hyperlink_href(&self, h: Node) -> Option<String> {
        let anchor = wattr(h, "anchor").filter(|a| !a.is_empty());
        let target = rattr(h, "id").and_then(|id| self.rels.get(id)).filter(|r| r.external).map(|r| r.target.clone());
        match (target, anchor) {
            (Some(t), Some(a)) => Some(format!("{t}#{a}")),
            (Some(t), None) => Some(t),
            (None, Some(a)) => Some(format!("#{a}")),
            (None, None) => None,
        }
        .filter(|h| !h.trim().is_empty())
    }

    fn run(&mut self, r: Node, ctx: &RunCtx, out: &mut Vec<Inl>) {
        let rpr = child(r, "rPr");
        let direct = rpr.map(|n| parse_rpr(n, &self.theme)).unwrap_or_default();
        let mut props = ctx.base.clone();
        let mut code = false;
        if let Some(rs) = rpr.and_then(|n| child(n, "rStyle")).and_then(wval) {
            let name = self.styles.map.get(rs).map(|s| s.name.clone()).unwrap_or_default();
            let lid = rs.to_ascii_lowercase();
            if name.contains("hyperlink") || lid.contains("hyperlink") || name == "internet link" {
                // Link styling is implied by the link mark.
            } else if is_code_name(&name) || is_code_name(&lid) {
                code = true;
            } else {
                props.overlay(&self.styles.resolved_rpr(rs));
            }
        }
        props.overlay(&direct);
        let hidden = props.vanish == Some(true);
        let marks = self.marks_for(&props, ctx.reference, code);
        self.run_content(r, ctx, &marks, code, hidden, out);
    }

    fn run_content(&mut self, node: Node, ctx: &RunCtx, marks: &[Value], code: bool, hidden: bool, out: &mut Vec<Inl>) {
        for c in node.children().filter(Node::is_element) {
            let suppressed = hidden || self.in_field_instruction();
            match c.tag_name().name() {
                "t" if !suppressed => {
                    let text = c.text().unwrap_or("");
                    self.push_text(out, text, marks, ctx, code);
                }
                "tab" | "ptab" if !suppressed => self.push_text(out, "\t", marks, ctx, code),
                "noBreakHyphen" if !suppressed => self.push_text(out, "-", marks, ctx, code),
                "sym" if !suppressed => {
                    if let Some(ch) = wattr(c, "char").and_then(sym_char) {
                        self.push_text(out, &ch.to_string(), marks, ctx, code);
                    }
                }
                "br" if !suppressed => match wattr(c, "type") {
                    Some("page") => out.push(Inl::PageBreak),
                    _ => out.push(Inl::Node(json!({ "type": "hardBreak" }))),
                },
                "cr" if !suppressed => out.push(Inl::Node(json!({ "type": "hardBreak" }))),
                "drawing" if !suppressed => {
                    if let Some(img) = self.drawing(c) {
                        out.push(Inl::Node(img));
                    }
                }
                "pict" | "object" if !suppressed => self.legacy_pict(c, out),
                "AlternateContent" if !suppressed => {
                    let before = out.len();
                    if let Some(choice) = child(c, "Choice") {
                        self.run_content(choice, ctx, marks, code, hidden, out);
                    }
                    if out.len() == before {
                        if let Some(fb) = child(c, "Fallback") {
                            self.run_content(fb, ctx, marks, code, hidden, out);
                        }
                    }
                }
                "fldChar" => match wattr(c, "fldCharType") {
                    Some("begin") => {
                        if self.fields.len() < 64 {
                            self.fields.push(Field::default());
                        }
                    }
                    Some("separate") => {
                        if let Some(f) = self.fields.last_mut() {
                            f.separated = true;
                            f.link = parse_field_link(&f.instr);
                        }
                    }
                    Some("end") => {
                        self.fields.pop();
                    }
                    _ => {}
                },
                "instrText" => {
                    if let Some(f) = self.fields.last_mut() {
                        if !f.separated && f.instr.len() < 4096 {
                            f.instr.push_str(c.text().unwrap_or(""));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn in_field_instruction(&self) -> bool {
        self.fields.iter().any(|f| !f.separated)
    }

    fn push_text(&self, out: &mut Vec<Inl>, text: &str, marks: &[Value], ctx: &RunCtx, code: bool) {
        if text.is_empty() {
            return;
        }
        let link = ctx.link.clone().or_else(|| self.fields.iter().rev().find_map(|f| f.link.clone()));
        let mut m = marks.to_vec();
        if let (Some(href), false) = (link, code) {
            m.push(json!({ "type": "link", "attrs": { "href": href, "target": "_blank" } }));
        }
        out.push(Inl::Text(text.to_string(), m));
    }

    fn marks_for(&self, p: &RunProps, reference: &RunProps, code: bool) -> Vec<Value> {
        if code {
            return vec![json!({ "type": "code" })];
        }
        let mut m = Vec::new();
        if p.bold == Some(true) && reference.bold != Some(true) {
            m.push(json!({ "type": "bold" }));
        }
        if p.italic == Some(true) && reference.italic != Some(true) {
            m.push(json!({ "type": "italic" }));
        }
        if p.underline == Some(true) {
            m.push(json!({ "type": "underline" }));
        }
        if p.strike == Some(true) {
            m.push(json!({ "type": "strike" }));
        }
        match p.vert {
            Some(1) => m.push(json!({ "type": "superscript" })),
            Some(-1) => m.push(json!({ "type": "subscript" })),
            _ => {}
        }
        let font = p.font.as_ref().filter(|f| {
            !f.eq_ignore_ascii_case(&self.defaults.font_family)
                && reference.font.as_ref().is_none_or(|r| !r.eq_ignore_ascii_case(f))
        });
        let size = p.size.filter(|s| {
            (s - self.defaults.font_size).abs() > 0.01 && reference.size.is_none_or(|r| (r - s).abs() > 0.01)
        });
        let ref_color = reference.color.as_deref().and_then(valid_hex);
        let color = p
            .color
            .as_deref()
            .and_then(valid_hex)
            .filter(|c| !near_black(c))
            .filter(|c| ref_color.as_deref() != Some(c.as_str()));
        if font.is_some() || size.is_some() || color.is_some() {
            m.push(json!({
                "type": "textStyle",
                "attrs": {
                    "fontFamily": font,
                    "fontSize": size.map(fmt_pt),
                    "color": color.map(|c| format!("#{c}")),
                }
            }));
        }
        let highlight = p
            .highlight
            .as_deref()
            .and_then(highlight_hex)
            .map(str::to_string)
            .or_else(|| p.shd.as_deref().and_then(valid_hex).filter(|c| c != "ffffff"));
        if let Some(h) = highlight {
            m.push(json!({ "type": "highlight", "attrs": { "color": format!("#{h}") } }));
        }
        m
    }

    // -- images -------------------------------------------------------------

    fn drawing(&mut self, d: Node) -> Option<Value> {
        let container = d.children().find(|c| is(*c, "inline") || is(*c, "anchor"))?;
        let blip = container.descendants().find(|n| is(*n, "blip"))?;
        let rid = rattr(blip, "embed")?;
        let src = self.image_src(rid)?;
        let extent = child(container, "extent");
        let px = |a: &str| {
            extent
                .and_then(|e| e.attribute(a))
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|v| *v > 0.0 && v.is_finite())
                .map(|v| (v / 9525.0).round().max(1.0) as i64)
        };
        let doc_pr = child(container, "docPr");
        let alt = doc_pr.and_then(|n| n.attribute("descr")).filter(|s| !s.is_empty());
        let title = doc_pr.and_then(|n| n.attribute("title")).filter(|s| !s.is_empty());
        let wrap = if is(container, "anchor") {
            let align = child(container, "positionH")
                .and_then(|p| child(p, "align"))
                .and_then(|a| a.text())
                .map(|s| s.trim());
            let top_bottom = child(container, "wrapTopAndBottom").is_some();
            match align {
                Some("right") => Some("wrap-right"),
                Some("center") | _ if top_bottom => Some("center"),
                _ => Some("wrap-left"),
            }
        } else {
            None
        };
        Some(image_node(src, alt, title, px("cx"), px("cy"), wrap))
    }

    fn legacy_pict(&mut self, pict: Node, out: &mut Vec<Inl>) {
        for d in pict.descendants().filter(Node::is_element) {
            let hr = d.attributes().any(|a| a.name() == "hr" && matches!(a.value(), "t" | "true"));
            if hr {
                out.push(Inl::Hr);
                return;
            }
            if d.tag_name().name() == "imagedata" {
                let Some(rid) = rattr(d, "id").or_else(|| d.attributes().find(|a| a.name() == "relid").map(|a| a.value())) else {
                    continue;
                };
                let Some(src) = self.image_src(rid) else { continue };
                let style = d.ancestors().find(|a| is(*a, "shape")).and_then(|s| s.attribute("style")).unwrap_or("");
                let (w, h) = vml_size(style);
                let title = d.attribute(("urn:schemas-microsoft-com:office:office", "title")).filter(|s| !s.is_empty());
                out.push(Inl::Node(image_node(src, None, title, w, h, None)));
                return;
            }
        }
    }

    fn image_src(&mut self, rid: &str) -> Option<String> {
        let rel = self.rels.get(rid)?;
        if rel.external {
            return None;
        }
        let path = rel.target.clone();
        if let Some(cached) = self.images.get(&path) {
            return cached.clone();
        }
        let src = self.pkg.read(&path, MAX_IMAGE).and_then(|bytes| {
            let mime = sniff_mime(&bytes).or_else(|| mime_from_ext(&path))?;
            Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
        });
        self.images.insert(path, src.clone());
        src
    }

    // -- tables -------------------------------------------------------------

    fn table(&mut self, tbl: Node) -> Option<Value> {
        if self.depth > MAX_DEPTH {
            return None;
        }
        struct Cell {
            col: usize,
            span: usize,
            rowspan: usize,
            bg: Option<String>,
            widths: Option<Vec<i64>>,
            content: Vec<Value>,
        }

        let grid: Vec<i64> = child(tbl, "tblGrid")
            .map(|g| g.children().filter(|c| is(*c, "gridCol")).map(|c| wattr(c, "w").and_then(parse_i64).unwrap_or(0)).collect())
            .unwrap_or_default();
        let mut trs = Vec::new();
        collect_wrapped(tbl, "tr", &mut trs, 0);

        let mut rows: Vec<(bool, Vec<Cell>)> = Vec::new();
        let mut active: HashMap<usize, (usize, usize)> = HashMap::new();
        for tr in trs {
            let trpr = child(tr, "trPr");
            let header = trpr.and_then(|t| child(t, "tblHeader")).is_some_and(on);
            let mut col = trpr
                .and_then(|t| child(t, "gridBefore"))
                .and_then(wval)
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(0)
                .min(64);
            let mut tcs = Vec::new();
            collect_wrapped(tr, "tc", &mut tcs, 0);
            let row_index = rows.len();
            let mut cells: Vec<Cell> = Vec::new();
            let mut seen: HashSet<usize> = HashSet::new();
            for tc in tcs {
                let tcpr = child(tc, "tcPr");
                let span = tcpr
                    .and_then(|p| child(p, "gridSpan"))
                    .and_then(wval)
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(1)
                    .clamp(1, 64);
                let vmerge = tcpr.and_then(|p| child(p, "vMerge")).map(|v| wval(v) == Some("restart"));
                if vmerge == Some(false) {
                    if let Some(&(orow, oidx)) = active.get(&col) {
                        if let Some(origin) = rows.get_mut(orow).and_then(|r| r.1.get_mut(oidx)) {
                            if origin.span == span {
                                origin.rowspan += 1;
                                seen.insert(col);
                                col += span;
                                continue;
                            }
                        }
                    }
                }
                for c in col..col + span {
                    active.remove(&c);
                }
                if vmerge == Some(true) {
                    active.insert(col, (row_index, cells.len()));
                    seen.insert(col);
                }
                let bg = tcpr
                    .and_then(|p| child(p, "shd"))
                    .and_then(|s| wattr(s, "fill"))
                    .and_then(valid_hex)
                    .map(|h| format!("#{h}"));
                let tcw_dxa = tcpr.and_then(|p| child(p, "tcW")).and_then(|w| {
                    if wattr(w, "type").unwrap_or("dxa") == "dxa" {
                        wattr(w, "w").and_then(parse_i64).filter(|v| *v > 0)
                    } else {
                        None
                    }
                });
                let from_grid: Option<Vec<i64>> =
                    (col..col + span).map(|c| grid.get(c).copied().filter(|w| *w > 0).map(twips_to_px)).collect();
                let widths = if span == 1 {
                    tcw_dxa.map(|w| vec![twips_to_px(w)]).or(from_grid)
                } else {
                    from_grid.or_else(|| tcw_dxa.map(|w| vec![twips_to_px(w / span as i64); span]))
                };

                let mut flats = Vec::new();
                self.block_flats(tc, &mut flats);
                let content = self.group(flats);
                cells.push(Cell { col, span, rowspan: 1, bg, widths, content });
                col += span;
            }
            active.retain(|c, _| seen.contains(c));
            rows.push((header, cells));
        }

        // Rows made only of merge continuations vanish; shrink spans across them.
        let empty: Vec<bool> = rows.iter().map(|r| r.1.is_empty()).collect();
        let n = rows.len();
        for (i, row) in rows.iter_mut().enumerate() {
            for cell in row.1.iter_mut() {
                let end = (i + cell.rowspan).min(n);
                let covered = (i + 1..end).filter(|j| empty[*j]).count();
                cell.rowspan = (cell.rowspan - covered).max(1);
            }
        }

        let mut out_rows = Vec::new();
        for (header, cells) in rows.into_iter().filter(|r| !r.1.is_empty()) {
            let mut sorted = cells;
            sorted.sort_by_key(|c| c.col);
            let cells_json: Vec<Value> = sorted
                .into_iter()
                .map(|cell| {
                    let mut content = cell.content;
                    if header {
                        for b in content.iter_mut() {
                            strip_bold(b);
                        }
                    }
                    if !content.iter().any(|b| node_type(b) == "paragraph") {
                        content.push(json!({ "type": "paragraph" }));
                    }
                    json!({
                        "type": if header { "tableHeader" } else { "tableCell" },
                        "attrs": {
                            "colspan": cell.span,
                            "rowspan": cell.rowspan,
                            "colwidth": cell.widths,
                            "backgroundColor": cell.bg,
                        },
                        "content": content,
                    })
                })
                .collect();
            out_rows.push(json!({ "type": "tableRow", "content": cells_json }));
        }
        if out_rows.is_empty() {
            return None;
        }
        Some(json!({ "type": "table", "content": out_rows }))
    }
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

fn flush_code(code: &mut Option<String>, out: &mut Vec<Value>) {
    if let Some(text) = code.take() {
        let mut node = json!({ "type": "codeBlock", "attrs": { "language": null } });
        if !text.is_empty() {
            node["content"] = json!([{ "type": "text", "text": text }]);
        }
        out.push(node);
    }
}

fn flush_quote(quote: &mut Vec<Value>, out: &mut Vec<Value>) {
    if !quote.is_empty() {
        out.push(json!({ "type": "blockquote", "content": std::mem::take(quote) }));
    }
}

fn close_top(stack: &mut Vec<OpenList>, out: &mut Vec<Value>) {
    let Some(list) = stack.pop() else { return };
    let node = list.into_node();
    match stack.last_mut().and_then(|parent| parent.items.last_mut()) {
        Some(item) => item.1.push(node),
        None => out.push(node),
    }
}

fn close_all(stack: &mut Vec<OpenList>, out: &mut Vec<Value>) {
    while !stack.is_empty() {
        close_top(stack, out);
    }
}

/// Deepest open list whose item indentation the paragraph lines up with.
fn continuation_target(stack: &[OpenList], ind_left: i64) -> Option<usize> {
    if ind_left <= 0 {
        return None;
    }
    stack.iter().rposition(|l| ind_left >= 720 * (l.ilvl as i64 + 1) - 60)
}

fn remove_attr(node: &mut Value, key: &str) {
    if let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut) {
        attrs.remove(key);
        if attrs.is_empty() {
            if let Some(obj) = node.as_object_mut() {
                obj.remove("attrs");
            }
        }
    }
}

fn task_prefix(node: &Value) -> Option<bool> {
    let first = node.get("content")?.as_array()?.first()?;
    let text = first.get("text")?.as_str()?;
    match text.chars().next()? {
        '\u{2610}' => Some(false),
        '\u{2611}' | '\u{2612}' => Some(true),
        _ => None,
    }
}

fn strip_task_prefix(node: &mut Value) {
    let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) else { return };
    let Some(first) = content.first_mut() else { return };
    let Some(text) = first.get("text").and_then(Value::as_str) else { return };
    let mut chars = text.chars();
    if !matches!(chars.next(), Some('\u{2610}' | '\u{2611}' | '\u{2612}')) {
        return;
    }
    let rest = chars.as_str();
    let rest = rest.strip_prefix(' ').unwrap_or(rest).to_string();
    if rest.is_empty() {
        content.remove(0);
    } else {
        first["text"] = json!(rest);
    }
    if content.is_empty() {
        if let Some(obj) = node.as_object_mut() {
            obj.remove("content");
        }
    }
}

fn strip_bold(v: &mut Value) {
    if node_type(v) == "text" {
        if let Some(marks) = v.get_mut("marks").and_then(Value::as_array_mut) {
            marks.retain(|m| node_type(m) != "bold");
            if marks.is_empty() {
                if let Some(obj) = v.as_object_mut() {
                    obj.remove("marks");
                }
            }
        }
    }
    if let Some(content) = v.get_mut("content").and_then(Value::as_array_mut) {
        for c in content {
            strip_bold(c);
        }
    }
}

/// Collect `name` children, transparently descending into content controls
/// and custom XML wrappers.
fn collect_wrapped<'a, 'i>(n: Node<'a, 'i>, name: &str, out: &mut Vec<Node<'a, 'i>>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    for c in n.children().filter(Node::is_element) {
        let local = c.tag_name().name();
        if local == name {
            out.push(c);
        } else if local == "sdt" {
            if let Some(sc) = child(c, "sdtContent") {
                collect_wrapped(sc, name, out, depth + 1);
            }
        } else if matches!(local, "customXml" | "sdtContent" | "ins" | "moveTo") {
            collect_wrapped(c, name, out, depth + 1);
        }
    }
}

/// Inline items -> ProseMirror inline nodes, merging adjacent equal-mark text.
fn build_content(items: Vec<Inl>) -> Vec<Value> {
    let mut merged: Vec<Inl> = Vec::with_capacity(items.len());
    for it in items {
        if let (Inl::Text(s, m), Some(Inl::Text(ps, pm))) = (&it, merged.last_mut()) {
            if pm == m {
                ps.push_str(s);
                continue;
            }
        }
        merged.push(it);
    }
    merged
        .into_iter()
        .filter_map(|it| match it {
            Inl::Text(s, _) if s.is_empty() => None,
            Inl::Text(s, m) if m.is_empty() => Some(json!({ "type": "text", "text": s })),
            Inl::Text(s, m) => Some(json!({ "type": "text", "text": s, "marks": m })),
            Inl::Node(n) => Some(n),
            _ => None,
        })
        .collect()
}

fn image_node(
    src: String,
    alt: Option<&str>,
    title: Option<&str>,
    w: Option<i64>,
    h: Option<i64>,
    wrap: Option<&str>,
) -> Value {
    let mut attrs = json!({ "src": src, "alt": alt, "title": title, "width": w, "height": h });
    if let Some(wr) = wrap {
        attrs["wrap"] = json!(wr);
    }
    json!({
        "type": "image",
        "attrs": attrs
    })
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

fn section_settings(body: Node, pkg: &mut Package, rels: &HashMap<String, Rel>) -> PageSettings {
    let sect = body
        .children()
        .filter(|n| is(*n, "sectPr"))
        .last()
        .or_else(|| body.descendants().filter(|n| is(*n, "sectPr")).last());
    let Some(sect) = sect else { return PageSettings::default() };
    let pg = child(sect, "pgSz");
    let dim = |a: &str| pg.and_then(|p| wattr(p, a)).and_then(parse_i64).filter(|v| *v > 0).map(|v| v as u32);
    let landscape = pg.and_then(|p| wattr(p, "orient")) == Some("landscape");
    let (size, orientation) = match (dim("w"), dim("h")) {
        (Some(w), Some(h)) => PageSettings::from_twips(w, h, landscape),
        _ => ("A4".to_string(), if landscape { "landscape" } else { "portrait" }.to_string()),
    };
    let mar = child(sect, "pgMar");
    let inches = |a: &str| {
        mar.and_then(|m| wattr(m, a))
            .and_then(parse_i64)
            .map(|v| (v.abs() as f64 / 1440.0 * 100.0).round() / 100.0)
            .unwrap_or(1.0)
    };

    let read_ref_xml = |tag: &str, pkg: &mut Package| -> Option<String> {
        let node = sect
            .children()
            .filter(|n| is(*n, tag))
            .find(|n| wattr(*n, "type").unwrap_or("default") == "default")
            .or_else(|| sect.children().find(|n| is(*n, tag)))?;
        let rid = rattr(node, "id")?;
        let rel = rels.get(rid).filter(|r| !r.external)?;
        pkg.read_text(&rel.target)
    };

    let header = read_ref_xml("headerReference", pkg).and_then(|xml| {
        let doc = Document::parse(&xml).ok()?;
        let mut s = String::new();
        for t in doc.descendants().filter(|n| is(*n, "t")) {
            if let Some(txt) = t.text() {
                s.push_str(txt);
            }
        }
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });

    let mut footer = None;
    let mut page_numbers = None;
    if let Some(xml) = read_ref_xml("footerReference", pkg) {
        if let Ok(doc) = Document::parse(&xml) {
            let has_page_field = doc.descendants().any(|n| {
                (is(n, "fldSimple") && wattr(n, "instr").is_some_and(|i| i.to_ascii_uppercase().contains("PAGE")))
                    || (is(n, "instrText") && n.text().is_some_and(|i| i.to_ascii_uppercase().contains("PAGE")))
            });
            if has_page_field {
                page_numbers = Some(true);
            }
            let mut s = String::new();
            for t in doc.descendants().filter(|n| is(*n, "t")) {
                if t.ancestors().any(|a| is(a, "fldSimple")) {
                    continue;
                }
                if let Some(txt) = t.text() {
                    s.push_str(txt);
                }
            }
            let cleaned = s
                .trim()
                .trim_end_matches("· Page")
                .trim_end_matches("· Page ")
                .trim();
            if !cleaned.is_empty() {
                footer = Some(cleaned.to_string());
            }
        }
    }

    PageSettings {
        size,
        orientation,
        margins: Margins { top: inches("top"), right: inches("right"), bottom: inches("bottom"), left: inches("left") },
        header,
        footer,
        page_numbers,
        doodle_under: None,
        doodle_over: None,
    }
}

fn map_jc(v: &str) -> Option<&'static str> {
    match v {
        "center" => Some("center"),
        "right" | "end" => Some("right"),
        "both" | "distribute" | "justify" | "lowKashida" | "mediumKashida" | "highKashida" | "thaiDistribute" => {
            Some("justify")
        }
        _ => None,
    }
}

fn ordered_type(fmt: &str) -> &'static str {
    match fmt {
        "lowerLetter" => "a",
        "upperLetter" => "A",
        "lowerRoman" => "i",
        "upperRoman" => "I",
        _ => "1",
    }
}

/// `"1.50"` -> `"1.5"`, `"2.00"` -> `"2"`.
fn fmt_num(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn fmt_pt(pt: f64) -> String {
    let v = (pt * 2.0).round() / 2.0;
    if v.fract() == 0.0 {
        format!("{}pt", v as i64)
    } else {
        format!("{v}pt")
    }
}

fn twips_to_px(tw: i64) -> i64 {
    ((tw as f64) / 15.0).round().max(1.0) as i64
}

/// Six hex digits -> lower-case; anything else (incl. `auto`) -> `None`.
fn valid_hex(s: &str) -> Option<String> {
    let s = s.trim().trim_start_matches('#');
    (s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_ascii_lowercase())
}

/// Relative luminance below 0.12 (near-black text follows the theme colour).
fn near_black(hex: &str) -> bool {
    let Ok(v) = u32::from_str_radix(hex, 16) else { return true };
    let lin = |c: u32| {
        let c = c as f64 / 255.0;
        if c <= 0.039_28 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let l = 0.2126 * lin((v >> 16) & 0xFF) + 0.7152 * lin((v >> 8) & 0xFF) + 0.0722 * lin(v & 0xFF);
    l < 0.12
}

fn highlight_hex(name: &str) -> Option<&'static str> {
    Some(match name {
        "yellow" => "ffff00",
        "green" => "00ff00",
        "cyan" => "00ffff",
        "magenta" => "ff00ff",
        "blue" => "0000ff",
        "red" => "ff0000",
        "darkBlue" => "000080",
        "darkCyan" => "008080",
        "darkGreen" => "008000",
        "darkMagenta" => "800080",
        "darkRed" => "800000",
        "darkYellow" => "808000",
        "darkGray" => "808080",
        "lightGray" => "c0c0c0",
        "black" => "000000",
        _ => return None,
    })
}

fn sym_char(hex: &str) -> Option<char> {
    let code = u32::from_str_radix(hex.trim(), 16).ok()?;
    if (0xF000..=0xF0FF).contains(&code) {
        // Symbol-font private-use range: only map the common bullet.
        return match code - 0xF000 {
            0xB7 => Some('\u{2022}'),
            _ => None,
        };
    }
    char::from_u32(code).filter(|c| !c.is_control())
}

fn parse_field_link(instr: &str) -> Option<String> {
    let t = instr.trim();
    if !t.get(..9).is_some_and(|h| h.eq_ignore_ascii_case("HYPERLINK")) {
        return None;
    }
    let mut toks = Vec::new();
    let mut chars = t[9..].chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else if c == '"' {
            chars.next();
            let tok: String = chars.by_ref().take_while(|c| *c != '"').collect();
            toks.push(tok);
        } else {
            let mut tok = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                tok.push(c);
                chars.next();
            }
            toks.push(tok);
        }
    }
    let (mut url, mut anchor) = (None, None);
    let mut i = 0;
    while i < toks.len() {
        let tok = &toks[i];
        if tok.eq_ignore_ascii_case("\\l") {
            anchor = toks.get(i + 1).cloned();
            i += 2;
        } else if tok.starts_with('\\') {
            i += if matches!(tok.to_ascii_lowercase().as_str(), "\\o" | "\\t") { 2 } else { 1 };
        } else {
            if url.is_none() {
                url = Some(tok.clone());
            }
            i += 1;
        }
    }
    match (url.filter(|u| !u.is_empty()), anchor.filter(|a| !a.is_empty())) {
        (Some(u), Some(a)) => Some(format!("{u}#{a}")),
        (Some(u), None) => Some(u),
        (None, Some(a)) => Some(format!("#{a}")),
        _ => None,
    }
}

/// `width:100pt;height:50pt` (VML shape style) -> px.
fn vml_size(style: &str) -> (Option<i64>, Option<i64>) {
    let mut w = None;
    let mut h = None;
    for decl in style.split(';') {
        let Some((k, v)) = decl.split_once(':') else { continue };
        let v = v.trim().to_ascii_lowercase();
        let px = if let Some(n) = v.strip_suffix("pt") {
            n.trim().parse::<f64>().ok().map(|n| n * 96.0 / 72.0)
        } else if let Some(n) = v.strip_suffix("in") {
            n.trim().parse::<f64>().ok().map(|n| n * 96.0)
        } else if let Some(n) = v.strip_suffix("px") {
            n.trim().parse::<f64>().ok()
        } else {
            v.parse::<f64>().ok()
        }
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.round().max(1.0) as i64);
        match k.trim().to_ascii_lowercase().as_str() {
            "width" => w = px,
            "height" => h = px,
            _ => {}
        }
    }
    (w, h)
}

fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.starts_with(b"BM") {
        Some("image/bmp")
    } else if b.len() > 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn mime_from_ext(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" | "jpe" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        // EMF/WMF/TIFF cannot be displayed by the webview.
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::export::tests::{sample_doc, sample_page};
    use super::super::export_docx;
    use super::*;
    use std::io::Write;

    /// Assert the contract's schema rules hold everywhere in the tree.
    fn assert_schema(v: &Value) {
        let t = node_type(v);
        match t {
            "text" => {
                assert!(!v["text"].as_str().unwrap_or("").is_empty(), "empty text node");
                return;
            }
            "doc" => assert!(!v["content"].as_array().unwrap().is_empty(), "empty doc"),
            "listItem" | "taskItem" => {
                assert_eq!(node_type(&v["content"][0]), "paragraph", "list item must start with a paragraph: {v}");
            }
            "tableCell" | "tableHeader" => {
                let content = v["content"].as_array().expect("cell content");
                assert!(content.iter().any(|c| node_type(c) == "paragraph"), "cell without paragraph");
            }
            "tableRow" => assert!(!v["content"].as_array().unwrap().is_empty(), "empty row"),
            "bulletList" | "orderedList" | "taskList" | "blockquote" | "table" => {
                assert!(!v["content"].as_array().unwrap().is_empty(), "empty {t}");
            }
            _ => {}
        }
        if let Some(c) = v.get("content").and_then(Value::as_array) {
            for k in c {
                assert_schema(k);
            }
        }
    }

    fn text_of(v: &Value) -> String {
        if node_type(v) == "text" {
            return v["text"].as_str().unwrap_or("").to_string();
        }
        v.get("content").and_then(Value::as_array).map(|c| c.iter().map(text_of).collect()).unwrap_or_default()
    }

    fn find_text<'v>(v: &'v Value, needle: &str) -> Option<&'v Value> {
        if node_type(v) == "text" && v["text"].as_str() == Some(needle) {
            return Some(v);
        }
        v.get("content")?.as_array()?.iter().find_map(|c| find_text(c, needle))
    }

    fn has_mark(t: &Value, mark: &str) -> bool {
        t["marks"].as_array().is_some_and(|m| m.iter().any(|m| node_type(m) == mark))
    }

    fn mark<'v>(t: &'v Value, mark: &str) -> &'v Value {
        t["marks"].as_array().and_then(|m| m.iter().find(|m| node_type(m) == mark)).unwrap_or(&Value::Null)
    }

    #[test]
    fn round_trip_rich_document() {
        let bytes = export_docx(&sample_doc(), &sample_page(), &DocDefaults::default(), "Round trip").unwrap();
        let imported = import_docx(&bytes).unwrap();
        let doc = &imported.doc;
        assert_schema(doc);

        assert_eq!(imported.page, sample_page());
        assert_eq!(imported.defaults, DocDefaults::default());

        let blocks = doc["content"].as_array().unwrap();
        let types: Vec<&str> = blocks.iter().map(node_type).collect();
        assert_eq!(
            types,
            vec![
                "paragraph", "heading", "paragraph", "bulletList", "taskList", "table", "paragraph", "pageBreak",
                "horizontalRule", "codeBlock", "blockquote", "paragraph"
            ]
        );

        // Title + heading.
        assert_eq!(blocks[0]["attrs"]["styleName"], "Title");
        assert_eq!(text_of(&blocks[0]), "Quarterly Report");
        assert_eq!(blocks[1]["attrs"]["level"], 1);
        assert_eq!(blocks[1]["attrs"]["textAlign"], "center");
        assert_eq!(text_of(&blocks[1]), "Overview & <Summary>");

        // Rich paragraph.
        let p = &blocks[2];
        assert_eq!(p["attrs"]["textAlign"], "justify");
        assert_eq!(p["attrs"]["lineHeight"], "1.5");
        assert_eq!(p["attrs"]["indent"], 2);
        assert!(has_mark(find_text(p, "bold").unwrap(), "bold"));
        let styled = find_text(p, "styled").unwrap();
        assert!(has_mark(styled, "italic"));
        let ts = &mark(styled, "textStyle")["attrs"];
        assert_eq!(ts["fontFamily"], "Georgia");
        assert_eq!(ts["fontSize"], "14pt");
        assert_eq!(ts["color"], "#c0392b");
        let marked = find_text(p, " marked").unwrap();
        assert_eq!(mark(marked, "highlight")["attrs"]["color"], "#fef08a");
        assert!(has_mark(marked, "underline"));
        assert!(p["content"].as_array().unwrap().iter().any(|n| node_type(n) == "hardBreak"));
        assert!(has_mark(find_text(p, "2").unwrap(), "superscript"));
        let code = find_text(p, "\tcode()").unwrap();
        assert_eq!(code["marks"].as_array().unwrap().len(), 1);
        assert!(has_mark(code, "code"));
        let our = find_text(p, "our ").unwrap();
        assert_eq!(mark(our, "link")["attrs"]["href"], "https://example.com/a%20b?x=1&y=2");
        let site = find_text(p, "site").unwrap();
        assert!(has_mark(site, "link") && has_mark(site, "bold"));
        assert!(text_of(p).ends_with(" now."));

        // Lists.
        let bullets = &blocks[3]["content"];
        assert_eq!(bullets.as_array().unwrap().len(), 2);
        let nested = &bullets[0]["content"][1];
        assert_eq!(node_type(nested), "orderedList");
        assert_eq!(nested["attrs"]["start"], 3);
        assert_eq!(nested["attrs"]["type"], "1");
        assert_eq!(nested["content"].as_array().unwrap().len(), 2);
        assert_eq!(text_of(&nested["content"][1]), "Nested four");
        let second = bullets[1]["content"].as_array().unwrap();
        assert_eq!(second.len(), 2);
        assert_eq!(text_of(&second[1]), "Bullet two continued");
        assert!(second[1].get("attrs").is_none());

        let tasks = blocks[4]["content"].as_array().unwrap();
        assert_eq!(node_type(&tasks[0]), "taskItem");
        assert_eq!(tasks[0]["attrs"]["checked"], true);
        assert_eq!(tasks[1]["attrs"]["checked"], false);
        assert_eq!(text_of(&tasks[0]), "Done task");

        // Table.
        let rows = blocks[5]["content"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        let h0 = &rows[0]["content"][0];
        assert_eq!(node_type(h0), "tableHeader");
        assert_eq!(h0["attrs"]["colspan"], 2);
        assert_eq!(h0["attrs"]["colwidth"], json!([120, 80]));
        assert!(!has_mark(find_text(h0, "Header AB").unwrap(), "bold"));
        let tall = &rows[1]["content"][0];
        assert_eq!(tall["attrs"]["rowspan"], 2);
        assert_eq!(tall["attrs"]["backgroundColor"], "#dbeafe");
        assert_eq!(rows[1]["content"].as_array().unwrap().len(), 3);
        assert_eq!(rows[2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(text_of(&rows[2]["content"][0]), "B3");

        // Image.
        let img = blocks[6]["content"].as_array().unwrap().iter().find(|n| node_type(n) == "image").unwrap();
        assert!(img["attrs"]["src"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(img["attrs"]["width"], 40);
        assert_eq!(img["attrs"]["height"], 40);
        assert_eq!(img["attrs"]["alt"], "dot");

        // Code / quote.
        assert_eq!(blocks[9]["content"][0]["text"], "fn main() {\n    println!(\"hi\");\n}");
        assert_eq!(blocks[10]["content"].as_array().unwrap().len(), 2);
        assert_eq!(text_of(&blocks[10]["content"][1]), "Second quote line.");
    }

    fn build_docx(files: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

    #[test]
    fn word_style_features() {
        let document = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document {W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:sz w:val="26"/></w:rPr><w:t>Heading</w:t></w:r></w:p>
<w:sdt><w:sdtContent>
<w:p><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t xml:space="preserve">Auto </w:t></w:r><w:r><w:rPr><w:color w:val="222222"/><w:highlight w:val="yellow"/></w:rPr><w:t>dark</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t xml:space="preserve"> kept</w:t></w:r></w:ins><w:proofErr w:type="spellStart"/><w:bookmarkStart w:id="0" w:name="x"/>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://field.example" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>field link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
<w:r><w:rPr><w:b w:val="0"/><w:i/><w:rFonts w:asciiTheme="majorHAnsi"/></w:rPr><w:t xml:space="preserve"> theme</w:t></w:r>
<w:r><w:br w:type="page"/><w:t>after break</w:t></w:r></w:p>
</w:sdtContent></w:sdt>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
<w:p><w:r><w:t>interrupt</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>three</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>three-a</w:t></w:r></w:p>
<w:tbl><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr>
</w:tbl>
<w:p><w:pPr><w:pStyle w:val="Source"/></w:pPr><w:r><w:t>let x = 1;</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Source"/></w:pPr><w:r><w:tab/><w:t>x</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr>
</w:body></w:document>"#
        );
        let styles = format!(
            r#"<w:styles {W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Source"><w:name w:val="Source Code"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>"#
        );
        let numbering = format!(
            r#"<w:numbering {W}><w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="9"/></w:num></w:numbering>"#
        );
        let theme = r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="x"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#;
        let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="/word/numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>"#;
        let bytes = build_docx(&[
            ("word/document.xml", &document),
            ("word/styles.xml", &styles),
            ("word/numbering.xml", &numbering),
            ("word/theme/theme1.xml", theme),
            ("word/_rels/document.xml.rels", rels),
        ]);
        let imported = import_docx(&bytes).unwrap();
        let doc = &imported.doc;
        assert_schema(doc);
        assert_eq!(imported.defaults.font_family, "Aptos");
        assert_eq!(imported.defaults.font_size, 11.0);
        assert_eq!(imported.page.size, "A4");
        assert_eq!(imported.page.margins.left, 1.18);

        let blocks = doc["content"].as_array().unwrap();
        let types: Vec<&str> = blocks.iter().map(node_type).collect();
        assert_eq!(
            types,
            vec!["heading", "paragraph", "pageBreak", "paragraph", "orderedList", "paragraph", "orderedList", "table", "codeBlock"]
        );
        // Heading size equal to the style size is not turned into a mark.
        assert!(blocks[0]["content"][0].get("marks").is_none());
        assert_eq!(blocks[0]["attrs"]["level"], 2);

        let p = &blocks[1];
        assert!(find_text(p, "Auto ").unwrap().get("marks").is_none(), "auto colour dropped");
        let dark = find_text(p, "dark").unwrap();
        assert!(mark(dark, "textStyle").is_null(), "near-black colour dropped");
        assert_eq!(mark(dark, "highlight")["attrs"]["color"], "#ffff00");
        assert!(text_of(p).contains(" kept") && !text_of(p).contains("gone"));
        assert_eq!(mark(find_text(p, "field link").unwrap(), "link")["attrs"]["href"], "https://field.example");
        let theme_run = find_text(p, " theme").unwrap();
        assert!(!has_mark(theme_run, "bold") && has_mark(theme_run, "italic"));
        assert_eq!(mark(theme_run, "textStyle")["attrs"]["fontFamily"], "Aptos Display");
        assert_eq!(text_of(&blocks[3]), "after break");

        // Numbering continues across the interruption; nested level gets "a".
        assert_eq!(blocks[4]["attrs"]["start"], 1);
        assert_eq!(blocks[4]["content"].as_array().unwrap().len(), 2);
        assert_eq!(blocks[6]["attrs"]["start"], 3);
        let nested = &blocks[6]["content"][0]["content"][1];
        assert_eq!(nested["attrs"]["type"], "a");

        // Table: vertical merge + nested table in a spanned cell.
        let rows = blocks[7]["content"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["content"][0]["attrs"]["rowspan"], 2);
        assert_eq!(rows[0]["content"][0]["attrs"]["colwidth"], json!([100]));
        assert_eq!(rows[1]["content"].as_array().unwrap().len(), 1);
        let spanned = &rows[2]["content"][0];
        assert_eq!(spanned["attrs"]["colspan"], 2);
        assert_eq!(spanned["attrs"]["colwidth"], json!([100, 200]));
        assert_eq!(node_type(&spanned["content"][0]), "table");

        assert_eq!(blocks[8]["content"][0]["text"], "let x = 1;\n\tx");
    }

    #[test]
    fn rejects_garbage_and_survives_truncation() {
        assert!(import_docx(b"definitely not a zip").is_err());
        assert!(import_docx(&[]).is_err());
        let bytes = export_docx(&sample_doc(), &sample_page(), &DocDefaults::default(), "t").unwrap();
        for cut in [bytes.len() / 3, bytes.len() / 2, bytes.len() - 10] {
            let _ = import_docx(&bytes[..cut]);
        }
    }

    #[test]
    fn tolerates_missing_parts() {
        let document = format!(r#"<w:document {W}><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>"#);
        let bytes = build_docx(&[("word/document.xml", &document), ("word/styles.xml", "<not-xml")]);
        let imported = import_docx(&bytes).unwrap();
        assert_eq!(imported.doc["content"][0]["content"][0]["text"], "Hi");
        assert_eq!(imported.page, PageSettings::default());

        let empty = format!(r#"<w:document {W}><w:body/></w:document>"#);
        let imported = import_docx(&build_docx(&[("word/document.xml", &empty)])).unwrap();
        assert_eq!(imported.doc["content"][0]["type"], "paragraph");

        assert!(import_docx(&build_docx(&[("word/other.xml", "<x/>")])).is_err());
    }

    #[test]
    fn helpers() {
        assert_eq!(resolve_path("word", "../media/a.png"), "media/a.png");
        assert_eq!(resolve_path("word", "/word/media/a.png"), "word/media/a.png");
        assert_eq!(resolve_path("word", "media/a.png"), "word/media/a.png");
        assert_eq!(fmt_num(1.15), "1.15");
        assert_eq!(fmt_num(2.0), "2");
        assert_eq!(fmt_pt(10.5), "10.5pt");
        assert_eq!(fmt_pt(12.0), "12pt");
        assert!(near_black("333333"));
        assert!(!near_black("c0392b"));
        assert_eq!(parse_field_link(r#"HYPERLINK \l "_Toc1""#).as_deref(), Some("#_Toc1"));
        assert_eq!(parse_field_link(r#" HYPERLINK "http://a.b/" \o "tip""#).as_deref(), Some("http://a.b/"));
        assert_eq!(parse_field_link("PAGE"), None);
        assert_eq!(vml_size("width:72pt;height:1in"), (Some(96), Some(96)));
        assert_eq!(percent_decode("a%20b%zz"), "a b%zz");
    }
}
