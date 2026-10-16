//! ProseMirror JSON -> WordprocessingML (.docx) writer.
//!
//! All XML is written by hand (no DOM) in strict schema order so that the
//! resulting package opens in Microsoft Word without a repair prompt and in
//! LibreOffice without warnings.

use super::{DocDefaults, PageSettings};
use base64::Engine as _;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as _;
use std::io::{Cursor, Write as _};
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP: &str = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const NS_PKG_REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL_OFFICE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const REL_STYLES: &str = "styles";
const REL_NUMBERING: &str = "numbering";
const REL_SETTINGS: &str = "settings";
const REL_HEADER: &str = "header";
const REL_FOOTER: &str = "footer";
const REL_IMAGE: &str = "image";
const REL_HYPERLINK: &str = "hyperlink";

/// Twips per list nesting level / indent step (0.5in).
const INDENT_STEP: u32 = 720;
/// Twips per CSS pixel (96 dpi).
const TWIPS_PER_PX: f64 = 15.0;
/// EMU per CSS pixel (96 dpi).
const EMU_PER_PX: f64 = 9525.0;

// abstractNum ids in numbering.xml
const ABS_BULLET: u32 = 0;
const ABS_TASK: u32 = 1;
const ABS_DEFAULT: u32 = 2;
const ABS_DECIMAL: u32 = 3;
const ABS_LOWER_LETTER: u32 = 4;
const ABS_UPPER_LETTER: u32 = 5;
const ABS_LOWER_ROMAN: u32 = 6;
const ABS_UPPER_ROMAN: u32 = 7;

/// Serialize a ProseMirror document into a `.docx` package.
pub fn export_docx(
    doc: &Value,
    page: &PageSettings,
    defaults: &DocDefaults,
    title: &str,
) -> Result<Vec<u8>, String> {
    let (page_w, page_h) = page.dimensions_twips();
    let margin = |inches: f64| -> i64 { (inches.max(0.0) * 1440.0).round() as i64 };
    let (m_top, m_right, m_bottom, m_left) = (
        margin(page.margins.top),
        margin(page.margins.right),
        margin(page.margins.bottom),
        margin(page.margins.left),
    );
    let text_width = (page_w as i64 - m_left - m_right).max(1440) as u32;

    let mut w = Writer::new(defaults, text_width);

    let mut body = String::with_capacity(16 * 1024);
    let blocks = content(doc);
    w.write_blocks(&mut body, blocks, Ctx::root(text_width));
    if body.is_empty() || body.ends_with("</w:tbl>") {
        body.push_str("<w:p/>");
    }

    let mut sect_refs = String::new();
    let header_xml = page
        .header
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|hdr| {
            let rid = w.add_rel(REL_HEADER, "header1.xml".to_string(), false);
            let _ = write!(sect_refs, r#"<w:headerReference w:type="default" r:id="{rid}"/>"#);
            format!(
                concat!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                    "\n",
                    r#"<w:hdr xmlns:w="{ns}"><w:p><w:r><w:t xml:space="preserve">{hdr}</w:t></w:r></w:p></w:hdr>"#
                ),
                ns = NS_W,
                hdr = esc(hdr)
            )
        });

    let footer_text = page.footer.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let has_page_nums = page.page_numbers.unwrap_or(false);
    let footer_xml = if footer_text.is_some() || has_page_nums {
        let rid = w.add_rel(REL_FOOTER, "footer1.xml".to_string(), false);
        let _ = write!(sect_refs, r#"<w:footerReference w:type="default" r:id="{rid}"/>"#);
        let inner = match (footer_text, has_page_nums) {
            (Some(ft), true) => format!(
                r#"<w:p><w:r><w:t xml:space="preserve">{} · Page </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>"#,
                esc(ft)
            ),
            (Some(ft), false) => format!(
                r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
                esc(ft)
            ),
            (None, true) => String::from(
                r#"<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>"#,
            ),
            (None, false) => String::from("<w:p/>"),
        };
        Some(format!(
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                "\n",
                r#"<w:ftr xmlns:w="{ns}">{inner}</w:ftr>"#
            ),
            ns = NS_W,
            inner = inner
        ))
    } else {
        None
    };

    let orient = if page.orientation == "landscape" { r#" w:orient="landscape""# } else { "" };
    let mut document = String::with_capacity(body.len() + 1024);
    let _ = write!(
        document,
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{NS_W}" xmlns:r="{NS_R}" xmlns:wp="{NS_WP}" xmlns:a="{NS_A}" xmlns:pic="{NS_PIC}"><w:body>{body}<w:sectPr>{sect_refs}<w:pgSz w:w="{page_w}" w:h="{page_h}"{orient}/><w:pgMar w:top="{m_top}" w:right="{m_right}" w:bottom="{m_bottom}" w:left="{m_left}" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>"#
    );

    let mut parts = w.into_parts(document, title, header_xml, footer_xml);
    let under_str = page.doodle_under.as_deref().unwrap_or("").trim();
    let over_str = page.doodle_over.as_deref().unwrap_or("").trim();
    if !under_str.is_empty() || !over_str.is_empty() {
        let doodle_xml = format!(
            concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                "\n",
                r#"<typoDoodles under="{}" over="{}"/>"#
            ),
            esc(under_str),
            esc(over_str)
        );
        parts.push(xml_part("customXml/typo_doodles.xml", doodle_xml));
    }
    write_zip(parts)
}

// ---------------------------------------------------------------------------
// Package assembly
// ---------------------------------------------------------------------------

struct Part {
    name: String,
    data: Vec<u8>,
    compress: bool,
}

fn write_zip(parts: Vec<Part>) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for part in parts {
        let method = if part.compress { CompressionMethod::Deflated } else { CompressionMethod::Stored };
        let opts = SimpleFileOptions::default().compression_method(method);
        zip.start_file(part.name.as_str(), opts).map_err(|e| format!("zip: {e}"))?;
        zip.write_all(&part.data).map_err(|e| format!("zip: {e}"))?;
    }
    let cursor = zip.finish().map_err(|e| format!("zip: {e}"))?;
    Ok(cursor.into_inner())
}

fn xml_part(name: &str, xml: String) -> Part {
    Part { name: name.to_string(), data: xml.into_bytes(), compress: true }
}

// ---------------------------------------------------------------------------
// Writer state
// ---------------------------------------------------------------------------

struct Rel {
    id: String,
    kind: &'static str,
    target: String,
    external: bool,
}

struct Num {
    abstract_id: u32,
    start_override: Option<(u32, u32)>,
}

/// Block-level context while walking the tree.
#[derive(Clone, Copy)]
struct Ctx {
    /// Inside a blockquote.
    quote: bool,
    /// `ilvl` of the enclosing list item, if any.
    depth: Option<u32>,
    /// Inside a table header cell (runs become bold).
    header: bool,
    /// Available width in twips (text width or cell width).
    width: u32,
}

impl Ctx {
    fn root(width: u32) -> Self {
        Self { quote: false, depth: None, header: false, width }
    }
}

#[derive(Default)]
struct ParOpts<'s> {
    style: Option<&'s str>,
    num: Option<(u32, u32)>,
    left_ind: Option<u32>,
    prefix: Option<&'static str>,
    bold: bool,
}

struct Writer<'a> {
    defaults: &'a DocDefaults,
    rels: Vec<Rel>,
    link_rels: HashMap<String, String>,
    media: Vec<(String, Vec<u8>)>,
    exts: BTreeSet<&'static str>,
    nums: Vec<Num>,
    bullet_num: Option<u32>,
    task_num: Option<u32>,
    next_drawing_id: u32,
    /// Current available width in twips, used to fit images.
    width: u32,
}

impl<'a> Writer<'a> {
    fn new(defaults: &'a DocDefaults, width: u32) -> Self {
        let fixed = |n: u32, kind: &'static str, target: &str| Rel {
            id: format!("rId{n}"),
            kind,
            target: target.to_string(),
            external: false,
        };
        Self {
            defaults,
            rels: vec![
                fixed(1, REL_STYLES, "styles.xml"),
                fixed(2, REL_NUMBERING, "numbering.xml"),
                fixed(3, REL_SETTINGS, "settings.xml"),
            ],
            link_rels: HashMap::new(),
            media: Vec::new(),
            exts: BTreeSet::new(),
            nums: Vec::new(),
            bullet_num: None,
            task_num: None,
            next_drawing_id: 1,
            width,
        }
    }

    fn add_rel(&mut self, kind: &'static str, target: String, external: bool) -> String {
        let id = format!("rId{}", self.rels.len() + 1);
        self.rels.push(Rel { id: id.clone(), kind, target, external });
        id
    }

    fn new_num(&mut self, abstract_id: u32, start_override: Option<(u32, u32)>) -> u32 {
        self.nums.push(Num { abstract_id, start_override });
        self.nums.len() as u32
    }

    fn bullet(&mut self) -> u32 {
        if let Some(n) = self.bullet_num {
            return n;
        }
        let n = self.new_num(ABS_BULLET, None);
        self.bullet_num = Some(n);
        n
    }

    fn task(&mut self) -> u32 {
        if let Some(n) = self.task_num {
            return n;
        }
        let n = self.new_num(ABS_TASK, None);
        self.task_num = Some(n);
        n
    }

    // -- blocks -------------------------------------------------------------

    fn write_blocks(&mut self, out: &mut String, blocks: &[Value], ctx: Ctx) {
        for block in blocks {
            // Two adjacent tables would be merged by Word; keep them apart.
            if node_type(block) == "table" && out.ends_with("</w:tbl>") {
                out.push_str("<w:p/>");
            }
            self.write_block(out, block, ctx);
        }
    }

    fn write_block(&mut self, out: &mut String, node: &Value, ctx: Ctx) {
        let saved_width = self.width;
        self.width = ctx.width;
        match node_type(node) {
            "paragraph" => {
                let style = match attr_str(node, "styleName") {
                    Some("Title") => Some("Title"),
                    Some("Subtitle") => Some("Subtitle"),
                    _ if ctx.quote => Some("Quote"),
                    _ if ctx.depth.is_some() => Some("ListParagraph"),
                    _ => None,
                };
                let opts = ParOpts {
                    style,
                    left_ind: ctx.depth.map(|d| INDENT_STEP * (d + 1)),
                    bold: ctx.header,
                    ..Default::default()
                };
                self.write_par(out, node, &opts);
            }
            "heading" => {
                let style = heading_style(node);
                let opts = ParOpts {
                    style: Some(&style),
                    left_ind: ctx.depth.map(|d| INDENT_STEP * (d + 1)),
                    bold: ctx.header,
                    ..Default::default()
                };
                self.write_par(out, node, &opts);
            }
            "blockquote" => {
                self.write_blocks(out, content(node), Ctx { quote: true, ..ctx });
            }
            "codeBlock" => self.write_code_block(out, node),
            "bulletList" | "orderedList" | "taskList" => self.write_list(out, node, ctx),
            "horizontalRule" => out.push_str(
                r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>"#,
            ),
            "pageBreak" => out.push_str(r#"<w:p><w:r><w:br w:type="page"/></w:r></w:p>"#),
            "table" => self.write_table(out, node, ctx),
            "image" | "text" | "hardBreak" => {
                // Stray inline node at block level: wrap it in a paragraph.
                let wrapper = serde_json::json!({ "type": "paragraph", "content": [node.clone()] });
                self.write_par(out, &wrapper, &ParOpts { bold: ctx.header, ..Default::default() });
            }
            _ => {
                let kids = content(node);
                let inline = kids
                    .first()
                    .map(|k| matches!(node_type(k), "text" | "hardBreak" | "image"))
                    .unwrap_or(false);
                if inline {
                    self.write_par(out, node, &ParOpts { bold: ctx.header, ..Default::default() });
                } else {
                    self.write_blocks(out, kids, ctx);
                }
            }
        }
        self.width = saved_width;
    }

    fn write_par(&mut self, out: &mut String, node: &Value, opts: &ParOpts) {
        out.push_str("<w:p>");
        let mut ppr = String::new();
        if let Some(style) = opts.style {
            let _ = write!(ppr, r#"<w:pStyle w:val="{}"/>"#, esc(style));
        }
        if let Some((num, ilvl)) = opts.num {
            let _ = write!(ppr, r#"<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num}"/></w:numPr>"#);
        }
        if let Some(lh) = attr_num(node, "lineHeight").filter(|v| *v > 0.0 && *v < 20.0) {
            let line = (240.0 * lh).round() as u32;
            let _ = write!(ppr, r#"<w:spacing w:line="{line}" w:lineRule="auto"/>"#);
        }
        if opts.num.is_none() {
            let steps = attr_num(node, "indent").map(|v| v.round().clamp(0.0, 8.0) as u32).unwrap_or(0);
            let left = opts.left_ind.unwrap_or(0) + INDENT_STEP * steps;
            if left > 0 {
                let _ = write!(ppr, r#"<w:ind w:left="{left}"/>"#);
            }
        }
        if let Some(jc) = attr_str(node, "textAlign").and_then(|a| match a {
            "left" | "start" => Some("left"),
            "center" => Some("center"),
            "right" | "end" => Some("right"),
            "justify" => Some("both"),
            _ => None,
        }) {
            let _ = write!(ppr, r#"<w:jc w:val="{jc}"/>"#);
        }
        if !ppr.is_empty() {
            let _ = write!(out, "<w:pPr>{ppr}</w:pPr>");
        }
        if let Some(prefix) = opts.prefix {
            let rpr = if opts.bold { "<w:rPr><w:b/><w:bCs/></w:rPr>" } else { "" };
            let _ = write!(out, r#"<w:r>{rpr}<w:t xml:space="preserve">{}</w:t></w:r>"#, esc(prefix));
        }
        self.write_inlines(out, content(node), opts.bold);
        out.push_str("</w:p>");
    }

    fn write_code_block(&mut self, out: &mut String, node: &Value) {
        let mut text = String::new();
        for child in content(node) {
            match node_type(child) {
                "text" => text.push_str(child.get("text").and_then(Value::as_str).unwrap_or("")),
                "hardBreak" => text.push('\n'),
                _ => {}
            }
        }
        for line in text.split('\n') {
            out.push_str(r#"<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>"#);
            let line = line.trim_end_matches('\r');
            if !line.is_empty() {
                out.push_str("<w:r>");
                push_text_content(out, line);
                out.push_str("</w:r>");
            }
            out.push_str("</w:p>");
        }
    }

    fn write_list(&mut self, out: &mut String, node: &Value, ctx: Ctx) {
        let kind = node_type(node);
        let ilvl = ctx.depth.map(|d| d + 1).unwrap_or(0).min(8);
        let num = match kind {
            "bulletList" => self.bullet(),
            "taskList" => self.task(),
            _ => {
                let abs = match attr_str(node, "type") {
                    Some("1") => ABS_DECIMAL,
                    Some("a") => ABS_LOWER_LETTER,
                    Some("A") => ABS_UPPER_LETTER,
                    Some("i") => ABS_LOWER_ROMAN,
                    Some("I") => ABS_UPPER_ROMAN,
                    _ => ABS_DEFAULT,
                };
                let start = attr_num(node, "start").map(|s| s.round().clamp(0.0, 32767.0) as u32).unwrap_or(1);
                self.new_num(abs, Some((ilvl, start)))
            }
        };
        let item_ctx = Ctx { depth: Some(ilvl), ..ctx };
        let list_style = if ctx.quote { "Quote" } else { "ListParagraph" };

        for item in content(node) {
            let is_task = kind == "taskList" || node_type(item) == "taskItem";
            let prefix = if is_task {
                let checked = item.get("attrs").and_then(|a| a.get("checked")).and_then(Value::as_bool).unwrap_or(false);
                Some(if checked { "\u{2611} " } else { "\u{2610} " })
            } else {
                None
            };
            let children = content(item);
            let mut first = true;
            for child in children {
                let t = node_type(child);
                if first && (t == "paragraph" || t == "heading") {
                    let heading;
                    let style = if t == "heading" {
                        heading = heading_style(child);
                        heading.as_str()
                    } else {
                        list_style
                    };
                    let opts = ParOpts { style: Some(style), num: Some((num, ilvl)), prefix, bold: ctx.header, ..Default::default() };
                    self.write_par(out, child, &opts);
                } else {
                    if first {
                        self.write_empty_list_par(out, list_style, num, ilvl, prefix);
                    }
                    self.write_block(out, child, item_ctx);
                }
                first = false;
            }
            if first {
                self.write_empty_list_par(out, list_style, num, ilvl, prefix);
            }
        }
    }

    fn write_empty_list_par(&mut self, out: &mut String, style: &str, num: u32, ilvl: u32, prefix: Option<&'static str>) {
        let empty = serde_json::json!({ "type": "paragraph" });
        let opts = ParOpts { style: Some(style), num: Some((num, ilvl)), prefix, ..Default::default() };
        self.write_par(out, &empty, &opts);
    }

    // -- tables -------------------------------------------------------------

    fn write_table(&mut self, out: &mut String, node: &Value, ctx: Ctx) {
        let rows: Vec<&Value> = content(node).iter().filter(|r| node_type(r) == "tableRow").collect();
        if rows.is_empty() {
            return;
        }
        let layout = table_layout(&rows);
        let ncols = layout
            .iter()
            .flat_map(|r| r.iter().map(|c| c.col + c.span))
            .max()
            .unwrap_or(1)
            .max(1);

        // Column widths (twips).
        let mut widths: Vec<Option<u32>> = vec![None; ncols];
        for row in &layout {
            for cell in row {
                let Some(cell_node) = cell.node else { continue };
                let Some(cw) = cell_node.get("attrs").and_then(|a| a.get("colwidth")).and_then(Value::as_array) else {
                    continue;
                };
                for i in 0..cell.span {
                    if let Some(px) = cw.get(i).and_then(Value::as_f64).filter(|p| *p > 0.0) {
                        if let Some(slot) = widths.get_mut(cell.col + i) {
                            slot.get_or_insert((px * TWIPS_PER_PX).round() as u32);
                        }
                    }
                }
            }
        }
        let known: u32 = widths.iter().flatten().sum();
        let unknown = widths.iter().filter(|w| w.is_none()).count() as u32;
        let all_known = unknown == 0;
        let fill = if unknown == 0 {
            0
        } else if unknown as usize == ncols {
            (ctx.width / unknown).max(1)
        } else {
            (ctx.width.saturating_sub(known) / unknown).max(360)
        };
        let grid: Vec<u32> = widths.iter().map(|w| w.unwrap_or(fill).max(1)).collect();

        out.push_str(r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>"#);
        if all_known {
            let total: u32 = grid.iter().sum();
            let _ = write!(out, r#"<w:tblW w:w="{total}" w:type="dxa"/>"#);
        } else {
            out.push_str(r#"<w:tblW w:w="5000" w:type="pct"/>"#);
        }
        out.push_str(concat!(
            r#"<w:tblBorders>"#,
            r#"<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
            r#"</w:tblBorders>"#,
            r#"<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>"#,
            r#"</w:tblPr><w:tblGrid>"#
        ));
        for g in &grid {
            let _ = write!(out, r#"<w:gridCol w:w="{g}"/>"#);
        }
        out.push_str("</w:tblGrid>");

        for row in &layout {
            out.push_str("<w:tr>");
            let origins: Vec<&CellPos> = row.iter().filter(|c| c.node.is_some()).collect();
            if !origins.is_empty() && origins.iter().all(|c| c.header) {
                out.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            if row.is_empty() {
                let _ = write!(
                    out,
                    r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/><w:gridSpan w:val="{ncols}"/></w:tcPr><w:p/></w:tc>"#,
                    grid.iter().sum::<u32>()
                );
            }
            for cell in row {
                let span_end = (cell.col + cell.span).min(ncols);
                let cell_w: u32 = grid[cell.col.min(ncols)..span_end].iter().sum::<u32>().max(1);
                out.push_str("<w:tc><w:tcPr>");
                let _ = write!(out, r#"<w:tcW w:w="{cell_w}" w:type="dxa"/>"#);
                if cell.span > 1 {
                    let _ = write!(out, r#"<w:gridSpan w:val="{}"/>"#, cell.span);
                }
                if cell.node.is_none() {
                    out.push_str("<w:vMerge/>");
                } else if cell.rowspan > 1 {
                    out.push_str(r#"<w:vMerge w:val="restart"/>"#);
                }
                if let Some(bg) = &cell.bg {
                    let _ = write!(out, r#"<w:shd w:val="clear" w:color="auto" w:fill="{bg}"/>"#);
                }
                out.push_str("</w:tcPr>");
                let mark = out.len();
                if let Some(cell_node) = cell.node {
                    let cell_ctx = Ctx { quote: false, depth: None, header: cell.header, width: cell_w.saturating_sub(216).max(360) };
                    self.write_blocks(out, content(cell_node), cell_ctx);
                }
                let tail = &out[mark..];
                if tail.is_empty() || !(tail.ends_with("</w:p>") || tail.ends_with("<w:p/>")) {
                    out.push_str("<w:p/>");
                }
                out.push_str("</w:tc>");
            }
            out.push_str("</w:tr>");
        }
        out.push_str("</w:tbl>");
    }

    // -- inline content -----------------------------------------------------

    fn write_inlines(&mut self, out: &mut String, nodes: &[Value], bold: bool) {
        let mut open: Option<String> = None;
        for node in nodes {
            let href = link_href(node);
            if href != open {
                if open.is_some() {
                    out.push_str("</w:hyperlink>");
                }
                if let Some(h) = &href {
                    self.open_hyperlink(out, h);
                }
                open = href;
            }
            match node_type(node) {
                "text" => {
                    let text = node.get("text").and_then(Value::as_str).unwrap_or("");
                    if text.is_empty() {
                        continue;
                    }
                    let rpr = self.run_props(marks(node), bold, open.is_some());
                    out.push_str("<w:r>");
                    out.push_str(&rpr);
                    push_text_content(out, text);
                    out.push_str("</w:r>");
                }
                "hardBreak" => out.push_str("<w:r><w:br/></w:r>"),
                "image" => self.write_image(out, node),
                _ => {}
            }
        }
        if open.is_some() {
            out.push_str("</w:hyperlink>");
        }
    }

    fn open_hyperlink(&mut self, out: &mut String, href: &str) {
        if let Some(anchor) = href.strip_prefix('#') {
            let _ = write!(out, r#"<w:hyperlink w:anchor="{}" w:history="1">"#, esc(anchor));
            return;
        }
        let target = sanitize_uri(href);
        let id = match self.link_rels.get(&target) {
            Some(id) => id.clone(),
            None => {
                let id = self.add_rel(REL_HYPERLINK, target.clone(), true);
                self.link_rels.insert(target, id.clone());
                id
            }
        };
        let _ = write!(out, r#"<w:hyperlink r:id="{id}" w:history="1">"#);
    }

    fn run_props(&self, marks: &[Value], force_bold: bool, in_link: bool) -> String {
        let has = |t: &str| marks.iter().any(|m| node_type(m) == t);
        let style = marks.iter().find(|m| node_type(m) == "textStyle");
        let style_attr = |k: &str| style.and_then(|s| s.get("attrs")).and_then(|a| a.get(k)).and_then(Value::as_str);
        let code = has("code");

        let mut r = String::new();
        if code {
            r.push_str(r#"<w:rStyle w:val="InlineCode"/>"#);
        } else if in_link {
            r.push_str(r#"<w:rStyle w:val="Hyperlink"/>"#);
        }
        if !code {
            if let Some(font) = style_attr("fontFamily").and_then(css_first_font) {
                let f = esc(&font);
                let _ = write!(r, r#"<w:rFonts w:ascii="{f}" w:hAnsi="{f}" w:eastAsia="{f}" w:cs="{f}"/>"#);
            }
        }
        if force_bold || has("bold") {
            r.push_str("<w:b/><w:bCs/>");
        }
        if has("italic") {
            r.push_str("<w:i/><w:iCs/>");
        }
        if has("strike") {
            r.push_str("<w:strike/>");
        }
        if let Some(color) = style_attr("color").and_then(parse_css_color) {
            let _ = write!(r, r#"<w:color w:val="{color}"/>"#);
        }
        if let Some(pt) = style_attr("fontSize").and_then(parse_font_size) {
            let half = (pt * 2.0).round().clamp(2.0, 3276.0) as u32;
            let _ = write!(r, r#"<w:sz w:val="{half}"/><w:szCs w:val="{half}"/>"#);
        }
        if has("underline") {
            r.push_str(r#"<w:u w:val="single"/>"#);
        }
        if let Some(h) = marks.iter().find(|m| node_type(m) == "highlight") {
            let fill = h
                .get("attrs")
                .and_then(|a| a.get("color"))
                .and_then(Value::as_str)
                .and_then(parse_css_color)
                .unwrap_or_else(|| "FFFF00".to_string());
            let _ = write!(r, r#"<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>"#);
        }
        if has("superscript") {
            r.push_str(r#"<w:vertAlign w:val="superscript"/>"#);
        } else if has("subscript") {
            r.push_str(r#"<w:vertAlign w:val="subscript"/>"#);
        }
        if r.is_empty() {
            r
        } else {
            format!("<w:rPr>{r}</w:rPr>")
        }
    }

    fn write_image(&mut self, out: &mut String, node: &Value) {
        let Some(src) = attr_str(node, "src") else { return };
        let Some((ext, bytes)) = decode_data_url(src) else { return };

        let intrinsic = imagesize::blob_size(&bytes)
            .ok()
            .map(|s| (s.width as f64, s.height as f64))
            .filter(|(w, h)| *w > 0.0 && *h > 0.0);
        let aw = attr_num(node, "width").filter(|v| *v > 0.0);
        let ah = attr_num(node, "height").filter(|v| *v > 0.0);
        let (mut w, mut h) = match (aw, ah, intrinsic) {
            (Some(w), Some(h), _) => (w, h),
            (Some(w), None, Some((iw, ih))) => (w, w * ih / iw),
            (None, Some(h), Some((iw, ih))) => (h * iw / ih, h),
            (Some(w), None, None) => (w, w),
            (None, Some(h), None) => (h, h),
            (None, None, Some(s)) => s,
            (None, None, None) => (96.0, 96.0),
        };
        let max_w = (self.width as f64 / TWIPS_PER_PX).max(16.0);
        if w > max_w {
            h = h * max_w / w;
            w = max_w;
        }
        let cx = ((w.max(1.0)) * EMU_PER_PX).round() as u64;
        let cy = ((h.max(1.0)) * EMU_PER_PX).round() as u64;

        let index = self.media.len() + 1;
        let file = format!("image{index}.{ext}");
        self.exts.insert(ext);
        self.media.push((file.clone(), bytes));
        let rid = self.add_rel(REL_IMAGE, format!("media/{file}"), false);

        let id = self.next_drawing_id;
        self.next_drawing_id += 1;
        let alt = attr_str(node, "alt").unwrap_or("");
        let title_attr = attr_str(node, "title")
            .filter(|t| !t.is_empty())
            .map(|t| format!(r#" title="{}""#, esc(t)))
            .unwrap_or_default();
        let wrap = attr_str(node, "wrap").unwrap_or("inline");
        let graphic = format!(
            concat!(
                r#"<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>"#,
                r#"<wp:docPr id="{id}" name="Picture {id}" descr="{alt}"{title}/>"#,
                r#"<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>"#,
                r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">"#,
                r#"<pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="{file}"/><pic:cNvPicPr/></pic:nvPicPr>"#,
                r#"<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"#,
                r#"<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>"#,
                r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>"#,
                r#"</a:graphicData></a:graphic>"#
            ),
            cx = cx,
            cy = cy,
            id = id,
            alt = esc(alt),
            title = title_attr,
            file = file,
            rid = rid,
        );
        match wrap {
            "wrap-left" | "wrap-right" | "center" => {
                let align = match wrap {
                    "wrap-left" => "left",
                    "wrap-right" => "right",
                    _ => "center",
                };
                let wrap_xml = if wrap == "center" {
                    r#"<wp:wrapTopAndBottom/>"#
                } else {
                    r#"<wp:wrapSquare wrapText="bothSides"/>"#
                };
                let _ = write!(
                    out,
                    concat!(
                        r#"<w:r><w:drawing><wp:anchor distT="114300" distB="114300" distL="152400" distR="152400" simplePos="0" relativeHeight="25165824" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">"#,
                        r#"<wp:simplePos x="0" y="0"/>"#,
                        r#"<wp:positionH relativeFrom="column"><wp:align>{align}</wp:align></wp:positionH>"#,
                        r#"<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>"#,
                        r#"{extent_and_wrap}</wp:anchor></w:drawing></w:r>"#
                    ),
                    align = align,
                    extent_and_wrap = graphic.replacen(
                        r#"<wp:effectExtent l="0" t="0" r="0" b="0"/>"#,
                        &format!(r#"<wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap_xml}"#),
                        1
                    ),
                );
            }
            _ => {
                let _ = write!(
                    out,
                    r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">{graphic}</wp:inline></w:drawing></w:r>"#
                );
            }
        }
    }

    // -- parts --------------------------------------------------------------

    fn into_parts(
        self,
        document: String,
        title: &str,
        header_xml: Option<String>,
        footer_xml: Option<String>,
    ) -> Vec<Part> {
        let mut parts = Vec::with_capacity(12 + self.media.len());

        // [Content_Types].xml
        let mut ct = String::from(concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
            r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#,
            r#"<Default Extension="xml" ContentType="application/xml"/>"#
        ));
        for ext in &self.exts {
            let _ = write!(ct, r#"<Default Extension="{ext}" ContentType="{}"/>"#, mime_for_ext(ext));
        }
        ct.push_str(concat!(
            r#"<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>"#,
            r#"<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>"#,
            r#"<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>"#,
            r#"<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>"#,
            r#"<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>"#,
            r#"<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>"#,
        ));
        if header_xml.is_some() {
            ct.push_str(r#"<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>"#);
        }
        if footer_xml.is_some() {
            ct.push_str(r#"<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>"#);
        }
        ct.push_str("</Types>");
        parts.push(xml_part("[Content_Types].xml", ct));

        // _rels/.rels
        parts.push(xml_part(
            "_rels/.rels",
            format!(
                concat!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                    "\n",
                    r#"<Relationships xmlns="{pkg}">"#,
                    r#"<Relationship Id="rId1" Type="{off}/officeDocument" Target="word/document.xml"/>"#,
                    r#"<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>"#,
                    r#"<Relationship Id="rId3" Type="{off}/extended-properties" Target="docProps/app.xml"/>"#,
                    r#"</Relationships>"#
                ),
                pkg = NS_PKG_REL,
                off = REL_OFFICE
            ),
        ));

        // docProps
        let now = w3cdtf_now();
        parts.push(xml_part(
            "docProps/core.xml",
            format!(
                concat!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                    "\n",
                    r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
                    r#"<dc:title>{title}</dc:title>"#,
                    r#"<dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>"#,
                    r#"<dcterms:modified xsi:type="dcterms:W3CDTF">{now}</dcterms:modified>"#,
                    r#"</cp:coreProperties>"#
                ),
                title = esc(title),
                now = now
            ),
        ));
        parts.push(xml_part(
            "docProps/app.xml",
            String::from(concat!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
                "\n",
                r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">"#,
                r#"<Application>Typo</Application></Properties>"#
            )),
        ));

        // word/*
        parts.push(xml_part("word/document.xml", document));
        parts.push(xml_part("word/styles.xml", styles_xml(self.defaults)));
        parts.push(xml_part("word/numbering.xml", self.numbering_xml()));
        parts.push(xml_part("word/settings.xml", settings_xml()));
        if let Some(hxml) = header_xml {
            parts.push(xml_part("word/header1.xml", hxml));
        }
        if let Some(fxml) = footer_xml {
            parts.push(xml_part("word/footer1.xml", fxml));
        }

        let mut rels = String::from(concat!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#, "\n"));
        let _ = write!(rels, r#"<Relationships xmlns="{NS_PKG_REL}">"#);
        for rel in &self.rels {
            let mode = if rel.external { r#" TargetMode="External""# } else { "" };
            let _ = write!(
                rels,
                r#"<Relationship Id="{}" Type="{REL_OFFICE}/{}" Target="{}"{mode}/>"#,
                rel.id,
                rel.kind,
                esc(&rel.target)
            );
        }
        rels.push_str("</Relationships>");
        parts.push(xml_part("word/_rels/document.xml.rels", rels));

        for (file, data) in self.media {
            let compress = file.ends_with(".bmp") || file.ends_with(".tiff");
            parts.push(Part { name: format!("word/media/{file}"), data, compress });
        }
        parts
    }

    fn numbering_xml(&self) -> String {
        let font = esc(&self.defaults.font_family);
        let mut x = String::from(concat!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#, "\n"));
        let _ = write!(x, r#"<w:numbering xmlns:w="{NS_W}">"#);

        let abstract_open = |x: &mut String, id: u32| {
            let _ = write!(
                x,
                r#"<w:abstractNum w:abstractNumId="{id}"><w:nsid w:val="{:08X}"/><w:multiLevelType w:val="hybridMultilevel"/>"#,
                0x5459_0000u32 + id
            );
        };

        // Bullets.
        abstract_open(&mut x, ABS_BULLET);
        let bullets = ['\u{2022}', '\u{25E6}', '\u{25AA}'];
        for i in 0..9u32 {
            let ch = bullets[(i % 3) as usize];
            let _ = write!(
                x,
                r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{ch}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}" w:hint="default"/></w:rPr></w:lvl>"#,
                INDENT_STEP * (i + 1)
            );
        }
        x.push_str("</w:abstractNum>");

        // Task lists: no visible number (the checkbox glyph is part of the text).
        abstract_open(&mut x, ABS_TASK);
        for i in 0..9u32 {
            let _ = write!(
                x,
                r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="none"/><w:suff w:val="nothing"/><w:lvlText w:val=""/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{}" w:hanging="0"/></w:pPr></w:lvl>"#,
                INDENT_STEP * (i + 1)
            );
        }
        x.push_str("</w:abstractNum>");

        // Ordered formats.
        let ordered: [(u32, [&str; 3]); 6] = [
            (ABS_DEFAULT, ["decimal", "lowerLetter", "lowerRoman"]),
            (ABS_DECIMAL, ["decimal"; 3]),
            (ABS_LOWER_LETTER, ["lowerLetter"; 3]),
            (ABS_UPPER_LETTER, ["upperLetter"; 3]),
            (ABS_LOWER_ROMAN, ["lowerRoman"; 3]),
            (ABS_UPPER_ROMAN, ["upperRoman"; 3]),
        ];
        for (id, cycle) in ordered {
            abstract_open(&mut x, id);
            for i in 0..9u32 {
                let fmt = cycle[(i % 3) as usize];
                let _ = write!(
                    x,
                    r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="%{}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{}" w:hanging="360"/></w:pPr></w:lvl>"#,
                    i + 1,
                    INDENT_STEP * (i + 1)
                );
            }
            x.push_str("</w:abstractNum>");
        }

        for (i, num) in self.nums.iter().enumerate() {
            let _ = write!(x, r#"<w:num w:numId="{}"><w:abstractNumId w:val="{}"/>"#, i + 1, num.abstract_id);
            if let Some((ilvl, start)) = num.start_override {
                let _ = write!(x, r#"<w:lvlOverride w:ilvl="{ilvl}"><w:startOverride w:val="{start}"/></w:lvlOverride>"#);
            }
            x.push_str("</w:num>");
        }
        x.push_str("</w:numbering>");
        x
    }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

struct CellPos<'v> {
    col: usize,
    span: usize,
    /// `None` = vMerge continuation placeholder.
    node: Option<&'v Value>,
    rowspan: usize,
    header: bool,
    bg: Option<String>,
}

/// Place cells on the grid, inserting vMerge continuation cells for rowspans.
fn table_layout<'v>(rows: &[&'v Value]) -> Vec<Vec<CellPos<'v>>> {
    // start column -> (remaining rows, span, background)
    let mut pending: BTreeMap<usize, (usize, usize, Option<String>)> = BTreeMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut col = 0usize;
        let mut cells: Vec<CellPos<'v>> = Vec::new();
        let mut touched: HashSet<usize> = HashSet::new();
        let emit_pending = |col: &mut usize, cells: &mut Vec<CellPos<'v>>, touched: &mut HashSet<usize>, pending: &mut BTreeMap<usize, (usize, usize, Option<String>)>| {
            while let Some((rem, span, bg)) = pending.get_mut(col) {
                if *rem == 0 || touched.contains(col) {
                    break;
                }
                *rem -= 1;
                let span = *span;
                cells.push(CellPos { col: *col, span, node: None, rowspan: 1, header: false, bg: bg.clone() });
                touched.insert(*col);
                *col += span;
            }
        };
        for cell in content(row).iter().filter(|c| matches!(node_type(c), "tableCell" | "tableHeader")) {
            emit_pending(&mut col, &mut cells, &mut touched, &mut pending);
            let span = attr_num(cell, "colspan").map(|v| v.round().clamp(1.0, 63.0) as usize).unwrap_or(1);
            let rowspan = attr_num(cell, "rowspan").map(|v| v.round().clamp(1.0, 1000.0) as usize).unwrap_or(1);
            let bg = attr_str(cell, "backgroundColor").and_then(parse_css_color);
            if rowspan > 1 {
                pending.insert(col, (rowspan - 1, span, bg.clone()));
                touched.insert(col);
            }
            cells.push(CellPos { col, span, node: Some(cell), rowspan, header: node_type(cell) == "tableHeader", bg });
            col += span;
        }
        // Trailing continuation cells to the right of the last real cell.
        let trailing: Vec<usize> = pending.range(col..).map(|(c, _)| *c).collect();
        for c in trailing {
            if c < col || touched.contains(&c) {
                continue;
            }
            let mut cc = c;
            emit_pending(&mut cc, &mut cells, &mut touched, &mut pending);
            col = cc;
        }
        // Spans that were overlapped by explicit cells still consume this row.
        for (c, (rem, _, _)) in pending.iter_mut() {
            if !touched.contains(c) && *rem > 0 {
                *rem -= 1;
            }
        }
        pending.retain(|_, (rem, _, _)| *rem > 0);
        out.push(cells);
    }
    out
}

// ---------------------------------------------------------------------------
// Static parts
// ---------------------------------------------------------------------------

fn styles_xml(defaults: &DocDefaults) -> String {
    let font = esc(defaults.font_family.trim());
    let font = if font.is_empty() { "Calibri".to_string() } else { font };
    let size = ((defaults.font_size * 2.0).round() as i64).clamp(2, 3276);
    let mut x = String::with_capacity(8 * 1024);
    let _ = write!(
        x,
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<w:styles xmlns:w="{ns}">"#,
            r#"<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="{f}" w:hAnsi="{f}" w:eastAsia="{f}" w:cs="{f}"/>"#,
            r#"<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>"#,
            r#"<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>"#,
            r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>"#,
            r#"<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>"#,
            r#"<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>"#,
            r#"<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>"#,
            r#"<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>"#,
            r#"<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>"#,
            r#"<w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>"#,
            r#"<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/>"#,
            r#"<w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:color w:val="595959"/><w:spacing w:val="15"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>"#
        ),
        ns = NS_W,
        f = font,
        sz = size
    );
    let heading_sizes = [32u32, 28, 24, 22, 22, 22];
    let heading_spacing = [(360u32, 80u32), (160, 80), (160, 80), (80, 40), (80, 40), (40, 0)];
    for level in 1..=6usize {
        let sz = heading_sizes[level - 1];
        let (before, after) = heading_spacing[level - 1];
        let italic = if level >= 4 { "<w:i/><w:iCs/>" } else { "" };
        let _ = write!(
            x,
            concat!(
                r#"<w:style w:type="paragraph" w:styleId="Heading{l}"><w:name w:val="heading {l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/>{hidden}<w:qFormat/>"#,
                r#"<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{b}" w:after="{a}"/><w:outlineLvl w:val="{o}"/></w:pPr>"#,
                r#"<w:rPr><w:b/><w:bCs/>{it}<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>"#
            ),
            l = level,
            hidden = if level > 1 { "<w:unhideWhenUsed/>" } else { "" },
            b = before,
            a = after,
            o = level - 1,
            it = italic,
            sz = sz
        );
    }
    x.push_str(concat!(
        r#"<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>"#,
        r#"<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:spacing w:before="120" w:after="120"/><w:ind w:left="720" w:right="720"/></w:pPr>"#,
        r#"<w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>"#,
        r#"<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:qFormat/>"#,
        r#"<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>"#,
        r#"<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>"#,
        r#"<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>"#,
        r#"<w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>"#,
        r#"<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>"#,
        r#"<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>"#,
        r#"<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:qFormat/>"#,
        r#"<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>"#,
        r#"<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>"#,
        r#"<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>"#,
        r#"<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
        r#"<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>"#,
        r#"<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>"#,
        r#"</w:styles>"#
    ));
    x
}

fn settings_xml() -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<w:settings xmlns:w="{}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>"#,
            r#"<w:characterSpacingControl w:val="doNotCompress"/>"#,
            r#"<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>"#,
            r#"</w:settings>"#
        ),
        NS_W
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Escape text for XML element content and attribute values, dropping
/// characters that are illegal in XML 1.0.
pub(crate) fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            '\t' | '\n' | '\r' => o.push(c),
            c if (c as u32) < 0x20 => {}
            '\u{7F}'..='\u{9F}' | '\u{FFFE}' | '\u{FFFF}' => {}
            c => o.push(c),
        }
    }
    o
}

/// Emit `<w:t>` / `<w:tab/>` / `<w:br/>` for a run's text.
fn push_text_content(out: &mut String, text: &str) {
    let mut buf = String::new();
    let flush = |out: &mut String, buf: &mut String| {
        if !buf.is_empty() {
            let _ = write!(out, r#"<w:t xml:space="preserve">{}</w:t>"#, esc(buf));
            buf.clear();
        }
    };
    for c in text.chars() {
        match c {
            '\t' => {
                flush(out, &mut buf);
                out.push_str("<w:tab/>");
            }
            '\n' => {
                flush(out, &mut buf);
                out.push_str("<w:br/>");
            }
            '\r' => {}
            c => buf.push(c),
        }
    }
    flush(out, &mut buf);
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn content(node: &Value) -> &[Value] {
    node.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn marks(node: &Value) -> &[Value] {
    node.get("marks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn attr_str<'v>(node: &'v Value, key: &str) -> Option<&'v str> {
    node.get("attrs")?.get(key)?.as_str()
}

/// Numeric attribute that may be stored as a number or a string like "240px".
fn attr_num(node: &Value, key: &str) -> Option<f64> {
    let v = node.get("attrs")?.get(key)?;
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().trim_end_matches("px").trim().parse::<f64>().ok()))
        .filter(|f| f.is_finite())
}

fn heading_style(node: &Value) -> String {
    let level = attr_num(node, "level").map(|l| l.round().clamp(1.0, 6.0) as u32).unwrap_or(1);
    format!("Heading{level}")
}

fn link_href(node: &Value) -> Option<String> {
    marks(node)
        .iter()
        .find(|m| node_type(m) == "link")
        .and_then(|m| m.get("attrs"))
        .and_then(|a| a.get("href"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(str::to_string)
}

/// Make a hyperlink target a syntactically valid URI reference so that strict
/// package readers (Word, System.IO.Packaging) accept it.
fn sanitize_uri(href: &str) -> String {
    let bytes = href.as_bytes();
    let mut out = String::with_capacity(href.len());
    let mut i = 0;
    for (idx, c) in href.char_indices() {
        if idx < i {
            continue;
        }
        i = idx + c.len_utf8();
        let needs = match c {
            ' ' | '"' | '<' | '>' | '\\' | '^' | '`' | '{' | '|' | '}' => true,
            '%' => {
                let hex = |b: Option<&u8>| b.map(|b| b.is_ascii_hexdigit()).unwrap_or(false);
                !(hex(bytes.get(idx + 1)) && hex(bytes.get(idx + 2)))
            }
            c if c.is_control() => true,
            _ => false,
        };
        if needs {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                let _ = write!(out, "%{b:02X}");
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// First family of a CSS `font-family` list, quotes stripped, generics mapped.
pub(crate) fn css_first_font(css: &str) -> Option<String> {
    let first = css.split(',').next()?.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if first.is_empty() {
        return None;
    }
    let mapped = match first.to_ascii_lowercase().as_str() {
        "serif" | "ui-serif" => "Times New Roman",
        "sans-serif" | "system-ui" | "ui-sans-serif" | "-apple-system" => "Arial",
        "monospace" | "ui-monospace" => "Courier New",
        "cursive" => "Comic Sans MS",
        "inherit" | "initial" | "unset" => return None,
        _ => first,
    };
    Some(mapped.to_string())
}

/// `"11pt"` / `"14px"` / `"12"` -> points.
pub(crate) fn parse_font_size(s: &str) -> Option<f64> {
    let s = s.trim().to_ascii_lowercase();
    let pt = if let Some(v) = s.strip_suffix("pt") {
        v.trim().parse::<f64>().ok()?
    } else if let Some(v) = s.strip_suffix("px") {
        v.trim().parse::<f64>().ok()? * 0.75
    } else {
        s.parse::<f64>().ok()?
    };
    (pt.is_finite() && pt > 0.0 && pt < 1638.0).then_some(pt)
}

/// `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `rgba(...)` -> `RRGGBB`.
pub(crate) fn parse_css_color(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(hex) = s.strip_prefix('#') {
        if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let full = match hex.len() {
            3 | 4 => hex.chars().take(3).flat_map(|c| [c, c]).collect::<String>(),
            6 | 8 => hex[..6].to_string(),
            _ => return None,
        };
        return Some(full.to_ascii_uppercase());
    }
    if s.starts_with("rgb") {
        let inner = s.split_once('(')?.1.trim_end_matches(')');
        let parts: Vec<&str> = inner
            .split(|c: char| c == ',' || c == '/' || c.is_whitespace())
            .filter(|p| !p.is_empty())
            .collect();
        if parts.len() < 3 {
            return None;
        }
        let mut rgb = [0u8; 3];
        for (i, p) in parts.iter().take(3).enumerate() {
            let v = if let Some(pct) = p.strip_suffix('%') {
                pct.parse::<f64>().ok()? * 2.55
            } else {
                p.parse::<f64>().ok()?
            };
            rgb[i] = v.round().clamp(0.0, 255.0) as u8;
        }
        return Some(format!("{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]));
    }
    None
}

/// Decode a base64 `data:` URL into (file extension, bytes). Unsupported or
/// malformed sources return `None`.
fn decode_data_url(src: &str) -> Option<(&'static str, Vec<u8>)> {
    let rest = src.trim().strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mut fields = meta.split(';');
    let mime = fields.next()?.trim().to_ascii_lowercase();
    if !fields.any(|f| f.trim().eq_ignore_ascii_case("base64")) {
        return None;
    }
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpeg",
        "image/gif" => "gif",
        "image/bmp" | "image/x-ms-bmp" => "bmp",
        "image/webp" => "webp",
        "image/tiff" => "tiff",
        _ => return None,
    };
    let cleaned: String = payload.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.trim_end_matches('=').as_bytes()))
        .ok()?;
    (!bytes.is_empty()).then_some((ext, bytes))
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpeg" | "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
}

fn w3cdtf_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    w3cdtf(secs)
}

fn w3cdtf(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Howard Hinnant's days-from-civil inverse.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;

    /// 1x1 transparent PNG.
    pub(crate) const PNG_1X1: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    pub(crate) fn sample_doc() -> Value {
        json!({
          "type": "doc",
          "content": [
            { "type": "paragraph", "attrs": { "styleName": "Title" }, "content": [{ "type": "text", "text": "Quarterly Report" }] },
            { "type": "heading", "attrs": { "level": 1, "textAlign": "center" }, "content": [{ "type": "text", "text": "Overview & <Summary>" }] },
            { "type": "paragraph", "attrs": { "textAlign": "justify", "lineHeight": "1.5", "indent": 2 }, "content": [
              { "type": "text", "text": "Plain " },
              { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] },
              { "type": "text", "text": " and " },
              { "type": "text", "text": "styled", "marks": [{ "type": "italic" }, { "type": "textStyle", "attrs": { "fontFamily": "\"Georgia\", serif", "fontSize": "14pt", "color": "#c0392b" } }] },
              { "type": "text", "text": " marked", "marks": [{ "type": "highlight", "attrs": { "color": "#fef08a" } }, { "type": "underline" }] },
              { "type": "hardBreak" },
              { "type": "text", "text": "x" },
              { "type": "text", "text": "2", "marks": [{ "type": "superscript" }] },
              { "type": "text", "text": "\tcode()", "marks": [{ "type": "code" }] },
              { "type": "text", "text": " visit ", "marks": [] },
              { "type": "text", "text": "our ", "marks": [{ "type": "link", "attrs": { "href": "https://example.com/a b?x=1&y=2" } }] },
              { "type": "text", "text": "site", "marks": [{ "type": "link", "attrs": { "href": "https://example.com/a b?x=1&y=2" } }, { "type": "bold" }] },
              { "type": "text", "text": " now\u{0001}." }
            ]},
            { "type": "bulletList", "content": [
              { "type": "listItem", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Bullet one" }] },
                { "type": "orderedList", "attrs": { "start": 3, "type": "1" }, "content": [
                  { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Nested three" }] }] },
                  { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Nested four" }] }] }
                ]}
              ]},
              { "type": "listItem", "content": [
                { "type": "paragraph", "content": [{ "type": "text", "text": "Bullet two" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "Bullet two continued" }] }
              ]}
            ]},
            { "type": "taskList", "content": [
              { "type": "taskItem", "attrs": { "checked": true }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Done task" }] }] },
              { "type": "taskItem", "attrs": { "checked": false }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Open task" }] }] }
            ]},
            { "type": "table", "content": [
              { "type": "tableRow", "content": [
                { "type": "tableHeader", "attrs": { "colspan": 2, "rowspan": 1, "colwidth": [120, 80] }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Header AB" }] }] },
                { "type": "tableHeader", "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Header C" }] }] }
              ]},
              { "type": "tableRow", "content": [
                { "type": "tableCell", "attrs": { "rowspan": 2, "backgroundColor": "#dbeafe" }, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Tall" }] }] },
                { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "B2" }] }] },
                { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "C2" }] }] }
              ]},
              { "type": "tableRow", "content": [
                { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "B3" }] }] },
                { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "C3" }] }] }
              ]}
            ]},
            { "type": "paragraph", "content": [
              { "type": "text", "text": "Image: " },
              { "type": "image", "attrs": { "src": PNG_1X1, "alt": "dot", "width": 40, "height": null } }
            ]},
            { "type": "pageBreak" },
            { "type": "horizontalRule" },
            { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [{ "type": "text", "text": "fn main() {\n    println!(\"hi\");\n}" }] },
            { "type": "blockquote", "content": [
              { "type": "paragraph", "content": [{ "type": "text", "text": "Quoted wisdom." }] },
              { "type": "paragraph", "content": [{ "type": "text", "text": "Second quote line." }] }
            ]},
            { "type": "paragraph" }
          ]
        })
    }

    pub(crate) fn sample_page() -> PageSettings {
        PageSettings {
            size: "Letter".into(),
            orientation: "landscape".into(),
            margins: super::super::Margins { top: 0.75, right: 1.25, bottom: 0.5, left: 1.5 },
            header: Some("Confidential Header".into()),
            footer: Some("Typo Corp".into()),
            page_numbers: Some(true),
            doodle_under: None,
            doodle_over: None,
        }
    }

    pub(crate) fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("valid zip");
        (0..zip.len())
            .map(|i| {
                let mut f = zip.by_index(i).unwrap();
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                (f.name().to_string(), data)
            })
            .collect()
    }

    #[test]
    fn every_part_is_well_formed_xml() {
        let bytes = export_docx(&sample_doc(), &sample_page(), &DocDefaults::default(), "Q & A <test>").unwrap();
        let parts = unzip(&bytes);
        let names: Vec<&str> = parts.iter().map(|(n, _)| n.as_str()).collect();
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "docProps/core.xml",
            "docProps/app.xml",
            "word/document.xml",
            "word/styles.xml",
            "word/numbering.xml",
            "word/settings.xml",
            "word/_rels/document.xml.rels",
            "word/media/image1.png",
        ] {
            assert!(names.contains(&required), "missing {required}");
        }
        for (name, data) in &parts {
            if name.ends_with(".xml") || name.ends_with(".rels") {
                let text = std::str::from_utf8(data).unwrap();
                roxmltree::Document::parse(text).unwrap_or_else(|e| panic!("{name}: {e}"));
            }
        }
        let doc = parts.iter().find(|(n, _)| n == "word/document.xml").unwrap();
        let doc = std::str::from_utf8(&doc.1).unwrap();
        assert!(doc.contains(r#"w:orient="landscape""#));
        assert!(doc.contains(r#"<w:pgSz w:w="15840" w:h="12240""#));
        assert!(doc.contains(r#"w:left="2160""#));
        assert!(doc.contains("<w:gridSpan w:val=\"2\"/>"));
        assert!(doc.contains(r#"<w:vMerge w:val="restart"/>"#));
        assert!(doc.contains("<w:vMerge/>"));
        assert!(doc.contains("<w:tblHeader/>"));
        assert!(!doc.contains('\u{0001}'));
        let rels = parts.iter().find(|(n, _)| n == "word/_rels/document.xml.rels").unwrap();
        let rels = std::str::from_utf8(&rels.1).unwrap();
        assert!(rels.contains("https://example.com/a%20b?x=1&amp;y=2"));
        assert_eq!(rels.matches("hyperlink\"").count(), 1, "hyperlink relationship is deduplicated");

        if let Ok(path) = std::env::var("TYPO_DOCX_SAMPLE_OUT") {
            std::fs::write(path, &bytes).unwrap();
        }
    }

    #[test]
    fn empty_doc_has_a_paragraph() {
        let bytes = export_docx(&json!({ "type": "doc" }), &PageSettings::default(), &DocDefaults::default(), "").unwrap();
        let parts = unzip(&bytes);
        let doc = &parts.iter().find(|(n, _)| n == "word/document.xml").unwrap().1;
        let doc = std::str::from_utf8(doc).unwrap();
        assert!(doc.contains("<w:body><w:p/><w:sectPr>"));
    }

    #[test]
    fn helpers() {
        assert_eq!(esc("a<b>&\"'\u{0}\u{b}c"), "a&lt;b&gt;&amp;&quot;&apos;c");
        assert_eq!(parse_css_color("#abc").as_deref(), Some("AABBCC"));
        assert_eq!(parse_css_color("rgb(255, 0, 16)").as_deref(), Some("FF0010"));
        assert_eq!(parse_font_size("14px"), Some(10.5));
        assert_eq!(parse_font_size("11pt"), Some(11.0));
        assert_eq!(css_first_font("'Times New Roman', serif").as_deref(), Some("Times New Roman"));
        assert_eq!(sanitize_uri("http://x/a b%zz%20"), "http://x/a%20b%25zz%20");
        assert_eq!(w3cdtf(0), "1970-01-01T00:00:00Z");
        assert_eq!(w3cdtf(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(w3cdtf(951_782_400), "2000-02-29T00:00:00Z");
    }
}
