// @ts-check
// Which code a tutorial page shows: Java with Commands v2, Java with Commands v3, or C++. The
// yassTutorials.language setting picks one, or "auto" follows the open robot project.
const vscode = require("vscode");
const { LANGUAGES } = require("./constants");

/**
 * The project's language: C++, Java with Commands v3, or Java with Commands v2.
 * @param {import("./project").Project} project
 */
function detectLanguage(project) {
  const s = project.status;
  return s.language === "cpp" ? "cpp" : s.framework === 3 ? "java3" : "java2";
}

/** The yassTutorials.language setting: "auto", "java2", "java3" or "cpp". */
function languageSetting() {
  return vscode.workspace.getConfiguration("yassTutorials").get("language", "auto");
}

/**
 * The language to show now: the setting, or the project's when the setting is "auto".
 * @param {import("./project").Project} project
 */
function currentLanguage(project) {
  const setting = languageSetting();
  return setting in LANGUAGES ? setting : detectLanguage(project);
}

/**
 * Save the language for every project.
 * @param {string} value
 */
function setLanguage(value) {
  return vscode.workspace.getConfiguration("yassTutorials").update("language", value, vscode.ConfigurationTarget.Global);
}

module.exports = { detectLanguage, languageSetting, currentLanguage, setLanguage };
