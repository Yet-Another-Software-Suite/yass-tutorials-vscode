// @ts-check
// The YAMS and YAGSL docs, downloaded from their GitHub repos and kept in the extension's storage.
//
// Each library's folder holds the files it needs at the commit it last saw: SUMMARY.md, the pages
// and the images that have been shown. state.json records that commit and each file's git blob
// hash, so an update downloads only what changed, and the tutorials keep working offline.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { SOURCES, pageFiles, buildSource, renderPage } = require("./render");

/** Check for new docs this often while VS Code is open. */
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;
const PARALLEL = 6;

/**
 * @typedef {import("./render").Source} Source
 * @typedef {import("./render").BuiltSource} BuiltSource
 * @typedef {import("./render").PageInfo} PageInfo
 * @typedef {{ commit: string, checked: number, tree: Record<string, string>, have: Record<string, string> }} SourceState
 * @typedef {{ sources: BuiltSource["tree"][], pages: Record<string, PageInfo> }} Index
 */

/**
 * Fetch with a timeout and GitHub's preferred headers.
 * @param {string} url
 * @param {Record<string, string>} [headers]
 */
async function get(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "yass-tutorials-vscode", ...headers },
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the jobs a few at a time.
 * @param {(() => Promise<void>)[]} jobs
 */
async function inParallel(jobs) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
}

const rawUrl = (/** @type {Source} */ source, /** @type {string} */ ref, /** @type {string} */ file) =>
  `https://raw.githubusercontent.com/${source.github}/${ref}/${file.split("/").map(encodeURIComponent).join("/")}`;

class Docs {
  /** @param {vscode.Uri} storage */
  constructor(storage) {
    this.root = path.join(storage.fsPath, "docs");
    /** @type {Index} */
    this.index = { sources: [], pages: {} };
    /** @type {Map<string, BuiltSource>} */
    this.built = new Map();
    /** @type {Map<string, SourceState>} */
    this.state = new Map();
    /** @type {Promise<{ changed: boolean, failed: string[] }> | undefined} */
    this.syncing = undefined;
    this.changed = new vscode.EventEmitter();
    /** Fires when the tutorials change. */
    this.onDidChange = this.changed.event;
    /** Images being downloaded, so each is fetched once. */
    this.downloading = new Set();
  }

  /** @param {Source} source */
  dir(source) {
    return path.join(this.root, source.id);
  }

  /** @param {Source} source */
  readState(source) {
    try {
      return /** @type {SourceState} */ (JSON.parse(fs.readFileSync(path.join(this.dir(source), "state.json"), "utf8")));
    } catch {
      return { commit: "", checked: 0, tree: {}, have: {} };
    }
  }

  /**
   * @param {Source} source
   * @param {SourceState} state
   */
  writeState(source, state) {
    fs.mkdirSync(this.dir(source), { recursive: true });
    fs.writeFileSync(path.join(this.dir(source), "state.json"), JSON.stringify(state));
    this.state.set(source.id, state);
  }

  /**
   * A file of the docs as it is now on disk, or null.
   * @param {Source} source
   * @param {string} file
   */
  readText(source, file) {
    try {
      return fs.readFileSync(path.join(this.dir(source), file), "utf8");
    } catch {
      return null;
    }
  }

  /** Whether any tutorials are downloaded. */
  get ready() {
    return this.index.sources.length > 0;
  }

  /** Which docs commit each library is at, such as "YAMS abc1234". */
  describe() {
    return SOURCES.filter((s) => this.state.get(s.id)?.commit)
      .map((s) => `${s.name} ${this.state.get(s.id)?.commit.slice(0, 7)}`)
      .join(", ");
  }

  /** Build the tutorial tree from what is on disk. */
  load() {
    /** @type {Index} */
    const index = { sources: [], pages: {} };
    this.built.clear();
    for (const source of SOURCES) {
      this.state.set(source.id, this.readState(source));
      const summary = this.readText(source, "SUMMARY.md");
      if (!summary) continue;
      try {
        const built = buildSource(source, summary, (file) => this.readText(source, file));
        this.built.set(source.id, built);
        index.sources.push(built.tree);
        Object.assign(index.pages, built.pages);
      } catch (e) {
        console.error(`YASS Tutorials: ${source.name} docs could not be read`, e);
      }
    }
    this.index = index;
  }

  /**
   * Download what changed since the last check. Runs once at a time; failures keep the docs on disk.
   * @param {{ force?: boolean }} [options] force checks even when the last check was recent
   */
  sync(options = {}) {
    if (!this.syncing) {
      this.syncing = this.doSync(options).finally(() => (this.syncing = undefined));
    }
    return this.syncing;
  }

  /** @param {{ force?: boolean }} options */
  async doSync({ force = false }) {
    let changed = false;
    /** @type {string[]} */
    const failed = [];
    for (const source of SOURCES) {
      const state = this.readState(source);
      if (!force && state.commit && Date.now() - state.checked < CHECK_EVERY_MS) continue;
      try {
        if (await this.syncSource(source, state)) changed = true;
      } catch (e) {
        console.error(`YASS Tutorials: could not update the ${source.name} docs`, e);
        failed.push(source.name);
      }
    }
    if (changed) {
      this.load();
      this.changed.fire(undefined);
    }
    return { changed, failed };
  }

  /**
   * @param {Source} source
   * @param {SourceState} state
   * @returns {Promise<boolean>} whether anything changed
   */
  async syncSource(source, state) {
    const api = `https://api.github.com/repos/${source.github}`;
    let commit;
    try {
      commit = (await (await get(`${api}/commits/${source.branch}`, { Accept: "application/vnd.github.sha" })).text()).trim();
    } catch (e) {
      // GitHub's API allows few requests per network. With nothing on disk yet, take the branch as it is.
      if (this.readText(source, "SUMMARY.md")) throw e;
      return this.syncFromBranch(source);
    }
    if (commit === state.commit && this.readText(source, "SUMMARY.md")) {
      this.writeState(source, { ...state, checked: Date.now() });
      return false;
    }

    // Every file's blob hash at that commit, to download only the files that changed.
    const listing = await (await get(`${api}/git/trees/${commit}?recursive=1`, { Accept: "application/vnd.github+json" })).json();
    /** @type {Record<string, string>} */
    const tree = {};
    for (const entry of listing.tree ?? []) if (entry.type === "blob") tree[entry.path] = entry.sha;

    const dir = this.dir(source);
    const have = { ...state.have };
    const download = async (/** @type {string} */ file) => {
      if (!tree[file] || have[file] === tree[file]) return;
      const body = Buffer.from(await (await get(rawUrl(source, commit, file))).arrayBuffer());
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
      have[file] = tree[file];
    };

    await download("SUMMARY.md");
    const summary = fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf8");
    // Throws when a group the extension shows is gone, which keeps the docs on disk.
    const files = pageFiles(source, summary);
    await inParallel(files.map((file) => () => download(file)));

    // Images already on disk that changed are fetched again the next time they are shown.
    for (const file of Object.keys(have)) {
      if (!tree[file]) {
        fs.rmSync(path.join(dir, file), { force: true });
        delete have[file];
      }
    }
    this.writeState(source, { commit, checked: Date.now(), tree, have });
    return true;
  }

  /**
   * Download the pages from the branch without the API's file list. Images then load from GitHub, and
   * the next check, with the API, makes everything incremental again.
   * @param {Source} source
   */
  async syncFromBranch(source) {
    const dir = this.dir(source);
    const save = async (/** @type {string} */ file) => {
      const body = Buffer.from(await (await get(rawUrl(source, source.branch, file))).arrayBuffer());
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), body);
    };
    await save("SUMMARY.md");
    const files = pageFiles(source, fs.readFileSync(path.join(dir, "SUMMARY.md"), "utf8"));
    await inParallel(files.map((file) => () => save(file)));
    // No commit, so the next check downloads the file list.
    this.writeState(source, { commit: "", checked: 0, tree: {}, have: {} });
    return true;
  }

  /**
   * A page's HTML. Images on disk use their file; the others load from GitHub and are saved for next time.
   * @param {string} id
   * @param {(file: string) => string} localUrl the panel's address for a file on disk
   */
  render(id, localUrl) {
    const page = this.index.pages[id];
    if (!page) return null;
    const source = SOURCES.find((s) => s.id === page.source);
    const built = source && this.built.get(source.id);
    const text = source && this.readText(source, page.file);
    if (!source || !built || text === null) return null;
    const state = this.state.get(source.id);
    return renderPage(source, page, text, built, (file) => {
      const sha = state?.tree[file];
      // Downloaded from the branch, without the file list: the image loads from GitHub.
      if (state && !state.commit) return rawUrl(source, source.branch, file);
      if (!sha) return null;
      const onDisk = path.join(this.dir(source), file);
      if (state?.have[file] === sha && fs.existsSync(onDisk)) return localUrl(onDisk);
      this.saveImage(source, file, sha);
      return rawUrl(source, state.commit, file);
    });
  }

  /**
   * Download an image in the background, so it shows offline next time.
   * @param {Source} source
   * @param {string} file
   * @param {string} sha
   */
  saveImage(source, file, sha) {
    const key = `${source.id}/${file}`;
    if (this.downloading.has(key)) return;
    this.downloading.add(key);
    const state = this.state.get(source.id);
    if (!state) return;
    get(rawUrl(source, state.commit, file))
      .then((r) => r.arrayBuffer())
      .then((body) => {
        const onDisk = path.join(this.dir(source), file);
        fs.mkdirSync(path.dirname(onDisk), { recursive: true });
        fs.writeFileSync(onDisk, Buffer.from(body));
        const now = this.readState(source);
        if (now.tree[file] === sha) this.writeState(source, { ...now, have: { ...now.have, [file]: sha } });
      })
      .catch(() => {})
      .finally(() => this.downloading.delete(key));
  }
}

module.exports = { Docs, CHECK_EVERY_MS };
