// Text Tools — example Typo plugin.
//
// A plugin is an ES module whose default export receives the `typo` API:
//   typo.ribbon.addTab(id, label).addGroup(label).button({ icon, label, size, onClick })
//   typo.editor            -> the TipTap editor (full power, use with care)
//   typo.document          -> getText(), getSelectionText(), replaceSelection(text), insert(content) ...
//   typo.on(event, fn)     -> "document:open" | "document:save" | "document:change" | "selection:change" ...
//   typo.ui.toast(msg) / typo.ui.prompt(title, fields)
//   typo.storage.get/set   -> per-plugin persistent storage
// Icons are Lucide names (https://lucide.dev/icons), e.g. "CaseUpper", "Timer".
// Return a function to run cleanup when the plugin is disabled.

export default function activate(typo) {
  const group = typo.ribbon.addTab("tools", "Tools").addGroup("Text Tools");

  const transform = (fn) => () => {
    const text = typo.document.getSelectionText();
    if (!text) return typo.ui.toast("Select some text first");
    typo.document.replaceSelection(fn(text));
  };

  group.button({ icon: "CaseUpper", label: "UPPERCASE", size: "small", onClick: transform((t) => t.toUpperCase()) });
  group.button({ icon: "CaseLower", label: "lowercase", size: "small", onClick: transform((t) => t.toLowerCase()) });
  group.button({
    icon: "CaseSensitive",
    label: "Title Case",
    size: "small",
    onClick: transform((t) => t.toLowerCase().replace(/(^|[\s\-("'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())),
  });
  group.button({
    icon: "Type",
    label: "Sentence case",
    size: "small",
    onClick: transform((t) => t.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase())),
  });

  const stats = typo.ribbon.addTab("tools", "Tools").addGroup("Statistics");
  stats.button({
    icon: "Timer",
    label: "Reading time",
    onClick: () => {
      const words = (typo.document.getText().match(/\S+/g) || []).length;
      const minutes = Math.max(1, Math.round(words / 238));
      const speak = Math.max(1, Math.round(words / 150));
      typo.ui.toast(`${words.toLocaleString()} words · ~${minutes} min read · ~${speak} min to speak`, "info");
    },
  });
}
