# How YASS Tutorials works

YASS Tutorials shows the YAMS and YAGSL GitBook tutorials inside WPILib VS Code. Nothing is built ahead of time: the extension downloads the docs from their GitHub repos, keeps them on disk, and renders each page when it is opened. When the docs change, the tutorials change with them, without a new vsix.

```
github.com/.../YAMS-Gitbook  ─┐   docs.js: download what changed,   render.js: SUMMARY.md to the tree,
github.com/.../YAGSL-gitbook ─┴─  keep it in the extension's storage ─ each page to HTML when it opens
                                                                     │
          extension.js starts it all: trees.js (sidebar), panel.js (tutorial panel), files.js, project.js
                                                                     │
                                       media/tutorial.js + tutorial.css: the page in the panel
```

## Files

| File | What it does |
| ---- | ------------ |
| `package.json` | The manifest: the activity bar tab and its two views, the commands and menus, the `yassTutorials.language` setting, Restricted Mode support, and the scripts. `main` is the bundle in `out/`. |
| `src/extension.js` | Where the extension starts: creates the pieces below, wires them together, registers every command, and keeps the tutorials up to date. |
| `src/constants.js` | The lists behavior comes from: setup pages, optional pages, the vendor library each tutorial needs, and the commands a page may run. Start here for most changes. |
| `src/render.js` | Which docs pages are shown (`SOURCES`), and how GitBook Markdown becomes the tree and each page's HTML. Used by the extension on the docs it downloads, and by `scripts/check-docs.mjs` on local clones. |
| `src/docs.js` | Downloads the docs and keeps them up to date. See [The docs](#the-docs). |
| `src/panel.js` | The tutorial panel: renders a page, sends it to `media/tutorial.js`, acts on its buttons, and decides the setup card (`card()`). |
| `src/trees.js` | The two sidebar views: Your Robot Project (`ProjectTree`) and Tutorials (`TutorialTree`). |
| `src/files.js` | Putting code into the project: Insert, Create file, and the Create button under "Create `X` in the `Y` folder". |
| `src/language.js` | Which code a page shows: Commands v2, Commands v3 or C++, from the setting or the project. |
| `src/project.js` | Reads the open robot project (WPILib or not, Java or C++, Commands v2 or v3, its vendordeps) and installs the YAMS and YAGSL vendordeps. |
| `media/tutorial.js` | The script inside the tutorial panel: tabs, code block buttons, collapsed complete files, Create buttons, the setup card, Refresh, Previous/Next/Done, and links. |
| `media/tutorial.css` | The panel's styles, all from the VS Code theme's colors, so light and dark themes both work. |
| `media/activity.svg`, `media/icon.png` | The activity bar icon and the extension's icon. |
| `scripts/check-docs.mjs` | Renders every page from local clones of the docs and fails on what the extension could not show. |
| `.github/workflows/build.yml` | CI. See [CI and releases](#ci-and-releases). |
| `images/` | README screenshots. Left out of the vsix. |

esbuild bundles `src/` and its libraries (markdown-it and highlight.js) into `out/extension.js`, so the vsix holds only that bundle and `media/`.

## The docs

### What is shown

`SOURCES` in `render.js` says, for each library:

* **`github`** and **`branch`**: the repo and branch the docs come from.
* **`groups`**: the `## ` headings of `SUMMARY.md` whose pages are shown. Everything else stays on the website.
* **`hidden`**: pages left out of the tree, the search and Previous/Next, but still shown when a link points at them. YAMS hides `tutorials/project-setup.md` (the Your Robot Project view does that job) and `details/how-yams-drives-a-motor.md`.
* **`site`**: the website the docs are published at, for links to pages that are not shown.

A page's id is `<library>/<path without .md>`, such as `yams/tutorials/arm/motor-controller`.

### Downloading and updating

`Docs` keeps each library in `<extension storage>/docs/<library>/`, laid out like the repo, with a `state.json` that records the commit it last saw, every file's git blob hash at that commit (`tree`), and the hash of each file on disk (`have`).

When VS Code starts, and every hour after, `sync()` checks each library whose last check is more than 12 hours old. **Refresh** (on the page and in the Tutorials header, or **YASS: Check for New Tutorials**) checks right away.

1. Ask GitHub for the branch's commit (`api.github.com/repos/<repo>/commits/<branch>`, one small request). The same commit means nothing to do.
2. Otherwise, get the commit's file list with blob hashes (`git/trees/<commit>?recursive=1`).
3. Download `SUMMARY.md` and the shown pages whose hash differs from the one on disk, from `raw.githubusercontent.com` at that commit. Files gone from the repo are removed.
4. Rebuild the tree, and refresh the sidebar and the open page.

Images are not downloaded ahead of time. A page shows an image from disk when its hash matches; otherwise it loads from GitHub and is saved in the background, so it works offline from then on.

If anything fails, the docs on disk stay as they were. With nothing on disk yet and GitHub's API refusing (it allows few requests per network, which a classroom can use up), the pages are taken from the branch directly, and the next check makes updates incremental again.

### Rendering a page

`renderPage` in `render.js`:

1. Strips the front matter. Its `description` is the page subtitle.
2. Turns GitBook's `{% hint %}`, `{% tabs %}`/`{% tab %}`, `{% stepper %}`/`{% step %}`, `{% code title %}`, `{% columns %}`, `{% embed %}` and `{% @github-files/github-code-block %}` into plain HTML that Markdown keeps rendering inside (`gitbookToHtml`). Unknown blocks are left out.
3. Renders the Markdown with markdown-it, and colors code with highlight.js. Headings get GitBook's ids, so `#the-complete-file` links still land.
4. Turns GitBook's raw HTML code blocks (`<pre class="language-java" data-title=...>`, which the later tutorial steps use to highlight the lines a step adds) into the same code blocks, keeping those lines highlighted (`rawPreToCodeBlock`).
5. Leaves out the "In a hurry?" hints, since the complete file is hidden behind a button.
6. Rewrites links: to a shown page, `data-page="<id>"`, so it opens in the panel; to any other page, its website address, built from its `SUMMARY.md` group, parents and file name. Images get the address `Docs` gives them.

## The sidebar

The **YASS** activity bar tab has two views, both in `trees.js`:

* **Your Robot Project** (`ProjectTree`): whether a robot project is open, its language and command framework, whether YAMS and YAGSL are installed (and for the right framework), and its other vendor libraries. Each row that needs something runs the command that fixes it.
* **Tutorials** (`TutorialTree`): the libraries, their groups and their pages, with a done mark and a done count. `OPTIONAL_PAGES` (Troubleshooting) say "optional" and are not counted. While the first download runs, or if it fails, the view says so.

Progress is kept in VS Code's global state (`yassTutorials.done`), so it follows the student across projects.

## The tutorial panel

`TutorialPanel` keeps one webview panel. A second one, such as one more that VS Code restores after a reload, replaces the first. The panel opens in its own editor group on the right and locks it, so files go beside it, never over it. Code always opens in a group that is not the tutorial's (`codeColumn`).

The panel's HTML is a fixed shell (`shell()`); each page arrives as a message. The page and the extension talk only through messages:

| From the page | What the extension does |
| ------------- | ----------------------- |
| `ready` | Sends the current page. |
| `open` `{id, anchor}` | Shows that page, scrolled to the heading. |
| `done` `{id, done, next}` | Marks the page done or not done, and shows the next page. |
| `copy` `{code}` | Copies the code. |
| `insert` `{code, lang}` | Puts the code at the cursor of the last editor, indented to the cursor's line. |
| `createFile` `{code, title}` | Writes a complete file into the project. See [Creating files](#creating-files). |
| `createStarter` `{name, folder, code}` | Creates the file a step asks for. See [Creating files](#creating-files). |
| `language` `{language}` | Saves the code language setting. |
| `command` `{command}` | Runs one of `PAGE_COMMANDS`: the setup commands and Refresh. |
| `external` `{url}` | Opens the website. |

| From the extension | What the page does |
| ------------------ | ------------------ |
| `show` | Renders the page: its HTML, Previous/Next, done state, code language, the setup card, and whether it is optional. |
| `done` | Updates the Done button. |
| `language` | Switches every tab group to the code language. |
| `setup` | Redraws the setup card after the project changes. |

On the page, `tutorial.js` picks the tab for the code language in every tab group (Java, Commands v2; Java, Commands v3; or C++), adds Copy and Insert to every code block, adds Create file to complete files and hides them behind **Show the complete file**, adds a Create button under each "Create `X` in the `Y` folder" sentence, numbers the steps, and adds Copy next to URLs written as code.

## The code language

The `yassTutorials.language` setting is `auto`, `java2`, `java3` or `cpp`. `auto` follows the project: C++ when `.wpilib/wpilib_preferences.json` says so, Commands v3 when the project has WPILib's Commands v3 vendordep, otherwise Commands v2. Clicking a language tab on any page sets it for every page.

## The project

`Project` in `project.js` reads the first workspace folder that has `.wpilib/wpilib_preferences.json`, and watches its `vendordeps` folder so the views and cards update as libraries come and go. The command framework comes from WPILib's own `Commands v2`/`Commands v3` vendordep, never from a library built for one.

**Install YAMS** and **Install YAGSL** download `https://cdn.yassrobotics.com/<yams|yagsl>_commands<2|3>.json` for the project's framework into `vendordeps`, removing that library's vendordep for the other framework. YAGSL needs YAMS, so installing YAGSL installs YAMS too. Other libraries, such as REVLib and Phoenix 6, come from WPILib's Vendor Dependencies view, which **Open vendor libraries** opens.

### Setup cards

`TutorialPanel.card(id)` decides the card at the top of a page:

* With no robot project open, on any page that adds code to one: **Create a robot project** (WPILib's project creator) and **Open a robot project**.
* On a setup page (`SETUP_PAGES`) with a project: install the library the page is about, or, once it is there, say the project is ready and mark the page done.
* On any other page: what that page's tutorial needs and the project lacks: YAMS, YAGSL, or a vendor library from `VENDOR_NEEDS` (REVLib for the Arm, Elevator and Shooter, Phoenix 6 for the Double FlyWheel, both for the Swerve Drive).

Creating or opening a project opens it in a new window. Before that, the extension saves the page the student is on in `yassTutorials.resume`, and the new window opens that page again when it starts with a robot project, within three hours.

## Creating files

* **Create file**, on a complete file: a code block is complete when its title ends in `.java` and the code has a `package` line, or its title is under `include/` or `cpp/` and the code starts with an `#include` or `#pragma`. A Java file goes to `src/main/java/<package path>/<name>`, a C++ file to `src/main/<title>`. It asks before replacing a file that already has code in it.
* **Create `ArmSubsystem.java`**, under "Create `ArmSubsystem.java` in the `subsystems` folder": creates the file the step asks for, from the page's complete file of that name: its `package` line, the class line, and the imports that line needs, so it compiles at once and each step's code goes inside. A C++ header starts with `#pragma once`. The folder is the template's robot package folder (where `Robot.java` is) plus the named folder, or the path the sentence gives for C++. A file that is already there is only opened.

## CI and releases

`.github/workflows/build.yml` runs on every push to main, every pull request, every day, and on demand. It checks out YAMS-Gitbook and YAGSL-gitbook and runs `scripts/check-docs.mjs` on them, so a docs change the extension cannot show fails the daily run. Pushes to main and manual runs also number the build `2027.0.<run>`, package `dist/yass-tutorials.vsix`, and publish it to the `latest` release that the README's download button points at.

## When something breaks

| What you see | Where to look |
| ------------ | ------------- |
| The daily CI run fails on "Render every page of the latest docs" | Its log names the page and the problem. A block left in the page or an unclosed `<div>` means the docs use a GitBook block `gitbookToHtml` in `src/render.js` doesn't know: add a `case` for it. `no "X" group in SUMMARY.md` means a heading in the docs' `SUMMARY.md` was renamed: update `groups` in `SOURCES`. |
| A page shows something wrong, but CI passes | Clone the docs next to this repo and run `npm run check-docs`, then change `src/render.js`. To see one page's HTML, call `renderPage` from a small script like `scripts/check-docs.mjs`. |
| The sidebar says it couldn't download the tutorials | The extension needs `api.github.com` and `raw.githubusercontent.com`. Check the network, then click **Try Again**. The download is in `src/docs.js`. |
| A button on a page does nothing | The page and the extension talk through messages: `onMessage` in `src/panel.js` handles each one, and the button is made in `media/tutorial.js`. A button that runs a command also needs it listed in `PAGE_COMMANDS` in `src/constants.js`. To see the page's own errors, run **Developer: Open Webview Developer Tools**. |
| The extension does nothing at all | Run **Developer: Toggle Developer Tools** and look at the Console for `YASS Tutorials` errors. In an untrusted folder, VS Code keeps the extension on only because `capabilities` in `package.json` says it supports that. |
| A card asks for the wrong library, or none | `VENDOR_NEEDS` and `VENDOR_MATCH` in `src/constants.js`, and what `src/project.js` reads from the project's `vendordeps`. |
| Create or Create file puts a file in the wrong place | `filePathFor` and `starterPathFor` in `src/files.js`. The file's start comes from `starterCode` in `media/tutorial.js`. |

To try a change, run `npm run package` and install `dist/yass-tutorials.vsix` in WPILib VS Code (**Extensions**, **...**, **Install from VSIX...**), then reload the window.

## Changing things

* **Show another group of pages:** add its `SUMMARY.md` heading to `groups` in `SOURCES`.
* **Hide a page but keep links to it working:** add its file to `hidden`.
* **Make a page optional:** add its id to `OPTIONAL_PAGES` in `src/constants.js`.
* **A tutorial needs another vendor library:** add it to `VENDOR_NEEDS`, and how to spot it among the vendordeps to `VENDOR_MATCH`, both in `src/constants.js`.
* **A new GitBook block:** handle it in `gitbookToHtml`.

Locally: `npm install`, then `npm run check-docs` (with the docs cloned next to this repo, or `--yams`/`--yagsl` paths) and `npm run package`.
