// Serves readers' Standard.site reviews on resenha.ink, straight from their own repositories.
// Nothing is stored here: each request looks the record up on the AT Protocol, and the CDN keeps the answer a while.
//
//   /.well-known/site.standard.publication/p/<did>   the reader's publication record, for verification
//   /p/<did>                                          the reader's reviews
//   /p/<did>/<rkey>                                   one review, with its verification tag and link-card tags
//   /@<handle>[/...]                                  the same pages by handle; redirects to the DID address
//
// Addresses use the DID because a handle can change hands. The handle form only ever redirects.

import { Marked } from "marked";

const ORIGIN = "https://resenha.ink";
const PUBLICATION = "site.standard.publication";
const DOCUMENT = "site.standard.document";
const APPVIEW = "https://public.api.bsky.app";
/// Resenha on the App Store. One app for iPhone, iPad and Mac; Apple opens the right store for each.
const APP_STORE_ID = "6821354481";
const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

export const config = {
  path: [
    "/.well-known/site.standard.publication/p/:did",
    "/p/:did",
    "/p/:did/:rkey",
    // One catch-all: Netlify doesn't match a named segment that ends the address, as in /@alice.example.
    "/@*",
  ],
};

export default async (request, context) => {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/@")) return await redirectHandle(url);
    const { did, rkey } = context.params;
    if (!isDid(did)) return notFound();
    if (url.pathname.startsWith("/.well-known/")) return await publicationURI(did);
    if (rkey) return await reviewPage(did, rkey);
    return await publicationPage(did);
  } catch (error) {
    console.error(error);
    return html(page({ title: "Resenha", body: `<p class="note">This page couldn’t be loaded. Try again in a moment.</p>` }), 502, 60);
  }
};

// MARK: - Routes

/** The handle form of an address, sent on to the DID form. A short cache, since the handle can move. */
async function redirectHandle(url) {
  const [, first, ...rest] = url.pathname.split("/");
  const handle = decodeURIComponent(first.slice(1)).toLowerCase();
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(handle)) return notFound();
  const resolved = await json(`${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
  if (!resolved?.did || !isDid(resolved.did)) return notFound();
  const tail = rest.filter(Boolean).map(encodeURIComponent).join("/");
  return new Response(null, {
    status: 302,
    headers: { Location: `/p/${resolved.did}${tail ? `/${tail}` : ""}`, ...cache(300) },
  });
}

/** The publication's at:// address, as Standard.site verification expects, in plain text. */
async function publicationURI(did) {
  const publication = await findPublication(did);
  if (!publication) return notFound("text/plain");
  return new Response(publication.uri, { headers: { "Content-Type": "text/plain; charset=utf-8", ...cache(600) } });
}

async function reviewPage(did, rkey) {
  if (!/^[A-Za-z0-9._:~-]{1,512}$/.test(rkey)) return notFound();
  const pds = await pdsFor(did);
  if (!pds) return notFound();
  const record = await json(`${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${DOCUMENT}&rkey=${encodeURIComponent(rkey)}`);
  const doc = record?.value;
  if (!doc?.title) return notFound();
  const author = await authorOf(did);
  const address = `${ORIGIN}/p/${did}/${rkey}`;
  const summary = excerpt(doc.description || doc.textContent || "", 300);
  const image = doc.coverImage?.ref?.$link ? blobURL(pds, did, doc.coverImage.ref.$link) : null;
  const published = doc.publishedAt ? new Date(doc.publishedAt) : null;
  const body = `
    <header>
      <p class="eyebrow"><a href="/p/${did}">${escape(author.name)}</a></p>
      <h1>${escape(doc.title)}</h1>
      <p class="meta">${escape(author.handle ? `@${author.handle}` : did)}${published ? ` · ${escape(published.toLocaleDateString("en", { dateStyle: "long" }))}` : ""}</p>
    </header>
    ${image ? `<img class="cover" src="${escape(image)}" alt="">` : ""}
    <article>${render(doc)}</article>
    ${doc.bskyPostRef?.uri ? `<p class="comments"><a href="${escape(blueskyPostURL(doc.bskyPostRef.uri, author.handle))}">Comments on Bluesky</a></p>` : ""}`;
  return html(page({
    title: `${doc.title} · ${author.name}`,
    description: summary,
    canonical: address,
    image,
    type: "article",
    // Bluesky's crawler reads both tags to draw the review's rich link card. It doesn't run scripts, so they're in the page itself.
    head: `<link rel="${DOCUMENT}" href="${escape(record.uri)}">${typeof doc.site === "string" && doc.site.startsWith("at://") ? `<link rel="${PUBLICATION}" href="${escape(doc.site)}">` : ""}`,
    body,
  }), 200, 600);
}

async function publicationPage(did) {
  const publication = await findPublication(did);
  if (!publication) return notFound();
  const pds = await pdsFor(did);
  const author = await authorOf(did);
  const docs = (await listAll(pds, did, DOCUMENT))
    .filter((r) => r.value?.site === publication.uri)
    .sort((a, b) => String(b.value.publishedAt).localeCompare(String(a.value.publishedAt)));
  const items = docs.map((r) => {
    const rkey = r.uri.split("/").pop();
    const date = r.value.publishedAt ? new Date(r.value.publishedAt).toLocaleDateString("en", { dateStyle: "medium" }) : "";
    return `<li><a href="/p/${did}/${escape(rkey)}">${escape(r.value.title)}</a><span>${escape(date)}</span></li>`;
  }).join("");
  return html(page({
    title: publication.value.name,
    description: publication.value.description || `Reviews by ${author.name}`,
    canonical: `${ORIGIN}/p/${did}`,
    head: `<link rel="${PUBLICATION}" href="${escape(publication.uri)}">`,
    body: `
      <header>
        <h1>${escape(publication.value.name)}</h1>
        <p class="meta">${escape(author.handle ? `@${author.handle}` : did)}</p>
        ${publication.value.description ? `<p>${escape(publication.value.description)}</p>` : ""}
      </header>
      ${items ? `<ul class="reviews">${items}</ul>` : `<p class="note">No reviews yet.</p>`}`,
  }), 200, 600);
}

// MARK: - The AT Protocol

/** A DID Resenha can look up: did:plc, or did:web on a plain host name. */
function isDid(did) {
  return typeof did === "string"
    && (/^did:plc:[a-z2-7]{24}$/.test(did) || /^did:web:[a-z0-9.-]+\.[a-z]{2,}$/i.test(did));
}

const didDocuments = new Map();

async function didDocument(did) {
  if (didDocuments.has(did)) return didDocuments.get(did);
  const address = did.startsWith("did:plc:")
    ? `https://plc.directory/${did}`
    : `https://${did.slice("did:web:".length)}/.well-known/did.json`;
  const doc = await json(address);
  didDocuments.set(did, doc);
  return doc;
}

async function pdsFor(did) {
  const doc = await didDocument(did);
  const service = doc?.service?.find((s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`);
  const endpoint = service?.serviceEndpoint;
  return typeof endpoint === "string" && endpoint.startsWith("https://") ? endpoint.replace(/\/$/, "") : null;
}

async function authorOf(did) {
  const doc = await didDocument(did);
  const handle = doc?.alsoKnownAs?.find((a) => a.startsWith("at://"))?.slice(5) ?? null;
  const profile = await json(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
  return { handle, name: profile?.displayName || (handle ? `@${handle}` : did) };
}

/** The reader's publication on resenha.ink: the one whose address is this site's page for their DID. */
async function findPublication(did) {
  const pds = await pdsFor(did);
  if (!pds) return null;
  const expected = `${ORIGIN}/p/${did}`;
  return (await listAll(pds, did, PUBLICATION)).find((r) => String(r.value?.url).replace(/\/$/, "") === expected) ?? null;
}

async function listAll(pds, did, collection) {
  const records = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const query = `repo=${did}&collection=${collection}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result = await json(`${pds}/xrpc/com.atproto.repo.listRecords?${query}`);
    records.push(...(result?.records ?? []));
    cursor = result?.cursor;
    if (!cursor || !result?.records?.length) break;
  }
  return records;
}

function blobURL(pds, did, cid) {
  return `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}

function blueskyPostURL(uri, handle) {
  const [, , repo, , rkey] = uri.split("/");
  return `https://bsky.app/profile/${handle || repo}/post/${rkey}`;
}

async function json(address) {
  const response = await fetch(address, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  return response.json();
}

// MARK: - Rendering

/** Markdown with raw HTML shown as text, and links only to the web or mail. Other content types fall back to plain text. */
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) { return escape(token.text ?? token.raw ?? ""); },
    link(token) {
      const href = safeHref(token.href);
      const text = this.parser.parseInline(token.tokens);
      return href ? `<a href="${escape(href)}" rel="nofollow ugc noopener">${text}</a>` : text;
    },
    image(token) {
      const src = safeHref(token.href);
      return src?.startsWith("https://") ? `<img src="${escape(src)}" alt="${escape(token.text ?? "")}" loading="lazy">` : escape(token.text ?? "");
    },
  },
});

function render(doc) {
  const content = doc.content;
  if (content?.$type === "at.markpub.markdown" && typeof content.text?.markdown === "string") {
    return markdown.parse(content.text.markdown);
  }
  return (doc.textContent ?? "").split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`).join("");
}

function safeHref(href) {
  try {
    const url = new URL(href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function excerpt(text, limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page({ title, description = "", canonical, image, type = "website", head = "", body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  ${description ? `<meta name="description" content="${escape(description)}">` : ""}
  ${canonical ? `<link rel="canonical" href="${escape(canonical)}">` : ""}
  ${head}
  <meta property="og:site_name" content="Resenha">
  <meta property="og:type" content="${type}">
  <meta property="og:title" content="${escape(title)}">
  ${description ? `<meta property="og:description" content="${escape(description)}">` : ""}
  ${canonical ? `<meta property="og:url" content="${escape(canonical)}">` : ""}
  ${image ? `<meta property="og:image" content="${escape(image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ""}
  <meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
  <meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}">
  <style>
    :root { --paper: #F4F5F7; --card: #FCFCFD; --ink: #1D2024; --ink2: #626971; --rule: #E1E4E8; color-scheme: light dark; }
    @media (prefers-color-scheme: dark) { :root { --paper: #17191C; --card: #202328; --ink: #E8EAED; --ink2: #9AA1A9; --rule: #2C3036; } }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: "New York", ui-serif, Georgia, serif; }
    main { max-width: 42rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
    a { color: inherit; }
    h1 { font-size: 2.4rem; line-height: 1.15; margin: .3rem 0 .5rem; font-weight: 500; }
    .eyebrow, .meta, .note, .reviews span { font-family: -apple-system, system-ui, sans-serif; color: var(--ink2); }
    .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; margin: 0; }
    .eyebrow a { text-decoration: none; }
    .meta { font-size: .9rem; margin: 0 0 2rem; }
    .cover { width: 100%; height: auto; border-radius: 12px; margin-bottom: 2rem; }
    article { font-size: 1.15rem; line-height: 1.65; overflow-wrap: anywhere; }
    article img { max-width: 100%; }
    article blockquote { margin: 1.5rem 0; padding-left: 1rem; border-left: 3px solid var(--rule); color: var(--ink2); font-style: italic; }
    article code { background: var(--rule); padding: .1em .3em; border-radius: 4px; font-size: .9em; }
    article hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
    .comments { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); font-family: -apple-system, system-ui, sans-serif; }
    .reviews { list-style: none; padding: 0; }
    .reviews li { display: flex; justify-content: space-between; gap: 1rem; padding: .9rem 0; border-bottom: 1px solid var(--rule); font-size: 1.1rem; }
    .get-app { display: flex; align-items: center; gap: .9rem; padding: .8rem 1rem; margin: 0 0 2.5rem; border-radius: 14px;
               background: var(--card); border: 1px solid var(--rule); font-family: -apple-system, system-ui, sans-serif; }
    .get-app img { width: 44px; height: 44px; border-radius: 10px; flex: none; }
    .get-app p { margin: 0; flex: 1; font-size: .9rem; line-height: 1.35; color: var(--ink2); }
    .get-app strong { display: block; color: var(--ink); font-size: 1rem; }
    .get-app a.button { flex: none; box-sizing: border-box; text-decoration: none; background: var(--ink); color: var(--paper); font-weight: 600; font-size: .9rem;
                        padding: .55rem .95rem; border-radius: 999px; white-space: nowrap; }
    .get-app[data-platform="other"] a.button { display: none; }
    @media (max-width: 30rem) { .get-app { flex-wrap: wrap; } .get-app a.button { width: 100%; text-align: center; } }
    footer { margin-top: 4rem; font-family: -apple-system, system-ui, sans-serif; font-size: .85rem; color: var(--ink2); }
  </style>
</head>
<body>
  <main>
    ${getApp()}
    ${body}
    <footer>Published with <a href="/">Resenha</a> on the AT Protocol.</footer>
  </main>
</body>
</html>`;
}

/// An invitation to the app, above every page. Pages are cached once for every visitor, so the server can't tailor it;
/// a few lines in the browser name the visitor's device, or leave just the note on Android, Windows or Linux.
/// Without scripts it reads "Get Resenha on the App Store". Crawlers only need the tags in the head.
function getApp() {
  return `<aside class="get-app" data-platform="apple">
      <img src="/icon.png" alt="">
      <p><strong>Resenha</strong><span class="get-app-note">Read and write book reviews on the Atmosphere.</span></p>
      <a class="button" href="${APP_STORE_URL}">Get Resenha on the App Store</a>
    </aside>
    <script>
      (function () {
        var aside = document.currentScript.previousElementSibling;
        var ua = navigator.userAgent;
        var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
        var device = /iPhone|iPod/.test(ua) ? "iPhone" : (/iPad/.test(ua) || touchMac) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : null;
        if (device) {
          aside.querySelector("a.button").textContent = "Get Resenha for " + device;
        } else {
          aside.dataset.platform = "other";
          aside.querySelector(".get-app-note").textContent = "An app for reading and writing book reviews, for iPhone, iPad and Mac.";
        }
      })();
    </script>`;
}

// MARK: - Responses

/** Cached at Netlify's edge, and served stale while it refreshes, so most visits never run the function. */
function cache(seconds) {
  return {
    "Cache-Control": "public, max-age=60",
    "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${seconds}, stale-while-revalidate=86400`,
  };
}

function html(body, status = 200, seconds = 600) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...cache(seconds) } });
}

function notFound(type = "text/html") {
  const body = type === "text/plain" ? "Not found" : page({ title: "Not found · Resenha", body: `<p class="note">There’s nothing here.</p>` });
  return new Response(body, { status: 404, headers: { "Content-Type": `${type}; charset=utf-8`, ...cache(60) } });
}
