// @ts-check
// The lists the extension's behavior comes from. Most changes to what a page shows or asks for start
// here: which pages are setup pages or optional, which vendor library each tutorial needs, and which
// commands a page's buttons may run. Which docs pages are shown at all is SOURCES in render.js.

/** The tutorial panel's type, which VS Code uses to restore it after a reload. */
const VIEW_TYPE = "yassTutorials.page";

/** Where the extension keeps the pages marked done, and the page to reopen in a new project's window. */
const DONE_KEY = "yassTutorials.done";
const RESUME_KEY = "yassTutorials.resume";

/** How long after leaving a page a new robot project's window picks the tutorial back up. */
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

/** How to spot each vendor library of VENDOR_NEEDS among a project's vendordeps. */
const VENDOR_MATCH = {
  REVLib: (/** @type {{ file: string, name: string }} */ v) => /^revlib/i.test(v.name) || /^revlib/i.test(v.file),
  "Phoenix 6": (/** @type {{ file: string, name: string }} */ v) => /phoenix ?\(?v?6/i.test(v.name) || /^phoenix6/i.test(v.file),
};

/** Pages a student may skip: they say "optional" and are not counted in the progress. */
const OPTIONAL_PAGES = new Set(["yams/tutorials/troubleshooting"]);

/** YAGSL pages that come before installing YAGSL, so they need no project. */
const BEFORE_YAGSL = ["yagsl/tutorial/README", "yagsl/tutorial/01-gather-your-robot-information"];

/** The note under a setup card. */
const VENDOR_NOTE =
  "Your motor controller's library, such as REVLib or Phoenix 6, comes from the vendor libraries list. The page below shows each step by hand.";

/** The commands the tutorial page's buttons may run. Anything else a page asks for is ignored. */
const PAGE_COMMANDS = [
  "yassTutorials.createProject",
  "yassTutorials.openProject",
  "yassTutorials.installYams",
  "yassTutorials.installYagsl",
  "yassTutorials.manageVendorLibs",
  "yassTutorials.refresh",
];

/** The code languages a page can show, as the yassTutorials.language setting names them. */
const LANGUAGES = {
  java2: "Java, Commands v2",
  java3: "Java, Commands v3",
  cpp: "C++",
};

module.exports = {
  VIEW_TYPE,
  DONE_KEY,
  RESUME_KEY,
  RESUME_MS,
  SETUP_PAGES,
  VENDOR_NEEDS,
  VENDOR_MATCH,
  OPTIONAL_PAGES,
  BEFORE_YAGSL,
  VENDOR_NOTE,
  PAGE_COMMANDS,
  LANGUAGES,
};
