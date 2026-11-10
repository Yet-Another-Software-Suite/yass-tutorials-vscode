// @ts-check
// Turns the YAMS and YAGSL GitBook pages into what the extension shows: the tutorial tree from each
// SUMMARY.md, and each page's HTML. It only works on text it is handed, so the extension uses it on
// the docs it downloads, and scripts/check-docs.mjs uses it on local clones.
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

const slugify = (/** @type {string} */ s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const escapeHtml = (/** @type {string} */ s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decodeEntities = (/** @type {string} */ s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const attr = (/** @type {string} */ tag, /** @type {string} */ name) =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/**
 * The pages of a SUMMARY.md, as groups of nested pages.
 * @param {string} text
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
 * The page's address on the website: its group, its parents and its file name.
 * @param {Source} source
 * @param {string} groupTitle
 * @param {string[]} chain
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
 * The files of the pages a SUMMARY.md's chosen groups list, hidden pages included.
 * @param {Source} source
 * @param {string} summaryText
 */
function pageFiles(source, summaryText) {
  const groups = parseSummary(summaryText);
  /** @type {string[]} */
  const files = [];
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
 * The front matter's fields, and the page without it.
 * @param {string} text
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
 * A library's tree and pages, from its SUMMARY.md and its pages' text.
 * @param {Source} source
 * @param {string} summaryText
 * @param {(file: string) => string | null} readPage the page's Markdown, or null when it is missing
 * @returns {BuiltSource}
 */
function buildSource(source, summaryText, readPage) {
  const groups = parseSummary(summaryText);
  /** Every page's website address, for links to pages that are not included. */
  const urls = new Map();
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
  /** @returns {TreeNode[]} */
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

md.renderer.rules.fence = (tokens, i, options) => {
  const token = tokens[i];
  const lang = token.info.trim().split(/\s+/)[0] || "";
  const body = options.highlight ? options.highlight(token.content, lang, "") : escapeHtml(token.content);
  return `<pre class="hljs" data-lang="${escapeHtml(lang)}"><code>${body}</code></pre>\n`;
};

/**
 * Highlighted code split into lines, each closing the spans it opens and reopening them on the next.
 * @param {string} code
 * @param {string} lang
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
 * highlighted lines.
 * @param {string} html
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
 * Turns GitBook's {% %} blocks into HTML that the Markdown keeps rendering inside.
 * @param {string} text
 */
function gitbookToHtml(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
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
 * A page's HTML.
 * @param {Source} source
 * @param {PageInfo} page
 * @param {string} text the page's Markdown
 * @param {BuiltSource} built the library, for its links
 * @param {(file: string) => string | null} imageUrl the address of an image in the docs repo, or null when it is missing
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
