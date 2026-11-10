// @ts-check
// The YAMS and YAGSL docs: downloaded from their GitHub repos, kept in the extension's storage, and
// kept up to date. Nothing about the tutorials is built into the extension.
//
// On disk, each library has a folder (<extension storage>/docs/<yams|yagsl>/) laid out like its repo,
// holding SUMMARY.md, the pages that are shown, and the images that have been shown. state.json
// there records:
//
//   - commit: the docs commit the files on disk come from,
//   - tree:   every file's git blob hash at that commit (from GitHub's file list),
//   - have:   the hash of each file on disk.
//
// sync() updates a library when its last check is more than 12 hours old, or right away with Refresh:
//
//   1. Ask GitHub for the branch's latest commit (api.github.com, one small request). The same commit
//      as last time means nothing to do.
//   2. Get that commit's file list with blob hashes.
//   3. Download SUMMARY.md and the shown pages whose hash changed, from raw.githubusercontent.com.
//   4. Build the tutorial tree again (load()), and fire onDidChange.
//
// Images are downloaded as they are first shown (saveImage()); until then they load from GitHub. A
// failure keeps the docs on disk, so the tutorials keep working offline. If GitHub's API refuses
// (it allows few requests per network, which a classroom can use up) and nothing is on disk yet, the
// pages come straight from the branch instead (syncFromBranch()), and the next check makes updates
// incremental again.
//
// render(id) gives a page's HTML, from render.js. Which pages are shown is SOURCES in render.js.

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
 * Download from GitHub, giving up after 20 seconds. Throws when GitHub answers with an error.
 * @param {string} url
 * @param {Record<string, string>} [headers] such as { Accept: "application/vnd.github.sha" }.
 * @returns {Promise<Response>}
 * @example
 * const commit = await (await get("https://api.github.com/repos/Yet-Another-Software-Suite/YAMS-Gitbook/commits/main",
 *   { Accept: "application/vnd.github.sha" })).text();
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
 * Run the jobs a few at a time (PARALLEL), so a library's pages download quickly without flooding
 * the network.
 * @param {(() => Promise<void>)[]} jobs
 * @example
 * await inParallel(files.map((file) => () => download(file)));
 */
async function inParallel(jobs) {
  let next = 0;
  /**
   * Take the next job until none are left.
   * @example
   * await Promise.all([worker(), worker()]);
   */
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
}

/**
 * The address of a file in a docs repo at a commit or branch, on raw.githubusercontent.com.
 * @example
 * rawUrl(source, "main", ".gitbook/assets/arm.gif");
 * // "https://raw.githubusercontent.com/Yet-Another-Software-Suite/YAMS-Gitbook/main/.gitbook/assets/arm.gif"
 */
const rawUrl = (/** @type {Source} */ source, /** @type {string} */ ref, /** @type {string} */ file) =>
  `https://raw.githubusercontent.com/${source.github}/${ref}/${file.split("/").map(encodeURIComponent).join("/")}`;

/**
 * The YAMS and YAGSL docs, on disk and kept up to date.
 * @example
 * const docs = new Docs(context.globalStorageUri);
 * docs.load(); // the tutorials on disk, at once
 * docs.onDidChange(() => tree.setIndex(docs.index));
 * await docs.sync(); // anything new from GitHub
 */
class Docs {
  /**
   * @param {vscode.Uri} storage the extension's storage folder; the docs go in its docs folder.
   * @example
   * const docs = new Docs(context.globalStorageUri);
   */
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

  /**
   * A library's folder on disk.
   * @param {Source} source
   * @example
   * this.dir(SOURCES[0]); // ".../globalStorage/yass-robotics.yass-tutorials/docs/yams"
   */
  dir(source) {
    return path.join(this.root, source.id);
  }

  /**
   * A library's state.json: the commit on disk, when it was last checked, and every file's hash.
   * Empty when nothing is downloaded yet.
   * @param {Source} source
   * @returns {SourceState}
   * @example
   * this.readState(source).commit; // "eb77fea..."
   */
  readState(source) {
    try {
      return /** @type {SourceState} */ (JSON.parse(fs.readFileSync(path.join(this.dir(source), "state.json"), "utf8")));
    } catch {
      return { commit: "", checked: 0, tree: {}, have: {} };
    }
  }

  /**
   * Save a library's state.json.
   * @param {Source} source
   * @param {SourceState} state
   * @example
   * this.writeState(source, { ...state, checked: Date.now() });
   */
  writeState(source, state) {
    fs.mkdirSync(this.dir(source), { recursive: true });
    fs.writeFileSync(path.join(this.dir(source), "state.json"), JSON.stringify(state));
    this.state.set(source.id, state);
  }

  /**
   * A file of a library's docs as it is on disk.
   * @param {Source} source
   * @param {string} file the file's path in the repo, such as "SUMMARY.md".
   * @returns {string | null} its text, or null when it is not on disk.
   * @example
   * const summary = this.readText(source, "SUMMARY.md");
   */
  readText(source, file) {
    try {
      return fs.readFileSync(path.join(this.dir(source), file), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Whether any tutorials are on disk to show.
   * @example
   * if (!docs.ready) setDocsState("loading");
   */
  get ready() {
    return this.index.sources.length > 0;
  }

  /**
   * Which docs commit each library is at.
   * @returns {string}
   * @example
   * docs.describe(); // "YAMS eb77fea, YAGSL 0330556"
   */
  describe() {
    return SOURCES.filter((s) => this.state.get(s.id)?.commit)
      .map((s) => `${s.name} ${this.state.get(s.id)?.commit.slice(0, 7)}`)
      .join(", ");
  }

  /**
   * Build the tutorial tree from what is on disk, into index. Doesn't download anything.
   * @example
   * docs.load();
   * docs.index.pages["yams/tutorials/arm"].title; // "Arm"
   */
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
   * Download what changed since the last check, then load() and fire onDidChange if anything did.
   * Only one runs at a time; calling it while one runs returns that one. Failures keep the docs on disk.
   * @param {{ force?: boolean }} [options] force checks every library now, even ones checked in the last 12 hours.
   * @returns {Promise<{ changed: boolean, failed: string[] }>}
   * @example
   * const { changed, failed } = await docs.sync({ force: true });
   * if (failed.length) console.log(`Couldn't update ${failed.join(" and ")}`);
   */
  sync(options = {}) {
    if (!this.syncing) {
      this.syncing = this.doSync(options).finally(() => (this.syncing = undefined));
    }
    return this.syncing;
  }

  /**
   * The work of sync(): check each library that is due.
   * @param {{ force?: boolean }} options
   * @example
   * // Use sync() instead, so two checks never run at once.
   * await this.doSync({ force: true });
   */
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
   * Update one library: ask GitHub for the branch's commit, and if it is new, download the file list
   * and every shown page whose hash changed. Falls back to syncFromBranch() when GitHub's API refuses
   * and nothing is on disk yet.
   * @param {Source} source
   * @param {SourceState} state the library's state on disk.
   * @returns {Promise<boolean>} whether anything changed.
   * @example
   * const changed = await this.syncSource(source, this.readState(source));
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
    /**
     * Download one file of the docs at the commit, unless the one on disk has the same hash.
     * @example
     * await download("tutorials/arm/motor-controller.md");
     */
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
   * Download the pages straight from the branch, without GitHub's API. Used when the API refuses and
   * nothing is on disk yet. Images then load from GitHub, and the next check, with the API, makes
   * updates incremental again.
   * @param {Source} source
   * @returns {Promise<boolean>} true, since the pages were downloaded.
   * @example
   * await this.syncFromBranch(source);
   */
  async syncFromBranch(source) {
    const dir = this.dir(source);
    /**
     * Download one file of the docs from the branch.
     * @example
     * await save("SUMMARY.md");
     */
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
   * A page's HTML. Images on disk use their file; the others load from GitHub and are saved for next
   * time (saveImage()).
   * @param {string} id the page's id.
   * @param {(file: string) => string} localUrl the panel's address for a file on disk.
   * @returns {string | null} the HTML, or null when the page is not on disk.
   * @example
   * const html = docs.render("yams/tutorials/arm/motor-controller",
   *   (file) => webview.asWebviewUri(vscode.Uri.file(file)).toString());
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
   * Download an image in the background, so it shows offline from then on. Each image downloads once.
   * @param {Source} source
   * @param {string} file the image's path in the repo, such as ".gitbook/assets/arm.gif".
   * @param {string} sha its blob hash, recorded once it is saved.
   * @example
   * this.saveImage(source, ".gitbook/assets/arm.gif", state.tree[".gitbook/assets/arm.gif"]);
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
