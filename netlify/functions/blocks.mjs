// Renders a Standard.site document written in Leaflet's block format (pub.leaflet.content) as HTML.
//
// Reviews published by newer versions of Resenha use this format, which Leaflet, Sill and WordPress also read.
// Everything third-party loads only on request: Bluesky posts are drawn here on the server from the public
// directory, and players (YouTube, Spotify and the like) sit behind a card until the reader taps them.

const APPVIEW = "https://public.api.bsky.app";

/** HTML for the document's content. `images(cid)` gives the address a blob of the author's is served from. */
export async function renderBlocks(content, { images, pds, did }) {
  const pages = await pagesOf(content, pds, did);
  const ctx = { images, posts: await fetchPosts(collectPostURIs(pages)) };
  const out = [];
  for (const page of pages) {
    for (const wrapper of page?.blocks ?? []) {
      const html = renderBlock(wrapper?.block, ctx);
      if (html) out.push(html);
    }
  }
  return out.join("\n");
}

/** The plain text of the content, for excerpts, when the document carries no textContent. */
export function blocksPlainText(content) {
  const out = [];
  for (const page of Array.isArray(content?.pages) ? content.pages : []) {
    for (const wrapper of page?.blocks ?? []) {
      const b = wrapper?.block;
      if (typeof b?.plaintext === "string") out.push(b.plaintext);
      for (const item of b?.children ?? []) if (typeof item?.content?.plaintext === "string") out.push(item.content.plaintext);
    }
  }
  return out.join("\n\n");
}

/** Large documents keep their pages in a blob the record points at; the inline pages are then a stub. */
async function pagesOf(content, pds, did) {
  const ref = content?.blobPages?.ref?.$link;
  if (ref && pds && did) {
    try {
      const res = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(ref)}`);
      if (res.ok) {
        const pages = await res.json();
        if (Array.isArray(pages)) return pages;
      }
    } catch {
      // Fall through to whatever is inline.
    }
  }
  return Array.isArray(content?.pages) ? content.pages : [];
}

// MARK: - Blocks

function renderBlock(block, ctx) {
  const type = typeof block?.$type === "string" ? block.$type.split(".").pop() : "";
  switch (type) {
    case "text":
      return `<p${block.textSize === "small" ? ' class="small"' : block.textSize === "large" ? ' class="large"' : ""}>${richText(block)}</p>`;
    case "header": {
      // The page's own h1 is the review title; the document's headings start one level down.
      const level = Math.min(6, Math.max(2, (Number(block.level) || 1) + 1));
      return `<h${level}>${richText(block)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote><p>${richText(block)}</p></blockquote>`;
    case "unorderedList":
      return list(block, false);
    case "orderedList":
      return list(block, true);
    case "code":
      return codeFrame(block.plaintext ?? "", block.language);
    case "math":
      return codeFrame(block.tex ?? "", "latex");
    case "horizontalRule":
      return "<hr>";
    case "image":
      return figure(block, ctx);
    case "imageGallery":
      return `<div class="gallery">${(block.images ?? []).map((image) => figure(image, ctx, true)).join("")}</div>`;
    case "website":
      return websiteCard(block, ctx);
    case "bskyPost":
      return postCard(block, ctx);
    case "iframe":
      return player(block);
    case "html":
      // Someone else's HTML runs only inside a sandbox with no scripts, no forms and no access to this page.
      return `<iframe class="html-block" sandbox="" srcdoc="${escapeAttr(block.html ?? "")}" style="${frameSize(block)}" loading="lazy"></iframe>`;
    case "button":
      return safeHref(block.url) ? `<p><a class="button" href="${escapeAttr(safeHref(block.url))}" rel="nofollow ugc noopener">${escape(block.text ?? "")}</a></p>` : "";
    case "drawing":
      return drawing(block);
    case "standardSitePost":
    case "standardSitePublication":
      return atLink(block.uri);
    default:
      // Leaflet's own furniture (polls, sign-up boxes, nested pages, canvases) has no place in a review.
      return "";
  }
}

function list(block, ordered) {
  const items = (block.children ?? []).map((item) => {
    const content = item?.content ? renderBlock(item.content, listCtx) : "";
    const check = typeof item?.checked === "boolean" ? `<span class="check" aria-hidden="true">${item.checked ? "☑" : "☐"}</span> ` : "";
    // A nested list of the same kind is the item's children; one of the other kind is a whole list block.
    const nested = item?.children?.length
      ? list({ children: item.children }, ordered)
      : item?.orderedListChildren?.children?.length
        ? list(item.orderedListChildren, true)
        : item?.unorderedListChildren?.children?.length
          ? list(item.unorderedListChildren, false)
          : "";
    return `<li${typeof item?.checked === "boolean" ? ' class="task"' : ""}>${check}${content.replace(/^<p>|<\/p>$/g, "")}${nested}</li>`;
  });
  const start = ordered && Number(block.startIndex) > 1 ? ` start="${Number(block.startIndex)}"` : "";
  return ordered ? `<ol${start}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
}
// Items in a list hold text, headings or images, none of which need the post or image context mid-list.
const listCtx = { images: () => "", posts: new Map() };

function figure(image, ctx, inGallery = false) {
  const cid = image?.image?.ref?.$link;
  if (!cid) return "";
  const src = ctx.images(cid);
  const ratio = image.aspectRatio?.width > 0 && image.aspectRatio?.height > 0 ? ` style="aspect-ratio:${Number(image.aspectRatio.width)}/${Number(image.aspectRatio.height)}"` : "";
  const width = !inGallery && Number(image.width) > 0 ? ` style="max-width:min(100%,${Number(image.width)}px)"` : "";
  const classes = [image.fullBleed ? "bleed" : "", inGallery ? "" : "image"].filter(Boolean).join(" ");
  return `<figure class="${classes}"${width}><img src="${escapeAttr(src)}" alt="${escapeAttr(image.alt ?? "")}" loading="lazy" decoding="async"${ratio}></figure>`;
}

function websiteCard(block, ctx) {
  const href = safeHref(block.src);
  if (!href) return "";
  const host = hostOf(href);
  const cid = block.previewImage?.ref?.$link;
  const preview = cid ? `<img class="card-preview" src="${escapeAttr(ctx.images(cid))}" alt="" loading="lazy">` : "";
  return `<a class="card" href="${escapeAttr(href)}" rel="nofollow ugc noopener">${preview}<span class="card-body"><strong>${escape(block.title || host)}</strong>${block.description ? `<span class="card-desc">${escape(block.description)}</span>` : ""}<span class="card-host">${escape(host)}</span></span></a>`;
}

/** A Bluesky post, drawn here from the public directory: author, text, pictures and link card, linking to Bluesky. */
function postCard(block, ctx) {
  const uri = block.postRef?.uri;
  const post = uri ? ctx.posts.get(uri) : null;
  if (!post) {
    const href = uri ? blueskyURL(uri) : null;
    return href ? `<a class="card" href="${escapeAttr(href)}" rel="nofollow noopener"><span class="card-body"><strong>A post on Bluesky</strong><span class="card-host">bsky.app</span></span></a>` : "";
  }
  const author = post.author ?? {};
  const name = author.displayName?.trim() || `@${author.handle ?? ""}`;
  const date = post.record?.createdAt ? new Date(post.record.createdAt) : null;
  const avatar = author.avatar ? `<img class="post-avatar" src="${escapeAttr(author.avatar)}" alt="">` : `<span class="post-avatar placeholder">${escape(name.replace(/^@/, "").slice(0, 1).toUpperCase())}</span>`;
  const text = escape(post.record?.text ?? "").replace(/\n/g, "<br>");
  return `<a class="post" href="${escapeAttr(blueskyURL(post.uri, author.handle))}" rel="nofollow noopener">
      <span class="post-head">${avatar}<span><strong>${escape(name)}</strong><span class="post-handle">@${escape(author.handle ?? "")}</span></span>${date ? `<time datetime="${date.toISOString()}">${escape(date.toLocaleDateString("en", { dateStyle: "medium" }))}</time>` : ""}</span>
      <span class="post-text">${text}</span>${postEmbed(post.embed)}
    </a>`;
}

function postEmbed(embed) {
  if (!embed?.$type) return "";
  if (embed.$type.startsWith("app.bsky.embed.images")) {
    const imgs = (embed.images ?? []).slice(0, 4).map((i) => `<img src="${escapeAttr(i.thumb)}" alt="${escapeAttr(i.alt ?? "")}" loading="lazy">`).join("");
    return imgs ? `<span class="post-images n${Math.min(4, embed.images.length)}">${imgs}</span>` : "";
  }
  if (embed.$type.startsWith("app.bsky.embed.external") && embed.external) {
    const e = embed.external;
    return `<span class="post-link">${e.thumb ? `<img src="${escapeAttr(e.thumb)}" alt="" loading="lazy">` : ""}<span><strong>${escape(e.title ?? "")}</strong><span class="card-host">${escape(hostOf(e.uri ?? ""))}</span></span></span>`;
  }
  if (embed.$type.startsWith("app.bsky.embed.recordWithMedia")) return postEmbed(embed.media);
  return "";
}

/** A player (YouTube, Vimeo, Spotify, Apple Music…) behind a card, loaded only when the reader asks. */
function player(block) {
  const href = safeHref(block.url);
  if (!href) return "";
  const host = hostOf(href);
  const known = provider(href);
  const youtube = youtubeID(href);
  const thumb = youtube ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(youtube)}/hqdefault.jpg" alt="" loading="lazy">` : "";
  return `<div class="embed" data-src="${escapeAttr(href)}" style="${frameSize(block)}">${thumb}<button type="button" class="embed-load"><span class="embed-play" aria-hidden="true"></span><span>Load from ${escape(known || host)}</span></button><a class="embed-open" href="${escapeAttr(href)}" rel="nofollow ugc noopener">Open on ${escape(known || host)}</a></div>`;
}

function provider(href) {
  const h = hostOf(href);
  if (/youtube(-nocookie)?\.com$|youtu\.be$/.test(h)) return "YouTube";
  if (/vimeo\.com$/.test(h)) return "Vimeo";
  if (/bilibili\.com$/.test(h)) return "Bilibili";
  if (/spotify\.com$/.test(h)) return "Spotify";
  if (/music\.apple\.com$/.test(h)) return "Apple Music";
  if (/soundcloud\.com$/.test(h)) return "SoundCloud";
  if (/bandcamp\.com$/.test(h)) return "Bandcamp";
  return null;
}

function youtubeID(href) {
  try {
    const u = new URL(href);
    if (/youtu\.be$/.test(u.hostname)) return u.pathname.slice(1).split("/")[0] || null;
    if (/youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const embedded = u.pathname.match(/^\/embed\/([\w-]{6,})/);
      if (embedded) return embedded[1];
      return u.searchParams.get("v");
    }
  } catch {
    return null;
  }
  return null;
}

function frameSize(block) {
  const r = block?.aspectRatio;
  if (r?.width > 0 && r?.height > 0) return `aspect-ratio:${Number(r.width)}/${Number(r.height)}`;
  const h = Number(block?.height);
  return `height:${h >= 16 && h <= 1600 ? h : 360}px`;
}

/** Freehand strokes as vectors, each stroke a round-capped path of its base width. */
function drawing(block) {
  const v = block.viewBox;
  if (!(v?.width > 0 && v?.height > 0)) return "";
  const color = (c) => (c === "primary" ? "currentColor" : c === "accent" ? "var(--accent)" : c === "tertiary" ? "var(--ink3)" : /^#[0-9a-f]{3,8}$/i.test(c ?? "") ? c : "currentColor");
  const fills = (block.fills ?? []).map((f) => {
    const pts = pairs(f.points, 2).map(([x, y]) => `${x},${y}`).join(" ");
    return pts ? `<polygon points="${pts}" fill="${color(f.color)}" fill-rule="nonzero"/>` : "";
  });
  const strokes = (block.strokes ?? []).map((s) => {
    const pts = pairs(s.points, 3).map(([x, y]) => `${x},${y}`).join(" ");
    return pts ? `<polyline points="${pts}" fill="none" stroke="${color(s.color)}" stroke-width="${Math.max(1, Number(s.size) || 1)}" stroke-linecap="round" stroke-linejoin="round"/>` : "";
  });
  return `<svg class="drawing" viewBox="${Number(v.x) || 0} ${Number(v.y) || 0} ${Number(v.width)} ${Number(v.height)}" role="img" aria-label="Drawing">${fills.join("")}${strokes.join("")}</svg>`;
}

function pairs(flat, size) {
  const out = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += size) out.push([Number(flat[i]), Number(flat[i + 1])]);
  return out;
}

function atLink(uri) {
  if (typeof uri !== "string" || !uri.startsWith("at://")) return "";
  const [, did] = uri.split("/").filter(Boolean);
  const href = `https://leaflet.pub/lish/${encodeURIComponent(did)}`;
  return `<a class="card" href="${escapeAttr(href)}" rel="nofollow noopener"><span class="card-body"><strong>A post on the Atmosphere</strong><span class="card-host">leaflet.pub</span></span></a>`;
}

// MARK: - Code

/* Code as an editor shows it: a bar with the language and a copy button, numbered lines, and colour for keywords,
 * strings, numbers, comments, types and calls. The same small lexer as the app's, so both readers agree. */
const C_FAMILY = ["if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return", "goto", "struct", "union", "enum", "typedef", "static", "const", "extern", "inline", "void", "int", "char", "float", "double", "long", "short", "unsigned", "signed", "bool", "true", "false", "sizeof", "NULL", "nullptr"];
const JS_KEYWORDS = ["const", "let", "var", "function", "class", "extends", "return", "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "new", "this", "super", "import", "export", "from", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "async", "await", "yield", "static", "get", "set", "delete", "void", "with", "as", "constructor"];
const lang = (name, keywords, extra = {}) => ({ name, keywords: new Set(keywords), lineComments: ["//"], blockComment: ["/*", "*/"], quotes: ['"', "'"], capitalisedTypes: true, attributeMarks: ["@"], caseInsensitive: false, ...extra });
const LANGUAGES = {
  swift: lang("Swift", ["let", "var", "func", "class", "struct", "enum", "protocol", "extension", "import", "if", "else", "guard", "switch", "case", "default", "for", "while", "repeat", "in", "return", "break", "continue", "fallthrough", "throw", "throws", "rethrows", "try", "catch", "do", "defer", "init", "deinit", "self", "Self", "super", "static", "final", "private", "public", "internal", "fileprivate", "open", "override", "mutating", "nonmutating", "async", "await", "actor", "where", "is", "as", "nil", "true", "false", "some", "any", "typealias", "associatedtype", "inout", "lazy", "weak", "unowned", "subscript", "operator", "precedencegroup", "indirect", "convenience", "required", "dynamic", "optional", "get", "set", "willSet", "didSet", "macro"]),
  javascript: lang("JavaScript", JS_KEYWORDS),
  typescript: lang("TypeScript", [...JS_KEYWORDS, "interface", "type", "enum", "implements", "readonly", "declare", "namespace", "abstract", "public", "private", "protected", "keyof", "satisfies"]),
  python: lang("Python", ["def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "None", "True", "False", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "pass", "break", "continue", "yield", "global", "nonlocal", "async", "await", "del", "assert", "match", "case", "self"], { lineComments: ["#"], blockComment: null }),
  ruby: lang("Ruby", ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "self", "nil", "true", "false", "and", "or", "not", "then", "when", "case", "require", "include", "extend", "attr_accessor", "attr_reader", "lambda", "proc"], { lineComments: ["#"], blockComment: null }),
  go: lang("Go", ["package", "import", "func", "var", "const", "type", "struct", "interface", "map", "chan", "go", "defer", "if", "else", "for", "range", "switch", "case", "default", "select", "return", "break", "continue", "fallthrough", "goto", "nil", "true", "false", "make", "new", "len", "cap", "append", "error", "string", "int", "int64", "float64", "bool", "byte", "rune"]),
  rust: lang("Rust", ["fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "for", "in", "while", "loop", "if", "else", "match", "return", "break", "continue", "pub", "crate", "mod", "use", "as", "where", "self", "Self", "super", "ref", "move", "dyn", "unsafe", "async", "await", "type", "true", "false", "Some", "None", "Ok", "Err", "String", "Vec", "Option", "Result", "Box"], { attributeMarks: ["#"] }),
  kotlin: lang("Kotlin", ["fun", "val", "var", "class", "object", "interface", "data", "sealed", "open", "override", "abstract", "private", "public", "internal", "protected", "if", "else", "when", "for", "while", "do", "in", "is", "as", "return", "break", "continue", "try", "catch", "finally", "throw", "null", "true", "false", "this", "super", "import", "package", "suspend", "lateinit", "companion", "by", "get", "set"]),
  java: lang("Java", [...C_FAMILY, "class", "interface", "extends", "implements", "public", "private", "protected", "abstract", "final", "new", "this", "super", "import", "package", "try", "catch", "finally", "throw", "throws", "instanceof", "null", "boolean", "byte", "var", "record", "sealed", "permits", "synchronized", "volatile"]),
  c: lang("C", C_FAMILY, { attributeMarks: ["#"] }),
  cpp: lang("C++", [...C_FAMILY, "class", "namespace", "using", "template", "typename", "new", "delete", "this", "virtual", "public", "private", "protected", "try", "catch", "throw", "auto", "constexpr", "override", "final", "std"], { attributeMarks: ["#"] }),
  csharp: lang("C#", [...C_FAMILY, "class", "namespace", "using", "new", "this", "base", "virtual", "override", "public", "private", "protected", "internal", "try", "catch", "finally", "throw", "var", "string", "async", "await", "foreach", "in", "is", "as", "null", "get", "set", "record", "interface"], { attributeMarks: ["#"] }),
  objc: lang("Objective-C", [...C_FAMILY, "self", "super", "nil", "YES", "NO", "id", "instancetype", "interface", "implementation", "property", "end", "import", "synthesize", "selector", "class", "protocol", "try", "catch", "finally", "throw"], { attributeMarks: ["@", "#"] }),
  php: lang("PHP", ["function", "class", "public", "private", "protected", "static", "return", "if", "else", "elseif", "foreach", "for", "while", "echo", "new", "null", "true", "false", "array", "use", "namespace", "require", "include", "try", "catch", "throw", "fn", "match", "abstract", "interface", "extends", "implements"], { lineComments: ["//", "#"] }),
  shell: lang("Shell", ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function", "return", "export", "local", "echo", "cd", "ls", "sudo", "brew", "npm", "git", "xcodebuild", "cat", "grep", "curl", "source", "exit", "set", "read"], { lineComments: ["#"], blockComment: null, capitalisedTypes: false, attributeMarks: [] }),
  sql: lang("SQL", ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "as", "and", "or", "not", "null", "is", "in", "exists", "between", "like", "distinct", "count", "sum", "avg", "min", "max", "with", "union", "primary", "key", "references", "index", "returning", "case", "when", "then", "else", "end"], { lineComments: ["--"], capitalisedTypes: false, attributeMarks: [], caseInsensitive: true }),
  json: lang("JSON", ["true", "false", "null"], { lineComments: [], blockComment: null, quotes: ['"'], capitalisedTypes: false, attributeMarks: [] }),
  yaml: lang("YAML", ["true", "false", "null", "yes", "no"], { lineComments: ["#"], blockComment: null, capitalisedTypes: false, attributeMarks: [] }),
  css: lang("CSS", ["important", "media", "import", "font-face", "keyframes", "supports"], { lineComments: [], capitalisedTypes: false }),
  html: lang("HTML", ["html", "head", "body", "div", "span", "p", "a", "img", "ul", "ol", "li", "h1", "h2", "h3", "h4", "section", "article", "nav", "header", "footer", "main", "script", "style", "link", "meta", "title", "button", "input", "form", "table", "tr", "td", "th", "svg", "path"], { lineComments: [], blockComment: ["<!--", "-->"], capitalisedTypes: false, attributeMarks: [] }),
  markdown: lang("Markdown", [], { lineComments: [], blockComment: null, quotes: [], capitalisedTypes: false, attributeMarks: ["#"] }),
  latex: lang("LaTeX", [], { lineComments: ["%"], blockComment: null, quotes: [], capitalisedTypes: false, attributeMarks: ["\\"] }),
};
const LANGUAGE_ALIASES = { js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript", ts: "typescript", tsx: "typescript", py: "python", python3: "python", rb: "ruby", golang: "go", rs: "rust", kt: "kotlin", kts: "kotlin", "c++": "cpp", cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp", cs: "csharp", "c#": "csharp", "objective-c": "objc", objectivec: "objc", m: "objc", sh: "shell", bash: "shell", zsh: "shell", fish: "shell", console: "shell", terminal: "shell", yml: "yaml", htm: "html", xml: "html", svg: "html", scss: "css", less: "css", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql", md: "markdown", tex: "latex" };

function languageFor(name, code) {
  if (typeof name === "string" && name.trim()) {
    const key = name.trim().toLowerCase();
    return { language: LANGUAGES[LANGUAGE_ALIASES[key] ?? key] ?? null, label: LANGUAGES[LANGUAGE_ALIASES[key] ?? key]?.name ?? name.trim() };
  }
  const detected = detectLanguage(code);
  return { language: detected, label: detected?.name ?? "Code" };
}

function detectLanguage(code) {
  const sample = String(code).slice(0, 4000);
  const has = (pattern) => new RegExp(pattern, "m").test(sample);
  if (has("^\\s*[\\[{]") && has("\"\\s*:") && !has("\\b(func|def|function|let|var|const)\\b")) return LANGUAGES.json;
  if (has("\\b(func|let|var|guard)\\b") && has("\\b(func|guard|struct|protocol|extension)\\b")) return LANGUAGES.swift;
  if (has("^\\s*(def|class) \\w+.*:\\s*$") && !has("[{};]\\s*$")) return LANGUAGES.python;
  if (has("\\b(import|from)\\b.*\\n") && has("^\\s*def ")) return LANGUAGES.python;
  if (has("\\b(const|let|var|function)\\b") && has("=>|console\\.|require\\(|import .* from")) return LANGUAGES.javascript;
  if (has("\\bfunc \\w+\\(.*\\) .*\\{") && has("\\bpackage \\w+|:= ")) return LANGUAGES.go;
  if (has("\\bfn \\w+\\(|\\blet mut\\b|impl |pub fn")) return LANGUAGES.rust;
  if (has("\\bfun \\w+\\(|\\bval \\w+")) return LANGUAGES.kotlin;
  if (has("\\bpublic (static )?(class|void)\\b|System\\.out")) return LANGUAGES.java;
  if (has("#include\\b|\\bstd::|printf\\(")) return LANGUAGES.cpp;
  if (has("^\\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\\b") && has("\\bFROM\\b|\\bINTO\\b|\\bTABLE\\b")) return LANGUAGES.sql;
  if (has("^\\s*(\\$ |#!/bin/|sudo |brew |npm |git )")) return LANGUAGES.shell;
  if (has("^\\s*<[a-zA-Z!]") && has("</\\w+>|/>")) return LANGUAGES.html;
  if (has("^\\s*[.#]?[\\w-]+\\s*\\{[^}]*:[^}]*\\}")) return LANGUAGES.css;
  if (has("^\\s*def \\w+|\\bend\\s*$|\\bputs\\b")) return LANGUAGES.ruby;
  return null;
}

/** The code as [text, kind] pieces: keyword, string, number, comment, type, function, attribute or plain. */
function tokenize(code, language) {
  if (!language) return [[code, "plain"]];
  const chars = Array.from(code);
  const tokens = [];
  let i = 0;
  const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);
  const matches = (marker) => chars.slice(i, i + marker.length).join("") === marker;
  const push = (end, kind) => { tokens.push([chars.slice(i, end).join(""), kind]); i = end; };
  while (i < chars.length) {
    const ch = chars[i];
    const lineComment = language.lineComments.find(matches);
    if (lineComment) {
      let end = i;
      while (end < chars.length && chars[end] !== "\n") end++;
      push(end, "comment");
      continue;
    }
    if (language.blockComment && matches(language.blockComment[0])) {
      const close = language.blockComment[1];
      let end = i + language.blockComment[0].length;
      while (end < chars.length) {
        if (chars.slice(end, end + close.length).join("") === close) { end += close.length; break; }
        end++;
      }
      push(end, "comment");
      continue;
    }
    if (language.quotes.includes(ch)) {
      const triple = matches(ch.repeat(3));
      let end = i + (triple ? 3 : 1);
      while (end < chars.length) {
        if (chars[end] === "\\") { end += 2; continue; }
        if (triple) {
          if (chars[end] === ch && chars[end + 1] === ch && chars[end + 2] === ch) { end += 3; break; }
        } else if (chars[end] === ch) { end++; break; } else if (chars[end] === "\n") { break; }
        end++;
      }
      push(end, "string");
      continue;
    }
    if (/\p{N}/u.test(ch) || (ch === "." && /[0-9]/.test(chars[i + 1] ?? "") && (i === 0 || !isWord(chars[i - 1])))) {
      let end = i + 1;
      while (end < chars.length && (/[0-9a-fA-F_.xXob]/.test(chars[end]) || ((chars[end] === "+" || chars[end] === "-") && /[eE]/.test(chars[end - 1])))) end++;
      push(end, "number");
      continue;
    }
    if (language.attributeMarks.includes(ch) && /\p{L}/u.test(chars[i + 1] ?? "")) {
      let end = i + 1;
      while (end < chars.length && (isWord(chars[end]) || chars[end] === ".")) end++;
      push(end, "attribute");
      continue;
    }
    if (/\p{L}/u.test(ch) || ch === "_" || ch === "$") {
      let end = i + 1;
      while (end < chars.length && isWord(chars[end])) end++;
      const word = chars.slice(i, end).join("");
      let kind;
      if (language.keywords.has(language.caseInsensitive ? word.toLowerCase() : word)) kind = "keyword";
      else if (language.capitalisedTypes && /^\p{Lu}/u.test(word) && word.length > 1 && /\p{Ll}/u.test(word)) kind = "type";
      else {
        let probe = end;
        while (probe < chars.length && chars[probe] === " ") probe++;
        kind = chars[probe] === "(" ? "function" : "plain";
      }
      push(end, kind);
      continue;
    }
    push(i + 1, "plain");
  }
  return tokens;
}

/** A code block as an editor frame: language bar, copy button, numbered coloured lines. */
export function codeFrame(code, languageName) {
  const text = String(code ?? "").replace(/\n+$/, "");
  const { language, label } = languageFor(languageName, text);
  const lines = [""];
  for (const [piece, kind] of tokenize(text, language)) {
    const parts = piece.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push("");
      if (!part) return;
      lines[lines.length - 1] += kind === "plain" ? escape(part) : `<span class="tk-${kind}">${escape(part)}</span>`;
    });
  }
  const body = lines.map((line, index) => `<span class="ln">${index + 1}</span><span class="lc">${line || " "}</span>`).join("\n");
  return `<div class="codeblock"><div class="code-bar"><span class="code-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="code-lang">${escape(label)}</span><button type="button" class="code-copy">Copy</button></div><pre class="code-lines"><code>${body}</code></pre></div>`;
}

/** Frames the code blocks Markdown produced, so both formats read the same. */
export function frameMarkdownCode(html) {
  return html.replace(/<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (_, language, body) => {
    const decoded = body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return codeFrame(decoded, language);
  });
}

// MARK: - Rich text

/** Plain text with facets, as HTML. Facet ranges count UTF-8 bytes, and may overlap, so the text is cut at every
 * boundary and each piece wrapped in whatever covers it. */
function richText(block) {
  const text = String(block?.plaintext ?? "");
  const bytes = Buffer.from(text, "utf8");
  const facets = (Array.isArray(block?.facets) ? block.facets : [])
    .map((f) => ({ start: clamp(f?.index?.byteStart, bytes.length), end: clamp(f?.index?.byteEnd, bytes.length), features: Array.isArray(f?.features) ? f.features : [] }))
    .filter((f) => f.end > f.start && f.features.length);
  if (!facets.length) return escape(text).replace(/\n/g, "<br>");
  const cuts = [...new Set([0, bytes.length, ...facets.flatMap((f) => [f.start, f.end])])].sort((a, b) => a - b);
  let html = "";
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    let piece = escape(bytes.subarray(a, b).toString("utf8")).replace(/\n/g, "<br>");
    const features = facets.filter((f) => f.start <= a && f.end >= b).flatMap((f) => f.features);
    html += wrap(piece, features);
  }
  return html;
}

function wrap(piece, features) {
  let html = piece;
  let href = null;
  let mark = null;
  let id = null;
  for (const f of features) {
    const kind = typeof f?.$type === "string" ? f.$type.split("#")[1] : "";
    switch (kind) {
      case "bold": html = `<strong>${html}</strong>`; break;
      case "italic": html = `<em>${html}</em>`; break;
      case "strikethrough": html = `<s>${html}</s>`; break;
      case "underline": html = `<u>${html}</u>`; break;
      case "code": html = `<code>${html}</code>`; break;
      case "highlight": mark = highlightColor(f.color); break;
      case "link": href = safeHref(f.uri); break;
      case "didMention": if (typeof f.did === "string") href = `https://bsky.app/profile/${encodeURIComponent(f.did)}`; break;
      case "footnote": html = `${html}<sup class="footnote" title="${escapeAttr(f.contentPlaintext ?? "")}">*</sup>`; break;
      case "id": if (typeof f.id === "string") id = f.id; break;
      default: break;
    }
  }
  if (mark) html = `<mark style="--mark:${mark}">${html}</mark>`;
  if (href) html = `<a href="${escapeAttr(href)}" rel="nofollow ugc noopener">${html}</a>`;
  if (id) html = `<span id="${escapeAttr(id)}">${html}</span>`;
  return html;
}

function highlightColor(color) {
  const n = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
  if (color && typeof color === "object" && "r" in color) {
    const alpha = "a" in color ? n(color.a, 100) / 100 : 0.55;
    return `rgba(${n(color.r, 255)},${n(color.g, 255)},${n(color.b, 255)},${alpha})`;
  }
  return "rgba(255,230,120,.6)";
}

// MARK: - Bluesky posts

function collectPostURIs(pages) {
  const uris = new Set();
  for (const page of pages) for (const w of page?.blocks ?? []) {
    const b = w?.block;
    if (typeof b?.$type === "string" && b.$type.endsWith(".bskyPost") && typeof b.postRef?.uri === "string") uris.add(b.postRef.uri);
  }
  return [...uris];
}

async function fetchPosts(uris) {
  const posts = new Map();
  for (let i = 0; i < uris.length; i += 25) {
    const batch = uris.slice(i, i + 25);
    try {
      const res = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getPosts?${batch.map((u) => `uris=${encodeURIComponent(u)}`).join("&")}`);
      if (!res.ok) continue;
      for (const post of (await res.json()).posts ?? []) posts.set(post.uri, post);
    } catch {
      // The card falls back to a plain link.
    }
  }
  return posts;
}

function blueskyURL(uri, handle) {
  const parts = uri.split("/");
  const author = handle || parts[2] || "";
  return `https://bsky.app/profile/${encodeURIComponent(author)}/post/${encodeURIComponent(parts[parts.length - 1] ?? "")}`;
}

// MARK: - Helpers

function clamp(n, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0;
}

function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function safeHref(href) {
  if (typeof href !== "string") return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function escape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const escapeAttr = escape;

/** Styles for everything above, inside the page's `.markdown` reading column. */
export const BLOCK_STYLES = `
    .markdown .codeblock { margin: 0 0 1rem; border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; background: var(--paper-raised, #FCFCFD); }
    .markdown .code-bar { display: flex; align-items: center; gap: .5rem; padding: .45rem .75rem; background: var(--code); border-bottom: 1px solid var(--rule); font: 500 .72rem/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink2); }
    .markdown .code-dots { display: inline-flex; gap: 4px; margin-right: .2rem; }
    .markdown .code-dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--rule); display: block; }
    .markdown .code-lang { flex: 1; }
    .markdown .code-copy { font: inherit; color: var(--ink2); background: none; border: 0; padding: .15rem .4rem; border-radius: 6px; cursor: pointer; }
    .markdown .code-copy:hover { background: rgba(0,0,0,.05); color: var(--ink); }
    .markdown pre.code-lines { margin: 0; padding: .75rem 0; background: none; border: 0; border-radius: 0; overflow-x: auto; font: .78em/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 4; }
    .markdown pre.code-lines code { background: none; padding: 0; font-size: inherit; display: grid; grid-template-columns: max-content 1fr; }
    .markdown pre.code-lines .ln { color: var(--ink3); text-align: right; padding: 0 .9rem 0 .9rem; user-select: none; }
    .markdown pre.code-lines .lc { padding-right: 1rem; white-space: pre; }
    .markdown .tk-keyword { color: #AD3DA4; }
    .markdown .tk-string { color: #C41A16; }
    .markdown .tk-number { color: #272AD8; }
    .markdown .tk-comment { color: #6B7A88; font-style: italic; }
    .markdown .tk-type { color: #0B4F79; }
    .markdown .tk-function { color: #326D74; }
    .markdown .tk-attribute { color: #6C36A9; }
    .markdown p.small { font-size: .9em; color: var(--ink2); }
    .markdown p.large { font-size: 1.25em; }
    .markdown mark { background: var(--mark, rgba(255,230,120,.6)); color: inherit; padding: 0 .1em; border-radius: 2px; }
    .markdown u { text-underline-offset: 3px; }
    .markdown sup.footnote { color: var(--link); cursor: help; }
    .markdown li.task { list-style: none; margin-left: -1.4rem; }
    .markdown li .check { color: var(--ink2); margin-right: .2rem; }
    .markdown figure { margin: 0 0 1rem; }
    .markdown figure.image { margin-left: auto; margin-right: auto; }
    .markdown figure img { display: block; width: 100%; height: auto; border-radius: 8px; object-fit: cover; }
    .markdown figure.bleed { max-width: none !important; margin-left: calc(50% - 50vw); margin-right: calc(50% - 50vw); }
    .markdown figure.bleed img { border-radius: 0; }
    .markdown .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: .5rem; margin: 0 0 1rem; }
    .markdown .gallery figure { margin: 0; }
    .markdown .card, .markdown .post { display: flex; gap: .9rem; margin: 0 0 1rem; padding: .85rem 1rem; border: 1px solid var(--rule); border-radius: 14px;
                                      background: var(--raised); color: var(--ink); text-decoration: none; font-family: var(--text, -apple-system, system-ui, sans-serif); font-size: .95rem; line-height: 1.4; }
    .markdown .card:hover, .markdown .post:hover { border-color: var(--ink3); }
    .markdown .card-preview { width: 96px; height: 96px; object-fit: cover; border-radius: 8px; flex: none; }
    .markdown .card-body { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
    .markdown .card-desc { color: var(--ink2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .markdown .card-host { color: var(--ink3); font-size: .8rem; }
    .markdown .post { flex-direction: column; gap: .55rem; }
    .markdown .post-head { display: flex; align-items: center; gap: .6rem; }
    .markdown .post-head > span { display: flex; flex-direction: column; min-width: 0; }
    .markdown .post-head time { margin-left: auto; color: var(--ink3); font-size: .8rem; white-space: nowrap; }
    .markdown .post-handle { color: var(--ink2); font-size: .85rem; }
    .markdown .post-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex: none; }
    .markdown .post-avatar.placeholder { display: grid; place-items: center; background: var(--rule); color: var(--ink2); font-weight: 600; }
    .markdown .post-text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .markdown .post-images { display: grid; gap: 4px; grid-template-columns: 1fr 1fr; border-radius: 10px; overflow: hidden; }
    .markdown .post-images.n1 { grid-template-columns: 1fr; }
    .markdown .post-images img { width: 100%; aspect-ratio: 4/3; object-fit: cover; margin: 0; }
    .markdown .post-images.n1 img { aspect-ratio: auto; max-height: 420px; }
    .markdown .post-link { display: flex; gap: .7rem; align-items: center; border: 1px solid var(--rule); border-radius: 10px; padding: .5rem .7rem; }
    .markdown .post-link img { width: 72px; height: 72px; object-fit: cover; border-radius: 6px; flex: none; }
    .markdown .post-link > span { display: flex; flex-direction: column; min-width: 0; }
    .markdown .embed { position: relative; width: 100%; margin: 0 0 1rem; border-radius: 14px; overflow: hidden; background: #1d2024; color: #fff; display: grid; place-items: center; }
    .markdown .embed > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .55; margin: 0; border-radius: 0; }
    .markdown .embed-load { position: relative; z-index: 1; display: flex; align-items: center; gap: .6rem; padding: .7rem 1.1rem; border: 0; border-radius: 999px; background: rgba(255,255,255,.92); color: #1d2024; font: 600 .95rem var(--text, system-ui, sans-serif); cursor: pointer; }
    .markdown .embed-play { width: 0; height: 0; border-left: 14px solid #1d2024; border-top: 9px solid transparent; border-bottom: 9px solid transparent; }
    .markdown .embed-open { position: absolute; right: .8rem; bottom: .6rem; z-index: 1; color: rgba(255,255,255,.85); font: .8rem var(--text, system-ui, sans-serif); }
    .markdown .embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
    .markdown .html-block { width: 100%; border: 1px solid var(--rule); border-radius: 10px; margin: 0 0 1rem; background: #fff; }
    .markdown svg.drawing { display: block; width: 100%; height: auto; margin: 0 0 1rem; color: var(--ink); }
    .markdown a.button { display: inline-block; padding: .55rem 1rem; border-radius: 999px; background: var(--ink); color: var(--paper); text-decoration: none; font-family: var(--text, system-ui, sans-serif); font-size: .9rem; font-weight: 600; }
`;

/** Loads a player into its card when the reader asks, and nothing before. */
export const BLOCK_SCRIPT = `
  document.addEventListener("click", function (event) {
    var copy = event.target.closest(".code-copy");
    if (!copy) return;
    var lines = copy.closest(".codeblock").querySelectorAll(".lc");
    var text = Array.prototype.map.call(lines, function (line) { return line.textContent; }).join("\\n");
    navigator.clipboard.writeText(text).then(function () {
      copy.textContent = "Copied";
      setTimeout(function () { copy.textContent = "Copy"; }, 1600);
    });
  });
  document.addEventListener("click", function (event) {
    var button = event.target.closest(".embed-load");
    if (!button) return;
    var card = button.closest(".embed");
    var src = card && card.getAttribute("data-src");
    if (!src) return;
    var frame = document.createElement("iframe");
    frame.src = src;
    frame.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    frame.setAttribute("allowfullscreen", "");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    frame.setAttribute("loading", "lazy");
    card.replaceChildren(frame);
  });
`;
