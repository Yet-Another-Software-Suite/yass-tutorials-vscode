# YASS Tutorials

Learn to program your robot with [YAMS](https://yams.yassrobotics.com) and [YAGSL](https://docs.yagsl.com) without leaving WPILib VS Code.

The extension adds a **YASS Tutorials** tab to the activity bar, next to the Explorer. It lists the YAMS and YAGSL tutorials and how-to guides, step by step.

* **Your Robot Project** shows whether a robot project is open and whether it has YAMS and YAGSL. One click creates a project, installs the YAMS or YAGSL vendordep for your command framework, or opens WPILib's vendor libraries. After WPILib opens a new project in its own window, the tutorial opens there too.
* Every code sample has **Copy** and **Insert** buttons. **Insert** puts the code at the cursor in the file you were last editing. A complete file also has **Create file**, which writes it to the right folder of your project.
* A tutorial says when your project is missing what it needs, such as YAMS or the REVLib a SparkMax needs, with a button to fix it.
* The tutorial keeps its own editor group, so the files you open go beside it instead of over it.
* Pick **Java, Commands v2**, **Java, Commands v3** or **C++** once and every code sample switches to it. By default the extension picks it from your robot project.
* Mark steps as done to track your progress. Search every tutorial with the magnifying glass.
* Links to the rest of the docs open the website.

## Install

1. Download `yass-tutorials-<version>.vsix`.
2. In WPILib VS Code, open the Extensions view, click the **...** menu, choose **Install from VSIX...** and pick the file.

Or from a terminal: `code --install-extension yass-tutorials-<version>.vsix`.

## Build

The tutorials come from the YAMS and YAGSL GitBook repos, cloned next to this one as `YAMS-Gitbook` and `YAGSL-gitbook`.

```
npm install
npm run package
```

`npm run build-docs` renders the GitBook pages into `content/`, and `npm run package` also writes `dist/yass-tutorials.vsix`. Pass other repo locations with `node scripts/build-docs.mjs --yams <path> --yagsl <path>`.
