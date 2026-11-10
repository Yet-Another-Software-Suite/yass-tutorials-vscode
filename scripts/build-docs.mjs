// Builds the tutorials the extension shows from the YAMS and YAGSL GitBook repos.
//
// Every page in the chosen SUMMARY.md groups is rendered to HTML once, here, so the extension
// itself needs no Markdown library. Images the pages use are copied next to them, links to other
// bundled pages become in-extension links, and links to the rest of the docs open the website.
//
//   node scripts/build-docs.mjs [--yams <YAMS-Gitbook>] [--yagsl <YAGSL-gitbook>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "content");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const SOURCES = [
  {
    id: "yams",
    name: "YAMS",
    description: "Yet Another Mechanism System",
    repo: path.resolve(arg("--yams", path.join(ROOT, "..", "YAMS-Gitbook"))),
    site: "https://yams.yassrobotics.com/documentation",
    // Built so links to them work, but left out of the list, search and Previous/Next: the
    // extension's Your Robot Project sets the project up, and the motor page is background.
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
    repo: path.resolve(arg("--yagsl", path.join(ROOT, "..", "YAGSL-gitbook"))),
    site: "https://docs.yagsl.com",
    groups: ["Tutorial", "How-to Guides"],
  },
];

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const posix = (p) => p.split(path.sep).join("/");

/** The pages of a SUMMARY.md, as groups of nested pages. */
function parseSummary(source) {
  const lines = fs.readFileSync(path.join(source.repo, "SUMMARY.md"), "utf8").split(/\r?\n/);
  const groups = [{ title: "", nodes: [] }];
  const stack = [];
  for (const line of lines) {
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

/** The page's address on the website: its group, its parents and its file name. */
function pageUrl(source, groupTitle, chain) {
  const parts = groupTitle ? [slugify(groupTitle)] : [];
  for (const file of chain) {
    const base = path.posix.basename(file, ".md");
    parts.push(base.toLowerCase() === "readme" ? path.posix.basename(path.posix.dirname(file)) : base);
  }
  // A group's README is the group's own page.
  if (parts.length === 2 && parts[0] === parts[1]) parts.pop();
  return source.site + "/" + parts.join("/");
}

/** Every page's website address, for links to pages this extension does not include. */
function urlMap(source, groups) {
  const map = new Map();
  const walk = (group, nodes, chain) => {
    for (const node of nodes) {
      if (/^https?:/.test(node.file)) continue;
      const next = [...chain, node.file];
      map.set(path.posix.normalize(node.file), pageUrl(source, group.title, next));
      walk(group, node.children, next);
    }
  };
  for (const group of groups) walk(group, group.nodes, []);
  return map;
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  highlight(code, lang) {
    const language = { gradle: "groovy", sh: "bash", shell: "bash", jsonc: "json" }[lang] ?? lang;
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
    const text = state.tokens[i + 1].children
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
  const body = options.highlight(token.content, lang);
  return `<pre class="hljs" data-lang="${escapeHtml(lang)}"><code>${body}</code></pre>\n`;
};

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** Highlighted code split into lines, each closing the spans it opens and reopening them on the next. */
function highlightedLines(code, lang) {
  const html = md.options.highlight(code, lang);
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
 */
function rawPreToCodeBlock(html) {
  return html.replace(
    /<pre class="language-([\w+-]+)"([^>]*)><code[^>]*>([\s\S]*?)<\/code><\/pre>/g,
    (whole, lang, attrs, inner) => {
      const title = attr(attrs, "data-title");
      // Which characters sit inside <strong>, so their lines can be marked as new.
      let code = "";
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

/** Turns GitBook's {% %} blocks into HTML that the Markdown keeps rendering inside. */
function gitbookToHtml(text) {
  const out = [];
  let fence = null;
  const block = (html) => out.push("", html, "");
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
    const name = body.split(/\s+/)[0];
    switch (name) {
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

function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "pages"), { recursive: true });

const index = { built: new Date().toISOString(), sources: [], pages: {} };
const assets = new Map();
let skippedImages = 0;

for (const source of SOURCES) {
  if (!fs.existsSync(path.join(source.repo, "SUMMARY.md"))) {
    throw new Error(`No SUMMARY.md in ${source.repo}. Pass --${source.id} <path to the GitBook repo>.`);
  }
  const groups = parseSummary(source);
  const urls = urlMap(source, groups);
  const bundled = new Map();
  const order = [];

  const toTree = (group, nodes, chain) =>
    nodes
      .filter((n) => !/^https?:/.test(n.file))
      .map((node) => {
        const file = path.posix.normalize(node.file);
        const id = `${source.id}/${file.replace(/\.md$/, "")}`;
        bundled.set(file, id);
        const hidden = (source.hidden ?? []).includes(file);
        order.push({ id, file, hidden, title: node.title, url: pageUrl(source, group.title, [...chain, node.file]) });
        const children = toTree(group, node.children, [...chain, node.file]);
        return hidden ? children : [{ id, title: node.title, children }];
      })
      .flat();

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
  index.sources.push(tree);

  // Previous and Next skip the hidden pages.
  const visible = order.filter((p) => !p.hidden);
  order.forEach((page) => {
    const i = visible.indexOf(page);
    const text = fs.readFileSync(path.join(source.repo, page.file), "utf8");
    const { meta, body } = frontMatter(text);
    let html = rawPreToCodeBlock(md.render(gitbookToHtml(body)))
      // "In a hurry? Jump to the complete file": the complete file is hidden in the extension.
      .replace(/<div class="hint[^"]*">\s*<p><strong>In a hurry\?<\/strong>[\s\S]*?<\/div>\n?/g, "");
    const dir = path.posix.dirname(page.file);

    html = html.replace(/(href|src)="([^"]*)"/g, (whole, kind, raw) => {
      const value = raw.replace(/&amp;/g, "&");
      if (/^(https?:|mailto:|data:)/.test(value)) {
        return kind === "href" ? `href="${escapeHtml(value)}" data-external="1"` : whole;
      }
      if (value.startsWith("#")) return whole;
      const [target, anchor] = value.split("#");
      let rel = path.posix.normalize(path.posix.join(dir, decodeURIComponent(target)));
      if (kind === "src") {
        const file = path.join(source.repo, rel);
        if (!fs.existsSync(file)) return whole;
        if (fs.statSync(file).size > MAX_IMAGE_BYTES) {
          skippedImages++;
          return `src="" data-too-big="${escapeHtml(page.url)}"`;
        }
        const name = `${source.id}/${path.basename(rel).replace(/[^\w.-]+/g, "_")}`;
        assets.set(name, file);
        return `src="{{ASSETS}}/${name}"`;
      }
      if (rel.endsWith("/") || !path.posix.extname(rel)) rel = path.posix.join(rel, "README.md");
      const hash = anchor ? `#${anchor}` : "";
      if (bundled.has(rel)) {
        return `href="#${escapeHtml(anchor ?? "")}" data-page="${escapeHtml(bundled.get(rel))}"`;
      }
      const url = (urls.get(rel) ?? source.site) + hash;
      return `href="${escapeHtml(url)}" data-external="1"`;
    });

    fs.writeFileSync(path.join(OUT, "pages", page.id.replace(/[\\/]/g, "__") + ".html"), html);
    index.pages[page.id] = {
      title: page.title,
      description: meta.description ?? "",
      source: source.id,
      url: page.url,
      prev: i > 0 ? visible[i - 1].id : null,
      // A hidden page leads into the first tutorial.
      next: i >= 0 ? (visible[i + 1]?.id ?? null) : (visible[0]?.id ?? null),
      ...(page.hidden ? { hidden: true } : {}),
    };
  });
}

for (const [name, file] of assets) {
  const dest = path.join(OUT, "assets", name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 1));
const bytes = [...assets.values()].reduce((sum, f) => sum + fs.statSync(f).size, 0);
console.log(
  `${Object.keys(index.pages).length} pages, ${assets.size} images (${(bytes / 1048576).toFixed(1)} MB)` +
    (skippedImages ? `, ${skippedImages} images over ${MAX_IMAGE_BYTES / 1048576} MB left on the website` : ""),
);
