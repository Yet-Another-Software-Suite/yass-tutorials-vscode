// @ts-check
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Project, LIBRARIES } = require("./project");
const { Docs } = require("./docs");

const VIEW_TYPE = "yassTutorials.page";
const DONE_KEY = "yassTutorials.done";
const RESUME_KEY = "yassTutorials.resume";
/** How long after leaving a setup page a new robot project window picks the tutorial back up. */
const RESUME_MS = 3 * 60 * 60 * 1000;
/** The pages that set the project up, and the library each one installs. */
const SETUP_PAGES = {
  "yams/tutorials/project-setup": "yams",
  "yagsl/tutorial/02-install-yagsl": "yagsl",
};
/** The motor controller libraries each tutorial's hardware needs, by page id prefix. */
const VENDOR_NEEDS = [
  { prefix: "yams/tutorials/arm", libs: ["REVLib"] },
  { prefix: "yams/tutorials/elevator", libs: ["REVLib"] },
  { prefix: "yams/tutorials/shooter-flywheels", libs: ["REVLib"] },
  { prefix: "yams/tutorials/double-flywheel", libs: ["Phoenix 6"] },
  { prefix: "yams/tutorials/swerve-drive", libs: ["REVLib", "Phoenix 6"] },
];
/** How to spot each vendor library among the installed vendordeps. */
const VENDOR_MATCH = {
  REVLib: (/** @type {{ file: string, name: string }} */ v) => /^revlib/i.test(v.name) || /^revlib/i.test(v.file),
  "Phoenix 6": (/** @type {{ file: string, name: string }} */ v) => /phoenix ?\(?v?6/i.test(v.name) || /^phoenix6/i.test(v.file),
};
/** Pages a student may skip: they are not counted in the progress. */
const OPTIONAL_PAGES = new Set(["yams/tutorials/troubleshooting"]);
/** YAGSL pages that come before installing YAGSL. */
const BEFORE_YAGSL = ["yagsl/tutorial/README", "yagsl/tutorial/01-gather-your-robot-information"];
const VENDOR_NOTE =
  "Your motor controller's library, such as REVLib or Phoenix 6, comes from the vendor libraries list. The page below shows each step by hand.";

/** The commands the tutorial page's buttons may run. */
const PAGE_COMMANDS = [
  "yassTutorials.createProject",
  "yassTutorials.openProject",
  "yassTutorials.installYams",
  "yassTutorials.installYagsl",
  "yassTutorials.manageVendorLibs",
  "yassTutorials.refresh",
];
const LANGUAGES = {
  java2: "Java, Commands v2",
  java3: "Java, Commands v3",
  cpp: "C++",
};

/**
 * @typedef {{ id: string, title: string, children: TreeNode[] }} TreeNode
 * @typedef {{ title: string, nodes: TreeNode[] }} Group
 * @typedef {{ id: string, name: string, description: string, site: string, groups: Group[] }} Source
 * @typedef {{ title: string, description: string, source: string, url: string, prev: string | null, next: string | null }} PageInfo
 * @typedef {{ sources: Source[], pages: Record<string, PageInfo> }} Index
 * @typedef {{ kind: "source", source: Source } | { kind: "group", source: Source, group: Group } | { kind: "page", node: TreeNode }} Item
 */

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  // The tutorials, from the docs downloaded last time; new ones are fetched in the background.
  const docs = new Docs(context.globalStorageUri);
  docs.load();
  context.subscriptions.push(docs.changed);
  const done = new Set(/** @type {string[]} */ (context.globalState.get(DONE_KEY, [])));

  // The last text editor, so code can be inserted while the tutorial has focus.
  let lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri.scheme !== "output") lastEditor = editor;
    }),
  );

  const project = new Project();
  context.subscriptions.push(project);
  projectRef = project;
  const projectTree = new ProjectTree(project);
  context.subscriptions.push(vscode.window.createTreeView("yassTutorials.project", { treeDataProvider: projectTree }));

  const tree = new TutorialTree(docs.index, done);
  const treeView = vscode.window.createTreeView("yassTutorials.tree", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const saveDone = () => {
    context.globalState.update(DONE_KEY, [...done]);
    tree.refresh();
    panel.refreshDone();
  };
  const setDone = (/** @type {string} */ id, /** @type {boolean} */ value) => {
    if (value) done.add(id);
    else done.delete(id);
    saveDone();
  };

  const panel = (panelRef = new TutorialPanel(context, docs, done, project, {
    setDone,
    insert: (code, lang) => insertCode(code, lang, lastEditor),
    revealInTree: (id) => {
      const item = tree.findPage(id);
      if (item && treeView.visible) treeView.reveal(item, { select: true, focus: false }).then(undefined, () => {});
    },
  }));

  // A setup page is done once the project has what it installs.
  const markSetupDone = () => {
    const s = project.status;
    let changed = false;
    for (const [id, key] of Object.entries(SETUP_PAGES)) {
      const lib = s[/** @type {"yams" | "yagsl"} */ (key)];
      if (s.isWpilib && lib.installed && !lib.wrongFramework && !done.has(id)) {
        done.add(id);
        changed = true;
      }
    }
    if (changed) saveDone();
  };
  markSetupDone();
  context.subscriptions.push(
    project.onDidChange(() => {
      markSetupDone();
      projectTree.refresh();
      panel.refreshSetup();
      panel.refreshLanguage();
    }),
  );

  // Creating a project opens it in a new window: remember the page so that window opens it.
  const workspaceKey = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "none";
  const rememberResume = (/** @type {string} */ id) =>
    context.globalState.update(RESUME_KEY, { id, at: Date.now(), from: workspaceKey() });
  panel.onSetupPageShown = (id) => {
    if (!project.status.isWpilib) rememberResume(id);
  };
  const resume = /** @type {{ id: string, at: number, from: string } | undefined} */ (context.globalState.get(RESUME_KEY));
  if (resume && project.status.isWpilib && resume.from !== workspaceKey() && Date.now() - resume.at < RESUME_MS) {
    context.globalState.update(RESUME_KEY, undefined);
    // After VS Code has restored any tutorial left open in this window.
    setTimeout(() => {
      vscode.commands.executeCommand("workbench.view.extension.yassTutorials");
      if (!panel.panel) panel.show(resume.id);
    }, 1500);
  }
  // The page to come back to in the new project's window: the one the student is on.
  const setupPageFor = () => panel.currentId ?? "yams/tutorials/arm";

  /** @param {any} arg */
  const pageId = (arg) => (typeof arg === "string" ? arg : arg?.kind === "page" ? arg.node.id : panel.currentId);

  context.subscriptions.push(
    vscode.commands.registerCommand("yassTutorials.open", (arg) => {
      const id = pageId(arg);
      if (id) panel.show(id);
    }),
    vscode.commands.registerCommand("yassTutorials.createProject", () => {
      rememberResume(setupPageFor());
      vscode.commands.executeCommand("wpilibcore.createNewProject");
    }),
    vscode.commands.registerCommand("yassTutorials.openProject", () => {
      rememberResume(setupPageFor());
      vscode.commands.executeCommand("workbench.action.files.openFolder");
    }),
    vscode.commands.registerCommand("yassTutorials.installYams", () => project.install("yams")),
    vscode.commands.registerCommand("yassTutorials.installYagsl", () => project.install("yagsl")),
    // WPILib's Vendor Dependencies view, with an Install button on each library.
    vscode.commands.registerCommand("yassTutorials.manageVendorLibs", () =>
      vscode.commands.executeCommand("wpilib.dependencyView.focus"),
    ),
    vscode.commands.registerCommand("yassTutorials.search", async () => {
      const picked = await vscode.window.showQuickPick(
        Object.entries(docs.index.pages).filter(([, page]) => !page.hidden).map(([id, page]) => ({
          id,
          label: `${done.has(id) ? "$(pass-filled)" : "$(book)"} ${page.title}`,
          description: docs.index.sources.find((s) => s.id === page.source)?.name,
          detail: page.description,
        })),
        { placeHolder: "Find a YAMS or YAGSL tutorial", matchOnDescription: true, matchOnDetail: true },
      );
      if (picked) panel.show(picked.id);
    }),
    vscode.commands.registerCommand("yassTutorials.chooseLanguage", async () => {
      const current = vscode.workspace.getConfiguration("yassTutorials").get("language", "auto");
      const detected = detectLanguage();
      const picked = await vscode.window.showQuickPick(
        [
          { value: "auto", label: "From my project", description: `currently ${LANGUAGES[detected]}` },
          ...Object.entries(LANGUAGES).map(([value, label]) => ({ value, label })),
        ].map((o) => ({ ...o, picked: o.value === current, label: (o.value === current ? "$(check) " : "") + o.label })),
        { placeHolder: "Which code should the tutorials show?" },
      );
      if (picked) await setLanguage(picked.value);
    }),
    vscode.commands.registerCommand("yassTutorials.markDone", (arg) => {
      const id = pageId(arg);
      if (id) setDone(id, true);
    }),
    vscode.commands.registerCommand("yassTutorials.markNotDone", (arg) => {
      const id = pageId(arg);
      if (id) setDone(id, false);
    }),
    vscode.commands.registerCommand("yassTutorials.openInBrowser", (arg) => {
      const id = pageId(arg);
      if (id && docs.index.pages[id]) vscode.env.openExternal(vscode.Uri.parse(docs.index.pages[id].url));
    }),
    vscode.commands.registerCommand("yassTutorials.resetProgress", async () => {
      const yes = await vscode.window.showWarningMessage(
        "Mark every YASS tutorial as not done?",
        { modal: true },
        "Reset",
      );
      if (yes === "Reset") {
        done.clear();
        saveDone();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yassTutorials.language")) panel.refreshLanguage();
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(webviewPanel, state) {
        panel.adopt(webviewPanel, state?.pageId);
      },
    }),
  );

  // Keep the tutorials up to date: from the docs on disk at once, from GitHub in the background.
  const setDocsState = (/** @type {string} */ state) =>
    vscode.commands.executeCommand("setContext", "yassTutorials.docs", state);
  setDocsState(docs.ready ? "ready" : "loading");
  const update = (/** @type {boolean} */ force) => {
    const job = docs.sync({ force });
    if (!docs.ready) {
      vscode.window.withProgress({ location: { viewId: "yassTutorials.tree" }, title: "Downloading the tutorials" }, () => job);
    }
    return job.then((result) => {
      setDocsState(docs.ready ? "ready" : "failed");
      return result;
    });
  };
  context.subscriptions.push(
    docs.onDidChange(() => {
      tree.setIndex(docs.index);
      markSetupDone();
      if (panel.currentId) panel.load(panel.currentId);
    }),
    vscode.commands.registerCommand("yassTutorials.refresh", async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Checking for new tutorials" },
        () => update(true),
      );
      if (result.failed.length) {
        vscode.window.showWarningMessage(
          `Couldn't download the ${result.failed.join(" and ")} tutorials. Are you online?${docs.ready ? " The ones you have keep working." : ""}`,
        );
      } else {
        vscode.window.setStatusBarMessage(
          `$(check) ${result.changed ? "Updated the tutorials" : "The tutorials are up to date"}: ${docs.describe()}`,
          5000,
        );
      }
    }),
  );
  update(!docs.ready);
  const timer = setInterval(() => update(false), 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // For the extension's tests.
  return { panel, tree, done, project, projectTree, docs };
}

/** @type {Project | undefined} */
let projectRef;
/** @type {TutorialPanel | undefined} */
let panelRef;

/** The editor group code opens in: any group but the tutorial's, or a new one beside it. */
function codeColumn() {
  const tutorial = panelRef?.panel?.viewColumn;
  const other = vscode.window.tabGroups.all.find((g) => g.viewColumn !== tutorial);
  return other ? other.viewColumn : vscode.ViewColumn.Beside;
}

/** The open project's language: C++, Java with Commands v3, or Java with Commands v2. */
function detectLanguage() {
  const s = projectRef?.status;
  if (!s) return "java2";
  return s.language === "cpp" ? "cpp" : s.framework === 3 ? "java3" : "java2";
}

function currentLanguage() {
  const setting = vscode.workspace.getConfiguration("yassTutorials").get("language", "auto");
  return setting in LANGUAGES ? setting : detectLanguage();
}

/** @param {string} value */
function setLanguage(value) {
  return vscode.workspace
    .getConfiguration("yassTutorials")
    .update("language", value, vscode.ConfigurationTarget.Global);
}

/**
 * Put code at the cursor of the editor the user last worked in, or in a new file when there is none.
 * @param {string} code
 * @param {string} lang
 * @param {vscode.TextEditor | undefined} lastEditor
 */
async function insertCode(code, lang, lastEditor) {
  let editor = lastEditor && !lastEditor.document.isClosed ? lastEditor : undefined;
  if (!editor) {
    const language = { java: "java", cpp: "cpp", "c++": "cpp", json: "json", groovy: "groovy", gradle: "groovy" }[lang];
    const doc = await vscode.workspace.openTextDocument({ language: language ?? "plaintext", content: "" });
    editor = await vscode.window.showTextDocument(doc, codeColumn());
  } else {
    editor = await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }
  const target = editor;
  // Keep the snippet's own indentation, shifted to the cursor's.
  const cursor = target.selection.active;
  const indent = target.document.lineAt(cursor.line).text.slice(0, cursor.character).match(/^\s*/)?.[0] ?? "";
  const text = code.replace(/\n$/, "").replace(/\n/g, "\n" + indent);
  await target.edit((edit) => {
    for (const selection of target.selections) edit.replace(selection, text);
  });
}

/**
 * The open robot project, and what the tutorials need in it.
 * @implements {vscode.TreeDataProvider<vscode.TreeItem>}
 */
class ProjectTree {
  /** @param {Project} project */
  constructor(project) {
    this.project = project;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * @param {string} label
   * @param {string} description
   * @param {string} icon
   * @param {string | undefined} command
   * @param {string} tooltip
   * @param {string} [color]
   */
  item(label, description, icon, command, tooltip, color) {
    const t = new vscode.TreeItem(label);
    t.description = description;
    t.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    t.tooltip = tooltip;
    if (command) t.command = { command, title: label };
    return t;
  }

  getTreeItem(/** @type {vscode.TreeItem} */ item) {
    return item;
  }

  getChildren() {
    const s = this.project.status;
    const ok = "testing.iconPassed";
    if (!s.isWpilib) {
      return [
        this.item(
          s.folder ? `${s.name} isn't a robot project` : "No robot project open",
          "",
          "warning",
          undefined,
          "The tutorials add code to a WPILib robot project. Create one, or open the one you have.",
          "editorWarning.foreground",
        ),
        this.item(
          "Create a robot project",
          "",
          "add",
          "yassTutorials.createProject",
          "Opens the WPILib project creator. The tutorial opens again in the new project's window.",
        ),
        this.item("Open a robot project", "", "folder-opened", "yassTutorials.openProject", "Open the folder of a robot project you already have."),
      ];
    }
    const library = (/** @type {"yams" | "yagsl"} */ key, /** @type {string} */ why) => {
      const lib = s[key];
      const label = LIBRARIES[key].label;
      const command = key === "yams" ? "yassTutorials.installYams" : "yassTutorials.installYagsl";
      if (!lib.installed) {
        return this.item(label, `click to install${why}`, "cloud-download", command, `Downloads the ${label} vendordep for Commands v${s.framework} into vendordeps.`);
      }
      if (lib.wrongFramework) {
        return this.item(
          label,
          `click to switch to Commands v${s.framework}`,
          "warning",
          command,
          `${lib.installed.name} is installed, but this project uses Commands v${s.framework}.`,
          "editorWarning.foreground",
        );
      }
      return this.item(label, lib.installed.version, "pass-filled", undefined, lib.installed.name, ok);
    };
    const others = s.vendordeps
      .filter((v) => !v.name.startsWith(LIBRARIES.yams.prefix) && !v.name.startsWith(LIBRARIES.yagsl.prefix) && !/commands/i.test(v.name))
      .map((v) => v.name);
    return [
      this.item(s.name, this.project.describe(), "pass-filled", undefined, `The tutorials show ${this.project.describe()} code.`, ok),
      library("yams", ""),
      library("yagsl", " (for swerve)"),
      this.item(
        "Vendor libraries",
        others.length ? others.join(", ") : "none yet: click to add",
        "library",
        "yassTutorials.manageVendorLibs",
        "Motor controller libraries such as REVLib and Phoenix 6. Click to open WPILib's vendor library list.",
      ),
    ];
  }
}

/**
 * Where a complete file from a tutorial goes in the project: Java files by their package, C++ files
 * by their path under src/main. Null for a part of a file.
 * @param {string} root
 * @param {string} title
 * @param {string} code
 */
function filePathFor(root, title, code) {
  const name = path.posix.basename(title);
  if (name.endsWith(".java")) {
    const pkg = code.match(/^\s*package\s+([\w.]+)\s*;/m);
    return pkg ? path.join(root, "src", "main", "java", ...pkg[1].split("."), name) : null;
  }
  if (/\.(h|hpp|cpp)$/.test(name) && /^\s*(\/\/.*\n\s*)*#/.test(code)) {
    const rel = title.replace(/^src\/main\//, "");
    if (rel.startsWith("include/") || rel.startsWith("cpp/")) return path.join(root, "src", "main", ...rel.split("/"));
  }
  return null;
}

/**
 * Write a complete file from a tutorial into the project, and open it beside the tutorial.
 * @param {Project} project
 * @param {string} code
 * @param {string} title
 */
async function createFile(project, code, title) {
  const s = project.status;
  if (!s.folder || !s.isWpilib) {
    vscode.window.showWarningMessage("Open your robot project first, then create the file.");
    return;
  }
  const file = filePathFor(s.folder.uri.fsPath, title, code);
  if (!file) {
    vscode.window.showWarningMessage(`Couldn't tell where ${title} goes. Create it yourself, then use Insert.`);
    return;
  }
  const uri = vscode.Uri.file(file);
  const rel = path.relative(s.folder.uri.fsPath, file).split(path.sep).join("/");
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) {
    const choice = await vscode.window.showWarningMessage(`${rel} already exists. Replace what's in it?`, { modal: true }, "Replace", "Open It");
    if (choice === "Open It") await vscode.window.showTextDocument(uri, { viewColumn: codeColumn() });
    if (choice !== "Replace") return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code.replace(/\r?\n/g, "\n"));
  await vscode.window.showTextDocument(uri, { viewColumn: codeColumn(), preview: false });
  vscode.window.setStatusBarMessage(`$(check) Created ${rel}`, 4000);
}

/**
 * The robot code's own folder: where the template's Robot.java is, such as src/main/java/first/robot.
 * @param {string} root
 */
function robotPackageDir(root) {
  const javaRoot = path.join(root, "src", "main", "java");
  const queue = [javaRoot];
  while (queue.length) {
    const dir = /** @type {string} */ (queue.shift());
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "Robot.java")) return dir;
    for (const e of entries) if (e.isDirectory()) queue.push(path.join(dir, e.name));
  }
  return path.join(javaRoot, "first", "robot");
}

/**
 * Where "Create ArmSubsystem.java in the subsystems folder" puts the file.
 * @param {string} root
 * @param {string} name
 * @param {string} folder
 * @param {string} code the file's start, whose package line wins for Java
 */
function starterPathFor(root, name, folder, code) {
  if (/^src[\\/]/.test(folder)) return path.join(root, ...folder.split(/[\\/]/), name);
  if (name.endsWith(".java")) {
    const pkg = code.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (pkg) return path.join(root, "src", "main", "java", ...pkg[1].split("."), name);
    return path.join(robotPackageDir(root), ...folder.split(/[\\/]/), name);
  }
  const base = /\.(hpp|h)$/.test(name) ? "include" : "cpp";
  return path.join(root, "src", "main", base, ...folder.split(/[\\/]/), name);
}

/**
 * Create the file a step asks for, with its start, and open it beside the tutorial. A file that is
 * already there is only opened.
 * @param {Project} project
 * @param {string} name
 * @param {string} folder
 * @param {string} code
 */
async function createStarter(project, name, folder, code) {
  const s = project.status;
  if (!s.folder || !s.isWpilib) {
    vscode.window.showWarningMessage("Open your robot project first, then create the file.");
    return;
  }
  const file = starterPathFor(s.folder.uri.fsPath, name, folder, code);
  const rel = path.relative(s.folder.uri.fsPath, file).split(path.sep).join("/");
  const existed = fs.existsSync(file);
  if (!existed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: codeColumn(), preview: false });
  vscode.window.setStatusBarMessage(existed ? `${rel} is already there` : `$(check) Created ${rel}`, 4000);
}

/** @implements {vscode.TreeDataProvider<Item>} */
class TutorialTree {
  /**
   * @param {Index} index
   * @param {Set<string>} done
   */
  constructor(index, done) {
    this.done = done;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.setIndex(index);
  }

  /**
   * Show these tutorials.
   * @param {Index} index
   */
  setIndex(index) {
    this.index = index;
    /** @type {Map<string, Item>} */
    this.items = new Map();
    /** @type {Map<Item, Item>} */
    this.parents = new Map();
    /** @type {Map<Group, Item>} */
    this.groupItems = new Map();
    this.roots = index.sources.map((source) => {
      /** @type {Item} */
      const root = { kind: "source", source };
      for (const group of source.groups) {
        /** @type {Item} */
        const groupItem = { kind: "group", source, group };
        this.groupItems.set(group, groupItem);
        this.parents.set(groupItem, root);
        this.walk(group.nodes, groupItem);
      }
      return root;
    });
    this.refresh();
  }

  /**
   * @param {TreeNode[]} nodes
   * @param {Item} parent
   */
  walk(nodes, parent) {
    for (const node of nodes) {
      /** @type {Item} */
      const item = { kind: "page", node };
      this.items.set(node.id, item);
      this.parents.set(item, parent);
      this.walk(node.children, item);
    }
  }

  refresh() {
    this.changed.fire(undefined);
  }

  /** @param {string} id */
  findPage(id) {
    return this.items.get(id);
  }

  /** @param {TreeNode[]} nodes */
  count(nodes) {
    let total = 0;
    let finished = 0;
    const visit = (/** @type {TreeNode[]} */ list) => {
      for (const n of list) {
        if (!OPTIONAL_PAGES.has(n.id)) {
          total++;
          if (this.done.has(n.id)) finished++;
        }
        visit(n.children);
      }
    };
    visit(nodes);
    return { total, finished };
  }

  /** @param {Item} [item] */
  getChildren(item) {
    if (!item) return this.roots;
    if (item.kind === "source") {
      return item.source.groups.map((group) => this.groupItems.get(group));
    }
    const nodes = item.kind === "group" ? item.group.nodes : item.node.children;
    return nodes.map((n) => this.items.get(n.id));
  }

  /** @param {Item} item */
  getParent(item) {
    return this.parents.get(item);
  }

  /** @param {Item} item */
  getTreeItem(item) {
    if (item.kind === "source") {
      const t = new vscode.TreeItem(item.source.name, vscode.TreeItemCollapsibleState.Expanded);
      const { total, finished } = this.count(item.source.groups.flatMap((g) => g.nodes));
      t.description = `${finished}/${total}`;
      t.tooltip = item.source.description;
      t.iconPath = new vscode.ThemeIcon(item.source.id === "yagsl" ? "rocket" : "tools");
      t.id = `source:${item.source.id}`;
      return t;
    }
    if (item.kind === "group") {
      const first = item.source.groups[0] === item.group;
      const t = new vscode.TreeItem(
        item.group.title,
        first ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const { total, finished } = this.count(item.group.nodes);
      t.description = `${finished}/${total}`;
      t.iconPath = new vscode.ThemeIcon(first ? "mortar-board" : "question");
      t.id = `group:${item.source.id}:${item.group.title}`;
      return t;
    }
    const page = this.index.pages[item.node.id];
    const isDone = this.done.has(item.node.id);
    const t = new vscode.TreeItem(
      item.node.title,
      item.node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    t.id = item.node.id;
    const optional = OPTIONAL_PAGES.has(item.node.id);
    t.tooltip = new vscode.MarkdownString(`**${page.title}**${optional ? " (optional)" : ""}\n\n${page.description}`);
    if (optional) t.description = "optional";
    t.contextValue = isDone ? "page.done" : "page";
    t.command = { command: "yassTutorials.open", title: "Open Tutorial", arguments: [item.node.id] };
    if (item.node.children.length) {
      const { total, finished } = this.count(item.node.children);
      t.description = `${finished}/${total}`;
    }
    t.iconPath = isDone
      ? new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"))
      : optional
        ? new vscode.ThemeIcon("circle-large-outline", new vscode.ThemeColor("disabledForeground"))
        : new vscode.ThemeIcon(item.node.children.length ? "book" : "circle-large-outline");
    return t;
  }
}

class TutorialPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {Index} index
   * @param {Set<string>} done
   * @param {Project} project
   * @param {{ setDone: (id: string, value: boolean) => void, insert: (code: string, lang: string) => Promise<void>, revealInTree: (id: string) => void }} actions
   */
  constructor(context, docs, done, project, actions) {
    this.docs = docs;
    this.project = project;
    /** @type {(id: string) => void} */
    this.onSetupPageShown = () => {};
    this.context = context;
    this.done = done;
    this.actions = actions;
    /** @type {vscode.WebviewPanel | undefined} */
    this.panel = undefined;
    /** @type {string | undefined} */
    this.currentId = undefined;
  }

  /** The tutorials, as downloaded now. */
  get index() {
    return this.docs.index;
  }

  /** @param {string} id */
  show(id) {
    if (!this.index.pages[id]) return;
    if (!this.panel) {
      // The tutorial gets a group of its own on the right, locked so files open beside it, not over it.
      const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Two;
      const created = vscode.window.createWebviewPanel(VIEW_TYPE, "YASS Tutorial", column, {});
      this.adopt(created, id);
      // Lock the tutorial's own group, and only while it is the active one, never the code's.
      setTimeout(() => {
        if (!created.active) return;
        vscode.commands.executeCommand("workbench.action.lockEditorGroup").then(
          () => vscode.commands.executeCommand("workbench.action.focusPreviousGroup"),
          () => {},
        );
      }, 150);
    } else {
      this.panel.reveal(undefined, false);
      this.load(id);
    }
  }

  /**
   * Take over a new panel, or one VS Code restored after a reload.
   * @param {vscode.WebviewPanel} panel
   * @param {string | undefined} id
   */
  adopt(panel, id) {
    // One tutorial at a time: a second one, such as one more restored after a reload, replaces it.
    const old = this.panel;
    this.panel = panel;
    if (old && old !== panel) old.dispose();
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, "media"), this.context.globalStorageUri];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "media", "icon.png");
    panel.webview.html = this.shell(panel.webview);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.currentId = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((msg) => {
      // A page that is not the current tutorial anymore has nothing to say.
      if (this.panel === panel) this.onMessage(msg);
    });
    // A page that is not downloaded yet shows once it is.
    this.currentId = id ?? Object.keys(this.index.pages)[0];
    // The page is sent once the webview's script says it is listening.
  }

  /**
   * @param {string} id
   * @param {string} [anchor] the heading to scroll to
   */
  load(id, anchor) {
    if (!this.panel || !this.index.pages[id]) return;
    this.currentId = id;
    const page = this.index.pages[id];
    const webview = this.panel.webview;
    const html =
      this.docs.render(id, (file) => webview.asWebviewUri(vscode.Uri.file(file)).toString()) ??
      "<p>This page has not downloaded yet. Run <strong>YASS: Check for New Tutorials</strong> when you are online.</p>";
    const source = this.index.sources.find((s) => s.id === page.source);
    this.panel.title = page.title;
    this.panel.webview.postMessage({
      type: "show",
      id,
      anchor,
      html,
      page,
      sourceName: source?.name ?? "",
      optional: OPTIONAL_PAGES.has(id),
      prevTitle: page.prev ? this.index.pages[page.prev].title : null,
      nextTitle: page.next ? this.index.pages[page.next].title : null,
      done: this.done.has(id),
      language: currentLanguage(),
      languageSetting: vscode.workspace.getConfiguration("yassTutorials").get("language", "auto"),
      hasProject: this.project.status.isWpilib,
      setup: this.card(id),
    });
    this.onSetupPageShown(id);
    this.actions.revealInTree(id);
  }

  /**
   * The card at the top of a page about what the open project still needs, or null when it has it.
   * @param {string} id
   */
  card(id) {
    const s = this.project.status;
    const page = this.index.pages[id];
    const describe = this.project.describe();
    const install = (/** @type {"yams" | "yagsl"} */ key) => ({
      label: `Install ${LIBRARIES[key].label} for Commands v${s.framework}`,
      command: key === "yams" ? "yassTutorials.installYams" : "yassTutorials.installYagsl",
    });
    const vendorLibs = { label: "Open vendor libraries", command: "yassTutorials.manageVendorLibs", secondary: true };
    const missing = (/** @type {"yams" | "yagsl"} */ key) => !s[key].installed || s[key].wrongFramework;

    const setupKey = /** @type {"yams" | "yagsl" | undefined} */ (SETUP_PAGES[id]);
    // Every page that adds code to a project starts by asking for one.
    const needsProject = setupKey || page.source === "yams" || !BEFORE_YAGSL.includes(id);
    if (!s.isWpilib && needsProject) {
      return {
          state: "todo",
          title: "First, a robot project",
          body: `${s.folder ? `${s.name} isn't a WPILib robot project.` : "No robot project is open."} Create one, or open the one you have. WPILib opens it in a new window, and this tutorial opens there too.`,
          actions: [
            { label: "Create a robot project", command: "yassTutorials.createProject" },
            { label: "Open a robot project", command: "yassTutorials.openProject", secondary: true },
          ],
          note: VENDOR_NOTE,
        };
    }
    if (setupKey) {
      const lib = s[setupKey];
      const label = LIBRARIES[setupKey].label;
      if (missing(setupKey)) {
        return {
          state: "todo",
          title: `Install ${label}`,
          body: lib.wrongFramework
            ? `${s.name} has ${lib.installed?.name}, but it uses ${describe}. Switch it to the Commands v${s.framework} vendordep.`
            : `${s.name} (${describe}) doesn't have ${label} yet. One click downloads the right vendordep into its vendordeps folder.`,
          actions: [install(setupKey), vendorLibs],
          note: VENDOR_NOTE,
        };
      }
      return {
        state: "ready",
        title: `${s.name} is ready`,
        body: `It has ${lib.installed?.name} ${lib.installed?.version}, and the tutorials show ${describe} code. You can skip the rest of this page.`,
        actions: page.next ? [{ label: `Next: ${this.index.pages[page.next].title} →`, open: page.next }] : [],
      };
    }

    // Any other page: only what the open project is missing for it.
    if (!s.isWpilib) return null;
    const needs = [];
    /** @type {{ label: string, command?: string, open?: string, secondary?: boolean }[]} */
    const actions = [];
    if (page.source === "yams" && missing("yams")) {
      needs.push("YAMS");
      actions.push(install("yams"));
    }
    if (page.source === "yagsl" && !BEFORE_YAGSL.includes(id) && missing("yagsl")) {
      needs.push("YAGSL");
      actions.push(install("yagsl"));
    }
    const libs = VENDOR_NEEDS.filter((n) => id === n.prefix || id.startsWith(n.prefix + "/")).flatMap((n) => n.libs);
    const vendorMissing = libs.filter((lib) => !s.vendordeps.some(VENDOR_MATCH[lib]));
    if (vendorMissing.length) {
      needs.push(...vendorMissing);
      actions.push({ ...vendorLibs, secondary: actions.length > 0 });
    }
    if (!needs.length) return null;
    const list = needs.length === 1 ? needs[0] : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
    return {
      state: "todo",
      title: `${s.name} needs ${list}`,
      body: vendorMissing.length
        ? `This tutorial's hardware uses ${vendorMissing.join(" and ")}. Install ${needs.length === 1 ? "it" : "them"} before building the code.`
        : `Install ${list} before building the code on this page.`,
      actions,
      note: vendorMissing.length ? `Find ${vendorMissing.join(" and ")} in WPILib's vendor library list, and click Install.` : "",
    };
  }

  refreshSetup() {
    if (this.panel && this.currentId) {
      this.panel.webview.postMessage({ type: "setup", setup: this.card(this.currentId) });
    }
  }

  refreshDone() {
    if (this.panel && this.currentId) {
      this.panel.webview.postMessage({ type: "done", done: this.done.has(this.currentId) });
    }
  }

  refreshLanguage() {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: "language",
        language: currentLanguage(),
        languageSetting: vscode.workspace.getConfiguration("yassTutorials").get("language", "auto"),
      hasProject: this.project.status.isWpilib,
      });
    }
  }

  /** @param {any} msg */
  async onMessage(msg) {
    switch (msg.type) {
      case "ready":
        if (this.currentId) this.load(this.currentId);
        break;
      case "open":
        this.load(msg.id, msg.anchor);
        break;
      case "external":
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case "copy":
        await vscode.env.clipboard.writeText(msg.code);
        vscode.window.setStatusBarMessage("$(check) Copied the code", 2000);
        break;
      case "insert":
        await this.actions.insert(msg.code, msg.lang);
        break;
      case "createFile":
        await createFile(this.project, msg.code, msg.title);
        break;
      case "createStarter":
        await createStarter(this.project, msg.name, msg.folder, msg.code);
        break;
      case "done":
        this.actions.setDone(msg.id, msg.done);
        if (msg.done && msg.next) this.load(msg.next);
        break;
      case "language":
        await setLanguage(msg.language);
        break;
      case "command":
        if (PAGE_COMMANDS.includes(msg.command)) vscode.commands.executeCommand(msg.command);
        break;
    }
  }

  /** @param {vscode.Webview} webview */
  shell(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const media = (/** @type {string} */ f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", f));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("tutorial.css")}">
<title>YASS Tutorial</title>
</head>
<body>
<header class="bar">
  <div class="crumbs"><span id="source"></span><span id="crumb-sep"> / </span><span id="crumb"></span> <span id="optional" class="badge" hidden>Optional</span></div>
  <div class="bar-actions">
    <label class="lang">Code
      <select id="language" aria-label="Code language">
        <option value="auto">From my project</option>
        <option value="java2">Java, Commands v2</option>
        <option value="java3">Java, Commands v3</option>
        <option value="cpp">C++</option>
      </select>
    </label>
    <button id="refresh" class="secondary" title="Check for new tutorials">&#x21bb; Refresh</button>
    <a id="website" href="#" class="button secondary" title="Open this page on the website">Website</a>
  </div>
</header>
<main>
  <section id="setup" class="setup" aria-live="polite" hidden></section>
  <p id="description" class="description"></p>
  <article id="content"><p class="muted">Loading…</p></article>
  <nav class="pager">
    <button id="prev" class="secondary"></button>
    <button id="done"></button>
    <button id="next" class="secondary"></button>
  </nav>
</main>
<script nonce="${nonce}" src="${media("tutorial.js")}"></script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
