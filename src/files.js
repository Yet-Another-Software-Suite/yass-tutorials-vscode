// @ts-check
// Putting a tutorial's code into the robot project. Three ways, all from buttons on the page:
//
//   - Insert (insertCode): puts a code block at the cursor of the editor the student last worked
//     in, shifted to that line's indentation. With no editor open, it opens a new file.
//   - Create file (createFile): writes a complete file from a page into the project. Java goes to
//     src/main/java/<its package path>/<name>, C++ to src/main/<its title>. A file that already has
//     code in it is only replaced after asking.
//   - Create, under "Create ArmSubsystem.java in the subsystems folder" (createStarter): creates the
//     file the step asks for, started with the package, class line and imports from the page's
//     complete file (starterCode in media/tutorial.js makes that start), so it compiles at once and
//     each step's code goes inside it. Java goes to the folder named next to the template's
//     Robot.java (robotPackageDir), or by its package line; C++ to the path the sentence gives. A
//     file that is already there is only opened, never overwritten.
//
// Every file opens in an editor group that is not the tutorial's (codeColumn), so the tutorial stays
// in view beside the code.
//
// When a file lands in the wrong place, the fix is in filePathFor or starterPathFor.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

/**
 * The editor group code opens in: any group but the tutorial's, or a new one beside it.
 * @param {vscode.WebviewPanel | undefined} tutorial the tutorial panel, if one is open.
 * @returns {vscode.ViewColumn}
 * @example
 * await vscode.window.showTextDocument(uri, { viewColumn: codeColumn(panel.panel) });
 */
function codeColumn(tutorial) {
  const other = vscode.window.tabGroups.all.find((g) => g.viewColumn !== tutorial?.viewColumn);
  return other ? other.viewColumn : vscode.ViewColumn.Beside;
}

/**
 * Insert: put code at the cursor of the editor the student last worked in, shifted to that line's
 * indentation, or in a new file when there is no editor.
 * @param {string} code the code block's text.
 * @param {string} lang the code block's language, such as "java", for a new file.
 * @param {vscode.TextEditor | undefined} lastEditor the editor to put it in.
 * @param {vscode.WebviewPanel | undefined} tutorial the tutorial panel, so a new file opens beside it.
 * @example
 * // With the cursor indented 2 spaces inside a class:
 * await insertCode("int a = 1;\nint b = 2;\n", "java", lastEditor, panel.panel);
 * // adds "int a = 1;" and "  int b = 2;" at the cursor
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
 * Where a complete file from a tutorial goes in the project: Java by its package line, C++ by its
 * path under src/main.
 * @param {string} root the project's folder.
 * @param {string} title the code block's title, such as "subsystems/ArmSubsystem.java".
 * @param {string} code the file's code.
 * @returns {string | null} the file's path, or null when the code is only part of a file.
 * @example
 * filePathFor("C:/Robots/MyRobot", "subsystems/ArmSubsystem.java", "package first.robot.subsystems;\n...");
 * // "C:/Robots/MyRobot/src/main/java/first/robot/subsystems/ArmSubsystem.java"
 * filePathFor("C:/Robots/MyRobot", "cpp/subsystems/ArmSubsystem.cpp", "#include ...");
 * // "C:/Robots/MyRobot/src/main/cpp/subsystems/ArmSubsystem.cpp"
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
 * Create file: write a complete file from a tutorial into the project, and open it beside the
 * tutorial. Asks before replacing a file that already has code in it.
 * @param {import("./project").Project} project the open robot project.
 * @param {string} code the file's code.
 * @param {string} title the code block's title, such as "subsystems/ArmSubsystem.java".
 * @param {vscode.WebviewPanel | undefined} tutorial the tutorial panel, so the file opens beside it.
 * @example
 * await createFile(project, "package first.robot;\n\npublic class RobotContainer {\n}\n", "RobotContainer.java", panel.panel);
 * // writes src/main/java/first/robot/RobotContainer.java
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
 * The robot code's own folder: where the template's Robot.java is.
 * @param {string} root the project's folder.
 * @returns {string} that folder, or src/main/java/first/robot when there is no Robot.java.
 * @example
 * robotPackageDir("C:/Robots/MyRobot"); // "C:/Robots/MyRobot/src/main/java/first/robot"
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
 * Where "Create ArmSubsystem.java in the subsystems folder" puts the file. A Java file's package
 * line wins; without one it goes in that folder next to Robot.java. C++ goes to the path given, or
 * to src/main/include (headers) or src/main/cpp.
 * @param {string} root the project's folder.
 * @param {string} name the file, such as "ArmSubsystem.java".
 * @param {string} folder the folder the step names, such as "subsystems" or "src/main/include/subsystems".
 * @param {string} code the file's start.
 * @returns {string} the file's path.
 * @example
 * starterPathFor("C:/Robots/MyRobot", "ArmSubsystem.java", "subsystems", "package first.robot.subsystems;\n...");
 * // "C:/Robots/MyRobot/src/main/java/first/robot/subsystems/ArmSubsystem.java"
 * starterPathFor("C:/Robots/MyRobot", "ArmSubsystem.hpp", "src/main/include/subsystems", "#pragma once\n");
 * // "C:/Robots/MyRobot/src/main/include/subsystems/ArmSubsystem.hpp"
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
 * The Create button under "Create ArmSubsystem.java in the subsystems folder": create the file with
 * its start, and open it beside the tutorial. A file that is already there is only opened.
 * @param {import("./project").Project} project the open robot project.
 * @param {string} name the file, such as "ArmSubsystem.java".
 * @param {string} folder the folder the step names, such as "subsystems".
 * @param {string} code the file's start, from starterCode() in media/tutorial.js.
 * @param {vscode.WebviewPanel | undefined} tutorial the tutorial panel, so the file opens beside it.
 * @example
 * await createStarter(project, "ArmSubsystem.java", "subsystems",
 *   "package first.robot.subsystems;\n\nimport org.wpilib.command2.SubsystemBase;\n\npublic class ArmSubsystem extends SubsystemBase {\n}\n",
 *   panel.panel);
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
