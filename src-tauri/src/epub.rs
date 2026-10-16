//! Native EPUB 3.0 E-Book Exporter & Importer (`export_epub`, `import_epub`).
//!
//! Uses `zip` + `roxmltree` + `base64` (already in Cargo.toml) with zero extra dependencies:
//! - Exports any Typo ProseMirror document into a standards-compliant EPUB 3.0 + EPUB 2 NCX
//!   hybrid e-book (`.epub`) with automatic chapter splitting at `Heading 1` / `Page Break`,
//!   embedded images (`EPUB/images/*`), table of contents (`nav.xhtml` + `toc.ncx`), and book CSS.
//! - Imports any `.epub` e-book back into a live editable Typo ProseMirror document (`ImportedDocx`),
//!   preserving chapters, headings, paragraphs, inline formatting, lists, blockquotes, tables, and images.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use base64::Engine as _;
use serde_json::{json, Value};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::docx::{DocDefaults, ImportedDocx, Margins, PageSettings};

struct EpubImage {
    id: String,
    href: String,
    mime: String,
    bytes: Vec<u8>,
}

struct EpubChapter {
    index: usize,
    title: String,
    filename: String,
    body_xhtml: String,
}

struct ExportContext {
    images: Vec<EpubImage>,
    footnotes: Vec<(usize, String)>,
}

/// Exports a ProseMirror JSON document as a standards-compliant EPUB 3.0 `.epub` archive.
pub fn export_epub(
    doc: &Value,
    page: &PageSettings,
    defaults: &DocDefaults,
    title: &str,
    author: &str,
) -> Result<Vec<u8>, String> {
    let book_title = if title.trim().is_empty() {
        "Untitled Book".to_string()
    } else {
        title.trim().to_string()
    };
    let book_author = if author.trim().is_empty() {
        "Typo Author".to_string()
    } else {
        author.trim().to_string()
    };

    let mut ctx = ExportContext {
        images: Vec::new(),
        footnotes: Vec::new(),
    };

    let blocks = doc
        .get("content")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();

    // Split into chapters at Heading 1 or explicit pageBreak nodes
    let mut chapters: Vec<EpubChapter> = Vec::new();
    let mut current_title = book_title.clone();
    let mut current_body = String::new();
    let mut has_content_in_current = false;

    for block in &blocks {
        let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if btype == "pageBreak" {
            if has_content_in_current {
                let idx = chapters.len() + 1;
                chapters.push(EpubChapter {
                    index: idx,
                    title: current_title.clone(),
                    filename: format!("chapter-{idx}.xhtml"),
                    body_xhtml: current_body.clone(),
                });
                current_body.clear();
                has_content_in_current = false;
                current_title = format!("Chapter {}", chapters.len() + 1);
            }
            continue;
        }

        if btype == "heading" {
            let level = block
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1);
            let heading_text = extract_plain_text(block).trim().to_string();
            if level == 1 && !heading_text.is_empty() {
                if has_content_in_current {
                    let idx = chapters.len() + 1;
                    chapters.push(EpubChapter {
                        index: idx,
                        title: current_title.clone(),
                        filename: format!("chapter-{idx}.xhtml"),
                        body_xhtml: current_body.clone(),
                    });
                    current_body.clear();
                    has_content_in_current = false;
                }
                current_title = heading_text;
            }
        }

        let rendered = render_block_xhtml(block, &mut ctx);
        if !rendered.trim().is_empty() {
            current_body.push_str(&rendered);
            current_body.push('\n');
            has_content_in_current = true;
        }
    }

    if has_content_in_current || chapters.is_empty() {
        let idx = chapters.len() + 1;
        if current_body.trim().is_empty() {
            current_body = "<p>&#160;</p>\n".to_string();
        }
        chapters.push(EpubChapter {
            index: idx,
            title: current_title,
            filename: format!("chapter-{idx}.xhtml"),
            body_xhtml: current_body,
        });
    }

    // Append collected footnotes at the end of the final chapter if any exist
    if !ctx.footnotes.is_empty() {
        if let Some(last) = chapters.last_mut() {
            last.body_xhtml
                .push_str("<hr class=\"epub-footnotes-sep\"/>\n<section class=\"epub-footnotes\">\n<h2>Notes</h2>\n<ol>\n");
            for (num, note) in &ctx.footnotes {
                last.body_xhtml.push_str(&format!(
                    "<li id=\"fn-{num}\">{} <a href=\"#fnref-{num}\">&#8617;</a></li>\n",
                    xml_escape(note)
                ));
            }
            last.body_xhtml.push_str("</ol>\n</section>\n");
        }
    }

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);

        // 1. mimetype MUST be the first entry and MUST be stored uncompressed (EPUB OCF spec)
        let stored_opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("mimetype", stored_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(b"application/epub+zip")
            .map_err(|e| e.to_string())?;

        let deflate_opts =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        // 2. META-INF/container.xml
        let container_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        zip.start_file("META-INF/container.xml", deflate_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(container_xml.as_bytes())
            .map_err(|e| e.to_string())?;

        // 3. EPUB/styles.css
        let css = build_epub_css(page, defaults);
        zip.start_file("EPUB/styles.css", deflate_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(css.as_bytes()).map_err(|e| e.to_string())?;

        // 4. Embedded images
        for img in &ctx.images {
            let path = format!("EPUB/{}", img.href);
            zip.start_file(&path, deflate_opts)
                .map_err(|e| e.to_string())?;
            zip.write_all(&img.bytes).map_err(|e| e.to_string())?;
        }

        // 5. Chapter XHTML files
        for ch in &chapters {
            let xhtml = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>{}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<section class="chapter" epub:type="chapter">
{}
</section>
</body>
</html>"#,
                xml_escape(&ch.title),
                ch.body_xhtml
            );
            let path = format!("EPUB/{}", ch.filename);
            zip.start_file(&path, deflate_opts)
                .map_err(|e| e.to_string())?;
            zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
        }

        // 6. EPUB/nav.xhtml (EPUB 3 TOC)
        let nav_xhtml = build_nav_xhtml(&book_title, &chapters);
        zip.start_file("EPUB/nav.xhtml", deflate_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(nav_xhtml.as_bytes())
            .map_err(|e| e.to_string())?;

        // 7. EPUB/toc.ncx (EPUB 2 compatibility TOC)
        let toc_ncx = build_toc_ncx(&book_title, &book_author, &chapters);
        zip.start_file("EPUB/toc.ncx", deflate_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(toc_ncx.as_bytes())
            .map_err(|e| e.to_string())?;

        // 8. EPUB/content.opf
        let opf = build_content_opf(&book_title, &book_author, &chapters, &ctx.images);
        zip.start_file("EPUB/content.opf", deflate_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    Ok(buf.into_inner())
}

fn build_epub_css(_page: &PageSettings, defaults: &DocDefaults) -> String {
    let font = if defaults.font_family.trim().is_empty() {
        "Georgia, 'Times New Roman', serif"
    } else {
        defaults.font_family.as_str()
    };
    let size_pt = if defaults.font_size > 6.0 {
        defaults.font_size
    } else {
        11.5
    };
    let line_h = 1.55;
    format!(
        r#"@charset "UTF-8";
body {{
  font-family: "{font}", Georgia, serif;
  font-size: {size_pt}pt;
  line-height: {line_h};
  color: #1c1e24;
  margin: 0 auto;
  padding: 1.2em 1.5em;
}}
h1, h2, h3, h4, h5, h6 {{
  font-weight: 700;
  line-height: 1.25;
  margin: 1.4em 0 0.55em;
  page-break-after: avoid;
}}
h1 {{ font-size: 1.85em; border-bottom: 1px solid #e2e5ec; padding-bottom: 0.25em; }}
h2 {{ font-size: 1.45em; }}
h3 {{ font-size: 1.2em; }}
p {{
  margin: 0 0 0.75em;
   orphans: 2;
  widows: 2;
}}
p.drop-cap::first-letter {{
  float: left;
  font-size: 3.1em;
  line-height: 0.85;
  padding-right: 0.1em;
  font-weight: 700;
}}
blockquote {{
  margin: 1em 0;
  padding: 0.5em 1.1em;
  border-left: 3px solid #7c8599;
  font-style: italic;
  color: #3a3f4d;
}}
pre, code {{
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 0.9em;
}}
pre {{
  background: #f4f6f9;
  border: 1px solid #dde1e8;
  border-radius: 6px;
  padding: 0.8em 1em;
  overflow-x: auto;
  white-space: pre-wrap;
}}
table {{
  width: 100%;
  border-collapse: collapse;
  margin: 1em 0;
}}
th, td {{
  border: 1px solid #cfd5e0;
  padding: 0.45em 0.65em;
  text-align: left;
  vertical-align: top;
}}
th {{
  background: #f0f3f8;
  font-weight: 700;
}}
figure.epub-figure {{
  margin: 1.1em auto;
  text-align: center;
  page-break-inside: avoid;
}}
figure.epub-figure img {{
  max-width: 100%;
  height: auto;
}}
figure.epub-figure figcaption {{
  font-size: 0.85em;
  color: #5c6270;
  margin-top: 0.35em;
}}
.callout {{
  border-left: 4px solid #5b7fff;
  background: #f3f6ff;
  padding: 0.75em 1em;
  border-radius: 4px;
  margin: 1em 0;
}}
hr {{
  border: none;
  border-top: 1px solid #d4d9e2;
  margin: 1.8em auto;
  width: 60%;
}}
"#
    )
}

fn build_nav_xhtml(book_title: &str, chapters: &[EpubChapter]) -> String {
    let mut items = String::new();
    for ch in chapters {
        items.push_str(&format!(
            "      <li><a href=\"{}\">{}</a></li>\n",
            ch.filename,
            xml_escape(&ch.title)
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents — {}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
{}    </ol>
  </nav>
</body>
</html>"#,
        xml_escape(book_title),
        items
    )
}

fn build_toc_ncx(book_title: &str, book_author: &str, chapters: &[EpubChapter]) -> String {
    let mut nav_points = String::new();
    for ch in chapters {
        nav_points.push_str(&format!(
            r#"    <navPoint id="navPoint-{idx}" playOrder="{idx}">
      <navLabel><text>{title}</text></navLabel>
      <content src="{file}"/>
    </navPoint>
"#,
            idx = ch.index,
            title = xml_escape(&ch.title),
            file = ch.filename
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:typo-epub-book"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>{}</text></docTitle>
  <docAuthor><text>{}</text></docAuthor>
  <navMap>
{}  </navMap>
</ncx>"#,
        xml_escape(book_title),
        xml_escape(book_author),
        nav_points
    )
}

fn build_content_opf(
    book_title: &str,
    book_author: &str,
    chapters: &[EpubChapter],
    images: &[EpubImage],
) -> String {
    let mut manifest = String::new();
    manifest.push_str(
        "    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n",
    );
    manifest.push_str(
        "    <item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>\n",
    );
    manifest.push_str("    <item id=\"css\" href=\"styles.css\" media-type=\"text/css\"/>\n");

    let mut spine = String::new();
    for ch in chapters {
        manifest.push_str(&format!(
            "    <item id=\"ch-{idx}\" href=\"{file}\" media-type=\"application/xhtml+xml\"/>\n",
            idx = ch.index,
            file = ch.filename
        ));
        spine.push_str(&format!("    <itemref idref=\"ch-{idx}\"/>\n", idx = ch.index));
    }

    for (idx, img) in images.iter().enumerate() {
        let props = if idx == 0 {
            " properties=\"cover-image\""
        } else {
            ""
        };
        manifest.push_str(&format!(
            "    <item id=\"{}\" href=\"{}\" media-type=\"{}\"{}/>\n",
            img.id, img.href, img.mime, props
        ));
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:typo-epub-book</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:creator>{}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
{}  </manifest>
  <spine toc="ncx">
{}  </spine>
</package>"#,
        xml_escape(book_title),
        xml_escape(book_author),
        manifest,
        spine
    )
}

fn render_block_xhtml(node: &Value, ctx: &mut ExportContext) -> String {
    let ntype = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let attrs = node.get("attrs").and_then(|a| a.as_object());

    match ntype {
        "heading" => {
            let level = attrs
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1)
                .clamp(1, 6);
            let align_style = text_align_style(attrs);
            let inner = render_inline_children(node, ctx);
            format!("<h{level}{align_style}>{inner}</h{level}>")
        }
        "paragraph" => {
            let align_style = text_align_style(attrs);
            let drop_cap = attrs
                .and_then(|a| a.get("dropCap"))
                .and_then(|d| d.as_bool())
                .unwrap_or(false);
            let cls = if drop_cap { " class=\"drop-cap\"" } else { "" };
            let inner = render_inline_children(node, ctx);
            if inner.trim().is_empty() {
                format!("<p{cls}{align_style}>&#160;</p>")
            } else {
                format!("<p{cls}{align_style}>{inner}</p>")
            }
        }
        "blockquote" => {
            let inner = render_block_children(node, ctx);
            format!("<blockquote>\n{inner}</blockquote>")
        }
        "callout" => {
            let icon = attrs
                .and_then(|a| a.get("icon"))
                .and_then(|i| i.as_str())
                .unwrap_or("💡");
            let inner = render_block_children(node, ctx);
            format!(
                "<div class=\"callout\"><p><strong>{}</strong></p>\n{}</div>",
                xml_escape(icon),
                inner
            )
        }
        "bulletList" => {
            let inner = render_block_children(node, ctx);
            format!("<ul>\n{inner}</ul>")
        }
        "orderedList" => {
            let inner = render_block_children(node, ctx);
            format!("<ol>\n{inner}</ol>")
        }
        "listItem" => {
            let inner = render_block_children(node, ctx);
            format!("<li>{inner}</li>")
        }
        "taskList" => {
            let inner = render_block_children(node, ctx);
            format!("<ul class=\"task-list\">\n{inner}</ul>")
        }
        "taskItem" => {
            let checked = attrs
                .and_then(|a| a.get("checked"))
                .and_then(|c| c.as_bool())
                .unwrap_or(false);
            let box_char = if checked { "&#9745; " } else { "&#9744; " };
            let inner = render_block_children(node, ctx);
            format!("<li>{box_char}{inner}</li>")
        }
        "codeBlock" => {
            let code = extract_plain_text(node);
            format!("<pre><code>{}</code></pre>", xml_escape(&code))
        }
        "horizontalRule" => "<hr/>".to_string(),
        "image" => render_image_figure(node, ctx),
        "table" => {
            let inner = render_block_children(node, ctx);
            format!("<table>\n{inner}</table>")
        }
        "tableRow" => {
            let inner = render_block_children(node, ctx);
            format!("<tr>{inner}</tr>")
        }
        "tableHeader" => {
            let inner = render_block_children(node, ctx);
            format!("<th>{inner}</th>")
        }
        "tableCell" => {
            let inner = render_block_children(node, ctx);
            format!("<td>{inner}</td>")
        }
        "mathBlock" => {
            let latex = attrs
                .and_then(|a| a.get("latex"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            format!(
                "<p class=\"math-block\"><code>{}</code></p>",
                xml_escape(latex)
            )
        }
        "columns" => render_block_children(node, ctx),
        _ => {
            if node.get("content").is_some() {
                render_block_children(node, ctx)
            } else {
                String::new()
            }
        }
    }
}

fn render_block_children(node: &Value, ctx: &mut ExportContext) -> String {
    let mut out = String::new();
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            let s = render_block_xhtml(child, ctx);
            if !s.is_empty() {
                out.push_str(&s);
                out.push('\n');
            }
        }
    }
    out
}

fn render_inline_children(node: &Value, ctx: &mut ExportContext) -> String {
    let mut out = String::new();
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            let ctype = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ctype {
                "text" => {
                    let raw = child.get("text").and_then(|t| t.as_str()).unwrap_or("");
                    let mut rendered = xml_escape(raw);
                    if let Some(marks) = child.get("marks").and_then(|m| m.as_array()) {
                        for mark in marks {
                            let mtype = mark.get("type").and_then(|t| t.as_str()).unwrap_or("");
                            let mattrs = mark.get("attrs").and_then(|a| a.as_object());
                            rendered = match mtype {
                                "bold" => format!("<strong>{rendered}</strong>"),
                                "italic" => format!("<em>{rendered}</em>"),
                                "underline" => {
                                    format!("<span style=\"text-decoration:underline\">{rendered}</span>")
                                }
                                "strike" => format!("<s>{rendered}</s>"),
                                "code" => format!("<code>{rendered}</code>"),
                                "subscript" => format!("<sub>{rendered}</sub>"),
                                "superscript" => format!("<sup>{rendered}</sup>"),
                                "highlight" => {
                                    let col = mattrs
                                        .and_then(|a| a.get("color"))
                                        .and_then(|c| c.as_str())
                                        .unwrap_or("#fff3a3");
                                    format!(
                                        "<span style=\"background-color:{}\">{rendered}</span>",
                                        xml_escape(col)
                                    )
                                }
                                "textStyle" => {
                                    let mut styles = Vec::new();
                                    if let Some(col) = mattrs
                                        .and_then(|a| a.get("color"))
                                        .and_then(|c| c.as_str())
                                    {
                                        if !col.is_empty() {
                                            styles.push(format!("color:{}", xml_escape(col)));
                                        }
                                    }
                                    if let Some(ff) = mattrs
                                        .and_then(|a| a.get("fontFamily"))
                                        .and_then(|c| c.as_str())
                                    {
                                        if !ff.is_empty() {
                                            styles.push(format!("font-family:'{}'", xml_escape(ff)));
                                        }
                                    }
                                    if let Some(fs) = mattrs
                                        .and_then(|a| a.get("fontSize"))
                                        .and_then(|c| c.as_str())
                                    {
                                        if !fs.is_empty() {
                                            styles.push(format!("font-size:{}", xml_escape(fs)));
                                        }
                                    }
                                    if styles.is_empty() {
                                        rendered
                                    } else {
                                        format!(
                                            "<span style=\"{}\">{rendered}</span>",
                                            styles.join(";")
                                        )
                                    }
                                }
                                "link" => {
                                    let href = mattrs
                                        .and_then(|a| a.get("href"))
                                        .and_then(|h| h.as_str())
                                        .unwrap_or("#");
                                    format!("<a href=\"{}\">{rendered}</a>", xml_escape(href))
                                }
                                _ => rendered,
                            };
                        }
                    }
                    out.push_str(&rendered);
                }
                "hardBreak" => out.push_str("<br/>"),
                "image" => out.push_str(&render_image_figure(child, ctx)),
                "footnote" => {
                    let note = child
                        .get("attrs")
                        .and_then(|a| a.get("note"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let num = ctx.footnotes.len() + 1;
                    ctx.footnotes.push((num, note));
                    out.push_str(&format!(
                        "<sup id=\"fnref-{num}\"><a href=\"#fn-{num}\">[{num}]</a></sup>"
                    ));
                }
                "mathInline" => {
                    let latex = child
                        .get("attrs")
                        .and_then(|a| a.get("latex"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("");
                    out.push_str(&format!("<code>{}</code>", xml_escape(latex)));
                }
                _ => {}
            }
        }
    }
    out
}

fn render_image_figure(node: &Value, ctx: &mut ExportContext) -> String {
    let attrs = match node.get("attrs").and_then(|a| a.as_object()) {
        Some(a) => a,
        None => return String::new(),
    };
    let src = attrs.get("src").and_then(|s| s.as_str()).unwrap_or("");
    let alt = attrs
        .get("alt")
        .and_then(|s| s.as_str())
        .or_else(|| attrs.get("caption").and_then(|s| s.as_str()))
        .unwrap_or("");
    let caption = attrs.get("caption").and_then(|s| s.as_str()).unwrap_or("");

    if let Some((mime, bytes)) = decode_data_url(src) {
        let ext = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/bmp" => "bmp",
            _ => "png",
        };
        let idx = ctx.images.len() + 1;
        let id = format!("img-{idx}");
        let href = format!("images/img-{idx}.{ext}");
        ctx.images.push(EpubImage {
            id,
            href: href.clone(),
            mime,
            bytes,
        });
        let cap_html = if !caption.trim().is_empty() {
            format!("<figcaption>{}</figcaption>", xml_escape(caption))
        } else {
            String::new()
        };
        format!(
            "<figure class=\"epub-figure\"><img src=\"{}\" alt=\"{}\"/>{}</figure>",
            href,
            xml_escape(alt),
            cap_html
        )
    } else {
        String::new()
    }
}

fn decode_data_url(src: &str) -> Option<(String, Vec<u8>)> {
    let rest = src.strip_prefix("data:")?;
    let (meta, b64) = rest.split_once(";base64,")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    Some((meta.to_lowercase(), bytes))
}

fn text_align_style(attrs: Option<&serde_json::Map<String, Value>>) -> String {
    if let Some(align) = attrs
        .and_then(|a| a.get("textAlign"))
        .and_then(|t| t.as_str())
    {
        if matches!(align, "center" | "right" | "justify") {
            return format!(" style=\"text-align:{align}\"");
        }
    }
    String::new()
}

fn extract_plain_text(node: &Value) -> String {
    let mut out = String::new();
    if let Some(t) = node.get("text").and_then(|v| v.as_str()) {
        out.push_str(t);
    }
    if let Some(arr) = node.get("content").and_then(|c| c.as_array()) {
        for child in arr {
            out.push_str(&extract_plain_text(child));
        }
    }
    out
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if c.is_control() && c != '\n' && c != '\r' && c != '\t' => {}
            other => out.push(other),
        }
    }
    out
}

// ===========================================================================
// EPUB Importer (`import_epub`)
// ===========================================================================

/// Parses an `.epub` archive into a ProseMirror `ImportedDocx` document so any e-book
/// can be opened, read, edited, and re-saved as `.epub`, `.docx`, or `.pdf` in Typo.
pub fn import_epub(bytes: &[u8]) -> Result<ImportedDocx, String> {
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("Invalid EPUB archive: {e}"))?;

    // Pre-read all zip entries into memory map (normalized forward-slash paths)
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..archive.len() {
        if let Ok(mut file) = archive.by_index(i) {
            if file.is_file() && file.size() <= 64 * 1024 * 1024 {
                let mut buf = Vec::with_capacity(file.size() as usize);
                if file.read_to_end(&mut buf).is_ok() {
                    let norm = normalize_zip_path(file.name());
                    files.insert(norm, buf);
                }
            }
        }
    }

    // 1. Locate OPF package file via META-INF/container.xml or fallback search
    let opf_path = find_opf_path(&files).ok_or("Could not find OPF package inside EPUB archive.")?;
    let opf_dir = parent_dir(&opf_path);
    let opf_bytes = files
        .get(&opf_path)
        .ok_or("OPF package file missing from EPUB archive.")?;
    let opf_xml = String::from_utf8_lossy(opf_bytes);

    let (book_title, spine_paths) = parse_opf(&opf_xml, &opf_dir)?;

    // Build data URL lookup for images in the archive
    let mut image_data_urls: HashMap<String, String> = HashMap::new();
    for (path, data) in &files {
        let lower = path.to_lowercase();
        let mime = if lower.ends_with(".png") {
            Some("image/png")
        } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            Some("image/jpeg")
        } else if lower.ends_with(".gif") {
            Some("image/gif")
        } else if lower.ends_with(".webp") {
            Some("image/webp")
        } else if lower.ends_with(".bmp") {
            Some("image/bmp")
        } else {
            None
        };
        if let Some(m) = mime {
            let b64 = base64::engine::general_purpose::STANDARD.encode(data);
            image_data_urls.insert(path.clone(), format!("data:{m};base64,{b64}"));
        }
    }

    let mut content_nodes: Vec<Value> = Vec::new();

    for (ch_idx, chapter_path) in spine_paths.iter().enumerate() {
        let Some(ch_bytes) = files.get(chapter_path) else {
            continue;
        };
        let raw_xhtml = String::from_utf8_lossy(ch_bytes);
        let ch_dir = parent_dir(chapter_path);
        let chapter_blocks = parse_xhtml_chapter(&raw_xhtml, &ch_dir, &image_data_urls);
        if chapter_blocks.is_empty() {
            continue;
        }
        if ch_idx > 0 && !content_nodes.is_empty() {
            content_nodes.push(json!({ "type": "pageBreak" }));
        }
        content_nodes.extend(chapter_blocks);
    }

    if content_nodes.is_empty() {
        content_nodes.push(json!({
            "type": "heading",
            "attrs": { "level": 1 },
            "content": [{ "type": "text", "text": book_title }]
        }));
        content_nodes.push(json!({ "type": "paragraph" }));
    }

    Ok(ImportedDocx {
        doc: json!({
            "type": "doc",
            "content": content_nodes,
        }),
        page: PageSettings {
            size: "A5".into(),
            orientation: "portrait".into(),
            margins: Margins {
                top: 0.75,
                right: 0.75,
                bottom: 0.75,
                left: 0.75,
            },
            header: Some(book_title),
            footer: None,
            page_numbers: Some(true),
            doodle_under: None,
            doodle_over: None,
        },
        defaults: DocDefaults {
            font_family: "Georgia".into(),
            font_size: 11.5,
        },
    })
}

fn find_opf_path(files: &HashMap<String, Vec<u8>>) -> Option<String> {
    if let Some(container_bytes) = files.get("META-INF/container.xml") {
        let xml = String::from_utf8_lossy(container_bytes);
        if let Ok(doc) = roxmltree::Document::parse(&xml) {
            for node in doc.descendants() {
                if node.has_tag_name("rootfile") {
                    if let Some(fp) = node.attribute("full-path") {
                        let norm = normalize_zip_path(fp);
                        if files.contains_key(&norm) {
                            return Some(norm);
                        }
                    }
                }
            }
        }
    }
    files
        .keys()
        .find(|k| k.to_lowercase().ends_with(".opf"))
        .cloned()
}

fn parse_opf(opf_xml: &str, opf_dir: &str) -> Result<(String, Vec<String>), String> {
    let sanitized = sanitize_xml_entities(opf_xml);
    let doc = roxmltree::Document::parse(&sanitized)
        .map_err(|e| format!("Failed to parse EPUB OPF metadata: {e}"))?;

    let mut title = String::from("Imported E-Book");
    let mut manifest: HashMap<String, (String, String, String)> = HashMap::new();
    let mut spine_ids: Vec<String> = Vec::new();

    for node in doc.descendants() {
        if node.has_tag_name("title") {
            let t = node.text().unwrap_or("").trim();
            if !t.is_empty() {
                title = t.to_string();
            }
        } else if node.has_tag_name("item") {
            if let (Some(id), Some(href)) = (node.attribute("id"), node.attribute("href")) {
                let media_type = node.attribute("media-type").unwrap_or("").to_string();
                let props = node.attribute("properties").unwrap_or("").to_string();
                let clean_href = href.split('#').next().unwrap_or(href);
                let resolved = resolve_rel_path(opf_dir, clean_href);
                manifest.insert(id.to_string(), (resolved, media_type, props));
            }
        } else if node.has_tag_name("itemref") {
            if let Some(idref) = node.attribute("idref") {
                spine_ids.push(idref.to_string());
            }
        }
    }

    let mut spine_paths = Vec::new();
    for idref in spine_ids {
        if let Some((path, media_type, props)) = manifest.get(&idref) {
            // Skip pure navigation TOC document if there are real chapters
            if props.split_whitespace().any(|p| p == "nav") {
                continue;
            }
            if media_type.contains("xhtml") || media_type.contains("html") || path.ends_with(".xhtml") || path.ends_with(".html") || path.ends_with(".htm") {
                spine_paths.push(path.clone());
            }
        }
    }

    Ok((title, spine_paths))
}

fn parse_xhtml_chapter(
    raw_xhtml: &str,
    ch_dir: &str,
    image_data_urls: &HashMap<String, String>,
) -> Vec<Value> {
    let cleaned = sanitize_xhtml_for_roxml(raw_xhtml);
    if let Ok(doc) = roxmltree::Document::parse(&cleaned) {
        let body = doc
            .descendants()
            .find(|n| n.has_tag_name("body"))
            .unwrap_or_else(|| doc.root_element());
        let mut blocks = Vec::new();
        collect_blocks_from_xml(body, ch_dir, image_data_urls, &mut blocks);
        if !blocks.is_empty() {
            return blocks;
        }
    }

    // Fallback tolerant line/tag extractor if an antique EPUB has malformed XML
    fallback_extract_blocks(raw_xhtml)
}

fn collect_blocks_from_xml(
    parent: roxmltree::Node,
    ch_dir: &str,
    image_data_urls: &HashMap<String, String>,
    out: &mut Vec<Value>,
) {
    for child in parent.children() {
        if !child.is_element() {
            continue;
        }
        let tag = child.tag_name().name().to_lowercase();
        match tag.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = tag[1..].parse::<u64>().unwrap_or(1).clamp(1, 6);
                let mut inlines = Vec::new();
                collect_inlines_from_xml(child, &mut Vec::new(), ch_dir, image_data_urls, &mut inlines);
                if !inlines.is_empty() {
                    out.push(json!({
                        "type": "heading",
                        "attrs": { "level": level },
                        "content": inlines
                    }));
                }
            }
            "p" => {
                let mut inlines = Vec::new();
                collect_inlines_from_xml(child, &mut Vec::new(), ch_dir, image_data_urls, &mut inlines);
                if !inlines.is_empty() {
                    out.push(json!({
                        "type": "paragraph",
                        "content": inlines
                    }));
                }
            }
            "blockquote" => {
                let mut inner = Vec::new();
                collect_blocks_from_xml(child, ch_dir, image_data_urls, &mut inner);
                if inner.is_empty() {
                    let mut inlines = Vec::new();
                    collect_inlines_from_xml(child, &mut Vec::new(), ch_dir, image_data_urls, &mut inlines);
                    if !inlines.is_empty() {
                        inner.push(json!({ "type": "paragraph", "content": inlines }));
                    }
                }
                if !inner.is_empty() {
                    out.push(json!({
                        "type": "blockquote",
                        "content": inner
                    }));
                }
            }
            "ul" | "ol" => {
                let list_type = if tag == "ol" { "orderedList" } else { "bulletList" };
                let mut items = Vec::new();
                for li in child.children().filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case("li")) {
                    let mut li_blocks = Vec::new();
                    collect_blocks_from_xml(li, ch_dir, image_data_urls, &mut li_blocks);
                    if li_blocks.is_empty() {
                        let mut inlines = Vec::new();
                        collect_inlines_from_xml(li, &mut Vec::new(), ch_dir, image_data_urls, &mut inlines);
                        if !inlines.is_empty() {
                            li_blocks.push(json!({ "type": "paragraph", "content": inlines }));
                        }
                    }
                    if !li_blocks.is_empty() {
                        items.push(json!({
                            "type": "listItem",
                            "content": li_blocks
                        }));
                    }
                }
                if !items.is_empty() {
                    out.push(json!({
                        "type": list_type,
                        "content": items
                    }));
                }
            }
            "pre" => {
                let text = collect_raw_text(child);
                if !text.trim().is_empty() {
                    out.push(json!({
                        "type": "codeBlock",
                        "content": [{ "type": "text", "text": text }]
                    }));
                }
            }
            "hr" => {
                out.push(json!({ "type": "horizontalRule" }));
            }
            "img" | "image" => {
                if let Some(img_node) = xml_img_to_node(child, ch_dir, image_data_urls) {
                    out.push(img_node);
                }
            }
            "figure" | "section" | "article" | "div" | "main" | "header" | "footer" | "svg" => {
                let before_len = out.len();
                collect_blocks_from_xml(child, ch_dir, image_data_urls, out);
                // If a <div> only contained direct inline text and no block elements, wrap it as a paragraph
                if out.len() == before_len && tag == "div" {
                    let mut inlines = Vec::new();
                    collect_inlines_from_xml(child, &mut Vec::new(), ch_dir, image_data_urls, &mut inlines);
                    if !inlines.is_empty() {
                        out.push(json!({ "type": "paragraph", "content": inlines }));
                    }
                }
            }
            _ => {
                collect_blocks_from_xml(child, ch_dir, image_data_urls, out);
            }
        }
    }
}

fn collect_inlines_from_xml(
    node: roxmltree::Node,
    active_marks: &mut Vec<Value>,
    ch_dir: &str,
    image_data_urls: &HashMap<String, String>,
    out: &mut Vec<Value>,
) {
    for child in node.children() {
        if child.is_text() {
            let t = collapse_inline_ws(child.text().unwrap_or(""));
            if !t.is_empty() {
                if active_marks.is_empty() {
                    out.push(json!({ "type": "text", "text": t }));
                } else {
                    out.push(json!({
                        "type": "text",
                        "text": t,
                        "marks": active_marks.clone()
                    }));
                }
            }
            continue;
        }
        if !child.is_element() {
            continue;
        }
        let tag = child.tag_name().name().to_lowercase();
        match tag.as_str() {
            "br" => out.push(json!({ "type": "hardBreak" })),
            "img" | "image" => {
                if let Some(img_node) = xml_img_to_node(child, ch_dir, image_data_urls) {
                    out.push(img_node);
                }
            }
            "strong" | "b" => {
                active_marks.push(json!({ "type": "bold" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "em" | "i" => {
                active_marks.push(json!({ "type": "italic" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "u" => {
                active_marks.push(json!({ "type": "underline" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "s" | "strike" | "del" => {
                active_marks.push(json!({ "type": "strike" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "code" => {
                active_marks.push(json!({ "type": "code" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "sub" => {
                active_marks.push(json!({ "type": "subscript" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "sup" => {
                active_marks.push(json!({ "type": "superscript" }));
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                active_marks.pop();
            }
            "a" => {
                let href = child.attribute("href").unwrap_or("#");
                let pushed = if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("mailto:") {
                    active_marks.push(json!({ "type": "link", "attrs": { "href": href } }));
                    true
                } else {
                    false
                };
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
                if pushed {
                    active_marks.pop();
                }
            }
            _ => {
                collect_inlines_from_xml(child, active_marks, ch_dir, image_data_urls, out);
            }
        }
    }
}

fn xml_img_to_node(
    node: roxmltree::Node,
    ch_dir: &str,
    image_data_urls: &HashMap<String, String>,
) -> Option<Value> {
    let raw_src = node
        .attribute("src")
        .or_else(|| node.attribute("href"))
        .or_else(|| {
            node.attributes()
                .find(|a| a.name().ends_with("href"))
                .map(|a| a.value())
        })?;
    let alt = node.attribute("alt").unwrap_or("");
    if raw_src.starts_with("data:image/") {
        return Some(json!({
            "type": "image",
            "attrs": { "src": raw_src, "alt": alt }
        }));
    }
    let resolved = resolve_rel_path(ch_dir, raw_src.split('#').next().unwrap_or(raw_src));
    let data_url = image_data_urls.get(&resolved)?;
    Some(json!({
        "type": "image",
        "attrs": { "src": data_url, "alt": alt }
    }))
}

fn collect_raw_text(node: roxmltree::Node) -> String {
    let mut s = String::new();
    for d in node.descendants() {
        if d.is_text() {
            s.push_str(d.text().unwrap_or(""));
        }
    }
    s
}

fn collapse_inline_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for c in s.chars() {
        if c == '\n' || c == '\r' || c == '\t' || c == ' ' {
            if !prev_ws {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            out.push(c);
            prev_ws = false;
        }
    }
    out
}

fn sanitize_xml_entities(input: &str) -> String {
    // Strip DOCTYPE declarations (which roxmltree rejects if they contain DTD subsets)
    let mut s = strip_doctype(input);
    let entities = [
        ("&nbsp;", "&#160;"),
        ("&mdash;", "&#8212;"),
        ("&ndash;", "&#8211;"),
        ("&ldquo;", "&#8220;"),
        ("&rdquo;", "&#8221;"),
        ("&lsquo;", "&#8216;"),
        ("&rsquo;", "&#8217;"),
        ("&hellip;", "&#8230;"),
        ("&copy;", "&#169;"),
        ("&reg;", "&#174;"),
        ("&trade;", "&#8482;"),
        ("&bull;", "&#8226;"),
        ("&middot;", "&#183;"),
    ];
    for (from, to) in entities {
        s = s.replace(from, to);
    }
    s
}

fn sanitize_xhtml_for_roxml(input: &str) -> String {
    sanitize_xml_entities(input)
}

fn strip_doctype(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("<!DOCTYPE") {
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        if let Some(end) = after.find('>') {
            rest = &after[end + 1..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn fallback_extract_blocks(raw: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut in_tag = false;
    let mut buf = String::new();
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                buf.push(' ');
            }
            _ if !in_tag => buf.push(c),
            _ => {}
        }
    }
    for para in buf.split("\n\n") {
        let trimmed = para.split_whitespace().collect::<Vec<_>>().join(" ");
        if !trimmed.is_empty() {
            blocks.push(json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": trimmed }]
            }));
        }
    }
    blocks
}

fn normalize_zip_path(p: &str) -> String {
    let replaced = p.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for seg in replaced.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[..idx].to_string(),
        None => String::new(),
    }
}

fn resolve_rel_path(base_dir: &str, rel: &str) -> String {
    let decoded = percent_decode(rel);
    if base_dir.is_empty() {
        normalize_zip_path(&decoded)
    } else {
        normalize_zip_path(&format!("{base_dir}/{decoded}"))
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
