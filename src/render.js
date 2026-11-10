// @ts-check
// Turns the YAMS and YAGSL GitBook docs into what the extension shows. It only works on text it is
// handed, so the extension uses it on the docs it downloads (docs.js), and scripts/check-docs.mjs
// uses it on local clones of the docs, the same way.
//
//   - SOURCES: for each library, its GitHub repo and branch, the SUMMARY.md groups whose pages are
//     shown, the pages hidden from the list (still shown when a link points at them), and the
//     website that the other pages' links go to. Showing another group of pages starts here.
//   - buildSource(): the tutorial tree, each page's title, description, website address and
//     Previous/Next, from SUMMARY.md and the pages' front matter.
//   - renderPage(): one page's HTML:
//       1. gitbookToHtml() turns GitBook's {% %} blocks (hint, tabs, stepper, code, columns, embed,
//          github-code-block) into plain HTML that the Markdown keeps rendering inside. Unknown
//          blocks are left out.
//       2. markdown-it renders the Markdown, and highlight.js colors the code. Headings get the ids
//          GitBook gives them, so #links still land.
//       3. rawPreToCodeBlock() turns GitBook's raw HTML code blocks, which the later tutorial steps
//          use to highlight the lines a step adds, into the same code blocks as the Markdown ones,
//          keeping those lines highlighted.
//       4. The "In a hurry?" hints are left out, since the complete file is hidden behind a button.
//       5. Links to shown pages open in the panel (data-page); any other page opens its website
//          address. Images get the address Docs gives them.
//
// When the docs start using a GitBook block this file doesn't know, the daily CI check names the page,
// and the fix is a new case in gitbookToHtml().

const path = require("path").posix;
const MarkdownIt = require("markdown-it");
const hljs = require("highlight.js/lib/core");

for (const [name, lang] of Object.entries({
  java: require("highlight.js/lib/languages/java"),
  cpp: require("highlight.js/lib/languages/cpp"),
  json: require("highlight.js/lib/languages/json"),
  bash: require("highlight.js/lib/languages/bash"),
  groovy: require("highlight.js/lib/languages/groovy"),
  python: require("highlight.js/lib/languages/python"),
  xml: require("highlight.js/lib/languages/xml"),
  yaml: require("highlight.js/lib/languages/yaml"),
  kotlin: require("highlight.js/lib/languages/kotlin"),
  javascript: require("highlight.js/lib/languages/javascript"),
  properties: require("highlight.js/lib/languages/properties"),
  plaintext: require("highlight.js/lib/languages/plaintext"),
})) {
  hljs.registerLanguage(name, lang);
}

/**
 * @typedef {{
 *   id: string, name: string, description: string,
 *   github: string, branch: string, site: string,
 *   groups: string[], hidden?: string[],
 * }} Source
 * @typedef {{ id: string, title: string, children: TreeNode[] }} TreeNode
 * @typedef {{ title: string, description: string, source: string, url: string, file: string,
 *   prev: string | null, next: string | null, hidden?: boolean }} PageInfo
 * @typedef {{ id: string, name: string, description: string, site: string,
 *   groups: { title: string, nodes: TreeNode[] }[] }} SourceTree
 * @typedef {{ tree: SourceTree, pages: Record<string, PageInfo>, files: Map<string, string>,
 *   urls: Map<string, string> }} BuiltSource
 */

/** @type {Source[]} */
const SOURCES = [
  {
    id: "yams",
    name: "YAMS",
    description: "Yet Another Mechanism System",
    github: "Yet-Another-Software-Suite/YAMS-Gitbook",
    branch: "main",
    site: "https://yams.yassrobotics.com/documentation",
    // Shown when a link points at them, but left out of the list, search and Previous/Next: Your
    // Robot Project sets the project up, and the motor page is background reading.
    hidden: ["tutorials/project-setup.md", "details/how-yams-drives-a-motor.md"],
    groups: [
      "Tutorials",
      "How-to: Mechanisms",
      "How-to: Motor controllers and sensors",
      "How-to: Simulation and logging",
      "How-to: Tuning",
    ],
  },
  {
    id: "yagsl",
    name: "YAGSL",
    description: "Yet Another Generic Swerve Library",
    github: "Yet-Another-Software-Suite/YAGSL-gitbook",
    branch: "main",
    site: "https://docs.yagsl.com",
    groups: ["Tutorial", "How-to Guides"],
  },
];

/**
 * A heading or group title as GitBook writes it in addresses and heading ids.
 * @example
 * slugify("How-to: Mechanisms"); // "how-to-mechanisms"
 * slugify("The complete file"); // "the-complete-file"
 */
const slugify = (/** @type {string} */ s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Text made safe to put in HTML.
 * @example
 * escapeHtml('List<Notifier> "a"'); // "List&lt;Notifier&gt; &quot;a&quot;"
 */
const escapeHtml = (/** @type {string} */ s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * HTML entities turned back into text, the named and the numbered ones.
 * @example
 * decodeEntities("List&#x3C;Notifier> &amp; more"); // "List<Notifier> & more"
 */
const decodeEntities = (/** @type {string} */ s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/**
 * One attribute of a GitBook tag or an HTML tag.
 * @example
 * attr('hint style="warning"', "style"); // "warning"
 * attr('tab title="Java, Commands v2"', "title"); // "Java, Commands v2"
 */
const attr = (/** @type {string} */ tag, /** @type {string} */ name) =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/**
 * The pages of a SUMMARY.md, as its "## " groups of nested pages.
 * @param {string} text the SUMMARY.md.
 * @example
 * parseSummary("## Tutorials\n* [Arm](tutorials/arm.md)\n  * [Step 1](tutorials/arm/motor-controller.md)\n");
 * // [{ title: "", nodes: [] },
 * //  { title: "Tutorials", nodes: [{ title: "Arm", file: "tutorials/arm.md", children: [{ title: "Step 1", ... }] }] }]
 */
function parseSummary(text) {
  /** @type {{ title: string, nodes: { title: string, file: string, children: any[] }[] }[]} */
  const groups = [{ title: "", nodes: [] }];
  /** @type {any[]} */
  const stack = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      groups.push({ title: heading[1], nodes: [] });
      stack.length = 0;
      continue;
    }
    const item = line.match(/^(\s*)[*-]\s+\[(.+?)\]\((.+?)\)\s*$/);
    if (!item) continue;
    const depth = Math.floor(item[1].replace(/\t/g, "  ").length / 2);
    const node = { title: item[2], file: item[3], children: [] };
    const group = groups[groups.length - 1];
    stack.length = depth;
    const parent = stack[depth - 1];
    (parent ? parent.children : group.nodes).push(node);
    stack[depth] = node;
  }
  return groups;
}

/**
 * A page's address on the website: its group, its parents and its file name, as GitBook makes it.
 * @param {Source} source the library.
 * @param {string} groupTitle the SUMMARY.md group the page is in.
 * @param {string[]} chain the files of the page's parents, then the page.
 * @example
 * pageUrl(yams, "Tutorials", ["tutorials/arm.md", "tutorials/arm/motor-controller.md"]);
 * // "https://yams.yassrobotics.com/documentation/tutorials/arm/motor-controller"
 */
function pageUrl(source, groupTitle, chain) {
  const parts = groupTitle ? [slugify(groupTitle)] : [];
  for (const file of chain) {
    const base = path.basename(file, ".md");
    parts.push(base.toLowerCase() === "readme" ? path.basename(path.dirname(file)) : base);
  }
  // A group's README is the group's own page.
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return source.site + "/" + parts.join("/");
}

/**
 * The files of every page a SUMMARY.md's shown groups list, hidden pages included: what Docs
 * downloads. Throws when a group in SOURCES is gone from SUMMARY.md.
 * @param {Source} source the library.
 * @param {string} summaryText the SUMMARY.md.
 * @returns {string[]}
 * @example
 * pageFiles(yams, summary); // ["tutorials/project-setup.md", "tutorials/arm.md", "tutorials/arm/motor-controller.md", ...]
 */
function pageFiles(source, summaryText) {
  const groups = parseSummary(summaryText);
  /** @type {string[]} */
  const files = [];
  /**
   * Add each page and its children to files.
   * @example
   * walk(group.nodes);
   */
  const walk = (/** @type {any[]} */ nodes) => {
    for (const n of nodes) {
      if (!/^https?:/.test(n.file)) files.push(path.normalize(n.file));
      walk(n.children);
    }
  };
  for (const title of source.groups) {
    const group = groups.find((g) => g.title === title);
    if (!group) throw new Error(`${source.name}: no "${title}" group in SUMMARY.md`);
    walk(group.nodes);
  }
  return files;
}

/**
 * A page's front matter (the --- block GitBook puts at the top), and the page without it.
 * @param {string} text the page's Markdown.
 * @example
 * frontMatter("---\ndescription: Learn how to program an Arm.\n---\n# Arm\n");
 * // { meta: { description: "Learn how to program an Arm." }, body: "# Arm\n" }
 */
function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  /** @type {Record<string, string>} */
  const meta = {};
  if (!m) return { meta, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * A library's tutorial tree and its pages' titles, descriptions, website addresses and Previous/Next,
 * from its SUMMARY.md. Hidden pages are left out of the tree and Previous/Next.
 * @param {Source} source the library.
 * @param {string} summaryText the SUMMARY.md.
 * @param {(file: string) => string | null} readPage a page's Markdown, or null when it is missing.
 * @returns {BuiltSource}
 * @example
 * const built = buildSource(yams, summary, (file) => fs.readFileSync(path.join(repo, file), "utf8"));
 * built.pages["yams/tutorials/arm/motor-controller"].next; // "yams/tutorials/arm/mechanism"
 */
function buildSource(source, summaryText, readPage) {
  const groups = parseSummary(summaryText);
  /** Every page's website address, for links to pages that are not included. */
  const urls = new Map();
  /**
   * Record the website address of each page and its children.
   * @example
   * walkUrls(group, group.nodes, []);
   */
  const walkUrls = (/** @type {any} */ group, /** @type {any[]} */ nodes, /** @type {string[]} */ chain) => {
    for (const node of nodes) {
      if (/^https?:/.test(node.file)) continue;
      const next = [...chain, node.file];
      urls.set(path.normalize(node.file), pageUrl(source, group.title, next));
      walkUrls(group, node.children, next);
    }
  };
  for (const group of groups) walkUrls(group, group.nodes, []);

  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {{ id: string, file: string, hidden: boolean, title: string, url: string }[]} */
  const order = [];
  /**
   * Turn SUMMARY.md's pages into tree nodes, recording each page's id, file and place in the order.
   * A hidden page's children take its place.
   * @returns {TreeNode[]}
   * @example
   * toTree(group, group.nodes, []); // [{ id: "yams/tutorials/arm", title: "Arm", children: [...] }, ...]
   */
  const toTree = (/** @type {any} */ group, /** @type {any[]} */ nodes, /** @type {string[]} */ chain) =>
    nodes
      .filter((n) => !/^https?:/.test(n.file))
      .map((node) => {
        const file = path.normalize(node.file);
        const id = `${source.id}/${file.replace(/\.md$/, "")}`;
        files.set(file, id);
        const hidden = (source.hidden ?? []).includes(file);
        order.push({ id, file, hidden, title: node.title, url: pageUrl(source, group.title, [...chain, node.file]) });
        const children = toTree(group, node.children, [...chain, node.file]);
        return hidden ? children : [{ id, title: node.title, children }];
      })
      .flat();

  /** @type {SourceTree} */
  const tree = {
    id: source.id,
    name: source.name,
    description: source.description,
    site: source.site,
    groups: source.groups.map((title) => {
      const group = groups.find((g) => g.title === title);
      if (!group) throw new Error(`${source.name}: no "${title}" group in SUMMARY.md`);
      return { title, nodes: toTree(group, group.nodes, []) };
    }),
  };

  // Previous and Next skip the hidden pages; a hidden page leads into the first tutorial.
  const visible = order.filter((p) => !p.hidden);
  /** @type {Record<string, PageInfo>} */
  const pages = {};
  for (const page of order) {
    const i = visible.indexOf(page);
    const text = readPage(page.file);
    pages[page.id] = {
      title: page.title,
      description: text ? frontMatter(text).meta.description ?? "" : "",
      source: source.id,
      url: page.url,
      file: page.file,
      prev: i > 0 ? visible[i - 1].id : null,
      next: i >= 0 ? (visible[i + 1]?.id ?? null) : (visible[0]?.id ?? null),
      ...(page.hidden ? { hidden: true } : {}),
    };
  }
  return { tree, pages, files, urls };
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  /**
   * Color a code block with highlight.js, for the languages registered at the top of this file.
   * @example
   * md.options.highlight("int a = 1;", "java", ""); // '<span class="hljs-type">int</span> a = ...'
   */
  highlight(code, lang) {
    const language = { gradle: "groovy", sh: "bash", shell: "bash", jsonc: "json", "c++": "cpp", text: "plaintext" }[lang] ?? lang;
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return escapeHtml(code);
  },
});

// Headings get the ids GitBook gives them, so "#the-complete-file" links still land.
md.core.ruler.push("heading_ids", (state) => {
  const seen = new Map();
  state.tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const text = (state.tokens[i + 1].children ?? [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join("");
    let id = slugify(text);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id += "-" + n;
    token.attrSet("id", id);
  });
});

/**
 * A Markdown code block as <pre class="hljs" data-lang="...">, the shape media/tutorial.js adds
 * Copy and Insert to.
 * @example
 * md.render("```java\nint a = 1;\n```"); // '<pre class="hljs" data-lang="java"><code>...</code></pre>'
 */
md.renderer.rules.fence = (tokens, i, options) => {
  const token = tokens[i];
  const lang = token.info.trim().split(/\s+/)[0] || "";
  const body = options.highlight ? options.highlight(token.content, lang, "") : escapeHtml(token.content);
  return `<pre class="hljs" data-lang="${escapeHtml(lang)}"><code>${body}</code></pre>\n`;
};

/**
 * Colored code split into lines, each closing the color spans it opens and reopening them on the next,
 * so a single line can be marked as new.
 * @param {string} code
 * @param {string} lang
 * @returns {string[]}
 * @example
 * highlightedLines('String a = "x";\nint b;', "java");
 * // ['<span class="hljs-type">String</span> <span class="hljs-variable">a</span> <span class="hljs-operator">=</span> <span class="hljs-string">&quot;x&quot;</span>;',
 * //  '<span class="hljs-type">int</span> b;']
 */
function highlightedLines(code, lang) {
  const html = md.options.highlight ? md.options.highlight(code, lang, "") : escapeHtml(code);
  /** @type {string[]} */
  const open = [];
  return html.split("\n").map((line) => {
    const start = open.join("");
    for (const tag of line.match(/<span[^>]*>|<\/span>/g) ?? []) {
      if (tag === "</span>") open.pop();
      else open.push(tag);
    }
    return start + line + "</span>".repeat(open.length);
  });
}

/**
 * GitBook writes code with highlighted lines as raw HTML: <pre class="language-java" data-title=...>
 * with each new line in <strong>. Turn it into a code block like the Markdown ones, keeping the
 * highlighted lines as <span class="line-new">.
 * @param {string} html a rendered page.
 * @returns {string}
 * @example
 * rawPreToCodeBlock('<pre class="language-java" data-title="Robot.java"><code>int a;\n<strong>int b;\n</strong></code></pre>');
 * // '<div class="code-block" data-title="Robot.java"><pre class="hljs" data-lang="java"><code>...int a;\n<span class="line-new">...int b;</span></code></pre></div>'
 */
function rawPreToCodeBlock(html) {
  return html.replace(
    /<pre class="language-([\w+-]+)"([^>]*)><code[^>]*>([\s\S]*?)<\/code><\/pre>/g,
    (whole, lang, attrs, inner) => {
      const title = attr(attrs, "data-title");
      // Which characters sit inside <strong>, so their lines can be marked as new.
      let code = "";
      /** @type {boolean[]} */
      const strong = [];
      let inStrong = false;
      for (const part of inner.split(/(<[^>]+>)/)) {
        if (part.startsWith("<")) {
          if (/^<strong\b/.test(part)) inStrong = true;
          else if (part === "</strong>") inStrong = false;
          continue;
        }
        const text = decodeEntities(part);
        code += text;
        for (let i = 0; i < text.length; i++) strong.push(inStrong);
      }
      code = code.replace(/\n$/, "");
      let at = 0;
      const isNew = code.split("\n").map((line) => {
        const marked = [...line].some((c, i) => c.trim() && strong[at + i]);
        at += line.length + 1;
        return marked;
      });
      const language = lang === "c++" ? "cpp" : lang;
      const lines = highlightedLines(code, language).map((l, i) => (isNew[i] ? `<span class="line-new">${l}</span>` : l));
      return (
        `<div class="code-block"${title ? ` data-title="${escapeHtml(decodeEntities(title))}"` : ""}>` +
        `<pre class="hljs" data-lang="${escapeHtml(language)}"><code>${lines.join("\n")}</code></pre></div>`
      );
    },
  );
}

/**
 * Turn GitBook's {% %} blocks into HTML that the Markdown keeps rendering inside. Blocks inside code
 * are left alone; unknown blocks are left out. A new GitBook block gets a case here.
 * @param {string} text a page's Markdown.
 * @returns {string}
 * @example
 * gitbookToHtml('{% hint style="info" %}\nRead this.\n{% endhint %}');
 * // '\n<div class="hint hint-info">\n\nRead this.\n\n</div>\n'
 */
function gitbookToHtml(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
  /**
   * Add a line of HTML with blank lines around it, so the Markdown inside keeps rendering.
   * @example
   * block('<div class="tabs">');
   */
  const block = (/** @type {string} */ html) => out.push("", html, "");
  for (const line of text.split(/\r?\n/)) {
    const fenceMark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMark) {
      if (!fence) fence = fenceMark[1];
      else if (line.trim().startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const tag = line.match(/^\s*\{%\s*(.+?)\s*%\}\s*$/);
    if (!tag) {
      out.push(line);
      continue;
    }
    const body = tag[1];
    switch (body.split(/\s+/)[0]) {
      case "hint":
        block(`<div class="hint hint-${escapeHtml(attr(body, "style") ?? "info")}">`);
        break;
      case "tabs":
        block('<div class="tabs">');
        break;
      case "tab":
        block(`<div class="tab" data-title="${escapeHtml(attr(body, "title") ?? "")}">`);
        break;
      case "stepper":
        block('<div class="stepper">');
        break;
      case "step":
        block('<div class="step">');
        break;
      case "code": {
        const title = attr(body, "title");
        block(`<div class="code-block"${title ? ` data-title="${escapeHtml(title)}"` : ""}>`);
        break;
      }
      case "columns":
        block('<div class="columns">');
        break;
      case "column":
        block('<div class="column">');
        break;
      case "content-ref":
        block('<div class="content-ref">');
        break;
      case "embed": {
        const url = attr(body, "url") ?? "";
        const label = /youtu\.?be/.test(url) ? "Watch the video" : url;
        block(`<p class="embed"><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`);
        break;
      }
      case "@github-files/github-code-block": {
        const url = attr(body, "url") ?? "";
        const file = decodeURIComponent(url.split("/").pop() ?? url);
        block(
          `<p class="github-file"><a href="${escapeHtml(url)}"><span class="codicon">&lt;/&gt;</span> ${escapeHtml(file)}</a> <span class="muted">on GitHub</span></p>`,
        );
        break;
      }
      case "endhint":
      case "endtabs":
      case "endtab":
      case "endstepper":
      case "endstep":
      case "endcode":
      case "endcolumns":
      case "endcolumn":
      case "endcontent-ref":
        block("</div>");
        break;
      default:
        // Anything else GitBook only (includes, buttons) is left out.
        break;
    }
  }
  return out.join("\n");
}

/**
 * A page's HTML: GitBook blocks, Markdown, code colors, highlighted lines, no "In a hurry?" hints,
 * links to shown pages opening in the panel and the others opening the website, and images at the
 * addresses imageUrl gives.
 * @param {Source} source the library.
 * @param {PageInfo} page the page, from buildSource().
 * @param {string} text the page's Markdown.
 * @param {BuiltSource} built the library, from buildSource(), for its links.
 * @param {(file: string) => string | null} imageUrl the address of an image in the repo, or null when it is missing.
 * @returns {string}
 * @example
 * const page = built.pages["yams/tutorials/arm/motor-controller"];
 * const html = renderPage(yams, page, read(page.file), built, (file) => `https://raw.githubusercontent.com/.../main/${file}`);
 */
function renderPage(source, page, text, built, imageUrl) {
  const { body } = frontMatter(text);
  const dir = path.dirname(page.file);
  return rawPreToCodeBlock(md.render(gitbookToHtml(body)))
    // "In a hurry? Jump to the complete file": the complete file is hidden behind a button.
    .replace(/<div class="hint[^"]*">\s*<p><strong>In a hurry\?<\/strong>[\s\S]*?<\/div>\n?/g, "")
    .replace(/(href|src)="([^"]*)"/g, (whole, kind, raw) => {
      const value = raw.replace(/&amp;/g, "&");
      if (/^(https?:|mailto:|data:)/.test(value)) {
        return kind === "href" ? `href="${escapeHtml(value)}" data-external="1"` : whole;
      }
      if (value.startsWith("#")) return whole;
      const [target, anchor] = value.split("#");
      let rel = path.normalize(path.join(dir, decodeURIComponent(target)));
      if (kind === "src") {
        const url = imageUrl(rel);
        return url ? `src="${escapeHtml(url)}"` : whole;
      }
      if (rel.endsWith("/") || !path.extname(rel)) rel = path.join(rel, "README.md");
      const id = built.files.get(rel);
      if (id) return `href="#${escapeHtml(anchor ?? "")}" data-page="${escapeHtml(id)}"`;
      const url = (built.urls.get(rel) ?? source.site) + (anchor ? `#${anchor}` : "");
      return `href="${escapeHtml(url)}" data-external="1"`;
    });
}

module.exports = { SOURCES, parseSummary, pageFiles, buildSource, renderPage, frontMatter };
