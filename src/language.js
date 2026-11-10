// @ts-check
// Which code a tutorial page shows: Java with Commands v2, Java with Commands v3, or C++.
//
// The yassTutorials.language setting (package.json) is "auto", "java2", "java3" or "cpp". "auto"
// follows the open robot project: C++ when its .wpilib/wpilib_preferences.json says so, Commands v3
// when it has WPILib's Commands v3 vendordep, otherwise Commands v2 (Project in project.js works that
// out). Picking a language from the page's Code menu, or clicking a language tab on any page, saves
// the setting for every project.
//
// The page (media/tutorial.js) matches the language to each tab group by the tab's title: "C++",
// "v3" and "v2" in the title, see tabLanguages() there.

const vscode = require("vscode");
const { LANGUAGES } = require("./constants");

/**
 * The project's own language: C++, Java with Commands v3, or Java with Commands v2.
 * @param {import("./project").Project} project the open robot project.
 * @returns {"cpp" | "java3" | "java2"}
 * @example
 * detectLanguage(project); // "java3" for a project with WPILib's Commands v3 vendordep
 */
function detectLanguage(project) {
  const s = project.status;
  return s.language === "cpp" ? "cpp" : s.framework === 3 ? "java3" : "java2";
}

/**
 * The yassTutorials.language setting, as the student set it.
 * @returns {string} "auto", "java2", "java3" or "cpp".
 * @example
 * if (languageSetting() === "auto") console.log("following the project");
 */
function languageSetting() {
  return vscode.workspace.getConfiguration("yassTutorials").get("language", "auto");
}

/**
 * The language to show now: the setting, or the project's own when the setting is "auto".
 * @param {import("./project").Project} project the open robot project.
 * @returns {string} "java2", "java3" or "cpp".
 * @example
 * webview.postMessage({ type: "language", language: currentLanguage(project) });
 */
function currentLanguage(project) {
  const setting = languageSetting();
  return setting in LANGUAGES ? setting : detectLanguage(project);
}

/**
 * Save the language for every project. VS Code then fires onDidChangeConfiguration, and the open page
 * switches its tabs.
 * @param {string} value "auto", "java2", "java3" or "cpp".
 * @example
 * await setLanguage("cpp"); // every page now opens on its C++ tab
 */
function setLanguage(value) {
  return vscode.workspace.getConfiguration("yassTutorials").update("language", value, vscode.ConfigurationTarget.Global);
}

module.exports = { detectLanguage, languageSetting, currentLanguage, setLanguage };
