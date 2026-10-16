# Typo — A fast, private, and Vibe-Coded Microsoft Word Alternative with customizable features.

**Typo** is a native Windows desktop word processor, EPUB 3.0 e-book studio, and visual PDF editor built with **Tauri 2 (Rust + WebView2)** and **TypeScript**.

---

##  Key Features

- **Rich Document Studio**: Full `.docx`, `.md`, `.html`, `.txt`, and `.typo` native editing with live multi-page pagination, headers & footers, customizable margins, tables, equations, and callouts.
- **Visual PDF Editor Suite**: Dedicated 1:1 visual PDF canvas with direct text-block editing, image replacement/deletion, freeform callouts, highlights, signatures, and lossless PDF export.
- **EPUB 3.0 E-Book Reader & Publisher**: Read and edit multi-chapter `.epub` books with preserved formatting and embedded artwork, or compile manuscripts into valid EPUB 3.0 packages with cover art and metadata.
- **Themes & Studio Customization**: 15 curated workspace themes, Custom Studio Palette builder, custom paper textures, Liquid Glass UI mode, and ambient focus audio.
- **100% Local & Private**: Zero telemetry, zero cloud accounts, and native Windows 11 offline COM spellcheck & proofing.
- **Built-in Auto-Updater**: Check for new releases and install updates in-app via **File → About → Check for Updates**.

<img width="1920" height="1140" alt="Screenshot 2026-10-16 221108" src="https://github.com/user-attachments/assets/01b716e0-803b-4755-8358-9000469cb635" />

<img width="1920" height="1139" alt="Screenshot 2026-10-16 221252" src="https://github.com/user-attachments/assets/8ef30949-f876-4dfc-8cbe-488a56ac0809" />



---

##  Download & Install

Grab the latest **`Typo_1.0.1_x64-setup.exe`** installer from the [**Releases**](https://github.com/Redlett/Typo-1.0.1/releases) page.

---

## 🛠️ Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+)
- [Rust & Cargo](https://rustup.rs/) (stable MSVC toolchain)

### Development & Release Build
```powershell
# Install dependencies
npm install

# Build production installer & portable executable
.\publish-release.ps1 -Version "1.0.1"
```
