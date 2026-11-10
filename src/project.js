// @ts-check
// What the open robot project has: whether it is a WPILib project, its language and command
// framework, and which vendordeps are installed. Also installs the YAMS and YAGSL vendordeps.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const CDN = "https://cdn.yassrobotics.com";

/** The YASS libraries the tutorials install, by the vendordep name they start with. */
const LIBRARIES = {
  yams: { label: "YAMS", prefix: "Yet Another Mechanism System", file: "yams" },
  yagsl: { label: "YAGSL", prefix: "YAGSL", file: "yagsl" },
};

/**
 * @typedef {{ file: string, name: string, version: string }} Vendordep
 * @typedef {{ installed: Vendordep | null, wrongFramework: boolean }} LibraryState
 * @typedef {{
 *   folder: vscode.WorkspaceFolder | null,
 *   isWpilib: boolean,
 *   name: string,
 *   language: "java" | "cpp",
 *   framework: 2 | 3,
 *   vendordeps: Vendordep[],
 *   yams: LibraryState,
 *   yagsl: LibraryState,
 * }} Status
 */

class Project {
  constructor() {
    this.changed = new vscode.EventEmitter();
    /** Fires when the project or its vendordeps change. */
    this.onDidChange = this.changed.event;
    /** @type {Status} */
    this.status = this.read();
    const watcher = vscode.workspace.createFileSystemWatcher("**/{vendordeps/*.json,.wpilib/wpilib_preferences.json}");
    const refresh = () => this.refresh();
    this.disposables = [
      watcher,
      watcher.onDidCreate(refresh),
      watcher.onDidChange(refresh),
      watcher.onDidDelete(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
      this.changed,
    ];
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  refresh() {
    this.status = this.read();
    this.changed.fire(this.status);
  }

  /** @returns {Status} */
  read() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder =
      folders.find((f) => fs.existsSync(path.join(f.uri.fsPath, ".wpilib", "wpilib_preferences.json"))) ??
      folders[0] ??
      null;
    const root = folder?.uri.fsPath ?? "";
    const isWpilib = !!folder && fs.existsSync(path.join(root, ".wpilib", "wpilib_preferences.json"));

    /** @type {Vendordep[]} */
    const vendordeps = [];
    const dir = path.join(root, "vendordeps");
    if (folder && fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"))) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
          vendordeps.push({ file, name: String(json.name ?? file), version: String(json.version ?? "") });
        } catch {
          vendordeps.push({ file, name: file, version: "" });
        }
      }
    }

    let language = /** @type {"java" | "cpp"} */ ("java");
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(root, ".wpilib", "wpilib_preferences.json"), "utf8"));
      if (String(prefs.currentLanguage).toLowerCase() === "cpp") language = "cpp";
    } catch {
      if (folder && fs.existsSync(path.join(root, "src", "main", "cpp"))) language = "cpp";
    }
    const framework = vendordeps.some((v) => /commands\s*v?3/i.test(v.name) || /commandsv?3/i.test(v.file)) ? 3 : 2;

    const library = (/** @type {keyof typeof LIBRARIES} */ key) => {
      const installed = vendordeps.find((v) => v.name.startsWith(LIBRARIES[key].prefix)) ?? null;
      const wrongFramework = !!installed && !installed.name.includes(`Commands v${framework}`);
      return { installed, wrongFramework };
    };

    return {
      folder,
      isWpilib,
      name: folder?.name ?? "",
      language,
      framework,
      vendordeps,
      yams: library("yams"),
      yagsl: library("yagsl"),
    };
  }

  /** "Java, Commands v2" and the like. */
  describe() {
    const s = this.status;
    return s.language === "cpp" ? "C++" : `Java, Commands v${s.framework}`;
  }

  /**
   * Download a YASS vendordep for the project's command framework into its vendordeps folder.
   * YAGSL needs YAMS, so installing YAGSL installs YAMS too.
   * @param {keyof typeof LIBRARIES} key
   * @returns {Promise<boolean>} whether it was installed
   */
  async install(key) {
    const s = this.status;
    if (!s.folder || !s.isWpilib) {
      vscode.window.showWarningMessage("Open a WPILib robot project first, then install " + LIBRARIES[key].label + ".");
      return false;
    }
    const keys = key === "yagsl" && (!s.yams.installed || s.yams.wrongFramework) ? ["yams", "yagsl"] : [key];
    const dir = path.join(s.folder.uri.fsPath, "vendordeps");
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Installing ${keys.map((k) => LIBRARIES[k].label).join(" and ")}` },
        async () => {
          for (const k of keys) {
            const lib = LIBRARIES[/** @type {keyof typeof LIBRARIES} */ (k)];
            const url = `${CDN}/${lib.file}_commands${s.framework}.json`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`${url} answered ${response.status}`);
            const text = await response.text();
            const json = JSON.parse(text);
            fs.mkdirSync(dir, { recursive: true });
            // The other command framework's vendordep conflicts with this one.
            for (const v of s.vendordeps) {
              if (v.name.startsWith(lib.prefix) && v.file !== json.fileName) fs.rmSync(path.join(dir, v.file), { force: true });
            }
            fs.writeFileSync(path.join(dir, json.fileName ?? path.basename(url)), text);
          }
        },
      );
    } catch (e) {
      const choice = await vscode.window.showErrorMessage(
        `Couldn't download ${LIBRARIES[key].label}: ${e instanceof Error ? e.message : e}. Are you online?`,
        "Open Vendor Libraries",
      );
      if (choice) vscode.commands.executeCommand("wpilibcore.manageVendorLibs");
      return false;
    }
    this.refresh();
    const build = await vscode.window.showInformationMessage(
      `Installed ${keys.map((k) => LIBRARIES[k].label).join(" and ")} for ${this.describe()}. Build the robot code once so it downloads.`,
      "Build Robot Code",
    );
    if (build) vscode.commands.executeCommand("wpilibcore.buildCode");
    return true;
  }
}

module.exports = { Project, LIBRARIES };
