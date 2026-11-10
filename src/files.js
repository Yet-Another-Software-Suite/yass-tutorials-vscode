// @ts-check
// Putting a tutorial's code into the robot project: Insert (at the cursor), Create file (a complete
// file from a page) and the Create button under "Create ArmSubsystem.java in the subsystems folder"
// (a file started from the page's complete file). Code always opens beside the tutorial, not over it.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

/**
 * The editor group code opens in: any group but the tutorial's, or a new one beside it.
 * @param {vscode.WebviewPanel | undefined} tutorial the tutorial panel, if one is open
 */
function codeColumn(tutorial) {
  const other = vscode.window.tabGroups.all.find((g) => g.viewColumn !== tutorial?.viewColumn);
  return other ? other.viewColumn : vscode.ViewColumn.Beside;
}

/**
 * Put code at the cursor of the editor the student last worked in, or in a new file when there is none.
 * @param {string} code
 * @param {string} lang the code block's language
 * @param {vscode.TextEditor | undefined} lastEditor
 * @param {vscode.WebviewPanel | undefined} tutorial
 */
async function insertCode(code, lang, lastEditor, tutorial) {
  let editor = lastEditor && !lastEditor.document.isClosed ? lastEditor : undefined;
  if (!editor) {
    const language = { java: "java", cpp: "cpp", "c++": "cpp", json: "json", groovy: "groovy", gradle: "groovy" }[lang];
    const doc = await vscode.workspace.openTextDocument({ language: language ?? "plaintext", content: "" });
    editor = await vscode.window.showTextDocument(doc, codeColumn(tutorial));
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
 * Where a complete file from a tutorial goes in the project: Java files by their package, C++ files
 * by their path under src/main. Null for a part of a file.
 * @param {string} root the project's folder
 * @param {string} title the code block's title, such as subsystems/ArmSubsystem.java
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
 * Create file: write a complete file from a tutorial into the project, and open it. Asks before
 * replacing a file that already has code in it.
 * @param {import("./project").Project} project
 * @param {string} code
 * @param {string} title
 * @param {vscode.WebviewPanel | undefined} tutorial
 */
async function createFile(project, code, title, tutorial) {
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
    if (choice === "Open It") await vscode.window.showTextDocument(uri, { viewColumn: codeColumn(tutorial) });
    if (choice !== "Replace") return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code.replace(/\r?\n/g, "\n"));
  await vscode.window.showTextDocument(uri, { viewColumn: codeColumn(tutorial), preview: false });
  vscode.window.setStatusBarMessage(`$(check) Created ${rel}`, 4000);
}

/**
 * The robot code's own folder: where the template's Robot.java is, such as src/main/java/first/robot.
 * @param {string} root the project's folder
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
 * @param {string} root the project's folder
 * @param {string} name such as ArmSubsystem.java
 * @param {string} folder such as subsystems, or src/main/include/subsystems for C++
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
 * The Create button: create the file a step asks for, with its start, and open it. A file that is
 * already there is only opened.
 * @param {import("./project").Project} project
 * @param {string} name
 * @param {string} folder
 * @param {string} code the file's start, from the page (see starterCode in media/tutorial.js)
 * @param {vscode.WebviewPanel | undefined} tutorial
 */
async function createStarter(project, name, folder, code, tutorial) {
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
  await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: codeColumn(tutorial), preview: false });
  vscode.window.setStatusBarMessage(existed ? `${rel} is already there` : `$(check) Created ${rel}`, 4000);
}

module.exports = { codeColumn, insertCode, createFile, createStarter };
