// @ts-check
// Where the extension starts. VS Code calls activate() when a WPILib project opens, when a tutorial
// panel is restored, or shortly after VS Code starts (activationEvents in package.json).
//
// activate() builds every piece and connects them:
//
//   - Docs (docs.js): the tutorials, loaded from disk at once and updated from GitHub in the
//     background, at start and every hour (each library is checked at most every 12 hours).
//   - Project (project.js): the open robot project and its vendordeps.
//   - ProjectTree and TutorialTree (trees.js): the two views in the YASS sidebar tab.
//   - TutorialPanel (panel.js): the page beside the code.
//
// It also keeps the state that ties them together: the pages marked done (saved in VS Code's global
// state under DONE_KEY), the last text editor (where Insert puts code), and the page to reopen when
// creating or opening a project opens a new window (RESUME_KEY).
//
// Every command in package.json is registered at the bottom.
// To add a command: add it to package.json's "commands" (and "menus" for a button), register it here,
// and add it to PAGE_COMMANDS in constants.js if a button on the page runs it.
//
// activate() returns the pieces so tests can drive them without clicking.

const vscode = require("vscode");
const { Project } = require("./project");
const { Docs } = require("./docs");
const { ProjectTree, TutorialTree } = require("./trees");
const { TutorialPanel } = require("./panel");
const { insertCode } = require("./files");
const { detectLanguage, languageSetting, setLanguage } = require("./language");
const { VIEW_TYPE, DONE_KEY, RESUME_KEY, RESUME_MS, SETUP_PAGES, LANGUAGES } = require("./constants");

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

  // The sidebar: Your Robot Project and Tutorials.
  const project = new Project();
  context.subscriptions.push(project);
  const projectTree = new ProjectTree(project);
  context.subscriptions.push(vscode.window.createTreeView("yassTutorials.project", { treeDataProvider: projectTree }));
  const tree = new TutorialTree(docs.index, done);
  const treeView = vscode.window.createTreeView("yassTutorials.tree", { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(treeView);

  // Pages marked done, saved for every project.
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

  // The tutorial panel.
  const panel = new TutorialPanel(context, docs, done, project, {
    setDone,
    insert: (code, lang) => insertCode(code, lang, lastEditor, panel.panel),
    revealInTree: (id) => {
      const item = tree.findPage(id);
      if (item && treeView.visible) treeView.reveal(item, { select: true, focus: false }).then(undefined, () => {});
    },
  });

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

  // Creating or opening a project opens it in a new window: remember the page so that window opens it.
  const workspaceKey = () => vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "none";
  const rememberResume = (/** @type {string} */ id) =>
    context.globalState.update(RESUME_KEY, { id, at: Date.now(), from: workspaceKey() });
  panel.onPageShown = (id) => {
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
  const resumePage = () => panel.currentId ?? "yams/tutorials/arm";

  /**
   * The page a command is for: the id it was given, the tree row it was run on, or the open page.
   * @param {any} arg
   */
  const pageId = (arg) => (typeof arg === "string" ? arg : arg?.kind === "page" ? arg.node.id : panel.currentId);

  // Keep the tutorials up to date: from the docs on disk at once, from GitHub in the background.
  const setDocsState = (/** @type {string} */ state) => vscode.commands.executeCommand("setContext", "yassTutorials.docs", state);
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
  );
  update(!docs.ready);
  const timer = setInterval(() => update(false), 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // The commands, as package.json lists them.
  context.subscriptions.push(
    vscode.commands.registerCommand("yassTutorials.open", (arg) => {
      const id = pageId(arg);
      if (id) panel.show(id);
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
    vscode.commands.registerCommand("yassTutorials.createProject", () => {
      rememberResume(resumePage());
      vscode.commands.executeCommand("wpilibcore.createNewProject");
    }),
    vscode.commands.registerCommand("yassTutorials.openProject", () => {
      rememberResume(resumePage());
      vscode.commands.executeCommand("workbench.action.files.openFolder");
    }),
    vscode.commands.registerCommand("yassTutorials.installYams", () => project.install("yams")),
    vscode.commands.registerCommand("yassTutorials.installYagsl", () => project.install("yagsl")),
    // WPILib's Vendor Dependencies view, with an Install button on each library.
    vscode.commands.registerCommand("yassTutorials.manageVendorLibs", () => vscode.commands.executeCommand("wpilib.dependencyView.focus")),
    vscode.commands.registerCommand("yassTutorials.search", async () => {
      const picked = await vscode.window.showQuickPick(
        Object.entries(docs.index.pages)
          .filter(([, page]) => !page.hidden)
          .map(([id, page]) => ({
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
      const current = languageSetting();
      const picked = await vscode.window.showQuickPick(
        [
          { value: "auto", label: "From my project", description: `currently ${LANGUAGES[detectLanguage(project)]}` },
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
      const yes = await vscode.window.showWarningMessage("Mark every YASS tutorial as not done?", { modal: true }, "Reset");
      if (yes === "Reset") {
        done.clear();
        saveDone();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("yassTutorials.language")) panel.refreshLanguage();
    }),
    // Brings back a tutorial left open when VS Code reloads.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(webviewPanel, state) {
        panel.adopt(webviewPanel, state?.pageId);
      },
    }),
  );

  // For tests: the pieces, to drive them without clicking.
  return { panel, tree, done, project, projectTree, docs };
}

function deactivate() {}

module.exports = { activate, deactivate };
