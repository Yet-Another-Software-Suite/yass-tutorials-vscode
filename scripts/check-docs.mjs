// Renders every page the extension shows, from local clones of the YAMS and YAGSL docs, with the same
// code the extension uses on the docs it downloads (src/render.js). It fails, naming the page, when:
//
//   - a page or image that SUMMARY.md or a page points at is missing,
//   - a GitBook {% %} block was left in the page, which means render.js doesn't know it yet,
//   - a page's <div>s don't close, which means a GitBook block wasn't closed.
//
// CI runs it every day on the latest docs (.github/workflows/build.yml), so a change to the docs that
// the extension can't show fails the build before a student sees it.
//
//   node scripts/check-docs.mjs [--yams <YAMS-Gitbook>] [--yagsl <YAGSL-gitbook>]
//
// By default it reads the repos cloned next to this one.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SOURCES, buildSource, renderPage } = require("../src/render.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * A command line option's value.
 * @example
 * arg("--yams", "../YAMS-Gitbook"); // "C:/docs/YAMS" when run with --yams C:/docs/YAMS
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const repos = {
  yams: path.resolve(arg("--yams", path.join(ROOT, "..", "YAMS-Gitbook"))),
  yagsl: path.resolve(arg("--yagsl", path.join(ROOT, "..", "YAGSL-gitbook"))),
};

let problems = 0;
/**
 * Report a problem; the script fails at the end if there are any.
 * @example
 * problem("yams/tutorials/arm: image .gitbook/assets/arm.gif is missing");
 */
const problem = (message) => {
  problems++;
  console.error(`  ${message}`);
};

for (const source of SOURCES) {
  const repo = repos[source.id];
  /**
   * A file of the docs repo, or null when it is missing.
   * @example
   * const summary = read("SUMMARY.md");
   */
  const read = (file) => {
    try {
      return fs.readFileSync(path.join(repo, file), "utf8");
    } catch {
      return null;
    }
  };
  const summary = read("SUMMARY.md");
  if (!summary) throw new Error(`No SUMMARY.md in ${repo}. Pass --${source.id} <path to the GitBook repo>.`);
  const built = buildSource(source, summary, read);
  let pages = 0;
  let images = 0;
  for (const [id, page] of Object.entries(built.pages)) {
    const text = read(page.file);
    if (text === null) {
      problem(`${id}: ${page.file} is missing`);
      continue;
    }
    const html = renderPage(source, page, text, built, (file) => {
      images++;
      if (!fs.existsSync(path.join(repo, file))) problem(`${id}: image ${file} is missing`);
      return file;
    });
    const open = (html.match(/<div/g) ?? []).length;
    const close = (html.match(/<\/div>/g) ?? []).length;
    if (open !== close) problem(`${id}: ${open} <div> but ${close} </div>, a GitBook block is not closed`);
    if (/\{%/.test(html.replace(/<pre[\s\S]*?<\/pre>/g, ""))) problem(`${id}: a GitBook block was left in the page`);
    pages++;
  }
  console.log(`${source.name}: ${pages} pages, ${images} images`);
}
if (problems) {
  console.error(`${problems} problems`);
  process.exit(1);
}
