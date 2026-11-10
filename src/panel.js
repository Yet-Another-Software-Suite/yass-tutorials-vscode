// @ts-check
// The tutorial panel: the page that shows a tutorial beside the code.
//
// TutorialPanel keeps one VS Code webview panel. The panel's HTML is a fixed shell (shell()) that
// loads media/tutorial.js and media/tutorial.css; each page then arrives as a message:
//
//   1. load(id) renders the page with Docs (docs.js), and sends it with everything the page needs:
//      Previous/Next, whether it is done, the code language, and the setup card.
//   2. media/tutorial.js shows it, and sends back what the student clicks.
//   3. onMessage() acts on that: open another page, copy, insert, create a file, mark done, change
//      the language, open the website, or run one of PAGE_COMMANDS (constants.js).
//
// CONTRIBUTING.md lists every message in both directions.
//
// card(id) decides the card at the top of a page about what the robot project still needs: a project
// at all, YAMS or YAGSL, or the vendor library its tutorial's hardware needs (VENDOR_NEEDS in
// constants.js). It is redrawn when the project changes (refreshSetup()).
//
// The panel opens in its own editor group on the right and locks that group, so the files the student
// opens go beside it rather than over it. A second panel, such as one more that VS Code restores
// after a reload, replaces the first (adopt()), so every button reaches the extension.
//
// Images the docs saved on disk are allowed through localResourceRoots in adopt(); an image that does
// not show is usually a folder missing from that list.

const vscode = require("vscode");
const crypto = require("crypto");
const { LIBRARIES } = require("./project");
const { VIEW_TYPE, SETUP_PAGES, VENDOR_NEEDS, VENDOR_MATCH, OPTIONAL_PAGES, BEFORE_YAGSL, VENDOR_NOTE, PAGE_COMMANDS } = require("./constants");
const { currentLanguage, languageSetting, setLanguage } = require("./language");
const { createFile, createStarter } = require("./files");

/**
 * The tutorial panel beside the code. One at a time.
 * @example
 * const panel = new TutorialPanel(context, docs, done, project, { setDone, insert, revealInTree });
 * panel.show("yams/tutorials/arm/motor-controller");
 */
class TutorialPanel {
  /**
   * @param {vscode.ExtensionContext} context the extension's context, for its folder and storage.
   * @param {import("./docs").Docs} docs the tutorials.
   * @param {Set<string>} done the ids of the pages marked done.
   * @param {import("./project").Project} project the open robot project.
   * @param {{ setDone: (id: string, value: boolean) => void, insert: (code: string, lang: string) => Promise<void>, revealInTree: (id: string) => void }} actions what the panel asks extension.js to do.
   * @example
   * const panel = new TutorialPanel(context, docs, done, project, {
   *   setDone: (id, value) => (value ? done.add(id) : done.delete(id)),
   *   insert: (code, lang) => insertCode(code, lang, lastEditor, panel.panel),
   *   revealInTree: (id) => treeView.reveal(tree.findPage(id)),
   * });
   */
  constructor(context, docs, done, project, actions) {
    this.context = context;
    this.docs = docs;
    this.done = done;
    this.project = project;
    this.actions = actions;
    /** Called with each page shown, so the extension can remember it for a new project's window. */
    /** @type {(id: string) => void} */
    this.onPageShown = () => {};
    /** @type {vscode.WebviewPanel | undefined} */
    this.panel = undefined;
    /** @type {string | undefined} */
    this.currentId = undefined;
  }

  /**
   * The tutorials, as downloaded now.
   * @example
   * panel.index.pages["yams/tutorials/arm"].title; // "Arm"
   */
  get index() {
    return this.docs.index;
  }

  /**
   * Show a page, opening the panel if it is not open. A new panel opens in its own editor group on the
   * right, which is then locked so files open beside it.
   * @param {string} id the page's id.
   * @example
   * panel.show("yams/tutorials/arm/motor-controller");
   */
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
   * Take over a new panel, or one VS Code restored after a reload: set its HTML and listen to its
   * buttons. A panel already open is closed, so there is only ever one.
   * @param {vscode.WebviewPanel} panel the webview panel.
   * @param {string | undefined} id the page to show once the page's script is ready.
   * @example
   * vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
   *   async deserializeWebviewPanel(webviewPanel, state) {
   *     panel.adopt(webviewPanel, state?.pageId);
   *   },
   * });
   */
  adopt(panel, id) {
    // One tutorial at a time: a second one, such as one more restored after a reload, replaces it.
    const old = this.panel;
    this.panel = panel;
    if (old && old !== panel) old.dispose();
    // The downloaded docs' folder as a file: path; globalStorageUri itself can have another scheme
    // (vscode-userdata:), which the images' file: addresses would not match.
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, "media"), vscode.Uri.file(this.context.globalStorageUri.fsPath)];
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
    // A page that is not downloaded yet shows once it is. It is sent once the page says it is ready.
    this.currentId = id ?? Object.keys(this.index.pages)[0];
  }

  /**
   * Render a page and send it to the panel, with Previous/Next, its done state, the code language and
   * the setup card.
   * @param {string} id the page's id.
   * @param {string} [anchor] the heading to scroll to, such as "the-complete-file".
   * @example
   * panel.load("yams/tutorials/arm/motor-controller", "the-complete-file");
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
    webview.postMessage({
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
      language: currentLanguage(this.project),
      languageSetting: languageSetting(),
      hasProject: this.project.status.isWpilib,
      setup: this.card(id),
    });
    this.onPageShown(id);
    this.actions.revealInTree(id);
  }

  /**
   * The card at the top of a page about what the robot project still needs: a project at all, YAMS or
   * YAGSL, or the vendor library its tutorial needs. On a setup page, the install card, or a ready card
   * once the project has it.
   * @param {string} id the page's id.
   * @returns the card for media/tutorial.js to draw ({ state, title, body, actions, note }), or null for none.
   * @example
   * panel.card("yams/tutorials/arm/motor-controller");
   * // { state: "todo", title: "MyRobot needs REVLib", body: "...", actions: [{ label: "Open vendor libraries", ... }], note: "..." }
   */
  card(id) {
    const s = this.project.status;
    const page = this.index.pages[id];
    const describe = this.project.describe();
    /**
     * The button that installs YAMS or YAGSL for the project's command framework.
     * @example
     * install("yams"); // { label: "Install YAMS for Commands v2", command: "yassTutorials.installYams" }
     */
    const install = (/** @type {"yams" | "yagsl"} */ key) => ({
      label: `Install ${LIBRARIES[key].label} for Commands v${s.framework}`,
      command: key === "yams" ? "yassTutorials.installYams" : "yassTutorials.installYagsl",
    });
    const vendorLibs = { label: "Open vendor libraries", command: "yassTutorials.manageVendorLibs", secondary: true };
    /**
     * Whether the project lacks YAMS or YAGSL, or has it for the wrong command framework.
     * @example
     * if (missing("yams")) actions.push(install("yams"));
     */
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

  /**
   * Redraw the open page's card, such as after the project's vendordeps change.
   * @example
   * project.onDidChange(() => panel.refreshSetup());
   */
  refreshSetup() {
    if (this.panel && this.currentId) {
      this.panel.webview.postMessage({ type: "setup", setup: this.card(this.currentId) });
    }
  }

  /**
   * Update the open page's Done button after a page is marked done or not.
   * @example
   * done.add(panel.currentId);
   * panel.refreshDone();
   */
  refreshDone() {
    if (this.panel && this.currentId) {
      this.panel.webview.postMessage({ type: "done", done: this.done.has(this.currentId) });
    }
  }

  /**
   * Switch the open page's code tabs after the language setting or the project changes.
   * @example
   * vscode.workspace.onDidChangeConfiguration((e) => {
   *   if (e.affectsConfiguration("yassTutorials.language")) panel.refreshLanguage();
   * });
   */
  refreshLanguage() {
    if (this.panel) {
      this.panel.webview.postMessage({
        type: "language",
        language: currentLanguage(this.project),
        languageSetting: languageSetting(),
        hasProject: this.project.status.isWpilib,
      });
    }
  }

  /**
   * Act on what the page's buttons send. CONTRIBUTING.md lists every message.
   * @param {any} msg the message, such as { type: "open", id: "yams/tutorials/arm" }.
   * @example
   * // media/tutorial.js sends:
   * vscode.postMessage({ type: "insert", code: "int a = 1;", lang: "java" });
   * // and this puts that code at the cursor.
   */
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
        await createFile(this.project, msg.code, msg.title, this.panel);
        break;
      case "createStarter":
        await createStarter(this.project, msg.name, msg.folder, msg.code, this.panel);
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

  /**
   * The panel's HTML: the top bar, an empty page and the Previous/Done/Next buttons. It stays the same;
   * each page arrives as a "show" message.
   * @param {vscode.Webview} webview the panel's webview, for its resource addresses.
   * @returns {string}
   * @example
   * panel.webview.html = this.shell(panel.webview);
   */
  shell(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");
    /**
     * The webview's address for a file in media/.
     * @example
     * media("tutorial.css"); // "https://file+.vscode-resource.vscode-cdn.net/.../media/tutorial.css"
     */
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

module.exports = { TutorialPanel };
