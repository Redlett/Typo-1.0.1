use std::path::Path;
use std::process::Command;
use serde_json::json;
use typo_lib::docx::{export_docx, DocDefaults, Margins, PageSettings};

#[test]
fn test_libreoffice_docx_compatibility() {
    let doc = json!({
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": { "level": 1 },
                "content": [{ "type": "text", "text": "Typo Compatibility Document" }]
            },
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "This document was exported by " },
                    { "type": "text", "marks": [{ "type": "bold" }], "text": "Typo" },
                    { "type": "text", "text": " and is being verified for Microsoft Word and LibreOffice compatibility." }
                ]
            },
            {
                "type": "bulletList",
                "content": [
                    {
                        "type": "listItem",
                        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Ultra-fast native Rust performance" }] }]
                    },
                    {
                        "type": "listItem",
                        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Fluent Ribbon interface" }] }]
                    },
                    {
                        "type": "listItem",
                        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Zero-telemetry local storage" }] }]
                    }
                ]
            },
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableHeader",
                                "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Feature" }] }]
                            },
                            {
                                "type": "tableHeader",
                                "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Status" }] }]
                            }
                        ]
                    },
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "OpenXML Export" }] }]
                            },
                            {
                                "type": "tableCell",
                                "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Verified" }] }]
                            }
                        ]
                    }
                ]
            }
        ]
    });

    let page = PageSettings {
        size: "A4".into(),
        orientation: "portrait".into(),
        margins: Margins { top: 1.0, bottom: 1.0, left: 1.0, right: 1.0 },
    };
    let defaults = DocDefaults {
        font_family: "Segoe UI".into(),
        font_size: 11.0,
    };

    let bytes = export_docx(&doc, &page, &defaults, "Compatibility Test").expect("Failed to export docx");
    let out_docx = Path::new("target").join("test_sample.docx");
    std::fs::write(&out_docx, &bytes).expect("Failed to write test_sample.docx");

    let soffice = r#"C:\Program Files\LibreOffice\program\soffice.exe"#;
    if Path::new(soffice).exists() {
        let status = Command::new(soffice)
            .args(["--headless", "--convert-to", "pdf", "test_sample.docx", "--outdir", "."])
            .current_dir("target")
            .status()
            .expect("Failed to execute soffice");

        assert!(status.success(), "LibreOffice conversion failed");
        let out_pdf = Path::new("target").join("test_sample.pdf");
        assert!(out_pdf.exists(), "test_sample.pdf was not generated");
        println!("LibreOffice conversion succeeded: {:?}", out_pdf);
    }
}
