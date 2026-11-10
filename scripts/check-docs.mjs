// Renders every page the extension shows from local clones of the docs, the same way the extension
// renders the ones it downloads. CI runs it on the latest docs, so a change to the docs that the
// extension can't show fails the build.
//
//   node scripts/check-docs.mjs [--yams <YAMS-Gitbook>] [--yagsl <YAGSL-gitbook>]

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SOURCES, buildSource, renderPage } = require("../src/render.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const repos = {
  yams: path.resolve(arg("--yams", path.join(ROOT, "..", "YAMS-Gitbook"))),
  yagsl: path.resolve(arg("--yagsl", path.join(ROOT, "..", "YAGSL-gitbook"))),
};

let problems = 0;
const problem = (message) => {
  problems++;
  console.error(`  ${message}`);
};

for (const source of SOURCES) {
  const repo = repos[source.id];
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
