# How YASS Tutorials works

YASS Tutorials shows the YAMS and YAGSL GitBook tutorials inside WPILib VS Code. It works in two halves:

1. **At build time**, `scripts/build-docs.mjs` reads the two GitBook repos and renders every chosen page to HTML. The extension never parses Markdown itself.
2. **At run time**, `src/extension.js` shows those pages in a sidebar tree and a tutorial panel, and `src/project.js` reads and sets up the open robot project.

```
YAMS-Gitbook  ─┐                              ┌─ sidebar: Your Robot Project, Tutorials
YAGSL-gitbook ─┴─ build-docs.mjs ─ content/ ─ extension.js ─┤
                                                             └─ tutorial panel: media/tutorial.js + tutorial.css
```

## Files

| File | What it does |
| ---- | ------------ |
| `package.json` | The extension manifest: the activity bar tab, its two views, the commands and menus, the `yassTutorials.language` setting, Restricted Mode support, and the build scripts. |
| `scripts/build-docs.mjs` | Builds `content/` from the GitBook repos. See [Building the pages](#building-the-pages). |
| `content/` | Build output, not in git. `index.json` holds the tree and each page's title, website address and Previous/Next; `pages/*.html` holds each page; `assets/` holds the images the pages use. |
| `src/extension.js` | Activation, commands, the two tree views, the tutorial panel, the setup cards, Create file and Insert. |
| `src/project.js` | Reads the open robot project (WPILib or not, Java or C++, Commands v2 or v3, its vendordeps) and installs the YAMS and YAGSL vendordeps. |
| `media/tutorial.js` | The script inside the tutorial panel: tabs, code block buttons, collapsed complete files, the setup card, Previous/Next/Done, and links. |
| `media/tutorial.css` | The panel's styles, all from the VS Code theme's colors, so light and dark themes both work. |
| `media/activity.svg`, `media/icon.png` | The activity bar icon and the extension's icon. |
| `.github/workflows/build.yml` | CI: builds the vsix from the latest docs and publishes it to the `latest` release. |
| `images/` | README screenshots. Left out of the vsix. |

## Building the pages

`node scripts/build-docs.mjs [--yams <YAMS-Gitbook>] [--yagsl <YAGSL-gitbook>]` defaults to the repos cloned next to this one. `SOURCES` at the top of the script says, for each library:

* **`groups`**: the `## ` headings of `SUMMARY.md` whose pages are included. Everything else stays on the website.
* **`hidden`**: pages that are built, so links to them work, but left out of the tree, the search and Previous/Next. YAMS hides `tutorials/project-setup.md` (the Your Robot Project view does that job) and `details/how-yams-drives-a-motor.md`.
* **`site`**: the website the docs are published at, for links to pages that are not included.

For each page the script:

1. Strips the front matter, keeping `description` for the page subtitle.
2. Turns GitBook's `{% hint %}`, `{% tabs %}`/`{% tab %}`, `{% stepper %}`/`{% step %}`, `{% code title %}`, `{% columns %}`, `{% embed %}` and `{% @github-files/github-code-block %}` into plain HTML that Markdown keeps rendering inside (`gitbookToHtml`).
3. Renders the Markdown with markdown-it, and colors code with highlight.js. Headings get GitBook's ids, so `#the-complete-file` links still land.
4. Turns GitBook's raw HTML code blocks (`<pre class="language-java" data-title=...>`, which the later tutorial steps use to highlight the lines a step adds) into the same code blocks, keeping those lines highlighted (`rawPreToCodeBlock`).
5. Rewrites links. A link to an included page becomes `data-page="<id>"`, so it opens in the panel. Any other page gets its website address, built from its `SUMMARY.md` group, parents and file name (`pageUrl`). Images are copied to `content/assets/` and pointed at `{{ASSETS}}`, which the extension replaces with the panel's resource address. Images over 4 MB are left on the website.

A page's id is `<library>/<path without .md>`, such as `yams/tutorials/arm/motor-controller`.

## At run time

### Activation

The extension starts when VS Code opens a WPILib project (`workspaceContains:.wpilib/wpilib_preferences.json`), when a tutorial panel is restored, or shortly after start-up (`onStartupFinished`). It declares Restricted Mode support, because it only reads its own files and writes text files. Without that, VS Code turns it off in an untrusted folder and the panel's buttons stop answering.

### The sidebar

The **YASS** activity bar tab has two views, both in `extension.js`:

* **Your Robot Project** (`ProjectTree`): whether a robot project is open, its language and command framework, whether YAMS and YAGSL are installed (and for the right framework), and its other vendor libraries. Each row that needs something runs the command that fixes it.
* **Tutorials** (`TutorialTree`): the libraries, their groups and their pages from `index.json`, with a done mark and a done count. `OPTIONAL_PAGES` (Troubleshooting) say "optional" and are not counted.

Progress is kept in VS Code's global state (`yassTutorials.done`), so it follows the user across projects.

### The tutorial panel

`TutorialPanel` keeps one webview panel. A second one, such as one more that VS Code restores after a reload, replaces the first. The panel opens in its own editor group on the right and locks it, so files the student opens go beside it, never over it. Code always opens in a group that is not the tutorial's (`codeColumn`).

The panel's HTML is a fixed shell (`shell()`); each page arrives as a message. The page and the extension talk only through messages:

| From the page | What the extension does |
| ------------- | ----------------------- |
| `ready` | Sends the current page. |
| `open` `{id, anchor}` | Shows that page, scrolled to the heading. |
| `done` `{id, done, next}` | Marks the page done or not done, and shows the next page. |
| `copy` `{code}` | Copies the code. |
| `insert` `{code, lang}` | Puts the code at the cursor of the last editor, indented to the cursor's line. |
| `createFile` `{code, title}` | Writes a complete file into the project. See [Create file](#create-file). |
| `language` `{language}` | Saves the code language setting. |
| `command` `{command}` | Runs one of the setup commands in `PAGE_COMMANDS`. |
| `external` `{url}` | Opens the website. |

| From the extension | What the page does |
| ------------------ | ------------------ |
| `show` | Renders the page: its HTML, Previous/Next, done state, code language, the setup card, and whether it is optional. |
| `done` | Updates the Done button. |
| `language` | Switches every tab group to the code language. |
| `setup` | Redraws the setup card after the project changes. |

On the page, `tutorial.js` picks the tab for the code language in every tab group (Java, Commands v2; Java, Commands v3; or C++), adds Copy and Insert to every code block, adds Create file to complete files and hides them behind **Show the complete file**, numbers the steps, and adds Copy next to URLs written as code.

### The code language

The `yassTutorials.language` setting is `auto`, `java2`, `java3` or `cpp`. `auto` follows the project: C++ when `.wpilib/wpilib_preferences.json` says so, Commands v3 when the project has WPILib's Commands v3 vendordep, otherwise Commands v2. Clicking a language tab on any page sets it for every page.

### The project

`Project` in `project.js` reads the first workspace folder that has `.wpilib/wpilib_preferences.json`, and watches its `vendordeps` folder so the views and cards update as libraries come and go. The command framework comes from WPILib's own `Commands v2`/`Commands v3` vendordep, never from a library built for one.

**Install YAMS** and **Install YAGSL** download `https://cdn.yassrobotics.com/<yams|yagsl>_commands<2|3>.json` for the project's framework into `vendordeps`, removing that library's vendordep for the other framework. YAGSL needs YAMS, so installing YAGSL installs YAMS too. Other libraries, such as REVLib and Phoenix 6, come from WPILib's Vendor Dependencies view, which **Open vendor libraries** opens.

### Setup cards

`TutorialPanel.card(id)` decides the card at the top of a page:

* With no robot project open, on any page that adds code to one: **Create a robot project** (WPILib's project creator) and **Open a robot project**.
* On a setup page (`SETUP_PAGES`) with a project: install the library the page is about, or, once it is there, say the project is ready and mark the page done.
* On any other page: what that page's tutorial needs and the project lacks: YAMS, YAGSL, or a vendor library from `VENDOR_NEEDS` (REVLib for the Arm, Elevator and Shooter, Phoenix 6 for the Double FlyWheel, both for the Swerve Drive).

Creating or opening a project opens it in a new window. Before that, the extension saves the page the student is on in `yassTutorials.resume`, and the new window opens that page again when it starts with a robot project, within three hours.

### Create file

A code block is a complete file when its title ends in `.java` and the code has a `package` line, or its title is under `include/` or `cpp/` and the code starts with an `#include` or `#pragma`. `filePathFor` puts a Java file at `src/main/java/<package path>/<name>` and a C++ file at `src/main/<title>`. It asks before replacing a file that already has code in it.

## CI and releases

`.github/workflows/build.yml` runs on every push to main, every pull request, every day, and on demand. It checks out YAMS-Gitbook and YAGSL-gitbook, numbers the build `2027.0.<run>`, builds the pages, packages `dist/yass-tutorials.vsix`, and on main publishes it to the `latest` release. The README's download button points at that file.

## Changing things

* **Include another group of pages:** add its `SUMMARY.md` heading to `groups` in `SOURCES`.
* **Hide a page but keep links to it working:** add its file to `hidden`.
* **Make a page optional:** add its id to `OPTIONAL_PAGES` in `extension.js`.
* **A tutorial needs another vendor library:** add it to `VENDOR_NEEDS`, and how to spot it among the vendordeps to `VENDOR_MATCH`.
* **A new GitBook block:** handle it in `gitbookToHtml`. Unknown blocks are left out.

Build and package locally with `npm install` and `npm run package`.
