// @ts-check
// The tutorial page: shows what the extension sends, and turns GitBook's tabs, steps and code
// blocks into something to click.
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const content = $("content");
  const languageSelect = /** @type {HTMLSelectElement} */ ($("language"));

  /** @type {any} */
  let current = null;
  let language = "java2";

  /** Which code languages a tab title is for. */
  function tabLanguages(/** @type {string} */ title) {
    const t = title.toLowerCase();
    if (t.includes("c++") || t.includes("cpp")) return ["cpp"];
    if (t.includes("v3") || t.includes("commands3")) return ["java3"];
    if (t.includes("v2") || t.includes("commands2")) return ["java2"];
    if (t.includes("java")) return ["java2", "java3"];
    return [];
  }

  function selectTab(/** @type {Element} */ tabs, /** @type {number} */ index) {
    tabs.querySelectorAll(":scope > .tab-bar > button").forEach((b, i) => {
      b.classList.toggle("active", i === index);
      b.setAttribute("aria-selected", String(i === index));
    });
    tabs.querySelectorAll(":scope > .tab").forEach((t, i) => t.classList.toggle("active", i === index));
  }

  /** Every tab group shows the tab for the chosen language, when it has one. */
  function applyLanguage() {
    document.querySelectorAll(".tabs").forEach((tabs) => {
      const panes = [...tabs.querySelectorAll(":scope > .tab")];
      let index = panes.findIndex((p) => tabLanguages(p.getAttribute("data-title") || "").includes(language));
      if (index < 0) index = Math.max(0, panes.findIndex((p) => p.classList.contains("active")));
      selectTab(tabs, index);
    });
  }

  function buildTabs() {
    document.querySelectorAll(".tabs").forEach((tabs) => {
      const panes = [...tabs.querySelectorAll(":scope > .tab")];
      const bar = document.createElement("div");
      bar.className = "tab-bar";
      bar.setAttribute("role", "tablist");
      panes.forEach((pane, i) => {
        const button = document.createElement("button");
        button.textContent = pane.getAttribute("data-title") || `Tab ${i + 1}`;
        button.setAttribute("role", "tab");
        button.addEventListener("click", () => {
          const langs = tabLanguages(button.textContent || "");
          // Picking a language tab picks it for every code sample.
          if (langs.length === 1 && langs[0] !== language) {
            language = langs[0];
            vscode.postMessage({ type: "language", language });
            applyLanguage();
          } else {
            selectTab(tabs, i);
          }
        });
        bar.appendChild(button);
      });
      tabs.insertBefore(bar, tabs.firstChild);
      selectTab(tabs, 0);
    });
  }

  function buildCodeBlocks() {
    content.querySelectorAll("pre.hljs").forEach((pre) => {
      const title = pre.closest(".code-block")?.getAttribute("data-title") || pre.getAttribute("data-lang") || "";
      const bar = document.createElement("div");
      bar.className = "code-bar";
      const label = document.createElement("span");
      label.className = "code-title";
      label.textContent = title;
      const copy = document.createElement("button");
      copy.className = "icon";
      copy.textContent = "Copy";
      copy.title = "Copy this code";
      const insert = document.createElement("button");
      insert.className = "icon";
      insert.textContent = "Insert";
      insert.title = "Insert this code at the cursor in your last editor";
      const code = () => pre.querySelector("code")?.textContent || "";
      copy.addEventListener("click", () => {
        vscode.postMessage({ type: "copy", code: code() });
        flash(copy, "Copied");
      });
      insert.addEventListener("click", () => {
        vscode.postMessage({ type: "insert", code: code(), lang: pre.getAttribute("data-lang") || "" });
        flash(insert, "Inserted");
      });
      bar.append(label, copy, insert);
      if (isCompleteFile(title, code())) {
        collapse(pre, bar);
        const create = document.createElement("button");
        create.className = "icon create";
        create.textContent = "Create file";
        create.title = "Create " + title.split("/").pop() + " in your project with this code";
        create.addEventListener("click", () => {
          vscode.postMessage({ type: "createFile", code: code(), title });
          flash(create, "Created");
        });
        bar.append(create);
      }
      pre.parentElement?.insertBefore(bar, pre);
    });
  }

  /**
   * "Create ArmSubsystem.java in the subsystems folder": a button that creates the file, started from
   * the page's complete file so that it compiles, ready for the step's code.
   */
  function buildCreateButtons() {
    content.querySelectorAll("p").forEach((p) => {
      if (!/^Create\b/.test((p.textContent || "").trim())) return;
      const codes = [...p.querySelectorAll(":scope > code")].map((c) => (c.textContent || "").trim());
      /** @type {{ name: string, folder: string }[]} */
      const files = [];
      for (let i = 0; i + 1 < codes.length; i++) {
        const name = codes[i];
        const folder = codes[i + 1];
        // A class or file name, followed by the folder it goes in (not by another file).
        if (!/^[A-Z]\w*(\.(java|hpp|h|cpp))?$/.test(name) || /\.\w+$/.test(folder)) continue;
        files.push({ name: /\./.test(name) ? name : `${name}.java`, folder });
        i++;
      }
      if (!files.length) return;
      const bar = document.createElement("div");
      bar.className = "create-files";
      for (const file of files) {
        const button = document.createElement("button");
        button.textContent = `Create ${file.name}`;
        button.title = `Create ${file.name} in ${file.folder}, and open it`;
        button.addEventListener("click", () => {
          vscode.postMessage({ type: "createStarter", ...file, code: starterCode(file.name) });
          flash(button, "Created");
        });
        bar.append(button);
      }
      p.after(bar);
    });
  }

  /**
   * The start of a file: its package, the imports its class line needs, and an empty class, taken
   * from the page's complete file of that name. C++ headers start with #pragma once.
   * @param {string} name
   */
  function starterCode(name) {
    if (/\.(hpp|h)$/.test(name)) return "#pragma once\n";
    if (!name.endsWith(".java")) return "";
    const complete = [...content.querySelectorAll("pre.hljs")]
      .map((pre) => ({ title: pre.closest(".code-block")?.getAttribute("data-title") || "", code: pre.textContent || "" }))
      .find((b) => (b.title === name || b.title.endsWith("/" + name)) && isCompleteFile(b.title, b.code));
    const className = name.replace(/\.java$/, "");
    if (!complete) return `public class ${className} {\n}\n`;
    const lines = complete.code.split("\n");
    const pkg = lines.find((l) => /^\s*package\s/.test(l));
    const declaration = lines.find((l) => new RegExp(`^\\s*(public\\s+)?(final\\s+)?class\\s+${className}\\b`).test(l)) ?? `public class ${className} {`;
    const used = new Set(declaration.match(/\b[A-Z]\w*/g) ?? []);
    const imports = lines.filter((l) => {
      const m = l.match(/^\s*import\s+(?:static\s+)?[\w.]+\.(\w+)\s*;/);
      return m && used.has(m[1]);
    });
    return [pkg, "", ...imports, ...(imports.length ? [""] : []), declaration.replace(/\s*\{?\s*$/, " {"), "}", ""]
      .filter((l, i) => l !== undefined && !(i === 1 && !pkg))
      .join("\n");
  }

  /** Hide a complete file behind a button, so the steps come first and the whole answer second. */
  function collapse(/** @type {Element} */ pre, /** @type {HTMLElement} */ bar) {
    const lines = (pre.textContent || "").split("\n").length;
    const show = document.createElement("button");
    show.className = "reveal";
    const set = (/** @type {boolean} */ open) => {
      show.textContent = open ? "Hide the complete file" : `Show the complete file (${lines} lines)`;
      show.setAttribute("aria-expanded", String(open));
      pre.classList.toggle("collapsed", !open);
      bar.classList.toggle("collapsed", !open);
    };
    show.addEventListener("click", () => set(pre.classList.contains("collapsed")));
    pre.after(show);
    set(false);
  }

  /** A whole file, not a part of one: Java with its package line, C++ starting with an #include or #pragma. */
  function isCompleteFile(/** @type {string} */ title, /** @type {string} */ code) {
    if (/\.java$/.test(title)) return /^\s*package\s+[\w.]+\s*;/m.test(code);
    if (/\.(h|hpp|cpp)$/.test(title)) return /^(src\/main\/)?(include|cpp)\//.test(title) && /^\s*(\/\/.*\n\s*)*#/.test(code);
    return false;
  }

  function flash(/** @type {HTMLElement} */ button, /** @type {string} */ text) {
    const old = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = old), 1200);
  }

  function numberSteps() {
    content.querySelectorAll(".stepper").forEach((stepper) => {
      stepper.querySelectorAll(":scope > .step").forEach((step, i) => step.setAttribute("data-step", String(i + 1)));
    });
  }

  /** URLs written as inline code, such as vendordep URLs, get a Copy button. */
  function buildUrlCopy() {
    content.querySelectorAll(":not(pre) > code").forEach((code) => {
      const text = (code.textContent || "").trim();
      if (!/^https?:\/\/\S+$/.test(text)) return;
      const copy = document.createElement("button");
      copy.className = "icon inline-copy";
      copy.textContent = "Copy";
      copy.title = "Copy " + text;
      copy.addEventListener("click", () => {
        vscode.postMessage({ type: "copy", code: text });
        flash(copy, "Copied");
      });
      code.after(copy);
    });
  }

  /** On a setup page: what the open project has, and buttons that set it up. */
  function renderSetup(/** @type {any} */ setup) {
    const card = $("setup");
    card.hidden = !setup;
    card.replaceChildren();
    if (!setup) return;
    const el = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const button = (/** @type {string} */ text, /** @type {() => void} */ onClick, secondary = false) => {
      const b = el("button", secondary ? "secondary" : "", text);
      b.addEventListener("click", onClick);
      return b;
    };
    const actions = el("div", "setup-actions", "");
    for (const action of setup.actions) {
      actions.append(
        button(
          action.label,
          () => vscode.postMessage(action.open ? { type: "open", id: action.open } : { type: "command", command: action.command }),
          !!action.secondary,
        ),
      );
    }
    card.className = `setup setup-${setup.state}`;
    card.append(el("h2", "", (setup.state === "ready" ? "✓ " : "") + setup.title), el("p", "", setup.body));
    if (setup.actions.length) card.append(actions);
    if (setup.note) card.append(el("p", "muted setup-note", setup.note));
  }

  function showImagesThatAreTooBig() {
    content.querySelectorAll("img[data-too-big]").forEach((img) => {
      const link = document.createElement("a");
      link.href = img.getAttribute("data-too-big") || "#";
      link.setAttribute("data-external", "1");
      link.textContent = "See this animation on the website";
      img.replaceWith(link);
    });
  }

  function render(/** @type {any} */ msg) {
    current = msg;
    content.innerHTML = msg.html;
    $("source").textContent = msg.sourceName;
    $("crumb").textContent = msg.page.title;
    $("optional").hidden = !msg.optional;
    $("description").textContent = msg.page.description;
    $("description").hidden = !msg.page.description;
    numberSteps();
    buildTabs();
    buildCodeBlocks();
    buildUrlCopy();
    buildCreateButtons();
    showImagesThatAreTooBig();
    renderSetup(msg.setup);
    setLanguage(msg.language, msg.languageSetting, msg.hasProject);
    setPager();
    vscode.setState({ pageId: msg.id });
    const anchor = msg.anchor && document.getElementById(msg.anchor);
    if (anchor) anchor.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  let hasProject = true;
  function setLanguage(/** @type {string} */ lang, /** @type {string} */ setting, /** @type {boolean | undefined} */ project) {
    language = lang;
    if (project !== undefined) hasProject = project;
    languageSelect.value = setting;
    const auto = languageSelect.querySelector('option[value="auto"]');
    if (auto) auto.textContent = setting === "auto" && hasProject ? `From my project (${labelOf(lang)})` : "From my project";
    applyLanguage();
  }

  function labelOf(/** @type {string} */ lang) {
    return { java2: "Java, Commands v2", java3: "Java, Commands v3", cpp: "C++" }[lang] || lang;
  }

  function setPager() {
    const prev = $("prev");
    const next = $("next");
    const done = $("done");
    prev.hidden = !current.page.prev;
    prev.textContent = current.prevTitle ? `← ${current.prevTitle}` : "";
    next.hidden = !current.page.next;
    next.textContent = current.nextTitle ? `${current.nextTitle} →` : "";
    done.textContent = current.done ? "✓ Done" : current.page.next ? "Mark done and continue" : "Mark done";
    done.classList.toggle("secondary", current.done);
    done.title = current.done ? "Click to mark this page as not done" : "";
  }

  $("prev").addEventListener("click", () => current?.page.prev && vscode.postMessage({ type: "open", id: current.page.prev }));
  $("next").addEventListener("click", () => current?.page.next && vscode.postMessage({ type: "open", id: current.page.next }));
  $("done").addEventListener("click", () => {
    if (!current) return;
    vscode.postMessage({ type: "done", id: current.id, done: !current.done, next: current.done ? null : current.page.next });
  });
  $("refresh").addEventListener("click", () => vscode.postMessage({ type: "command", command: "yassTutorials.refresh" }));
  $("website").addEventListener("click", (e) => {
    e.preventDefault();
    if (current) vscode.postMessage({ type: "external", url: current.page.url });
  });
  languageSelect.addEventListener("change", () => vscode.postMessage({ type: "language", language: languageSelect.value }));

  document.addEventListener("click", (e) => {
    const link = /** @type {HTMLElement} */ (e.target)?.closest?.("a");
    if (!link || link.id === "website") return;
    const href = link.getAttribute("href") || "";
    if (link.hasAttribute("data-page")) {
      e.preventDefault();
      vscode.postMessage({ type: "open", id: link.getAttribute("data-page"), anchor: href.slice(1) });
    } else if (link.hasAttribute("data-external") || /^https?:/.test(href)) {
      e.preventDefault();
      vscode.postMessage({ type: "external", url: link.href });
    } else if (href.startsWith("#")) {
      e.preventDefault();
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: "smooth" });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "show") render(msg);
    else if (msg.type === "done" && current) {
      current.done = msg.done;
      setPager();
    } else if (msg.type === "language") setLanguage(msg.language, msg.languageSetting, msg.hasProject);
    else if (msg.type === "setup") renderSetup(msg.setup);
  });

  vscode.postMessage({ type: "ready" });
})();
