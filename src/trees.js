// @ts-check
// The two views in the YASS sidebar tab. ProjectTree is "Your Robot Project": the open project and
// what the tutorials need in it, each row running the command that fixes it. TutorialTree is
// "Tutorials": the libraries, groups and pages from the docs, with done marks and done counts.
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
 */
class ProjectTree {
  /** @param {import("./project").Project} project */
  constructor(project) {
    this.project = project;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * One row.
   * @param {string} label
   * @param {string} description the grey text after the label
   * @param {string} icon a codicon name
   * @param {string | undefined} command what clicking the row runs
   * @param {string} tooltip
   * @param {string} [color] a theme color for the icon
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
 * Tutorials: the libraries, their groups and their pages, with done marks.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class TutorialTree {
  /**
   * @param {Index} index the tutorials, from Docs
   * @param {Set<string>} done the ids of the pages marked done
   */
  constructor(index, done) {
    this.done = done;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.setIndex(index);
  }

  /**
   * Show these tutorials, such as after the docs update.
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

  /**
   * The row of a page, to reveal it.
   * @param {string} id
   */
  findPage(id) {
    return this.items.get(id);
  }

  /**
   * How many of these pages and their children are done, leaving out the optional ones.
   * @param {TreeNode[]} nodes
   */
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

module.exports = { ProjectTree, TutorialTree };
