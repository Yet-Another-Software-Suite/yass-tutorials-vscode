# YASS Tutorials

[![Download the latest vsix](https://img.shields.io/badge/Download-latest%20vsix-2ea44f?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://github.com/Yet-Another-Software-Suite/yass-tutorials-vscode/releases/download/latest/yass-tutorials.vsix)
[![Build](https://github.com/Yet-Another-Software-Suite/yass-tutorials-vscode/actions/workflows/build.yml/badge.svg)](https://github.com/Yet-Another-Software-Suite/yass-tutorials-vscode/actions/workflows/build.yml)

Learn to program your robot with [YAMS](https://yams.yassrobotics.com) and [YAGSL](https://docs.yagsl.com) without leaving WPILib VS Code.

The extension adds a **YASS** tab to the activity bar, next to the Explorer. It lists the YAMS and YAGSL tutorials and how-to guides step by step, and opens each one beside your code.

![An Arm tutorial step open beside the robot code, with the tutorial list and its progress in the sidebar](images/tutorial.png)

## From an empty window to a working project

**Your Robot Project** shows whether a robot project is open and whether it has YAMS and YAGSL. With no project open, a tutorial offers to create one. WPILib opens the new project in its own window, and the tutorial opens there too.

![A tutorial with no project open, offering to create a robot project or open one](images/setup-no-project.png)

One click installs the YAMS or YAGSL vendordep that matches your project: Commands v2 or Commands v3, Java or C++.

When a tutorial needs a library your project doesn't have yet, such as the REVLib a SparkMax needs or Phoenix 6 for a TalonFX, the page says so and opens WPILib's vendor library list.

![A Double FlyWheel step saying the project needs Phoenix 6, with a button that opens the vendor libraries](images/needs.png)

## Code you can use straight away

* Every code sample has **Copy** and **Insert**. **Insert** puts the code at the cursor in the file you were last editing.
* A complete file also has **Create file**, which writes it to the right folder of your project and opens it beside the tutorial.
* The lines a step adds are highlighted, the same as in the docs.
* Pick **Java, Commands v2**, **Java, Commands v3** or **C++** once and every sample switches to it. By default the extension picks it from your project.

![Step 2's complete file with Copy, Insert and Create file, and the lines this step adds highlighted](images/complete-file.png)

## Find your way

Mark steps as done to track your progress, and search every tutorial with the magnifying glass. Links to the rest of the docs open the website.

![Searching the tutorials for "shoot"](images/search.png)

## Install

Download [yass-tutorials.vsix](https://github.com/Yet-Another-Software-Suite/yass-tutorials-vscode/releases/download/latest/yass-tutorials.vsix). CI rebuilds it from the latest YAMS and YAGSL docs on every push and every day. Then, in WPILib VS Code:

1. Click **Extensions** in the activity bar on the left.
2. Click **...** at the top of the Extensions view.

![The Extensions icon in the activity bar, and the ... button at the top of the Extensions view, boxed in red](images/install-1.png)

3. Click **Install from VSIX...**, and pick the `yass-tutorials.vsix` you downloaded.

![The ... menu, with Install from VSIX... boxed in red](images/install-2.png)

4. **YASS Tutorials** is now in the list of installed extensions. Click the book icon it adds to the activity bar to open the tutorials.

![YASS Tutorials in the installed extensions, and its book icon in the activity bar, boxed in red](images/install-3.png)

To update, install the new `yass-tutorials.vsix` the same way. From a terminal, `code --install-extension yass-tutorials.vsix` does the same.

## Build

[REFERENCE.md](REFERENCE.md) explains how the extension works and which file does what.

The tutorials come from the YAMS and YAGSL GitBook repos, cloned next to this one as `YAMS-Gitbook` and `YAGSL-gitbook`.

```
npm install
npm run package
```

`npm run build-docs` renders the GitBook pages into `content/`, and `npm run package` also writes `dist/yass-tutorials.vsix`. Pass other repo locations with `node scripts/build-docs.mjs --yams <path> --yagsl <path>`.
