//! Native PDF Engine for Typo:
//! 1. PDF Parser & Text/Layout/Image Extractor (`parse_pdf_bytes`) for PDF -> Word (.docx) & PDF Editor
//! 2. High-fidelity HTML/Vector PDF Exporter + Pure-Rust PDF 1.4 Writer fallback (`export_pdf_document`, `save_edited_pdf_document`)

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use flate2::read::{DeflateDecoder, ZlibDecoder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::docx::{self, DocDefaults, ImportedDocx, Margins, PageSettings};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageBlock {
    pub id: String,
    /// "heading1" | "heading2" | "heading3" | "paragraph" | "image"
    pub kind: String,
    pub text: String,
    /// X coordinate in points from left of page
    pub x: f64,
    /// Y coordinate in points from top of page
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    pub font_family: String,
    pub bold: bool,
    pub italic: bool,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_patch_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDeletedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInkPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfAnnotation {
    pub id: String,
    /// "textbox" | "highlight" | "stamp" | "ink" | "image"
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub font_size: f64,
    #[serde(default)]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_src: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PdfInkPoint>,
    #[serde(default)]
    pub stroke_width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEditorPage {
    pub page_number: usize,
    pub width_pt: f64,
    pub height_pt: f64,
    pub rotation: i32,
    pub blocks: Vec<PdfPageBlock>,
    #[serde(default)]
    pub annotations: Vec<PdfAnnotation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_image: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted_rects: Vec<PdfDeletedRect>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedPdfDocument {
    pub path: String,
    pub name: String,
    pub page_count: usize,
    pub pages: Vec<PdfEditorPage>,
    pub docx: ImportedDocx,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf_base64: Option<String>,
}

// ---------------------------------------------------------------------------
// Low-level PDF Object & Stream Extractor
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct PdfObject {
    dict_text: String,
    stream: Option<Vec<u8>>,
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn decompress_flate(raw: &[u8]) -> Option<Vec<u8>> {
    let trimmed = trim_stream_newlines(raw);
    // 1. Try standard zlib header
    {
        let mut decoder = ZlibDecoder::new(trimmed);
        let mut out = Vec::new();
        if decoder.read_to_end(&mut out).is_ok() && !out.is_empty() {
            return Some(out);
        }
    }
    // 2. Try raw deflate
    {
        let mut decoder = DeflateDecoder::new(trimmed);
        let mut out = Vec::new();
        if decoder.read_to_end(&mut out).is_ok() && !out.is_empty() {
            return Some(out);
        }
    }
    None
}

fn trim_stream_newlines(mut b: &[u8]) -> &[u8] {
    if b.starts_with(b"\r\n") {
        b = &b[2..];
    } else if b.starts_with(b"\n") || b.starts_with(b"\r") {
        b = &b[1..];
    }
    if b.ends_with(b"\r\n") {
        b = &b[..b.len() - 2];
    } else if b.ends_with(b"\n") || b.ends_with(b"\r") {
        b = &b[..b.len() - 1];
    }
    b
}

/// Decodes a decoded stream or raw stream from a PDF object.
fn decode_object_stream(obj: &PdfObject) -> Option<Vec<u8>> {
    let raw = obj.stream.as_ref()?;
    let d = &obj.dict_text;
    if d.contains("/FlateDecode") || d.contains("/Fl") {
        if let Some(dec) = decompress_flate(raw) {
            return Some(dec);
        }
    }
    Some(trim_stream_newlines(raw).to_vec())
}

/// Parses top-level `N G obj ... endobj` blocks and also unpacks `/Type /ObjStm` streams.
fn parse_all_objects(bytes: &[u8]) -> HashMap<u32, PdfObject> {
    let mut map = HashMap::new();
    let len = bytes.len();
    let mut i = 0;

    while i + 8 < len {
        // Look for `<num> <gen> obj` at a token boundary
        if bytes[i].is_ascii_digit() && (i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b'>' || bytes[i - 1] == b']') {
            let start_num = i;
            while i < len && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let Ok(obj_id) = std::str::from_utf8(&bytes[start_num..i]).unwrap_or("").parse::<u32>() else {
                continue;
            };
            if i >= len || !bytes[i].is_ascii_whitespace() {
                continue;
            }
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let start_gen = i;
            while i < len && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if start_gen == i || i >= len || !bytes[i].is_ascii_whitespace() {
                continue;
            }
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i + 3 <= len && &bytes[i..i + 3] == b"obj" && (i + 3 == len || bytes[i + 3].is_ascii_whitespace() || bytes[i + 3] == b'<' || bytes[i + 3] == b'[') {
                i += 3;
                let body_start = i;
                let Some(rel_end) = find_subslice(&bytes[body_start..], b"endobj") else {
                    break;
                };
                let body = &bytes[body_start..body_start + rel_end];
                if let Some(stream_pos) = find_subslice(body, b"stream") {
                    // Make sure it's `stream` followed by \r or \n (not `endstream`)
                    let valid_stream = (stream_pos == 0 || &body[stream_pos.saturating_sub(3)..stream_pos] != b"end")
                        && body.get(stream_pos + 6).map(|c| *c == b'\r' || *c == b'\n' || *c == b' ').unwrap_or(false);
                    if valid_stream {
                        let dict_text = String::from_utf8_lossy(&body[..stream_pos]).into_owned();
                        let data_start = stream_pos + 6;
                        let data_end = find_subslice(&body[data_start..], b"endstream")
                            .map(|p| data_start + p)
                            .unwrap_or(body.len());
                        let raw_stream = body[data_start..data_end].to_vec();
                        map.insert(obj_id, PdfObject { dict_text, stream: Some(raw_stream) });
                    } else {
                        let dict_text = String::from_utf8_lossy(body).into_owned();
                        map.insert(obj_id, PdfObject { dict_text, stream: None });
                    }
                } else {
                    let dict_text = String::from_utf8_lossy(body).into_owned();
                    map.insert(obj_id, PdfObject { dict_text, stream: None });
                }
                i = body_start + rel_end + 6;
                continue;
            }
        }
        i += 1;
    }

    // Unpack PDF 1.5+ `/Type /ObjStm` compressed object streams
    let obj_stm_ids: Vec<u32> = map
        .iter()
        .filter(|(_, o)| o.dict_text.contains("/ObjStm"))
        .map(|(k, _)| *k)
        .collect();

    for stm_id in obj_stm_ids {
        let Some(stm_obj) = map.get(&stm_id).cloned() else { continue };
        let Some(n_objs) = extract_int_after(&stm_obj.dict_text, "/N") else { continue };
        let Some(first_offset) = extract_int_after(&stm_obj.dict_text, "/First") else { continue };
        let Some(decoded) = decode_object_stream(&stm_obj) else { continue };
        if first_offset <= 0 || (first_offset as usize) > decoded.len() {
            continue;
        }
        let header_str = String::from_utf8_lossy(&decoded[..first_offset as usize]);
        let nums: Vec<usize> = header_str
            .split_whitespace()
            .filter_map(|t| t.parse::<usize>().ok())
            .collect();
        let mut pairs = Vec::new();
        let mut idx = 0;
        while idx + 1 < nums.len() && pairs.len() < (n_objs as usize) {
            pairs.push((nums[idx] as u32, nums[idx + 1]));
            idx += 2;
        }
        for p_idx in 0..pairs.len() {
            let (inner_id, rel_off) = pairs[p_idx];
            let abs_start = (first_offset as usize) + rel_off;
            let abs_end = if p_idx + 1 < pairs.len() {
                (first_offset as usize) + pairs[p_idx + 1].1
            } else {
                decoded.len()
            };
            if abs_start < abs_end && abs_end <= decoded.len() {
                let text = String::from_utf8_lossy(&decoded[abs_start..abs_end]).into_owned();
                map.entry(inner_id).or_insert(PdfObject { dict_text: text, stream: None });
            }
        }
    }

    map
}

fn extract_int_after(s: &str, key: &str) -> Option<i64> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    for tok in rest.split(|c: char| c.is_whitespace() || c == '/' || c == '<' || c == '>' || c == '[' || c == ']') {
        if !tok.is_empty() {
            return tok.parse::<i64>().ok();
        }
    }
    None
}

fn extract_ref_after(s: &str, key: &str) -> Option<u32> {
    let idx = s.find(key)?;
    let rest = &s[idx + key.len()..];
    let mut toks = rest.split_whitespace();
    let first = toks.next()?;
    let second = toks.next()?;
    let third = toks.next()?;
    if second.chars().all(|c| c.is_ascii_digit()) && third.starts_with('R') {
        first.parse::<u32>().ok()
    } else {
        None
    }
}

fn extract_refs_list_after(s: &str, key: &str) -> Vec<u32> {
    let Some(idx) = s.find(key) else { return Vec::new() };
    let rest = s[idx + key.len()..].trim_start();
    if rest.starts_with('[') {
        let Some(end) = rest.find(']') else { return Vec::new() };
        let inside = &rest[1..end];
        parse_ref_tokens(inside)
    } else {
        extract_ref_after(s, key).into_iter().collect()
    }
}

fn parse_ref_tokens(s: &str) -> Vec<u32> {
    let toks: Vec<&str> = s.split_whitespace().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < toks.len() {
        let clean_r = toks[i + 2].trim_matches(|c: char| c == ']' || c == '>' || c == '/');
        if clean_r == "R" {
            if let Ok(id) = toks[i].trim_matches('[').parse::<u32>() {
                out.push(id);
                i += 3;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn extract_mediabox(s: &str) -> Option<(f64, f64)> {
    let idx = s.find("/MediaBox")?;
    let rest = &s[idx + 9..];
    let open = rest.find('[')?;
    let close = rest[open..].find(']')?;
    let nums: Vec<f64> = rest[open + 1..open + close]
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .collect();
    if nums.len() >= 4 {
        let w = (nums[2] - nums[0]).abs();
        let h = (nums[3] - nums[1]).abs();
        if w > 50.0 && h > 50.0 {
            return Some((w, h));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// ToUnicode CMap Parser
// ---------------------------------------------------------------------------

type CMapTable = HashMap<u32, String>;

fn parse_cmap(stream_text: &str) -> CMapTable {
    let mut cmap = HashMap::new();

    // 1. beginbfchar ... endbfchar
    let mut rest = stream_text;
    while let Some(start) = rest.find("beginbfchar") {
        let after = &rest[start + 11..];
        let Some(end) = after.find("endbfchar") else { break };
        let block = &after[..end];
        let hexes = extract_angle_hex_tokens(block);
        let mut i = 0;
        while i + 1 < hexes.len() {
            if let Ok(code) = u32::from_str_radix(&hexes[i], 16) {
                if let Some(uni) = hex_to_utf16_string(&hexes[i + 1]) {
                    cmap.insert(code, uni);
                }
            }
            i += 2;
        }
        rest = &after[end + 9..];
    }

    // 2. beginbfrange ... endbfrange
    let mut rest2 = stream_text;
    while let Some(start) = rest2.find("beginbfrange") {
        let after = &rest2[start + 12..];
        let Some(end) = after.find("endbfrange") else { break };
        let block = &after[..end];
        for line in block.lines() {
            let hexes = extract_angle_hex_tokens(line);
            if hexes.len() >= 3 {
                let Ok(low) = u32::from_str_radix(&hexes[0], 16) else { continue };
                let Ok(high) = u32::from_str_radix(&hexes[1], 16) else { continue };
                if line.contains('[') && hexes.len() >= 2 + ((high.saturating_sub(low) + 1) as usize) {
                    for (offset, code) in (low..=high).enumerate() {
                        if let Some(uni) = hex_to_utf16_string(&hexes[2 + offset]) {
                            cmap.insert(code, uni);
                        }
                    }
                } else if let Ok(target_base) = u32::from_str_radix(&hexes[2], 16) {
                    for code in low..=high.min(low + 2048) {
                        let mapped = target_base + (code - low);
                        if let Some(ch) = char::from_u32(mapped) {
                            cmap.insert(code, ch.to_string());
                        }
                    }
                }
            }
        }
        rest2 = &after[end + 10..];
    }

    cmap
}

fn extract_angle_hex_tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && (i + 1 >= bytes.len() || bytes[i + 1] != b'<') {
            i += 1;
            let start = i;
            while i < bytes.len() && bytes[i] != b'>' {
                i += 1;
            }
            let token: String = std::str::from_utf8(&bytes[start..i])
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_ascii_hexdigit())
                .collect();
            if !token.is_empty() {
                out.push(token);
            }
        }
        i += 1;
    }
    out
}

fn hex_to_utf16_string(hex: &str) -> Option<String> {
    if hex.len() == 2 {
        let b = u8::from_str_radix(hex, 16).ok()?;
        return Some((b as char).to_string());
    }
    let mut units = Vec::new();
    let mut i = 0;
    while i + 4 <= hex.len() {
        if let Ok(u) = u16::from_str_radix(&hex[i..i + 4], 16) {
            units.push(u);
        }
        i += 4;
    }
    if units.is_empty() {
        None
    } else {
        Some(String::from_utf16_lossy(&units))
    }
}

#[derive(Clone, Default)]
struct FontMeta {
    family: String,
    bold: bool,
    italic: bool,
    cmap: CMapTable,
}

fn collect_font_resources(dict_text: &str, objects: &HashMap<u32, PdfObject>) -> HashMap<String, FontMeta> {
    let mut fonts = HashMap::new();
    // Look for `/F1 12 0 R` or `/TT0 15 0 R` patterns in the page/resource dictionaries
    let mut combined_dict = dict_text.to_string();
    if let Some(res_id) = extract_ref_after(dict_text, "/Resources") {
        if let Some(res_obj) = objects.get(&res_id) {
            combined_dict.push(' ');
            combined_dict.push_str(&res_obj.dict_text);
        }
    }
    if let Some(font_dict_id) = extract_ref_after(&combined_dict, "/Font") {
        if let Some(f_obj) = objects.get(&font_dict_id) {
            combined_dict.push(' ');
            combined_dict.push_str(&f_obj.dict_text);
        }
    }

    let tokens: Vec<&str> = combined_dict.split_whitespace().collect();
    let mut i = 0;
    while i + 3 < tokens.len() {
        if tokens[i].starts_with('/') && tokens[i + 3].starts_with('R') {
            let name = tokens[i].trim_start_matches('/').to_string();
            if let (Ok(obj_id), Ok(_gen)) = (tokens[i + 1].parse::<u32>(), tokens[i + 2].parse::<u32>()) {
                if let Some(fobj) = objects.get(&obj_id) {
                    let fd = &fobj.dict_text;
                    if fd.contains("/Font") || fd.contains("/BaseFont") || fd.contains("/ToUnicode") {
                        let mut meta = FontMeta {
                            family: "Calibri".into(),
                            bold: fd.contains("Bold") || fd.contains("Heavy") || fd.contains("Black") || fd.contains(",Bold"),
                            italic: fd.contains("Italic") || fd.contains("Oblique"),
                            cmap: HashMap::new(),
                        };
                        if fd.contains("Times") || fd.contains("Georgia") || fd.contains("Garamond") || fd.contains("Serif") {
                            meta.family = "Georgia".into();
                        } else if fd.contains("Courier") || fd.contains("Consolas") || fd.contains("Mono") {
                            meta.family = "Consolas".into();
                        }
                        if let Some(tu_id) = extract_ref_after(fd, "/ToUnicode") {
                            if let Some(tu_obj) = objects.get(&tu_id) {
                                if let Some(dec) = decode_object_stream(tu_obj) {
                                    let cmap_str = String::from_utf8_lossy(&dec);
                                    meta.cmap = parse_cmap(&cmap_str);
                                }
                            }
                        }
                        fonts.insert(name, meta);
                    }
                }
            }
        }
        i += 1;
    }

    // Also attach any global ToUnicode maps as a fallback if font references were indirect
    if fonts.values().all(|f| f.cmap.is_empty()) {
        let mut global_cmap = HashMap::new();
        for obj in objects.values() {
            if let Some(dec) = decode_object_stream(obj) {
                let s = String::from_utf8_lossy(&dec);
                if s.contains("beginbfchar") || s.contains("beginbfrange") {
                    for (k, v) in parse_cmap(&s) {
                        global_cmap.entry(k).or_insert(v);
                    }
                }
            }
        }
        if !global_cmap.is_empty() {
            fonts.insert("_global".into(), FontMeta {
                family: "Calibri".into(),
                bold: false,
                italic: false,
                cmap: global_cmap,
            });
        }
    }

    fonts
}

// ---------------------------------------------------------------------------
// PDF Content Stream Interpreter (BT .. ET, Tm, Td, TD, Tf, Tj, TJ)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct PositionedSpan {
    x: f64,
    end_x: f64,
    y: f64,
    font_size: f64,
    font_family: String,
    bold: bool,
    italic: bool,
    text: String,
}

fn mat_mul(m1: [f64; 6], m2: [f64; 6]) -> [f64; 6] {
    // 3x3 affine matrix multiplication: m1 * m2
    // [ a b 0 ]
    // [ c d 0 ]
    // [ e f 1 ]
    [
        m1[0] * m2[0] + m1[1] * m2[2],
        m1[0] * m2[1] + m1[1] * m2[3],
        m1[2] * m2[0] + m1[3] * m2[2],
        m1[2] * m2[1] + m1[3] * m2[3],
        m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
        m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
    ]
}

fn decode_pdf_literal_string(bytes: &[u8], cmap: Option<&CMapTable>) -> String {
    let mut raw = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'n' => raw.push(b'\n'),
                b'r' => raw.push(b'\r'),
                b't' => raw.push(b'\t'),
                b'b' => raw.push(8),
                b'f' => raw.push(12),
                b'(' => raw.push(b'('),
                b')' => raw.push(b')'),
                b'\\' => raw.push(b'\\'),
                b'\r' => {
                    if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                        i += 1;
                    }
                }
                b'\n' => {}
                c if (b'0'..=b'7').contains(&c) => {
                    let mut oct = (c - b'0') as u8;
                    for _ in 0..2 {
                        if i + 1 < bytes.len() && (b'0'..=b'7').contains(&bytes[i + 1]) {
                            i += 1;
                            oct = oct.wrapping_mul(8).wrapping_add(bytes[i] - b'0');
                        } else {
                            break;
                        }
                    }
                    raw.push(oct);
                }
                other => raw.push(other),
            }
        } else {
            raw.push(bytes[i]);
        }
        i += 1;
    }

    // Check UTF-16BE BOM
    if raw.starts_with(&[0xFE, 0xFF]) && raw.len() >= 4 {
        let mut u16s = Vec::new();
        let mut j = 2;
        while j + 1 < raw.len() {
            u16s.push(u16::from_be_bytes([raw[j], raw[j + 1]]));
            j += 2;
        }
        return String::from_utf16_lossy(&u16s);
    }

    if let Some(map) = cmap {
        if !map.is_empty() {
            // If 2-byte big-endian glyph IDs match cmap
            if raw.len() % 2 == 0 && raw.iter().step_by(2).any(|&b| b == 0) {
                let mut mapped = String::new();
                let mut ok_count = 0;
                let mut j = 0;
                while j + 1 < raw.len() {
                    let code = u16::from_be_bytes([raw[j], raw[j + 1]]) as u32;
                    if let Some(s) = map.get(&code) {
                        mapped.push_str(s);
                        ok_count += 1;
                    } else if let Some(ch) = char::from_u32(code) {
                        if !ch.is_control() {
                            mapped.push(ch);
                        }
                    }
                    j += 2;
                }
                if ok_count > 0 {
                    return mapped;
                }
            }
            // Try 1-byte glyph lookup in cmap
            let mut mapped1 = String::new();
            let mut ok1 = 0;
            for &b in &raw {
                let code = b as u32;
                if let Some(s) = map.get(&code) {
                    mapped1.push_str(s);
                    ok1 += 1;
                } else if b >= 32 {
                    mapped1.push(b as char);
                }
            }
            if ok1 > 0 {
                return mapped1;
            }
        }
    }

    // WinAnsi / Latin-1 decoding
    raw.into_iter()
        .filter_map(|b| match b {
            0x80 => Some('€'),
            0x85 => Some('…'),
            0x91 => Some('‘'),
            0x92 => Some('’'),
            0x93 => Some('“'),
            0x94 => Some('”'),
            0x95 => Some('•'),
            0x96 => Some('–'),
            0x97 => Some('—'),
            0x99 => Some('™'),
            0xA0 => Some(' '),
            c if c >= 32 || c == b'\n' || c == b'\t' => Some(c as char),
            _ => None,
        })
        .collect()
}

fn decode_pdf_hex_string(hex_bytes: &[u8], cmap: Option<&CMapTable>) -> String {
    let clean: Vec<u8> = hex_bytes.iter().copied().filter(|b| b.is_ascii_hexdigit()).collect();
    if clean.is_empty() {
        return String::new();
    }
    let hex_str = std::str::from_utf8(&clean).unwrap_or("");

    if let Some(map) = cmap {
        if !map.is_empty() {
            // Try 4-hex-digit (2-byte) codes first if length % 4 == 0
            if hex_str.len() % 4 == 0 {
                let mut out4 = String::new();
                let mut hits = 0;
                let mut i = 0;
                while i + 4 <= hex_str.len() {
                    if let Ok(code) = u32::from_str_radix(&hex_str[i..i + 4], 16) {
                        if let Some(s) = map.get(&code) {
                            out4.push_str(s);
                            hits += 1;
                        } else if let Some(ch) = char::from_u32(code) {
                            if ch >= ' ' {
                                out4.push(ch);
                            }
                        }
                    }
                    i += 4;
                }
                if hits > 0 {
                    return out4;
                }
            }
            // Try 2-hex-digit (1-byte) codes
            let mut out2 = String::new();
            let mut hits2 = 0;
            let mut i = 0;
            while i + 2 <= hex_str.len() {
                if let Ok(code) = u32::from_str_radix(&hex_str[i..i + 2], 16) {
                    if let Some(s) = map.get(&code) {
                        out2.push_str(s);
                        hits2 += 1;
                    } else if (32..=126).contains(&code) {
                        out2.push(code as u8 as char);
                    }
                }
                i += 2;
            }
            if hits2 > 0 {
                return out2;
            }
        }
    }

    // Fallback: if 4-digit UTF-16BE (e.g. 00480065...)
    if hex_str.len() % 4 == 0 && hex_str.starts_with("00") {
        if let Some(s) = hex_to_utf16_string(hex_str) {
            return s;
        }
    }
    // 1-byte ASCII hex
    let mut out = String::new();
    let mut i = 0;
    while i + 2 <= hex_str.len() {
        if let Ok(b) = u8::from_str_radix(&hex_str[i..i + 2], 16) {
            if b >= 32 {
                out.push(b as char);
            }
        }
        i += 2;
    }
    out
}

fn extract_spans_from_content_stream(
    content: &[u8],
    page_width: f64,
    page_height: f64,
    fonts: &HashMap<String, FontMeta>,
) -> Vec<PositionedSpan> {
    let mut spans = Vec::new();
    let global_cmap = fonts.get("_global").map(|f| &f.cmap);

    // Track graphics state CTM (`cm`, `q`, `Q`) and text matrices (`Tm`, `Td`, `TD`, `T*`)
    let mut ctm: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut ctm_stack: Vec<[f64; 6]> = Vec::new();
    let mut tm: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut tlm: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    let mut cur_font = String::new();
    let mut tf_size = 11.0_f64;
    let mut leading = 14.0_f64;

    let mut num_stack: Vec<f64> = Vec::new();
    let mut last_name = String::new();
    let mut last_str = String::new();

    let len = content.len();
    let mut i = 0;

    while i < len {
        let b = content[i];
        // Skip whitespace
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        // Skip comments `% ... \n`
        if b == b'%' {
            while i < len && content[i] != b'\n' && content[i] != b'\r' {
                i += 1;
            }
            continue;
        }
        // Name `/F1`
        if b == b'/' {
            i += 1;
            let start = i;
            while i < len && !content[i].is_ascii_whitespace() && !b"()<>[]{}/%".contains(&content[i]) {
                i += 1;
            }
            last_name = String::from_utf8_lossy(&content[start..i]).into_owned();
            continue;
        }
        // Literal string `(...)`
        if b == b'(' {
            i += 1;
            let start = i;
            let mut depth = 1i32;
            while i < len && depth > 0 {
                if content[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if content[i] == b'(' {
                    depth += 1;
                } else if content[i] == b')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                i += 1;
            }
            let slice = &content[start..i.min(len)];
            let cmap = fonts.get(&cur_font).map(|f| &f.cmap).or(global_cmap);
            last_str = decode_pdf_literal_string(slice, cmap);
            if i < len && content[i] == b')' {
                i += 1;
            }
            continue;
        }
        // Hex string `<...>` or dict `<<...>>`
        if b == b'<' {
            if i + 1 < len && content[i + 1] == b'<' {
                i += 2;
                continue;
            }
            i += 1;
            let start = i;
            while i < len && content[i] != b'>' {
                i += 1;
            }
            let slice = &content[start..i.min(len)];
            let cmap = fonts.get(&cur_font).map(|f| &f.cmap).or(global_cmap);
            last_str = decode_pdf_hex_string(slice, cmap);
            if i < len && content[i] == b'>' {
                i += 1;
            }
            continue;
        }
        if b == b'>' {
            i += 1;
            continue;
        }
        // Array `[...]` (used for `TJ`)
        if b == b'[' {
            i += 1;
            let mut tj_buf = String::new();
            let cmap = fonts.get(&cur_font).map(|f| &f.cmap).or(global_cmap);
            let mut depth = 1i32;
            while i < len && depth > 0 {
                let c = content[i];
                if c.is_ascii_whitespace() {
                    i += 1;
                    continue;
                }
                if c == b'[' {
                    depth += 1;
                    i += 1;
                } else if c == b']' {
                    depth -= 1;
                    i += 1;
                } else if c == b'(' {
                    i += 1;
                    let s_start = i;
                    let mut p_depth = 1i32;
                    while i < len && p_depth > 0 {
                        if content[i] == b'\\' {
                            i += 2;
                            continue;
                        }
                        if content[i] == b'(' {
                            p_depth += 1;
                        } else if content[i] == b')' {
                            p_depth -= 1;
                            if p_depth == 0 {
                                break;
                            }
                        }
                        i += 1;
                    }
                    tj_buf.push_str(&decode_pdf_literal_string(&content[s_start..i.min(len)], cmap));
                    if i < len && content[i] == b')' {
                        i += 1;
                    }
                } else if c == b'<' {
                    i += 1;
                    let s_start = i;
                    while i < len && content[i] != b'>' {
                        i += 1;
                    }
                    tj_buf.push_str(&decode_pdf_hex_string(&content[s_start..i.min(len)], cmap));
                    if i < len && content[i] == b'>' {
                        i += 1;
                    }
                } else if c == b'-' || c == b'+' || c == b'.' || c.is_ascii_digit() {
                    let n_start = i;
                    i += 1;
                    while i < len && (content[i].is_ascii_digit() || content[i] == b'.') {
                        i += 1;
                    }
                    if let Ok(kern) = std::str::from_utf8(&content[n_start..i]).unwrap_or("").parse::<f64>() {
                        // In PDF TJ arrays, negative values in thousandths of text space shift right.
                        // Values between -1 and -180 are normal glyph kerning; only < -185 is a word space.
                        if kern < -185.0 && !tj_buf.ends_with(' ') {
                            tj_buf.push(' ');
                        }
                    }
                } else {
                    i += 1;
                }
            }
            last_str = tj_buf;
            continue;
        }
        // Number token
        if b == b'-' || b == b'+' || b == b'.' || b.is_ascii_digit() {
            let start = i;
            i += 1;
            while i < len && (content[i].is_ascii_digit() || content[i] == b'.') {
                i += 1;
            }
            if let Ok(val) = std::str::from_utf8(&content[start..i]).unwrap_or("").parse::<f64>() {
                num_stack.push(val);
                if num_stack.len() > 16 {
                    num_stack.remove(0);
                }
            }
            continue;
        }

        // Operator or keyword token
        let start = i;
        while i < len && !content[i].is_ascii_whitespace() && !b"()<>[]{}/%".contains(&content[i]) {
            i += 1;
        }
        let op = std::str::from_utf8(&content[start..i]).unwrap_or("");
        match op {
            "q" => {
                ctm_stack.push(ctm);
                num_stack.clear();
            }
            "Q" => {
                if let Some(prev) = ctm_stack.pop() {
                    ctm = prev;
                }
                num_stack.clear();
            }
            "cm" => {
                if num_stack.len() >= 6 {
                    let n = num_stack.len();
                    let m = [
                        num_stack[n - 6],
                        num_stack[n - 5],
                        num_stack[n - 4],
                        num_stack[n - 3],
                        num_stack[n - 2],
                        num_stack[n - 1],
                    ];
                    ctm = mat_mul(m, ctm);
                }
                num_stack.clear();
            }
            "BT" => {
                tm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                tlm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
                num_stack.clear();
            }
            "ET" => {
                num_stack.clear();
            }
            "Tf" => {
                if let Some(sz) = num_stack.pop() {
                    if sz.abs() > 0.01 {
                        tf_size = sz.abs();
                    }
                }
                if !last_name.is_empty() {
                    cur_font = last_name.clone();
                }
                num_stack.clear();
            }
            "TL" => {
                if let Some(tl) = num_stack.pop() {
                    leading = tl;
                }
                num_stack.clear();
            }
            "Tm" => {
                if num_stack.len() >= 6 {
                    let n = num_stack.len();
                    tm = [
                        num_stack[n - 6],
                        num_stack[n - 5],
                        num_stack[n - 4],
                        num_stack[n - 3],
                        num_stack[n - 2],
                        num_stack[n - 1],
                    ];
                    tlm = tm;
                }
                num_stack.clear();
            }
            "Td" | "TD" => {
                if num_stack.len() >= 2 {
                    let dy = num_stack.pop().unwrap_or(0.0);
                    let dx = num_stack.pop().unwrap_or(0.0);
                    if op == "TD" {
                        leading = -dy;
                    }
                    let tr = [1.0, 0.0, 0.0, 1.0, dx, dy];
                    tlm = mat_mul(tr, tlm);
                    tm = tlm;
                }
                num_stack.clear();
            }
            "T*" => {
                let tr = [1.0, 0.0, 0.0, 1.0, 0.0, -leading];
                tlm = mat_mul(tr, tlm);
                tm = tlm;
                num_stack.clear();
            }
            "Tj" | "TJ" | "'" | "\"" => {
                if op == "'" || op == "\"" {
                    let tr = [1.0, 0.0, 0.0, 1.0, 0.0, -leading];
                    tlm = mat_mul(tr, tlm);
                    tm = tlm;
                }
                let txt = last_str.trim_matches('\0').to_string();
                if !txt.is_empty() && !txt.chars().all(|c| c.is_control()) {
                    // Combine text matrix with Current Transformation Matrix (M = tm * ctm)
                    let m = mat_mul(tm, ctm);
                    let scale_x = (m[0] * m[0] + m[1] * m[1]).sqrt();
                    let scale_y = (m[2] * m[2] + m[3] * m[3]).sqrt();
                    let effective_pt = (tf_size * scale_x.max(scale_y).max(0.1)).clamp(6.0, 96.0);
                    let page_x = m[4].clamp(4.0, (page_width - 8.0).max(60.0));
                    // `m[5]` is in standard PDF MediaBox bottom-up coordinates once multiplied by `ctm`.
                    let raw_top_y = page_height - m[5] - effective_pt * 0.85;
                    let top_y = raw_top_y.clamp(4.0, (page_height - 12.0).max(24.0));

                    let char_count = txt.chars().count() as f64;
                    let span_w = (char_count * effective_pt * 0.52).max(effective_pt * 0.45);
                    let fmeta = fonts.get(&cur_font);

                    spans.push(PositionedSpan {
                        x: page_x,
                        end_x: page_x + span_w,
                        y: top_y,
                        font_size: (effective_pt * 10.0).round() / 10.0,
                        font_family: fmeta.map(|m| m.family.clone()).unwrap_or_else(|| "Calibri".into()),
                        bold: fmeta.map(|m| m.bold).unwrap_or(false),
                        italic: fmeta.map(|m| m.italic).unwrap_or(false),
                        text: txt,
                    });

                    // Advance `tm` along text X axis by estimated glyph width in text space
                    let adv_text_space = if tf_size > 0.1 {
                        char_count * tf_size * 0.52
                    } else {
                        char_count * 5.0
                    };
                    let adv = [1.0, 0.0, 0.0, 1.0, adv_text_space, 0.0];
                    tm = mat_mul(adv, tm);
                }
                last_str.clear();
                num_stack.clear();
            }
            _ => {
                num_stack.clear();
            }
        }
    }

    spans
}

fn spans_to_blocks(spans: Vec<PositionedSpan>, page_num: usize, page_width: f64) -> Vec<PdfPageBlock> {
    if spans.is_empty() {
        return Vec::new();
    }

    // Group spans into horizontal lines by similar Y coordinate (top-to-bottom, then left-to-right)
    let mut sorted = spans;
    sorted.sort_by(|a, b| {
        let tol = a.font_size.max(b.font_size) * 0.45;
        if (a.y - b.y).abs() <= tol {
            a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal)
        }
    });

    #[derive(Clone)]
    struct Line {
        x: f64,
        end_x: f64,
        y: f64,
        font_size: f64,
        font_family: String,
        bold: bool,
        italic: bool,
        text: String,
    }

    let mut lines: Vec<Line> = Vec::new();
    for sp in sorted {
        if let Some(last) = lines.last_mut() {
            let tol = (last.font_size.max(sp.font_size)) * 0.55;
            if (sp.y - last.y).abs() <= tol {
                // Only insert a space if there is a genuine horizontal word gap (> 18% of font size)
                let gap = sp.x - last.end_x;
                let word_gap_threshold = last.font_size.max(sp.font_size) * 0.18;
                if gap > word_gap_threshold && !last.text.ends_with(' ') && !sp.text.starts_with(' ') {
                    last.text.push(' ');
                }
                last.text.push_str(&sp.text);
                last.end_x = last.end_x.max(sp.end_x);
                if sp.font_size > last.font_size {
                    last.font_size = sp.font_size;
                }
                last.bold = last.bold || sp.bold;
                continue;
            }
        }
        lines.push(Line {
            x: sp.x,
            end_x: sp.end_x,
            y: sp.y,
            font_size: sp.font_size,
            font_family: sp.font_family,
            bold: sp.bold,
            italic: sp.italic,
            text: sp.text,
        });
    }

    // Merge consecutive lines into paragraphs or headings
    let mut blocks: Vec<PdfPageBlock> = Vec::new();
    let mut block_seq = 1usize;

    for ln in lines {
        let clean = ln.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if clean.is_empty() {
            continue;
        }
        let kind = if ln.font_size >= 18.0 {
            "heading1"
        } else if ln.font_size >= 14.5 || (ln.bold && ln.font_size >= 13.0 && clean.len() < 90) {
            "heading2"
        } else if ln.bold && clean.len() < 80 && !clean.ends_with('.') {
            "heading3"
        } else {
            "paragraph"
        };

        if let Some(prev) = blocks.last_mut() {
            let gap = ln.y - (prev.y + prev.height);
            let same_style = prev.kind == "paragraph"
                && kind == "paragraph"
                && (prev.font_size - ln.font_size).abs() <= 1.5
                && (prev.x - ln.x).abs() <= 36.0;
            if same_style && gap >= -6.0 && gap <= ln.font_size * 1.65 {
                if prev.text.ends_with('-') && prev.text.len() > 2 {
                    prev.text.pop();
                    prev.text.push_str(&clean);
                } else {
                    prev.text.push(' ');
                    prev.text.push_str(&clean);
                }
                prev.height = (ln.y - prev.y + ln.font_size * 1.4).max(prev.height + ln.font_size * 1.25);
                prev.original_text = Some(prev.text.clone());
                prev.original_height = Some(prev.height);
                continue;
            }
        }

        let avail_w = (page_width - ln.x - 36.0).max(160.0);
        let blk_w = (ln.end_x - ln.x + 24.0).max(avail_w.min(page_width - 48.0));
        let est_lines = ((clean.chars().count() as f64 * ln.font_size * 0.52) / blk_w.max(160.0))
            .ceil()
            .max(1.0);
        let blk_x = ln.x.clamp(16.0, (page_width - 80.0).max(36.0));
        let blk_h = (est_lines * ln.font_size * 1.38).max(20.0);
        blocks.push(PdfPageBlock {
            id: format!("p{page_num}-b{}", block_seq),
            kind: kind.into(),
            text: clean.clone(),
            x: blk_x,
            y: ln.y,
            width: blk_w,
            height: blk_h,
            font_size: ln.font_size,
            font_family: ln.font_family,
            bold: ln.bold || kind.starts_with("heading"),
            italic: ln.italic,
            color: "#1c1c1f".into(),
            image_src: None,
            original_text: Some(clean),
            original_x: Some(blk_x),
            original_y: Some(ln.y),
            original_width: Some(blk_w),
            original_height: Some(blk_h),
            bg_patch_color: None,
        });
        block_seq += 1;
    }

    blocks
}

// ---------------------------------------------------------------------------
// High-Level PDF Parser (`parse_pdf_bytes`)
// ---------------------------------------------------------------------------

pub fn parse_pdf_bytes(bytes: &[u8], path: &str, name: &str) -> Result<ParsedPdfDocument, String> {
    if bytes.len() < 8 || !bytes[..1024.min(bytes.len())].windows(4).any(|w| w == b"%PDF") {
        return Err("File is not a valid PDF document.".into());
    }

    let objects = parse_all_objects(bytes);

    // Collect embedded JPEG images (`DCTDecode`)
    let mut embedded_jpegs: Vec<(u32, String, f64, f64)> = Vec::new();
    for (&obj_id, obj) in &objects {
        if obj.dict_text.contains("/Image") && (obj.dict_text.contains("/DCTDecode") || obj.dict_text.contains("/DCT")) {
            if let Some(raw) = &obj.stream {
                let trimmed = trim_stream_newlines(raw);
                if trimmed.len() > 64 {
                    let w = extract_int_after(&obj.dict_text, "/Width").unwrap_or(320) as f64;
                    let h = extract_int_after(&obj.dict_text, "/Height").unwrap_or(220) as f64;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(trimmed);
                    embedded_jpegs.push((obj_id, format!("data:image/jpeg;base64,{b64}"), w, h));
                }
            }
        }
    }

    // Find all `/Type /Page` objects (excluding `/Type /Pages`)
    let mut page_obj_ids: Vec<u32> = Vec::new();
    for (&id, obj) in &objects {
        let d = &obj.dict_text;
        if is_page_object_dict(d) {
            page_obj_ids.push(id);
        }
    }
    page_obj_ids.sort_unstable();

    // Find global fallback MediaBox if inherited from `/Type /Pages`
    let mut default_size = (595.28_f64, 841.89_f64); // A4 points
    for obj in objects.values() {
        if let Some(mb) = extract_mediabox(&obj.dict_text) {
            default_size = mb;
            break;
        }
    }

    let mut editor_pages: Vec<PdfEditorPage> = Vec::new();

    if !page_obj_ids.is_empty() {
        for (idx, &pid) in page_obj_ids.iter().enumerate() {
            let page_num = idx + 1;
            let Some(pobj) = objects.get(&pid) else { continue };
            let (w_pt, h_pt) = extract_mediabox(&pobj.dict_text).unwrap_or(default_size);
            let rotation = extract_int_after(&pobj.dict_text, "/Rotate").unwrap_or(0) as i32;
            let fonts = collect_font_resources(&pobj.dict_text, &objects);

            let content_ids = extract_refs_list_after(&pobj.dict_text, "/Contents");
            let mut combined_stream = Vec::new();
            for cid in content_ids {
                if let Some(cobj) = objects.get(&cid) {
                    if let Some(dec) = decode_object_stream(cobj) {
                        combined_stream.extend_from_slice(&dec);
                        combined_stream.push(b'\n');
                    }
                }
            }
            // If page object itself had a stream
            if combined_stream.is_empty() {
                if let Some(dec) = decode_object_stream(pobj) {
                    combined_stream.extend_from_slice(&dec);
                }
            }

            let spans = extract_spans_from_content_stream(&combined_stream, w_pt, h_pt, &fonts);
            let mut blocks = spans_to_blocks(spans, page_num, w_pt);

            // Attach page-referenced JPEG images if any
            for (img_id, data_url, iw, ih) in &embedded_jpegs {
                let ref_pat = format!("{img_id} 0 R");
                if pobj.dict_text.contains(&ref_pat) {
                    let disp_w = iw.clamp(120.0, (w_pt - 144.0).max(200.0));
                    let disp_h = (ih * (disp_w / iw.max(1.0))).clamp(80.0, 360.0);
                    blocks.push(PdfPageBlock {
                        id: format!("p{page_num}-img{img_id}"),
                        kind: "image".into(),
                        text: String::new(),
                        x: 72.0,
                        y: blocks.last().map(|b| (b.y + b.height + 16.0).min(h_pt - disp_h - 48.0)).unwrap_or(120.0),
                        width: disp_w,
                        height: disp_h,
                        font_size: 11.0,
                        font_family: "Calibri".into(),
                        bold: false,
                        italic: false,
                        color: "#1c1c1f".into(),
                        image_src: Some(data_url.clone()),
                        original_text: None,
                        original_x: None,
                        original_y: None,
                        original_width: None,
                        original_height: None,
                        bg_patch_color: None,
                    });
                }
            }

            editor_pages.push(PdfEditorPage {
                page_number: page_num,
                width_pt: w_pt,
                height_pt: h_pt,
                rotation,
                blocks,
                annotations: Vec::new(),
                background_image: None,
                deleted_rects: Vec::new(),
            });
        }
    }

    // Fallback: if page tree was inside an unsupported structure or streams weren't linked via `/Contents`,
    // scan all content streams in object order for `BT .. ET` text operators.
    if editor_pages.is_empty() || editor_pages.iter().all(|p| p.blocks.is_empty()) {
        let mut all_ids: Vec<u32> = objects.keys().copied().collect();
        all_ids.sort_unstable();
        let global_fonts = collect_font_resources("", &objects);
        let mut fallback_spans = Vec::new();
        for oid in all_ids {
            if let Some(obj) = objects.get(&oid) {
                if obj.dict_text.contains("/Image") || obj.dict_text.contains("/FontFile") || obj.dict_text.contains("/Metadata") {
                    continue;
                }
                if let Some(dec) = decode_object_stream(obj) {
                    if find_subslice(&dec, b"BT").is_some() || find_subslice(&dec, b"Tj").is_some() || find_subslice(&dec, b"TJ").is_some() {
                        let mut s = extract_spans_from_content_stream(&dec, default_size.0, default_size.1, &global_fonts);
                        fallback_spans.append(&mut s);
                    }
                }
            }
        }
        let mut blocks = spans_to_blocks(fallback_spans, 1, default_size.0);
        for (idx, (img_id, data_url, iw, ih)) in embedded_jpegs.iter().take(6).enumerate() {
            let disp_w = iw.clamp(120.0, 420.0);
            let disp_h = (ih * (disp_w / iw.max(1.0))).clamp(80.0, 320.0);
            blocks.push(PdfPageBlock {
                id: format!("p1-img{img_id}-{idx}"),
                kind: "image".into(),
                text: String::new(),
                x: 72.0,
                y: 120.0 + (idx as f64) * 180.0,
                width: disp_w,
                height: disp_h,
                font_size: 11.0,
                font_family: "Calibri".into(),
                bold: false,
                italic: false,
                color: "#1c1c1f".into(),
                image_src: Some(data_url.clone()),
                original_text: None,
                original_x: None,
                original_y: None,
                original_width: None,
                original_height: None,
                bg_patch_color: None,
            });
        }
        if blocks.is_empty() {
            blocks.push(PdfPageBlock {
                id: "p1-b1".into(),
                kind: "heading2".into(),
                text: name.trim_end_matches(".pdf").trim_end_matches(".PDF").to_string(),
                x: 72.0,
                y: 72.0,
                width: default_size.0 - 144.0,
                height: 28.0,
                font_size: 16.0,
                font_family: "Calibri".into(),
                bold: true,
                italic: false,
                color: "#1c1c1f".into(),
                image_src: None,
                original_text: None,
                original_x: None,
                original_y: None,
                original_width: None,
                original_height: None,
                bg_patch_color: None,
            });
            blocks.push(PdfPageBlock {
                id: "p1-b2".into(),
                kind: "paragraph".into(),
                text: "Opened PDF in Typo. You can edit this text directly, add text boxes, highlights, stamps, or signatures in the PDF Editor, or edit in the Word Processor.".into(),
                x: 72.0,
                y: 112.0,
                width: default_size.0 - 144.0,
                height: 48.0,
                font_size: 11.0,
                font_family: "Calibri".into(),
                bold: false,
                italic: false,
                color: "#1c1c1f".into(),
                image_src: None,
                original_text: None,
                original_x: None,
                original_y: None,
                original_width: None,
                original_height: None,
                bg_patch_color: None,
            });
        }
        if editor_pages.is_empty() {
            editor_pages.push(PdfEditorPage {
                page_number: 1,
                width_pt: default_size.0,
                height_pt: default_size.1,
                rotation: 0,
                blocks,
                annotations: Vec::new(),
                background_image: None,
                deleted_rects: Vec::new(),
            });
        } else {
            editor_pages[0].blocks = blocks;
        }
    }

    let docx = build_imported_docx_from_pdf_pages(&editor_pages);
    let page_count = editor_pages.len();
    let pdf_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(ParsedPdfDocument {
        path: path.to_string(),
        name: name.to_string(),
        page_count,
        pages: editor_pages,
        docx,
        pdf_base64: Some(pdf_b64),
    })
}

fn is_page_object_dict(d: &str) -> bool {
    let mut rest = d;
    while let Some(pos) = rest.find("/Page") {
        let after = &rest[pos + 5..];
        let next_ch = after.chars().next().unwrap_or(' ');
        if !next_ch.is_ascii_alphabetic() {
            return true;
        }
        rest = after;
    }
    false
}

/// Converts structured `PdfEditorPage` list into a full ProseMirror `ImportedDocx` for Typo & Word export.
pub fn build_imported_docx_from_pdf_pages(pages: &[PdfEditorPage]) -> ImportedDocx {
    let mut content: Vec<Value> = Vec::new();

    for (p_idx, page) in pages.iter().enumerate() {
        if p_idx > 0 {
            content.push(json!({ "type": "pageBreak" }));
        }

        // Combine blocks + textbox annotations in vertical reading order
        let mut page_items: Vec<(f64, Value)> = Vec::new();

        for b in &page.blocks {
            if b.kind == "image" {
                if let Some(src) = &b.image_src {
                    page_items.push((
                        b.y,
                        json!({
                            "type": "image",
                            "attrs": {
                                "src": src,
                                "width": (b.width * 1.25).round() as u32,
                                "wrap": "center"
                            }
                        }),
                    ));
                }
                continue;
            }
            let text = b.text.trim();
            if text.is_empty() {
                continue;
            }
            let mut marks: Vec<Value> = Vec::new();
            if b.bold && !b.kind.starts_with("heading") {
                marks.push(json!({ "type": "bold" }));
            }
            if b.italic {
                marks.push(json!({ "type": "italic" }));
            }
            let text_node = if marks.is_empty() {
                json!({ "type": "text", "text": text })
            } else {
                json!({ "type": "text", "text": text, "marks": marks })
            };

            let node = match b.kind.as_str() {
                "heading1" => json!({ "type": "heading", "attrs": { "level": 1 }, "content": [text_node] }),
                "heading2" => json!({ "type": "heading", "attrs": { "level": 2 }, "content": [text_node] }),
                "heading3" => json!({ "type": "heading", "attrs": { "level": 3 }, "content": [text_node] }),
                _ => json!({ "type": "paragraph", "content": [text_node] }),
            };
            page_items.push((b.y, node));
        }

        for ann in &page.annotations {
            match ann.kind.as_str() {
                "textbox" => {
                    let t = ann.text.trim();
                    if !t.is_empty() {
                        page_items.push((
                            ann.y,
                            json!({
                                "type": "paragraph",
                                "content": [{ "type": "text", "text": t }]
                            }),
                        ));
                    }
                }
                "stamp" => {
                    let label = ann.stamp_type.as_deref().unwrap_or(&ann.text).trim();
                    if !label.is_empty() {
                        page_items.push((
                            ann.y,
                            json!({
                                "type": "paragraph",
                                "content": [{
                                    "type": "text",
                                    "text": format!("[STAMP: {label}]"),
                                    "marks": [{ "type": "bold" }]
                                }]
                            }),
                        ));
                    }
                }
                "image" => {
                    if let Some(src) = &ann.image_src {
                        page_items.push((
                            ann.y,
                            json!({
                                "type": "image",
                                "attrs": {
                                    "src": src,
                                    "width": (ann.width * 1.25).round() as u32,
                                    "wrap": "center"
                                }
                            }),
                        ));
                    }
                }
                _ => {}
            }
        }

        page_items.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, node) in page_items {
            content.push(node);
        }
    }

    if content.is_empty() {
        content.push(json!({ "type": "paragraph" }));
    }

    let first = pages.first();
    let w_pt = first.map(|p| p.width_pt).unwrap_or(595.28);
    let h_pt = first.map(|p| p.height_pt).unwrap_or(841.89);
    let (size, orientation) = PageSettings::from_twips((w_pt * 20.0) as u32, (h_pt * 20.0) as u32, w_pt > h_pt);

    ImportedDocx {
        doc: json!({
            "type": "doc",
            "content": content,
        }),
        page: PageSettings {
            size,
            orientation,
            margins: Margins::default(),
            header: None,
            footer: None,
            page_numbers: None,
        },
        defaults: DocDefaults {
            font_family: "Calibri".into(),
            font_size: 11.0,
        },
    }
}

// ---------------------------------------------------------------------------
// High-Fidelity PDF Exporter (Browser Headless Vector Print + Pure-Rust PDF 1.4 Fallback)
// ---------------------------------------------------------------------------

fn find_headless_pdf_browser() -> Option<&'static str> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    ];
    candidates.into_iter().find(|p| Path::new(p).is_file())
}

fn render_html_via_headless_browser(tmp_dir: &Path, html_content: &str, out_pdf: &Path) -> bool {
    let Some(browser) = find_headless_pdf_browser() else {
        return false;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(1);
    let tmp_html = tmp_dir.join(format!("_typo_print_{stamp}.html"));
    let tmp_pdf = tmp_dir.join(format!("_typo_print_{stamp}.pdf"));
    let _ = fs::remove_file(&tmp_pdf);

    if fs::write(&tmp_html, html_content.as_bytes()).is_err() {
        return false;
    }

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let file_url = format!("file:///{}", tmp_html.to_string_lossy().replace('\\', "/"));
    let mut cmd = std::process::Command::new(browser);
    cmd.args([
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        "--print-to-pdf-no-header",
        &format!("--print-to-pdf={}", tmp_pdf.to_string_lossy()),
        &file_url,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let ok = cmd.status().map(|s| s.success()).unwrap_or(false) && tmp_pdf.is_file();
    let _ = fs::remove_file(&tmp_html);
    if ok {
        if let Ok(bytes) = fs::read(&tmp_pdf) {
            let _ = fs::remove_file(&tmp_pdf);
            if bytes.len() > 100 && crate::write_atomic(out_pdf, &bytes).is_ok() {
                return true;
            }
        }
    }
    let _ = fs::remove_file(&tmp_pdf);
    false
}

/// Exports a Typo document to a `.pdf` file at `target_path`.
/// Uses:
/// 1. Headless Edge / Chrome vector PDF generation from styled HTML (preserves all formatting, images, stickers, tables, colors)
/// 2. LibreOffice headless if installed
/// 3. Pure-Rust native PDF 1.4 writer fallback (100% guaranteed offline export)
pub fn export_pdf_document(
    tmp_dir: &Path,
    target_path: &Path,
    doc: &Value,
    page: &PageSettings,
    defaults: &DocDefaults,
    title: &str,
    html_body: Option<&str>,
) -> Result<bool, String> {
    // 1. Build print-exact standalone HTML and render via Edge/Chrome headless
    let full_html = build_print_html(doc, page, defaults, title, html_body);
    if render_html_via_headless_browser(tmp_dir, &full_html, target_path) {
        return Ok(true);
    }

    // 2. Try LibreOffice if available
    let soffice_candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ];
    if let Some(soffice) = soffice_candidates.iter().find(|p| Path::new(p).is_file()) {
        if let Ok(bytes) = docx::export_docx(doc, page, defaults, title) {
            let tmp_docx = tmp_dir.join("_typo_pdf_export.docx");
            let tmp_pdf = tmp_dir.join("_typo_pdf_export.pdf");
            let _ = fs::remove_file(&tmp_pdf);
            if fs::write(&tmp_docx, &bytes).is_ok() {
                #[cfg(target_os = "windows")]
                use std::os::windows::process::CommandExt;
                let mut cmd = std::process::Command::new(soffice);
                cmd.args([
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    &tmp_dir.to_string_lossy(),
                    &tmp_docx.to_string_lossy(),
                ]);
                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000);
                let ok = cmd.status().map(|s| s.success()).unwrap_or(false) && tmp_pdf.is_file();
                let _ = fs::remove_file(&tmp_docx);
                if ok {
                    if let Ok(pdf_bytes) = fs::read(&tmp_pdf) {
                        let _ = fs::remove_file(&tmp_pdf);
                        crate::write_atomic(target_path, &pdf_bytes)?;
                        return Ok(true);
                    }
                }
            }
        }
    }

    // 3. Pure-Rust Native PDF 1.4 Writer fallback (never fails!)
    let pdf_bytes = write_native_pdf_from_doc(doc, page, defaults, title);
    crate::write_atomic(target_path, &pdf_bytes)?;
    Ok(true)
}

/// Exports edited PDF pages from the Built-In PDF Editor Studio to a `.pdf` file at `target_path`.
pub fn save_edited_pdf_document(
    tmp_dir: &Path,
    target_path: &Path,
    pages: &[PdfEditorPage],
) -> Result<bool, String> {
    let html = build_edited_pdf_html(pages);
    if render_html_via_headless_browser(tmp_dir, &html, target_path) {
        return Ok(true);
    }

    // Pure-Rust fallback using our native PDF 1.4 writer
    let imported = build_imported_docx_from_pdf_pages(pages);
    let pdf_bytes = write_native_pdf_from_doc(&imported.doc, &imported.page, &imported.defaults, "Edited PDF");
    crate::write_atomic(target_path, &pdf_bytes)?;
    Ok(true)
}

fn page_css_dimensions(page: &PageSettings) -> (f64, f64) {
    let (w_in, h_in) = match page.size.as_str() {
        "Letter" => (8.5, 11.0),
        "Legal" => (8.5, 14.0),
        "A5" => (5.83, 8.27),
        "Executive" => (7.25, 10.5),
        _ => (8.27, 11.69), // A4
    };
    if page.orientation == "landscape" {
        (h_in, w_in)
    } else {
        (w_in, h_in)
    }
}

fn build_print_html(
    doc: &Value,
    page: &PageSettings,
    defaults: &DocDefaults,
    title: &str,
    html_body: Option<&str>,
) -> String {
    let (w_in, h_in) = page_css_dimensions(page);
    let m = &page.margins;
    let body_markup = match html_body {
        Some(b) if !b.trim().is_empty() => b.to_string(),
        _ => prosemirror_json_to_html(doc),
    };
    let safe_title = xml_escape(title);
    let header_html = page
        .header
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(r#"<div class="pdf-running-header">{}</div>"#, xml_escape(s)))
        .unwrap_or_default();
    let footer_html = page
        .footer
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(r#"<div class="pdf-running-footer">{}</div>"#, xml_escape(s)))
        .unwrap_or_default();

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{safe_title}</title>
<style>
  @page {{
    size: {w_in}in {h_in}in;
    margin: {top}in {right}in {bottom}in {left}in;
  }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  html, body {{
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #1c1c1f;
    font-family: "{font}", "Segoe UI", Calibri, system-ui, sans-serif;
    font-size: {size}pt;
    line-height: 1.5;
  }}
  p {{ margin: 0 0 0.55em 0; }}
  h1 {{ font-size: 22pt; font-weight: 700; margin: 0.7em 0 0.35em; color: #111827; }}
  h2 {{ font-size: 16pt; font-weight: 700; margin: 0.65em 0 0.3em; color: #1f2937; }}
  h3 {{ font-size: 13pt; font-weight: 600; margin: 0.6em 0 0.25em; color: #374151; }}
  table {{ width: 100%; border-collapse: collapse; margin: 0.75em 0; }}
  td, th {{ border: 1px solid #cbd5e1; padding: 6px 10px; vertical-align: top; }}
  th {{ background: #f1f5f9; font-weight: 600; }}
  blockquote {{ border-left: 3px solid #6366f1; margin: 0.7em 0; padding: 0.35em 1em; background: #f8fafc; color: #334155; }}
  pre {{ background: #f1f5f9; padding: 10px 14px; border-radius: 6px; font-family: Consolas, monospace; font-size: 9.5pt; white-space: pre-wrap; }}
  hr {{ border: none; border-top: 1px solid #cbd5e1; margin: 1em 0; }}
  [data-page-break], .page-break {{ page-break-after: always; break-after: page; height: 0; margin: 0; border: none; }}
  img {{ max-width: 100%; height: auto; }}
  figure.typo-img--left {{ float: left; margin: 4px 16px 10px 0; }}
  figure.typo-img--right {{ float: right; margin: 4px 0 10px 16px; }}
  figure.typo-img--center {{ display: block; text-align: center; margin: 12px auto; }}
  .pdf-running-header {{ font-size: 9pt; color: #64748b; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 14px; }}
  .pdf-running-footer {{ font-size: 9pt; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 4px; margin-top: 18px; }}
</style>
</head>
<body>
{header_html}
{body_markup}
{footer_html}
</body>
</html>"#,
        top = m.top,
        right = m.right,
        bottom = m.bottom,
        left = m.left,
        font = defaults.font_family.replace('"', ""),
        size = defaults.font_size,
    )
}

fn build_edited_pdf_html(pages: &[PdfEditorPage]) -> String {
    let first = pages.first();
    let w_pt = first.map(|p| if p.rotation % 180 != 0 { p.height_pt } else { p.width_pt }).unwrap_or(595.28);
    let h_pt = first.map(|p| if p.rotation % 180 != 0 { p.width_pt } else { p.height_pt }).unwrap_or(841.89);

    let mut pages_html = String::new();
    for (idx, p) in pages.iter().enumerate() {
        let pw = if p.rotation % 180 != 0 { p.height_pt } else { p.width_pt };
        let ph = if p.rotation % 180 != 0 { p.width_pt } else { p.height_pt };
        let brk = if idx + 1 < pages.len() { "page-break-after: always; break-after: page;" } else { "" };

        let mut items_html = String::new();
        let has_bg = p.background_image.is_some();

        // 0. Visual PDF Page Background (from PDF.js high-DPI render)
        if let Some(bg) = &p.background_image {
            items_html.push_str(&format!(
                r#"<img src="{bg}" style="position:absolute;left:0;top:0;width:{pw}pt;height:{ph}pt;object-fit:fill;pointer-events:none;" />"#
            ));
        }

        // 0b. Mask rectangles for deleted original blocks on visual pages
        for dr in &p.deleted_rects {
            let col = if dr.color.is_empty() { "#ffffff" } else { &dr.color };
            items_html.push_str(&format!(
                r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;background:{col};"></div>"#,
                x = (dr.x - 2.0).max(0.0),
                y = (dr.y - 2.0).max(0.0),
                w = dr.width + 4.0,
                h = dr.height + 4.0,
            ));
        }

        // 1. Highlights behind text
        for ann in &p.annotations {
            if ann.kind == "highlight" {
                let col = if ann.color.is_empty() { "rgba(250, 204, 21, 0.42)" } else { &ann.color };
                items_html.push_str(&format!(
                    r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;background:{col};border-radius:3px;"></div>"#,
                    x = ann.x,
                    y = ann.y,
                    w = ann.width.max(24.0),
                    h = ann.height.max(14.0),
                ));
            }
        }

        // 2. Extracted / Edited PDF Blocks
        for b in &p.blocks {
            if b.kind == "image" {
                if let Some(src) = &b.image_src {
                    if has_bg {
                        let moved_or_resized = (b.original_x.unwrap_or(b.x) - b.x).abs() > 1.5
                            || (b.original_y.unwrap_or(b.y) - b.y).abs() > 1.5
                            || (b.original_width.unwrap_or(b.width) - b.width).abs() > 1.5
                            || (b.original_height.unwrap_or(b.height) - b.height).abs() > 1.5
                            || b.original_text.as_deref() == Some("modified");
                        if !moved_or_resized {
                            continue;
                        }
                        if let (Some(ox), Some(oy)) = (b.original_x, b.original_y) {
                            let ow = b.original_width.unwrap_or(b.width);
                            let oh = b.original_height.unwrap_or(b.height);
                            let patch_col = b.bg_patch_color.as_deref().unwrap_or("#ffffff");
                            items_html.push_str(&format!(
                                r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;background:{patch_col};"></div>"#,
                                x = (ox - 2.0).max(0.0),
                                y = (oy - 2.0).max(0.0),
                                w = ow + 4.0,
                                h = oh + 4.0,
                            ));
                        }
                    }
                    items_html.push_str(&format!(
                        r#"<img src="{src}" style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;object-fit:fill;" />"#,
                        x = b.x,
                        y = b.y,
                        w = b.width,
                        h = b.height,
                    ));
                }
                continue;
            }

            if has_bg {
                let text_changed = b.original_text.as_deref() != Some(b.text.as_str());
                let pos_changed = (b.original_x.unwrap_or(b.x) - b.x).abs() > 1.5
                    || (b.original_y.unwrap_or(b.y) - b.y).abs() > 1.5;
                if !text_changed && !pos_changed {
                    // Original PDF text is already rendered crisply on `background_image`
                    continue;
                }
                // Cover the original text box on the visual background before drawing the edited/moved text
                let ox = b.original_x.unwrap_or(b.x);
                let oy = b.original_y.unwrap_or(b.y);
                let ow = b.original_width.unwrap_or(b.width);
                let oh = b.original_height.unwrap_or(b.height);
                let patch_col = b.bg_patch_color.as_deref().unwrap_or("#ffffff");
                items_html.push_str(&format!(
                    r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;background:{patch_col};"></div>"#,
                    x = (ox - 3.0).max(0.0),
                    y = (oy - 3.0).max(0.0),
                    w = ow + 6.0,
                    h = oh + 6.0,
                ));
            }

            let weight = if b.bold { "700" } else { "400" };
            let style_it = if b.italic { "italic" } else { "normal" };
            let color = if b.color.is_empty() { "#1c1c1f" } else { &b.color };
            items_html.push_str(&format!(
                r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;font-family:'{ff}',Calibri,sans-serif;font-size:{fs}pt;font-weight:{weight};font-style:{style_it};color:{color};line-height:1.32;white-space:pre-wrap;">{txt}</div>"#,
                x = b.x,
                y = b.y,
                w = b.width.max(40.0),
                ff = b.font_family.replace('\'', ""),
                fs = b.font_size.max(7.0),
                txt = xml_escape(&b.text),
            ));
        }

        // 3. Annotations (textboxes, whiteout/rect, stamps, images, ink strokes)
        for ann in &p.annotations {
            match ann.kind.as_str() {
                "whiteout" | "rect" => {
                    let col = if ann.color.is_empty() { "#ffffff" } else { &ann.color };
                    items_html.push_str(&format!(
                        r#"<div style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;background:{col};"></div>"#,
                        x = ann.x,
                        y = ann.y,
                        w = ann.width.max(12.0),
                        h = ann.height.max(12.0),
                    ));
                }
                "textbox" => {
                    let col = if ann.color.is_empty() { "#111827" } else { &ann.color };
                    let fs = if ann.font_size > 4.0 { ann.font_size } else { 12.0 };
                    let fw = if ann.bold { "700" } else { "400" };
                    items_html.push_str(&format!(
                        r#"<div style="position:absolute;left:{x}pt;top:{y}pt;min-width:{w}pt;font-family:Calibri,sans-serif;font-size:{fs}pt;font-weight:{fw};color:{col};line-height:1.32;white-space:pre-wrap;">{txt}</div>"#,
                        x = ann.x,
                        y = ann.y,
                        w = ann.width.max(40.0),
                        txt = xml_escape(&ann.text),
                    ));
                }
                "stamp" => {
                    let col = if ann.color.is_empty() { "#dc2626" } else { &ann.color };
                    let label = ann.stamp_type.as_deref().unwrap_or(&ann.text);
                    items_html.push_str(&format!(
                        r#"<div style="position:absolute;left:{x}pt;top:{y}pt;padding:4pt 12pt;border:2.5pt solid {col};border-radius:4pt;color:{col};font-family:'Segoe UI',Impact,sans-serif;font-size:14pt;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;transform:rotate(-8deg);">{txt}</div>"#,
                        x = ann.x,
                        y = ann.y,
                        txt = xml_escape(label),
                    ));
                }
                "image" => {
                    if let Some(src) = &ann.image_src {
                        items_html.push_str(&format!(
                            r#"<img src="{src}" style="position:absolute;left:{x}pt;top:{y}pt;width:{w}pt;height:{h}pt;object-fit:contain;" />"#,
                            x = ann.x,
                            y = ann.y,
                            w = ann.width.max(24.0),
                            h = ann.height.max(24.0),
                        ));
                    }
                }
                "ink" => {
                    if ann.points.len() >= 2 {
                        let col = if ann.color.is_empty() { "#1d4ed8" } else { &ann.color };
                        let sw = if ann.stroke_width > 0.5 { ann.stroke_width } else { 2.2 };
                        let mut d = String::new();
                        for (pi, pt) in ann.points.iter().enumerate() {
                            if pi == 0 {
                                d.push_str(&format!("M {:.1} {:.1}", pt.x, pt.y));
                            } else {
                                d.push_str(&format!(" L {:.1} {:.1}", pt.x, pt.y));
                            }
                        }
                        items_html.push_str(&format!(
                            r#"<svg style="position:absolute;left:0;top:0;width:{pw}pt;height:{ph}pt;pointer-events:none;overflow:visible;" viewBox="0 0 {pw} {ph}"><path d="{d}" fill="none" stroke="{col}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/></svg>"#,
                        ));
                    }
                }
                _ => {}
            }
        }

        pages_html.push_str(&format!(
            r#"<div class="pdf-page" style="position:relative;width:{pw}pt;height:{ph}pt;overflow:hidden;background:#ffffff;{brk}">{items_html}</div>"#
        ));
    }

    format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{ size: {w_pt}pt {h_pt}pt; margin: 0; }}
  * {{ box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  html, body {{ margin: 0; padding: 0; background: #ffffff; }}
</style>
</head>
<body>{pages_html}</body>
</html>"#
    )
}

fn prosemirror_json_to_html(doc: &Value) -> String {
    let mut out = String::new();
    if let Some(arr) = doc.get("content").and_then(Value::as_array) {
        for node in arr {
            render_pm_node(node, &mut out);
        }
    }
    out
}

fn render_pm_node(node: &Value, out: &mut String) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "paragraph" => {
            out.push_str("<p>");
            render_pm_children(node, out);
            out.push_str("</p>\n");
        }
        "heading" => {
            let lvl = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3);
            out.push_str(&format!("<h{lvl}>"));
            render_pm_children(node, out);
            out.push_str(&format!("</h{lvl}>\n"));
        }
        "bulletList" => {
            out.push_str("<ul>");
            render_pm_children(node, out);
            out.push_str("</ul>\n");
        }
        "orderedList" => {
            out.push_str("<ol>");
            render_pm_children(node, out);
            out.push_str("</ol>\n");
        }
        "listItem" => {
            out.push_str("<li>");
            render_pm_children(node, out);
            out.push_str("</li>\n");
        }
        "blockquote" => {
            out.push_str("<blockquote>");
            render_pm_children(node, out);
            out.push_str("</blockquote>\n");
        }
        "codeBlock" => {
            out.push_str("<pre><code>");
            render_pm_children(node, out);
            out.push_str("</code></pre>\n");
        }
        "horizontalRule" => {
            out.push_str("<hr>\n");
        }
        "pageBreak" => {
            out.push_str(r#"<div data-page-break="true" class="page-break"></div>"#);
        }
        "image" => {
            if let Some(src) = node.get("attrs").and_then(|a| a.get("src")).and_then(Value::as_str) {
                let w = node
                    .get("attrs")
                    .and_then(|a| a.get("width"))
                    .and_then(Value::as_u64)
                    .unwrap_or(320);
                out.push_str(&format!(r#"<p><img src="{}" width="{w}"></p>"#, xml_escape(src)));
            }
        }
        "text" => {
            let raw = xml_escape(node.get("text").and_then(Value::as_str).unwrap_or(""));
            let mut s = raw;
            if let Some(marks) = node.get("marks").and_then(Value::as_array) {
                for m in marks {
                    match m.get("type").and_then(Value::as_str).unwrap_or("") {
                        "bold" => s = format!("<strong>{s}</strong>"),
                        "italic" => s = format!("<em>{s}</em>"),
                        "underline" => s = format!("<u>{s}</u>"),
                        "strike" => s = format!("<s>{s}</s>"),
                        "code" => s = format!("<code>{s}</code>"),
                        _ => {}
                    }
                }
            }
            out.push_str(&s);
        }
        _ => {
            render_pm_children(node, out);
        }
    }
}

fn render_pm_children(node: &Value, out: &mut String) {
    if let Some(arr) = node.get("content").and_then(Value::as_array) {
        for c in arr {
            render_pm_node(c, out);
        }
    }
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Pure-Rust Native PDF 1.4 Writer Fallback (Zero External Dependencies)
// ---------------------------------------------------------------------------

fn pdf_escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        let code = ch as u32;
        let b = if (32..=126).contains(&code) {
            ch as u8
        } else if (160..=255).contains(&code) {
            code as u8
        } else {
            b'?'
        };
        match b {
            b'(' => out.push_str("\\("),
            b')' => out.push_str("\\)"),
            b'\\' => out.push_str("\\\\"),
            c => out.push(c as char),
        }
    }
    out
}

fn wrap_text_to_lines(text: &str, max_chars: usize) -> Vec<String> {
    let max_c = max_chars.max(16);
    let mut lines = Vec::new();
    for raw_line in text.split('\n') {
        let mut cur = String::new();
        for word in raw_line.split_whitespace() {
            if cur.is_empty() {
                cur.push_str(word);
            } else if cur.chars().count() + 1 + word.chars().count() <= max_c {
                cur.push(' ');
                cur.push_str(word);
            } else {
                lines.push(cur);
                cur = word.to_string();
            }
        }
        lines.push(cur);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

pub fn write_native_pdf_from_doc(
    doc: &Value,
    page: &PageSettings,
    defaults: &DocDefaults,
    _title: &str,
) -> Vec<u8> {
    let (w_twips, h_twips) = page.dimensions_twips();
    let page_w = (w_twips as f64) / 20.0;
    let page_h = (h_twips as f64) / 20.0;
    let margin_l = (page.margins.left * 72.0).clamp(36.0, 144.0);
    let margin_r = (page.margins.right * 72.0).clamp(36.0, 144.0);
    let margin_t = (page.margins.top * 72.0).clamp(36.0, 144.0);
    let margin_b = (page.margins.bottom * 72.0).clamp(36.0, 144.0);
    let usable_w = (page_w - margin_l - margin_r).max(200.0);

    // Collect paragraphs & headings from ProseMirror JSON
    struct PdfLine {
        text: String,
        font_key: &'static str, // "/F1" regular, "/F2" bold
        font_size: f64,
        gap_before: f64,
        force_new_page: bool,
    }

    let mut all_lines: Vec<PdfLine> = Vec::new();
    let base_pt = defaults.font_size.clamp(9.0, 18.0);

    if let Some(nodes) = doc.get("content").and_then(Value::as_array) {
        for node in nodes {
            let ntype = node.get("type").and_then(Value::as_str).unwrap_or("");
            if ntype == "pageBreak" {
                all_lines.push(PdfLine {
                    text: String::new(),
                    font_key: "/F1",
                    font_size: base_pt,
                    gap_before: 0.0,
                    force_new_page: true,
                });
                continue;
            }
            let (f_key, f_size, gap) = if ntype == "heading" {
                let lvl = node
                    .get("attrs")
                    .and_then(|a| a.get("level"))
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                match lvl {
                    1 => ("/F2", 20.0, 10.0),
                    2 => ("/F2", 15.0, 8.0),
                    _ => ("/F2", 12.5, 6.0),
                }
            } else {
                ("/F1", base_pt, 4.0)
            };

            let mut text = String::new();
            let mut is_bold = f_key == "/F2";
            collect_node_plain_text(node, &mut text, &mut is_bold);
            let max_chars = (usable_w / (f_size * 0.52)).floor() as usize;
            let wrapped = wrap_text_to_lines(&text, max_chars);
            for (idx, ln) in wrapped.into_iter().enumerate() {
                all_lines.push(PdfLine {
                    text: ln,
                    font_key: if is_bold { "/F2" } else { "/F1" },
                    font_size: f_size,
                    gap_before: if idx == 0 { gap } else { 0.0 },
                    force_new_page: false,
                });
            }
        }
    }

    if all_lines.is_empty() {
        all_lines.push(PdfLine {
            text: String::new(),
            font_key: "/F1",
            font_size: base_pt,
            gap_before: 0.0,
            force_new_page: false,
        });
    }

    // Paginate lines into page content streams
    let mut page_streams: Vec<String> = Vec::new();
    let mut cur_stream = String::new();
    let mut cur_y = page_h - margin_t;

    for ln in all_lines {
        if ln.force_new_page {
            page_streams.push(std::mem::take(&mut cur_stream));
            cur_y = page_h - margin_t;
            continue;
        }
        let step = ln.font_size * 1.38 + ln.gap_before;
        if cur_y - step < margin_b && !cur_stream.is_empty() {
            page_streams.push(std::mem::take(&mut cur_stream));
            cur_y = page_h - margin_t;
        }
        cur_y -= step;
        if !ln.text.is_empty() {
            let escaped = pdf_escape_literal(&ln.text);
            cur_stream.push_str(&format!(
                "BT {} {:.1} Tf {:.2} {:.2} Td ({}) Tj ET\n",
                ln.font_key, ln.font_size, margin_l, cur_y, escaped
            ));
        }
    }
    if !cur_stream.is_empty() || page_streams.is_empty() {
        page_streams.push(cur_stream);
    }

    // Assemble PDF 1.4 binary with exact byte offsets
    // Obj 1: Catalog, Obj 2: Pages, Obj 3: Font F1 (Helvetica), Obj 4: Font F2 (Helvetica-Bold)
    // For each page i: Page Obj = 5 + i*2, Content Obj = 6 + i*2
    let mut pdf = Vec::new();
    pdf.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let total_objs = 4 + page_streams.len() * 2;
    let mut offsets = vec![0usize; total_objs + 1];

    let write_obj = |pdf: &mut Vec<u8>, offsets: &mut [usize], id: usize, body: &str| {
        offsets[id] = pdf.len();
        pdf.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    };

    write_obj(&mut pdf, &mut offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>");

    let kids: String = (0..page_streams.len())
        .map(|i| format!("{} 0 R", 5 + i * 2))
        .collect::<Vec<_>>()
        .join(" ");
    write_obj(
        &mut pdf,
        &mut offsets,
        2,
        &format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", page_streams.len()),
    );
    write_obj(
        &mut pdf,
        &mut offsets,
        3,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    write_obj(
        &mut pdf,
        &mut offsets,
        4,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );

    for (i, stm) in page_streams.iter().enumerate() {
        let page_id = 5 + i * 2;
        let content_id = 6 + i * 2;
        write_obj(
            &mut pdf,
            &mut offsets,
            page_id,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R >>",
                page_w, page_h
            ),
        );
        let stm_bytes = stm.as_bytes();
        write_obj(
            &mut pdf,
            &mut offsets,
            content_id,
            &format!("<< /Length {} >>\nstream\n{}endstream", stm_bytes.len(), stm),
        );
    }

    let xref_offset = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", total_objs + 1).as_bytes());
    for id in 1..=total_objs {
        pdf.extend_from_slice(format!("{:010} 00000 n \n", offsets[id]).as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            total_objs + 1
        )
        .as_bytes(),
    );
    pdf
}

fn collect_node_plain_text(node: &Value, out: &mut String, is_bold: &mut bool) {
    if node.get("type").and_then(Value::as_str) == Some("text") {
        if let Some(t) = node.get("text").and_then(Value::as_str) {
            out.push_str(t);
        }
        if let Some(marks) = node.get("marks").and_then(Value::as_array) {
            for m in marks {
                if m.get("type").and_then(Value::as_str) == Some("bold") {
                    *is_bold = true;
                }
            }
        }
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for c in children {
            collect_node_plain_text(c, out, is_bold);
        }
    }
}
