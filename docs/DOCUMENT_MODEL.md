# Typo Document Model (frontend <-> Rust contract)

The editor is TipTap 3 (ProseMirror). Documents travel between the webview and the
Rust core as **ProseMirror JSON** (`editor.getJSON()`), plus a `PageSettings` object.

```jsonc
// Node
{ "type": "paragraph", "attrs": { ... }, "content": [ Node, ... ] }
// Text node
{ "type": "text", "text": "Hello", "marks": [ { "type": "bold" }, ... ] }
```

`attrs`, `content` and `marks` are all optional. Unknown attrs must be ignored.

## Block nodes

| type | attrs | content |
|---|---|---|
| `doc` | – | block+ |
| `paragraph` | `textAlign`: `"left"\|"center"\|"right"\|"justify"\|null`, `lineHeight`: string like `"1.15"` or null, `indent`: integer 0..8 or null (each step = 0.5in), `styleName`: `"Title"\|"Subtitle"\|null` | inline* |
| `heading` | `level` 1..6, `textAlign`, `lineHeight`, `indent` | inline* |
| `blockquote` | – | block+ |
| `codeBlock` | `language`: string or null | text* (no marks; `\n` separates lines) |
| `bulletList` | – | listItem+ |
| `orderedList` | `start`: integer (default 1), `type`: `"1"\|"a"\|"A"\|"i"\|"I"\|null` | listItem+ |
| `listItem` | – | paragraph block* |
| `taskList` / `taskItem` | `checked` bool (taskItem) | treat like bulletList/listItem, render ☐ / ☑ prefix on export |
| `horizontalRule` | – | – |
| `pageBreak` | – | – |
| `table` | – | tableRow+ |
| `tableRow` | – | (tableCell \| tableHeader)+ |
| `tableCell` / `tableHeader` | `colspan` int (1), `rowspan` int (1), `colwidth`: int[] (px) or null, `backgroundColor`: `"#rrggbb"` or null | block+ |

`paragraph.attrs.styleName` may be `"Title"` or `"Subtitle"` (Word built-in styles) — otherwise null.

## Inline nodes

| type | attrs |
|---|---|
| `text` | `text`, `marks` |
| `hardBreak` | – |
| `image` | `src`: data URL (`data:image/png;base64,...`), `alt`, `title`, `width`: px number or null, `height`: px number or null |

Images are **inline** (they live inside paragraphs, like Word inline pictures).

## Marks

| type | attrs |
|---|---|
| `bold`, `italic`, `underline`, `strike`, `code`, `subscript`, `superscript` | – |
| `link` | `href`, `target` |
| `textStyle` | `fontFamily` (CSS font-family string; first family wins, quotes stripped), `fontSize` (`"11pt"` or `"14px"`), `color` (`"#rrggbb"` or `rgb(r,g,b)`) — any may be null |
| `highlight` | `color` (`"#rrggbb"`) |

## PageSettings

```json
{
  "size": "A4" | "Letter" | "Legal" | "A5" | "Executive",
  "orientation": "portrait" | "landscape",
  "margins": { "top": 1.0, "right": 1.0, "bottom": 1.0, "left": 1.0 }   // inches
}
```

Page dimensions (portrait, twips): A4 11906x16838, Letter 12240x15840, Legal 12240x20160,
A5 8391x11906, Executive 10440x15120. Landscape swaps width/height and sets `w:orient="landscape"`.

## Defaults

`DocDefaults { "fontFamily": "Calibri", "fontSize": 11 /* pt */ }` is passed on export and
returned on import (from `w:docDefaults` / `Normal` style).

## Rust API (src-tauri/src/docx/)

```rust
pub fn export_docx(doc: &serde_json::Value, page: &PageSettings, defaults: &DocDefaults, title: &str) -> Result<Vec<u8>, String>;
pub fn import_docx(bytes: &[u8]) -> Result<ImportedDocx, String>;
// ImportedDocx { doc: serde_json::Value, page: PageSettings, defaults: DocDefaults }  (serde camelCase)
```

Imported JSON must be **schema-valid** for the table above:
no empty text nodes, `listItem` starts with a paragraph, table cells contain at least one paragraph,
`doc` contains at least one block, near-black text colours (`auto`, `000000`, luminance < 0.12) are
dropped so text follows the theme's automatic colour.
