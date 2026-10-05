/**
 * The core file-shelf OpenCode engine plugin, shipped as source.
 *
 * Same reasoning as `lifecyclePlugin.ts`: embedding the source as a string
 * makes an npm package (a real `server/` directory) and a `bun build --compile`
 * binary (no real filesystem) one code path. The engine loads it as a normal
 * plugin (`module.exports = { id, setup }`); `setup()` registers the
 * `shelf_share` / `shelf_list` / `shelf_remove` tools and a system hint, so the
 * model can use the shelf with no extension installed.
 *
 * Install story (wired by `server/setup.ts`, reported separately): the webui
 * writes this source to `<config>/opencode/plugins/opencode-webui-shelf/`
 * next to the lifecycle plugin, marker-gated so an unrelated directory is never
 * clobbered, and removed by `opencode-webui uninstall` like the lifecycle
 * plugin. `WEBUI_NO_PLUGIN=1` skips both.
 *
 * The plugin talks to no webui code — it reads/writes the shelf directory
 * directly and returns links under the FROZEN `/api/shelf/file/` prefix (see
 * `server/shelf.ts`). Engine rules apply: an edit is picked up on engine
 * restart.
 *
 * The source deliberately avoids template literals and `${}` so it can live in
 * this TS template verbatim.
 */

export const SHELF_ENGINE_PLUGIN_ID = "opencode-webui-shelf";

export const SHELF_ENGINE_PLUGIN_SOURCE = `// opencode-webui shelf plugin
//
// Managed by opencode-webui — do not edit. (Re)written on every webui boot and
// removed by \`opencode-webui uninstall\`.
//
// Gives the model a shelf: publish a local file (or inline text) and get a link
// back, list the shelf, remove an item. The webui proxy serves these files
// read-only behind the webui login (server/shelf.ts) under /api/shelf/file/.
// Node builtins only.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ID = "opencode-webui-shelf";
const FILE_PREFIX = "/api/shelf/file/";
const PUBLIC_PREFIX = "/shared";
const PAGE_PATH = "/shelf";
const WEBUI_CONFIG = path.join(os.homedir(), ".config", "opencode", "webui", "config.json");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);

function envFirst() {
  for (var i = 0; i < arguments.length; i++) {
    var v = process.env[arguments[i]];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function rootOf(isPublic) {
  if (isPublic) {
    return envFirst("WEBUI_SHELF_PUBLIC_ROOT", "FILE_SHELF_PUBLIC_ROOT") || "/srv/hosted-public";
  }
  return envFirst("WEBUI_SHELF_ROOT", "FILE_SHELF_ROOT") || path.join(os.homedir(), "hosted");
}

function publicPrefix() {
  return envFirst("WEBUI_SHELF_PUBLIC_PREFIX", "FILE_SHELF_PUBLIC_PREFIX") || PUBLIC_PREFIX;
}

// The public shelf is OPT-IN and never served by the webui proxy.
function publicEnabled() {
  return envFirst("WEBUI_SHELF_PUBLIC_ENABLED") === "1";
}

// Refuse to read/write a shelf root that is not a DEDICATED directory.
function assertDedicated(root) {
  var real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    return; // does not exist yet; the caller creates it and we re-check
  }
  var home = os.homedir();
  var cwd = process.cwd();
  if (real === "/" || real === home || real === cwd) {
    throw new Error("shelf root must be a dedicated directory (not /, $HOME, or the repo)");
  }
  if (home.indexOf(real + path.sep) === 0) {
    throw new Error("shelf root is too broad (it contains $HOME)");
  }
}

// Where the webui is reachable from a browser: config publicUrl, else the
// configured serve port, else the production default.
function origin() {
  try {
    var cfg = JSON.parse(fs.readFileSync(WEBUI_CONFIG, "utf8"));
    if (typeof cfg.publicUrl === "string" && cfg.publicUrl.trim() !== "") {
      return cfg.publicUrl.trim().replace(/\\/+$/, "");
    }
    var port = Number(cfg.port);
    if (Number.isFinite(port) && port > 0) return "http://localhost:" + port;
  } catch (err) {
    /* no config yet — fall through */
  }
  return "http://localhost:4097";
}

function encodeRel(rel) {
  return String(rel).split("/").map(encodeURIComponent).join("/");
}

function urlFor(rel, isPublic) {
  if (isPublic) return origin() + publicPrefix() + "/" + encodeRel(rel);
  return origin() + FILE_PREFIX + encodeRel(rel);
}

function human(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return bytes + " B";
  var units = ["KB", "MB", "GB", "TB"];
  var v = bytes / 1024;
  var i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + " " + units[i];
}

// Keep a caller-supplied name to one harmless path segment.
function safeName(name) {
  var base = path.basename(String(name || ""));
  var cleaned = base.replace(/[^\\w.\\- ()]+/g, "_").replace(/^\\.+/, "");
  return cleaned !== "" ? cleaned : "file-" + Date.now();
}

// A shelf-relative path is valid when every segment is a plain name (no "..",
// no dotfiles). Mirrors the proxy stratum's rule.
function safeRel(rel) {
  var s = String(rel == null ? "" : rel).replace(/^\\/+/, "");
  if (s === "" || s.indexOf("\\0") !== -1 || s.indexOf("\\\\") !== -1) return null;
  var segs = s.split("/");
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i];
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.charAt(0) === ".") return null;
  }
  return s;
}

// Resolve a caller-supplied subfolder and confine it to the given root.
function resolveFolder(folder, root) {
  var base = path.resolve(root);
  var rel = String(folder || "").replace(/^\\/+/, "");
  var abs = path.resolve(base, rel);
  if (abs !== base && abs.indexOf(base + path.sep) !== 0) {
    throw new Error("folder escapes the shelf root");
  }
  return abs;
}

function shelfRelative(abs, root) {
  return path.relative(path.resolve(root), abs).split(path.sep).join("/");
}

// Pick a name that does not clobber an existing file unless overwrite is set.
function uniqueDest(folder, name, overwrite) {
  var dest = path.join(folder, name);
  if (overwrite || !fs.existsSync(dest)) return dest;
  var ext = path.extname(name);
  var stem = name.slice(0, name.length - ext.length);
  for (var i = 1; i < 1000; i++) {
    var candidate = path.join(folder, stem + "-" + i + ext);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(folder, stem + "-" + Date.now() + ext);
}

function expandHome(p) {
  var s = String(p);
  return s === "~" || s.indexOf("~/") === 0 ? path.join(os.homedir(), s.slice(1)) : s;
}

function walk(dir, rel, out, cap) {
  if (out.length >= cap) return;
  var entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  entries.sort(function (a, b) { return a.name.localeCompare(b.name); });
  for (var i = 0; i < entries.length; i++) {
    if (out.length >= cap) return;
    var e = entries[i];
    if (e.name.charAt(0) === ".") continue;
    var abs = path.join(dir, e.name);
    var childRel = rel === "" ? e.name : rel + "/" + e.name;
    var st;
    try { st = fs.statSync(abs); } catch (err) { continue; }
    if (st.isDirectory()) walk(abs, childRel, out, cap);
    else if (st.isFile()) out.push({ path: childRel, size: st.size, mtime: st.mtimeMs });
  }
}

function share(args) {
  var a = args || {};
  var isPublic = a.public === true;
  if (isPublic && !publicEnabled()) {
    return { output: "Error: the public shelf is disabled. Set WEBUI_SHELF_PUBLIC_ENABLED=1 to enable it." };
  }
  var root = rootOf(isPublic);
  var folder;
  try {
    folder = resolveFolder(a.folder, root);
    fs.mkdirSync(folder, { recursive: true });
    assertDedicated(root);
  } catch (err) {
    return { output: "Error: " + (err && err.message ? err.message : String(err)) };
  }

  var hasContent = typeof a.content === "string";
  var hasPath = typeof a.path === "string" && a.path.trim() !== "";
  if (!hasContent && !hasPath) {
    return { output: "Error: provide either 'path' (a local file to copy) or 'content' (inline text)." };
  }

  var src = null;
  var name;
  if (hasContent) {
    name = safeName(a.name || "note-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt");
  } else {
    src = expandHome(a.path.trim());
    var st;
    try { st = fs.statSync(src); } catch (err) { return { output: "Error: no such file: " + src }; }
    if (!st.isFile()) return { output: "Error: not a file: " + src };
    name = safeName(a.name || path.basename(src));
  }

  var dest = uniqueDest(folder, name, a.overwrite === true);
  try {
    if (hasContent) fs.writeFileSync(dest, a.content);
    else fs.copyFileSync(src, dest);
  } catch (err) {
    return { output: "Error: could not stage the file: " + (err && err.message ? err.message : String(err)) };
  }

  var rel = shelfRelative(dest, root);
  var size = NaN;
  try { size = fs.statSync(dest).size; } catch (err) { /* ignore */ }
  var kind = IMAGE_EXT.has(path.extname(dest).toLowerCase()) ? "image" : "file";
  var link = urlFor(rel, isPublic);

  return {
    output: [
      'Shared "' + rel + '" (' + kind + ", " + human(size) + ") — " +
        (isPublic ? "PUBLIC: anyone with the link" : "private: login required") + ".",
      "Link: " + link,
      isPublic
        ? "This link needs no login. It cannot be un-shared by revoking auth — delete the file to withdraw it."
        : "Browse the shelf: " + origin() + PAGE_PATH,
      "Include the link in your reply as a markdown link so it is clickable in chat.",
    ].join("\\n"),
  };
}

function list(args) {
  var a = args || {};
  var isPublic = a.public === true;
  if (isPublic && !publicEnabled()) {
    return { output: "Error: the public shelf is disabled. Set WEBUI_SHELF_PUBLIC_ENABLED=1 to enable it." };
  }
  var root = rootOf(isPublic);
  var folder;
  try {
    folder = resolveFolder(a.folder, root);
    assertDedicated(root);
  } catch (err) {
    return { output: "Error: " + (err && err.message ? err.message : String(err)) };
  }
  var items = [];
  walk(folder, "", items, 2000);
  var where = isPublic ? "public" : "private";
  if (items.length === 0) return { output: "The " + where + " shelf is empty." };
  var lines = items.map(function (it) {
    return it.path + "  (" + human(it.size) + ")  " + urlFor(it.path, isPublic);
  });
  return { output: items.length + " file(s) on the " + where + " shelf:\\n" + lines.join("\\n") };
}

function remove(args) {
  var a = args || {};
  var isPublic = a.public === true;
  if (isPublic && !publicEnabled()) {
    return { output: "Error: the public shelf is disabled. Set WEBUI_SHELF_PUBLIC_ENABLED=1 to enable it." };
  }
  var rel = safeRel(a.path);
  if (!rel) return { output: "Error: provide a valid 'path' (the shelf-relative path to remove)." };
  var root = path.resolve(rootOf(isPublic));
  try {
    assertDedicated(root);
  } catch (err) {
    return { output: "Error: " + (err && err.message ? err.message : String(err)) };
  }
  var abs = path.resolve(root, rel);
  if (abs.indexOf(root + path.sep) !== 0) {
    return { output: "Error: path escapes the shelf root." };
  }
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    return { output: 'Error: could not remove "' + rel + '": ' + (err && err.message ? err.message : String(err)) };
  }
  return { output: 'Removed "' + rel + '" from the ' + (isPublic ? "public" : "private") + " shelf." };
}

var OUTPUT_SCHEMA = { type: "object", properties: { output: { type: "string" } }, additionalProperties: true };

var PUBLIC_PROP = {
  type: "boolean",
  description:
    "true = public shelf (no login; served at " + PUBLIC_PREFIX +
    "/*; anyone with the link). Default false = private shelf behind the webui login.",
};

function systemHint() {
  var lines = [
    "File shelf (webui): publish files and get a link back.",
    "- 'shelf_share': pass 'path' to copy a local file or 'content' to write inline text. Returns a URL.",
    "- 'shelf_list' lists the shelf; 'shelf_remove' takes a file off it.",
    "- Files land in the private shelf root and are served behind the webui login at " +
      origin() + FILE_PREFIX + "<path>.",
  ];
  if (publicEnabled()) {
    lines.push(
      "- PUBLIC shares: pass 'public: true' to stage into the public shelf, served WITHOUT auth at " +
        origin() + publicPrefix() + "/<path>.",
    );
    lines.push("- Use a PUBLIC share only when the human asked for a link that works without login. Anyone with the URL can read it; the only way back is deleting the file.");
    lines.push("- Never put secrets on either shelf. The public shelf is world-readable.");
  } else {
    lines.push("- The public shelf is DISABLED on this deployment; sharing is private (login required) only.");
    lines.push("- Never put secrets on the shelf.");
  }
  lines.push("- ALWAYS include the returned link in your reply as a markdown link so it is visible and clickable in chat.");
  return lines.join("\\n");
}

async function setup(api) {
  try {
    if (api && api.session && typeof api.session.hook === "function") {
      var HINT = systemHint();
      await api.session.hook("context", function (m) {
        try {
          if (m && Array.isArray(m.system)) m.system.push({ type: "text", text: HINT });
        } catch (err) { /* hint is best-effort */ }
      });
    }
  } catch (err) { /* older engines without session.hook: the tools still work */ }

  if (!api || !api.tool || typeof api.tool.transform !== "function") return undefined;

  await api.tool.transform(function (tools) {
    tools.add({
      name: "shelf_share",
      description:
        "Publish a file to the webui file shelf and get a link. Pass 'path' to copy a local file, or " +
        "'content' to write inline text. Default is PRIVATE (login required). With 'public: true' the file " +
        "is served without auth under the public prefix for anyone with the link. Returns the URL to include in your reply.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Local file to copy onto the shelf (supports ~)." },
          content: { type: "string", description: "Inline text to write onto the shelf (alternative to 'path')." },
          name: { type: "string", description: "File name to use (defaults to the source basename, or a timestamped .txt for inline content)." },
          folder: { type: "string", description: "Optional subfolder inside the shelf." },
          overwrite: { type: "boolean", description: "Overwrite an existing file of the same name (default false: a -1, -2 suffix is added)." },
          public: PUBLIC_PROP,
        },
        required: [],
        additionalProperties: false,
      },
      output: OUTPUT_SCHEMA,
      execute: async function (args) { return share(args); },
    });

    tools.add({
      name: "shelf_list",
      description: "List the files on the webui file shelf, with their sizes and links.",
      input: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Optional subfolder to list instead of the whole shelf." },
          public: PUBLIC_PROP,
        },
        required: [],
        additionalProperties: false,
      },
      output: OUTPUT_SCHEMA,
      execute: async function (args) { return list(args); },
    });

    tools.add({
      name: "shelf_remove",
      description: "Remove a file from the webui file shelf by its shelf-relative path.",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "Shelf-relative path to remove, e.g. \\"notes/readme.md\\"." },
          public: PUBLIC_PROP,
        },
        required: ["path"],
        additionalProperties: false,
      },
      output: OUTPUT_SCHEMA,
      execute: async function (args) { return remove(args); },
    });
  });

  return undefined;
}

module.exports = { id: ID, setup };
`;

export const SHELF_ENGINE_PLUGIN_PACKAGE_JSON = `{
  "name": "opencode-webui-shelf",
  "private": true,
  "main": "index.js",
  "description": "File-shelf tools (shelf_share / shelf_list / shelf_remove) for opencode-webui. Managed by opencode-webui."
}
`;
