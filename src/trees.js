// @ts-check
// The two views in the YASS sidebar tab (package.json "views"):
//
//   - ProjectTree, "Your Robot Project": the open robot project and what the tutorials need in it.
//     With no robot project: Create a robot project and Open a robot project. With one: its name
//     and code language, YAMS and YAGSL (installed, missing, or for the wrong command framework),
//     and its other vendor libraries. Each row that needs something runs the command that fixes
//     it. It redraws whenever Project (project.js) sees the project change.
//   - TutorialTree, "Tutorials": each library (YAMS, YAGSL), its groups from SOURCES in render.js,
//     and their pages, as Docs (docs.js) builds them. Each row shows a done mark, and libraries,
//     groups and tutorials show how many of their pages are done, leaving out OPTIONAL_PAGES.
//     Clicking a page opens it in the tutorial panel. setIndex() replaces the tree after the docs
//     update.
//
// Both are VS Code TreeDataProviders: getChildren() lists the rows under a row, getTreeItem() says how
// one row looks. Icons are codicon names (https://code.visualstudio.com/api/references/icons-in-labels).

const vscode = require("vscode");
const { LIBRARIES } = require("./project");
const { OPTIONAL_PAGES } = require("./constants");

/**
 * @typedef {import("./render").TreeNode} TreeNode
 * @typedef {import("./render").SourceTree} Source
 * @typedef {Source["groups"][number]} Group
 * @typedef {import("./docs").Index} Index
 * @typedef {{ kind: "source", source: Source } | { kind: "group", source: Source, group: Group } | { kind: "page", node: TreeNode }} Item
 */

/**
 * Your Robot Project: the open robot project, and what the tutorials need in it.
 * @implements {vscode.TreeDataProvider<vscode.TreeItem>}
 * @example
 * const projectTree = new ProjectTree(project);
 * vscode.window.createTreeView("yassTutorials.project", { treeDataProvider: projectTree });
 * project.onDidChange(() => projectTree.refresh());
 */
class ProjectTree {
  /**
   * @param {import("./project").Project} project the open robot project, whose status the rows show.
   * @example
   * const projectTree = new ProjectTree(project);
   */
  constructor(project) {
    this.project = project;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  /**
   * Redraw every row, such as after the project's vendordeps change.
   * @example
   * project.onDidChange(() => projectTree.refresh());
   */
  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * Make one row.
   * @param {string} label the row's text.
   * @param {string} description the grey text after the label.
   * @param {string} icon a codicon name, such as "pass-filled" (https://code.visualstudio.com/api/references/icons-in-labels).
   * @param {string | undefined} command the command clicking the row runs, or undefined for none.
   * @param {string} tooltip what shows when hovering the row.
   * @param {string} [color] a theme color id for the icon, such as "testing.iconPassed".
   * @example
   * this.item("YAMS", "click to install", "cloud-download", "yassTutorials.installYams", "Downloads the YAMS vendordep.");
   */
  item(label, description, icon, command, tooltip, color) {
    const t = new vscode.TreeItem(label);
    t.description = description;
    t.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    t.tooltip = tooltip;
    if (command) t.command = { command, title: label };
    return t;
  }

  /**
   * How a row looks. The rows are made whole by getChildren(), so this hands them back.
   * @example
   * // VS Code calls it for each row getChildren() returns.
   * projectTree.getTreeItem(row);
   */
  getTreeItem(/** @type {vscode.TreeItem} */ item) {
    return item;
  }

  /**
   * The rows: Create and Open with no robot project; with one, the project, YAMS, YAGSL and its other
   * vendor libraries.
   * @returns {vscode.TreeItem[]}
   * @example
   * // VS Code calls it to draw the view.
   * projectTree.getChildren().map((row) => row.label); // ["MyRobot", "YAMS", "YAGSL", "Vendor libraries"]
   */
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
    /**
     * The row for YAMS or YAGSL: installed (its version), missing (click to install), or for the wrong
     * command framework (click to switch).
     * @example
     * library("yagsl", " (for swerve)");
     */
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
 * Tutorials: the libraries, their groups and their pages, with done marks and done counts.
 * @implements {vscode.TreeDataProvider<Item>}
 * @example
 * const tree = new TutorialTree(docs.index, done);
 * vscode.window.createTreeView("yassTutorials.tree", { treeDataProvider: tree, showCollapseAll: true });
 * docs.onDidChange(() => tree.setIndex(docs.index));
 */
class TutorialTree {
  /**
   * @param {Index} index the tutorials, from Docs.
   * @param {Set<string>} done the ids of the pages marked done. The tree reads it each time it draws.
   * @example
   * const tree = new TutorialTree(docs.index, new Set(["yams/tutorials/arm/motor-controller"]));
   */
  constructor(index, done) {
    this.done = done;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.setIndex(index);
  }

  /**
   * Show these tutorials, such as after the docs update.
   * @param {Index} index the tutorials, from Docs.
   * @example
   * docs.onDidChange(() => tree.setIndex(docs.index));
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
   * Make a row for each page and its children, and remember each row's parent, for getParent().
   * @param {TreeNode[]} nodes the pages.
   * @param {Item} parent the row they go under.
   * @example
   * this.walk(group.nodes, groupItem);
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

  /**
   * Redraw every row, such as after a page is marked done.
   * @example
   * done.add(id);
   * tree.refresh();
   */
  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * The row of a page, to reveal it.
   * @param {string} id the page's id.
   * @returns {Item | undefined}
   * @example
   * const row = tree.findPage("yams/tutorials/arm/motor-controller");
   * if (row) treeView.reveal(row, { select: true });
   */
  findPage(id) {
    return this.items.get(id);
  }

  /**
   * How many of these pages and their children are done, leaving out OPTIONAL_PAGES.
   * @param {TreeNode[]} nodes the pages.
   * @returns {{ total: number, finished: number }}
   * @example
   * const { total, finished } = this.count(item.group.nodes);
   * row.description = `${finished}/${total}`; // "1/6"
   */
  count(nodes) {
    let total = 0;
    let finished = 0;
    /**
     * Count each page and its children.
     * @example
     * visit(nodes);
     */
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

  /**
   * The rows under a row: the libraries at the top, then their groups, then the pages.
   * @param {Item} [item] the row, or nothing for the top.
   * @example
   * // VS Code calls it as rows open.
   * tree.getChildren(); // the YAMS and YAGSL rows
   */
  getChildren(item) {
    if (!item) return this.roots;
    if (item.kind === "source") {
      return item.source.groups.map((group) => this.groupItems.get(group));
    }
    const nodes = item.kind === "group" ? item.group.nodes : item.node.children;
    return nodes.map((n) => this.items.get(n.id));
  }

  /**
   * The row a row is under. VS Code needs it to reveal a page inside closed groups.
   * @param {Item} item
   * @example
   * treeView.reveal(tree.findPage(id)); // VS Code walks up with getParent() to open the groups
   */
  getParent(item) {
    return this.parents.get(item);
  }

  /**
   * How a row looks: its label, icon, done mark, done count, tooltip, and the page it opens.
   * @param {Item} item
   * @returns {vscode.TreeItem}
   * @example
   * // VS Code calls it for each row getChildren() returns.
   * tree.getTreeItem(tree.findPage("yams/tutorials/arm")).description; // "1/6"
   */
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

module.exports = { ProjectTree, TutorialTree };
