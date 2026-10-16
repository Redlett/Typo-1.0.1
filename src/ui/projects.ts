/**
 * Beginner-Friendly Writer's Projects Binder (`File → Projects` & Workspace `#project-sidebar`).
 *
 * Lets writers create a dedicated folder on their PC for a book, story, or research project
 * and effortlessly add pages (`+ Add Page`, `+ Add Brainstorm Page`), switch between pages,
 * rename pages, or delete pages — without needing complex database tools like Notion.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { native, type ProjectFileEntry } from "../core/native";
import { settings, saveSettings, pushRecentProject, removeRecentProject } from "../core/settings";
import { state, on, emit } from "../core/state";
import { openPath, newDocument, newFromPreset, saveDocxDirect } from "../core/document";
import { DOCUMENT_PRESETS } from "../core/presets";
import { h, icon, promptDialog, toast } from "./dom";

let sidebarEl: HTMLElement | null = null;
let cachedFiles: ProjectFileEntry[] = [];

function folderDisplayName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Project";
}

function joinPath(dir: string, file: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${file}`;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function isProjectSidebarOpen(): boolean {
  return Boolean(settings.activeProjectFolder && settings.projectSidebarOpen);
}

export function toggleProjectSidebar(force?: boolean): void {
  if (!settings.activeProjectFolder) {
    void createNewProjectFlow();
    return;
  }
  settings.projectSidebarOpen = force !== undefined ? force : !settings.projectSidebarOpen;
  saveSettings();
  syncProjectSidebar();
  emit("project:change");
}

export function initProjectSidebar(): void {
  const workspace = document.getElementById("workspace");
  const canvas = document.getElementById("canvas");
  if (!workspace || !canvas) return;

  if (!sidebarEl) {
    sidebarEl = document.createElement("aside");
    sidebarEl.id = "project-sidebar";
    sidebarEl.className = "project-sidebar";
    sidebarEl.hidden = true;
    workspace.insertBefore(sidebarEl, canvas);
  }

  on("document:open", () => renderSidebarContents());
  on("document:save", () => void refreshActiveProjectFiles());
  on("tabs:change", () => renderSidebarContents());

  if (settings.activeProjectFolder) {
    void refreshActiveProjectFiles();
  }
}

export async function refreshActiveProjectFiles(): Promise<ProjectFileEntry[]> {
  const folder = settings.activeProjectFolder;
  if (!folder) {
    cachedFiles = [];
    syncProjectSidebar();
    return [];
  }
  try {
    cachedFiles = await native.listProjectFiles(folder);
  } catch {
    cachedFiles = [];
  }
  syncProjectSidebar();
  return cachedFiles;
}

function syncProjectSidebar(): void {
  if (!sidebarEl) return;
  const show = Boolean(settings.activeProjectFolder && settings.projectSidebarOpen);
  sidebarEl.hidden = !show;
  document.documentElement.dataset.projectSidebar = show ? "on" : "off";
  if (show) {
    renderSidebarContents();
  }
}

function renderSidebarContents(): void {
  if (!sidebarEl || sidebarEl.hidden || !settings.activeProjectFolder) return;
  const folder = settings.activeProjectFolder;
  const projName = folderDisplayName(folder);
  const activePathLower = (state.path || "").toLowerCase();

  const listEl = h("div", { class: "project-sidebar__list" });

  if (cachedFiles.length === 0) {
    listEl.append(
      h(
        "div",
        { class: "project-sidebar__empty" },
        h("p", {}, "No pages in this project yet."),
        h("span", {}, "Click \"+ Page\" or \"+ Brainstorm\" above to add your first page."),
      ),
    );
  } else {
    cachedFiles.forEach((f, idx) => {
      const isCurrent = f.path.toLowerCase() === activePathLower;
      const item = h(
        "div",
        {
          class: `project-sidebar__item ${isCurrent ? "is-active" : ""}`,
          title: f.path,
          onclick: () => {
            void openPath(f.path);
          },
        },
        h("span", { class: "project-sidebar__idx" }, String(idx + 1)),
        h(
          "div",
          { class: "project-sidebar__meta" },
          h("span", { class: "project-sidebar__name" }, stripExt(f.name)),
          h("span", { class: "project-sidebar__ext" }, `.${f.kind}`),
        ),
        h(
          "div",
          { class: "project-sidebar__item-actions" },
          h(
            "button",
            {
              type: "button",
              class: "project-sidebar__mini-btn",
              "data-tip": "Rename Page",
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                void renameProjectPageFlow(f);
              },
            },
            icon("Pencil", 12),
          ),
          h(
            "button",
            {
              type: "button",
              class: "project-sidebar__mini-btn project-sidebar__mini-btn--danger",
              "data-tip": "Delete Page",
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                void deleteProjectPageFlow(f);
              },
            },
            icon("Trash2", 12),
          ),
        ),
      );
      listEl.append(item);
    });
  }

  sidebarEl.replaceChildren(
    h(
      "div",
      { class: "project-sidebar__head" },
      h(
        "div",
        { class: "project-sidebar__title-wrap" },
        icon("FolderOpen", 15),
        h("div", { class: "project-sidebar__titles" },
          h("strong", { class: "project-sidebar__title" }, projName),
          h("span", { class: "project-sidebar__sub" }, `${cachedFiles.length} ${cachedFiles.length === 1 ? "page" : "pages"}`),
        ),
      ),
      h(
        "div",
        { class: "project-sidebar__head-btns" },
        h(
          "button",
          {
            type: "button",
            class: "scratchpad__close",
            "data-tip": "Open Project Folder in File Explorer",
            onclick: () => void native.openFolder(folder),
          },
          icon("ExternalLink", 13),
        ),
        h(
          "button",
          {
            type: "button",
            class: "scratchpad__close",
            "data-tip": "Hide Project Sidebar",
            onclick: () => toggleProjectSidebar(false),
          },
          icon("X", 14),
        ),
      ),
    ),
    h(
      "div",
      { class: "project-sidebar__toolbar" },
      h(
        "button",
        {
          type: "button",
          class: "project-sidebar__add-btn project-sidebar__add-btn--primary",
          "data-tip": "Create a new writing page in this project folder",
          onclick: () => void addPageToActiveProject("page"),
        },
        icon("Plus", 13),
        h("span", {}, "New Page"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "project-sidebar__add-btn",
          "data-tip": "Create a Landscape Brainstorm & Doodle page in this project folder",
          onclick: () => void addPageToActiveProject("brainstorm"),
        },
        icon("Pencil", 13),
        h("span", {}, "Brainstorm"),
      ),
    ),
    listEl,
  );
}

export async function activateProjectFolder(folderPath: string, openFirstPageIfNone = true): Promise<void> {
  settings.activeProjectFolder = folderPath;
  settings.projectSidebarOpen = true;
  pushRecentProject(folderPath, folderDisplayName(folderPath));
  const files = await refreshActiveProjectFiles();

  if (files.length === 0 && openFirstPageIfNone) {
    // Automatically create "Page 1.docx" so a brand-new project is immediately ready to write in
    await createPageFileInFolder(folderPath, "Page 1", "page");
    await refreshActiveProjectFiles();
  } else if (openFirstPageIfNone && files.length > 0) {
    const activeInFolder = state.path && state.path.toLowerCase().startsWith(folderPath.toLowerCase());
    if (!activeInFolder) {
      await openPath(files[0].path);
    }
  }
  emit("project:change");
}

async function createPageFileInFolder(
  folderPath: string,
  rawTitle: string,
  kind: "page" | "brainstorm",
): Promise<string | null> {
  const safeName = rawTitle
    .trim()
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.docx$/i, "") || "Page 1";
  const targetPath = joinPath(folderPath, `${safeName}.docx`);

  if (kind === "brainstorm") {
    const preset = DOCUMENT_PRESETS.find((p) => p.id === "brainstorm");
    if (preset) {
      await newFromPreset(preset, false);
    } else {
      await newDocument(false);
    }
  } else {
    await newDocument(false);
  }
  state.name = `${safeName}.docx`;
  const ok = await saveDocxDirect(targetPath);
  if (!ok) return null;
  await refreshActiveProjectFiles();
  return targetPath;
}

export async function addPageToActiveProject(
  kind: "page" | "brainstorm" = "page",
  onComplete?: () => void,
): Promise<void> {
  const folder = settings.activeProjectFolder;
  if (!folder) {
    await createNewProjectFlow(onComplete);
    return;
  }

  const nextNum = cachedFiles.length + 1;
  const defaultTitle = kind === "brainstorm" ? `Brainstorm ${nextNum}` : `Page ${nextNum}`;
  const res = await promptDialog(
    kind === "brainstorm" ? "Add Brainstorm Page to Project" : "Add New Page to Project",
    [
      {
        name: "title",
        label: "Page Title (saved as a .docx file inside your Project folder)",
        value: defaultTitle,
        placeholder: kind === "brainstorm" ? "e.g. Character Sketch · World Map" : "e.g. Chapter 1 — The Beginning",
      },
    ],
    kind === "brainstorm" ? "Create Brainstorm Page" : "Create Page",
  );
  if (!res) return;
  const created = await createPageFileInFolder(folder, res.title || defaultTitle, kind);
  if (created && onComplete) onComplete();
}

export async function renameProjectPageFlow(entry: ProjectFileEntry, onComplete?: () => void): Promise<void> {
  const currentBase = stripExt(entry.name);
  const res = await promptDialog(
    "Rename Project Page",
    [
      {
        name: "name",
        label: "New Page Title",
        value: currentBase,
      },
    ],
    "Rename",
  );
  if (!res || !res.name.trim() || res.name.trim() === currentBase) return;
  try {
    const newPath = await native.renameProjectFile(entry.path, res.name.trim());
    if (state.path && state.path.toLowerCase() === entry.path.toLowerCase()) {
      state.path = newPath;
      state.name = newPath.split(/[\\/]/).pop() || state.name;
      emit("tabs:change");
    }
    await refreshActiveProjectFiles();
    if (onComplete) onComplete();
    toast(`Renamed page to "${res.name.trim()}"`, "success", 1600);
  } catch (e) {
    toast(`Couldn't rename page: ${e}`, "error", 3200);
  }
}

export async function deleteProjectPageFlow(entry: ProjectFileEntry, onComplete?: () => void): Promise<void> {
  const root = document.getElementById("overlay-root") || document.body;
  root.querySelectorAll(".scrim").forEach((el) => el.remove());
  const close = () => scrim.remove();

  const scrim = h(
    "div",
    {
      class: "scrim scrim--in",
      onmousedown: (e: MouseEvent) => {
        if (e.target === scrim) close();
      },
    },
    h(
      "div",
      { class: "modal discard-modal" },
      h(
        "div",
        { class: "discard-modal__head" },
        icon("Trash2", 18),
        h("h2", { class: "modal__title" }, `Delete "${stripExt(entry.name)}"?`),
      ),
      h(
        "p",
        { class: "discard-modal__desc" },
        `This will permanently remove "${entry.name}" from your project folder on disk.`,
      ),
      h(
        "div",
        { class: "modal__actions" },
        h("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--danger",
            onclick: async () => {
              close();
              try {
                await native.deleteProjectFile(entry.path);
                await refreshActiveProjectFiles();
                if (onComplete) onComplete();
                toast(`Deleted "${entry.name}"`, "info", 1600);
              } catch (e) {
                toast(`Delete failed: ${e}`, "error", 3200);
              }
            },
          },
          icon("Trash2", 14),
          "Delete Page",
        ),
      ),
    ),
  );
  root.append(scrim);
}

export async function createNewProjectFlow(onSuccess?: () => void): Promise<void> {
  let baseDir = "";
  try {
    baseDir = await native.defaultProjectsDir();
  } catch {
    baseDir = "";
  }

  const root = document.getElementById("overlay-root") || document.body;
  root.querySelectorAll(".scrim").forEach((el) => el.remove());
  const close = () => scrim.remove();

  const nameInput = h("input", {
    type: "text",
    class: "input field__input",
    value: "My First Book",
    placeholder: "e.g. My Novel · Story Bible · Semester Notes",
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void createNow();
      } else if (e.key === "Escape") {
        close();
      }
    },
  }) as HTMLInputElement;

  const dirInput = h("input", {
    type: "text",
    class: "input field__input",
    value: baseDir,
    placeholder: "Select a folder on your PC…",
  }) as HTMLInputElement;

  const browseBtn = h(
    "button",
    {
      type: "button",
      class: "btn",
      onclick: async () => {
        const picked = await openDialog({
          directory: true,
          multiple: false,
          defaultPath: dirInput.value || undefined,
          title: "Choose Where to Create Your Project Folder",
        });
        if (typeof picked === "string" && picked) {
          dirInput.value = picked;
        }
      },
    },
    icon("FolderOpen", 14),
    "Browse…",
  );

  const createNow = async () => {
    const projName = nameInput.value.trim();
    const parentDir = dirInput.value.trim();
    if (!projName) {
      toast("Please enter a name for your project", "info", 1800);
      nameInput.focus();
      return;
    }
    if (!parentDir) {
      toast("Please select a parent folder on your PC", "info", 1800);
      return;
    }
    try {
      const createdFolder = await native.createProjectFolder(parentDir, projName);
      close();
      await activateProjectFolder(createdFolder, true);
      if (onSuccess) onSuccess();
      toast(`Created project "${projName}" with Page 1 ready!`, "success", 2400);
    } catch (e) {
      toast(`Couldn't create project folder: ${e}`, "error", 3800);
    }
  };

  const scrim = h(
    "div",
    {
      class: "scrim scrim--in",
      onmousedown: (e: MouseEvent) => {
        if (e.target === scrim) close();
      },
    },
    h(
      "div",
      { class: "modal project-create-modal" },
      h(
        "div",
        { class: "preflight__head" },
        h("div", { class: "preflight__title" }, icon("FolderPlus", 18), h("h2", { class: "modal__title" }, "Create New Writer's Project")),
        h("button", { type: "button", class: "scratchpad__close", onclick: close }, icon("X", 15)),
      ),
      h(
        "p",
        { class: "discard-modal__desc" },
        "A Project creates a dedicated folder right on your PC where you can add pages, chapters, and brainstorm sheets — everything stays organized as real files on your computer.",
      ),
      h(
        "label",
        { class: "field" },
        h("span", { class: "field__label" }, "Project Name"),
        nameInput,
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "Save Inside Folder on PC"),
        h("div", { class: "project-dir-row" }, dirInput, browseBtn),
      ),
      h(
        "div",
        { class: "modal__actions" },
        h("button", { type: "button", class: "btn", onclick: close }, "Cancel"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--primary",
            onclick: () => void createNow(),
          },
          icon("Sparkles", 14),
          "Create Project & First Page",
        ),
      ),
    ),
  );

  root.append(scrim);
  setTimeout(() => {
    nameInput.focus();
    nameInput.select();
  }, 30);
}

export async function openExistingProjectFolderFlow(onSuccess?: () => void): Promise<void> {
  let defaultDir = settings.activeProjectFolder;
  if (!defaultDir) {
    try {
      defaultDir = await native.defaultProjectsDir();
    } catch {
      defaultDir = "";
    }
  }
  const picked = await openDialog({
    directory: true,
    multiple: false,
    defaultPath: defaultDir || undefined,
    title: "Select a Folder on Your PC to Open as a Project",
  });
  if (typeof picked === "string" && picked) {
    await activateProjectFolder(picked, true);
    if (onSuccess) onSuccess();
    toast(`Opened project "${folderDisplayName(picked)}"`, "success", 2000);
  }
}

/** Builds the `File → Projects` view (right under `Blank Doc`). */
export function buildProjectsBackstageSection(closeBackstage: () => void): HTMLElement {
  const host = h("div", { class: "bs-projects-host" });

  const render = async () => {
    const activeFolder = settings.activeProjectFolder;
    const files = activeFolder ? await refreshActiveProjectFiles() : [];

    // Top Hero Action Cards
    const heroGrid = h(
      "div",
      { class: "bs-projects-hero" },
      h(
        "button",
        {
          type: "button",
          class: "bs-project-action-card bs-project-action-card--primary",
          onclick: () => void createNewProjectFlow(() => closeBackstage()),
        },
        h("div", { class: "bs-project-action-card__icon" }, icon("FolderPlus", 22)),
        h(
          "div",
          { class: "bs-project-action-card__body" },
          h("strong", {}, "Create New Project Folder"),
          h(
            "span",
            {},
            "Creates a dedicated folder on your PC and starts you off with Page 1 so you can keep chapters, notes, and brainstorms in one place.",
          ),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "bs-project-action-card",
          onclick: () => void openExistingProjectFolderFlow(() => closeBackstage()),
        },
        h("div", { class: "bs-project-action-card__icon" }, icon("FolderOpen", 22)),
        h(
          "div",
          { class: "bs-project-action-card__body" },
          h("strong", {}, "Open Existing Folder from PC"),
          h(
            "span",
            {},
            "Pick any folder on your computer to turn it into a writer's binder and browse or add pages inside it.",
          ),
        ),
      ),
    );

    // Active Project Binder Section
    let activeBinderEl: HTMLElement;
    if (activeFolder) {
      const projName = folderDisplayName(activeFolder);
      const pageCards =
        files.length === 0
          ? h(
              "div",
              { class: "bs-empty" },
              "This project folder doesn't have any pages yet. Click \"+ Add Page\" or \"+ Add Brainstorm Page\" above to start!",
            )
          : h(
              "div",
              { class: "bs-project-pages-grid" },
              ...files.map((f, i) =>
                h(
                  "div",
                  {
                    class: "bs-project-page-card",
                    onclick: () => {
                      closeBackstage();
                      void openPath(f.path);
                    },
                  },
                  h(
                    "div",
                    { class: "bs-project-page-card__top" },
                    h("span", { class: "bs-project-page-card__num" }, `Page ${i + 1}`),
                    h("span", { class: "bs-project-page-card__ext" }, `.${f.kind}`),
                  ),
                  h("strong", { class: "bs-project-page-card__title" }, stripExt(f.name)),
                  h(
                    "span",
                    { class: "bs-project-page-card__date" },
                    f.modified ? new Date(f.modified).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "",
                  ),
                  h(
                    "div",
                    { class: "bs-project-page-card__actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn--sm",
                        onclick: (e: MouseEvent) => {
                          e.stopPropagation();
                          void renameProjectPageFlow(f, () => void render());
                        },
                      },
                      icon("Pencil", 12),
                      "Rename",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn--sm",
                        onclick: (e: MouseEvent) => {
                          e.stopPropagation();
                          void deleteProjectPageFlow(f, () => void render());
                        },
                      },
                      icon("Trash2", 12),
                      "Delete",
                    ),
                  ),
                ),
              ),
            );

      activeBinderEl = h(
        "div",
        { class: "bs-card bs-project-binder" },
        h(
          "div",
          { class: "bs-section-head bs-project-binder__head" },
          h(
            "div",
            { class: "bs-project-binder__title" },
            h("div", { class: "bs-card__title" }, icon("BookOpen", 16), `Active Project: ${projName}`),
            h("p", { class: "bs-card__desc" }, activeFolder),
          ),
          h(
            "div",
            { class: "bs-project-binder__actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn--primary",
                onclick: () => void addPageToActiveProject("page", () => closeBackstage()),
              },
              icon("Plus", 14),
              "Add New Page",
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn",
                onclick: () => void addPageToActiveProject("brainstorm", () => closeBackstage()),
              },
              icon("Pencil", 14),
              "Add Brainstorm Page",
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn",
                onclick: () => {
                  settings.projectSidebarOpen = true;
                  saveSettings();
                  syncProjectSidebar();
                  closeBackstage();
                },
              },
              icon("PanelLeft", 14),
              "Show in Workspace Sidebar",
            ),
            h(
              "button",
              {
                type: "button",
                class: "btn",
                onclick: () => void native.openFolder(activeFolder),
              },
              icon("ExternalLink", 14),
              "Open in Explorer",
            ),
          ),
        ),
        pageCards,
      );
    } else {
      activeBinderEl = h(
        "div",
        { class: "bs-card" },
        h("div", { class: "bs-card__title" }, icon("Sparkles", 15), "How Writer's Projects Work"),
        h(
          "p",
          { class: "bs-card__desc" },
          "1. Click \"Create New Project Folder\" above to make a folder on your PC.\n2. Add as many pages or brainstorm sheets as you like with one click.\n3. Switch between your pages anytime from the left Project Sidebar while writing!",
        ),
      );
    }

    // Recent Projects List
    const recents = settings.recentProjects || [];
    const recentListEl =
      recents.length === 0
        ? h("div", { class: "bs-empty" }, "Your recent project folders will appear here for one-click switching.")
        : h(
            "div",
            { class: "bs-recent-list" },
            ...recents.map((proj) => {
              const isCurrent = proj.path.toLowerCase() === (activeFolder || "").toLowerCase();
              return h(
                "div",
                { class: "bs-recent-row" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "bs-recent-main",
                    onclick: async () => {
                      await activateProjectFolder(proj.path, true);
                      closeBackstage();
                    },
                  },
                  h("span", { class: "bs-recent-ext" }, isCurrent ? "ACTIVE" : "FOLDER"),
                  h(
                    "span",
                    { class: "bs-recent-meta" },
                    h("strong", {}, proj.name),
                    h("small", {}, proj.path),
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn--sm",
                    onclick: () => void native.openFolder(proj.path),
                  },
                  icon("ExternalLink", 12),
                  "Explorer",
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "bs-recent-remove",
                    "data-tip": "Remove from Recent Projects list",
                    onclick: (e: MouseEvent) => {
                      e.stopPropagation();
                      removeRecentProject(proj.path);
                      syncProjectSidebar();
                      void render();
                    },
                  },
                  icon("X", 14),
                ),
              );
            }),
          );

    host.replaceChildren(
      heroGrid,
      activeBinderEl,
      h(
        "div",
        { class: "bs-card" },
        h("div", { class: "bs-card__title" }, icon("Clock", 15), "Your Project Folders"),
        recentListEl,
      ),
    );
  };

  void render();
  return host;
}
