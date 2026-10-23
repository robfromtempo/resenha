// Serves readers' Standard.site reviews on resenha.ink, straight from their own repositories.
// Nothing is stored here: each request looks the record up on the AT Protocol, and the CDN keeps the answer a while.
//
//   /.well-known/site.standard.publication/p/<did>   the reader's publication record, for verification
//   /p/<did>                                          the reader's reviews
//   /p/<did>/<rkey>                                   one review, with its verification tag and link-card tags
//   /@<handle>[/...]                                  the same pages by handle; redirects to the DID address
//   /friend/<did>                                     a reader's friend code: who it adds, and the app to add them with
//
// Addresses use the DID because a handle can change hands. The handle form only ever redirects.

import { Marked } from "marked";
import { renderBlocks, blocksPlainText, BLOCK_STYLES, BLOCK_SCRIPT, frameMarkdownCode } from "./blocks.mjs";

const ORIGIN = "https://resenha.ink";
const PUBLICATION = "site.standard.publication";
const DOCUMENT = "site.standard.document";
const APPVIEW = "https://public.api.bsky.app";
const LINK = "ink.resenha.bookReview";
const BOOKHIVE = "https://bookhive.buzz/xrpc";
/// Resenha on the App Store. One app for iPhone, iPad and Mac; Apple opens the right store for each.
const APP_STORE_ID = "6821354481";
const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

export const config = {
  path: [
    "/.well-known/site.standard.publication/p/:did",
    "/p/:did",
    "/p/:did/:rkey",
    // A friend code's link. With Resenha installed, the phone opens the app instead of this page.
    "/friend/:did",
    // Pictures in reviews, served from the author's own account by their content address.
    "/img/:did/:cid",
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
    if (url.pathname.startsWith("/img/")) return await image(did, context.params.cid);
    if (url.pathname.startsWith("/friend/")) return await friendPage(did);
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
  // The book comes from Resenha's link for the review, when there is one: BookHive's catalogue for the cover and details,
  // the reader's BookHive record for their rating.
  const [author, link] = await Promise.all([authorOf(did), linkFor(pds, did, record.uri)]);
  const [book, stars] = link ? await Promise.all([bookHiveBook(link.hiveId), starsOf(pds, link.book)]) : [null, null];
  const address = `${ORIGIN}/p/${did}/${rkey}`;
  // A review with spoilers never puts its opening in previews, whatever its description says.
  const summary = hasSpoilers(doc) ? "This review contains spoilers." : excerpt(doc.description || doc.textContent || plainTextOf(doc), 300);
  const card = doc.coverImage?.ref?.$link ? blobURL(pds, did, doc.coverImage.ref.$link) : null;
  const published = doc.publishedAt ? new Date(doc.publishedAt) : null;
  const spoilers = hasSpoilers(doc);
  const lang = link?.langs?.[0];
  const spacing = lineHeightFor(doc);
  const markdown = `<div class="markdown"${lang ? ` lang="${escape(lang)}"` : ""}${spacing ? ` style="--review-line: ${spacing}"` : ""}>${await render(doc, pds, did)}</div>`;
  const body = `
    <div class="review-layout">
      ${book ? bookColumn(book) : card ? `<img class="card-image" src="${escape(card)}" alt="">` : ""}
      <article class="review">
        <p class="eyebrow">Review by</p>
        <a class="byline" href="/p/${did}">
          ${author.avatar ? `<img class="avatar" src="${escape(author.avatar)}" alt="">` : `<span class="avatar placeholder">${escape((author.name || "?").replace(/^@/, "").slice(0, 1).toUpperCase())}</span>`}
          <span><strong>${escape(author.handle ? `@${author.handle}` : author.name)}</strong>${published ? `<span class="date">${escape(published.toLocaleDateString("en", { dateStyle: "long" }))}</span>` : ""}</span>
        </a>
        <h1 class="review-title">${escape(doc.title)}</h1>
        ${typeof stars === "number" ? starsSVG(stars) : ""}
        ${spoilers ? `<p class="spoiler-badge">Spoilers</p>` : ""}
        <hr class="rule">
        ${spoilers
          ? `<details class="spoilers"><summary><strong>This review contains spoilers.</strong> <span>Show review</span></summary>${markdown}</details>`
          : markdown}
        ${doc.bskyPostRef?.uri ? `<p class="comments"><a href="${escape(blueskyPostURL(doc.bskyPostRef.uri, author.handle))}">Comments on Bluesky</a></p>` : ""}
      </article>
    </div>`;
  return html(page({
    title: `${doc.title} · ${author.name}`,
    description: summary,
    canonical: address,
    image: card,
    type: "article",
    // Bluesky's crawler reads both tags to draw the review's rich link card. It doesn't run scripts, so they're in the page itself.
    head: `<link rel="${DOCUMENT}" href="${escape(record.uri)}">${typeof doc.site === "string" && doc.site.startsWith("at://") ? `<link rel="${PUBLICATION}" href="${escape(doc.site)}">` : ""}`,
    body,
    wide: Boolean(book),
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
    const preview = hasSpoilers(r.value) ? "Contains spoilers." : excerpt(r.value.description || r.value.textContent || plainTextOf(r.value), 220);
    return `<li><a href="/p/${did}/${escape(rkey)}">
        <span class="row-title">${escape(r.value.title)}</span>
        ${date ? `<span class="row-date">${escape(date)}</span>` : ""}
        ${preview ? `<span class="row-excerpt">${escape(preview)}</span>` : ""}
      </a></li>`;
  }).join("");
  return html(page({
    title: publication.value.name,
    description: publication.value.description || `Reviews by ${author.name}`,
    canonical: `${ORIGIN}/p/${did}`,
    head: `<link rel="${PUBLICATION}" href="${escape(publication.uri)}">`,
    body: `
      <header class="publication">
        ${author.avatar ? `<img class="avatar large" src="${escape(author.avatar)}" alt="">` : ""}
        <div>
          <h1>${escape(publication.value.name)}</h1>
          <p class="meta">${escape(author.handle ? `@${author.handle}` : did)} · ${docs.length} ${docs.length === 1 ? "review" : "reviews"}</p>
        </div>
      </header>
      ${items ? `<ul class="reviews">${items}</ul>` : `<p class="note">No reviews yet.</p>`}`,
  }), 200, 600);
}

/** Who a friend code adds, for someone whose phone opened it without Resenha. Installing Resenha, signing in and
 *  opening the link again adds them. */
async function friendPage(did) {
  const author = await authorOf(did);
  const name = author.name;
  return html(page({
    title: `Add ${name} as a friend on Resenha`,
    description: `${name} wants to be friends on Resenha, where readers share what they read and write about books.`,
    canonical: `${ORIGIN}/friend/${did}`,
    image: author.avatar ?? undefined,
    body: `
      <header class="publication friend">
        ${author.avatar ? `<img class="avatar large" src="${escape(author.avatar)}" alt="">` : `<span class="avatar large placeholder">${escape(name.replace(/^@/, "").slice(0, 1).toUpperCase())}</span>`}
        <div>
          <h1>${escape(name)}</h1>
          ${author.handle ? `<p class="meta">@${escape(author.handle)}</p>` : ""}
        </div>
      </header>
      <p class="markdown">${escape(name)} wants to be friends on Resenha. Friends follow each other, and see what the other starts, finishes and reviews.</p>
      <p class="note">Get Resenha, sign in, then open this link again on the same device to add ${escape(name)}.</p>`,
  }), 200, 600);
}

/** The line height a review was written with in Resenha, from its document's ink.resenha.lineSpacing: a percentage of
 *  the font's own line height (100, 115, 150 or 200), as word processors count spacing. The app measures from a line
 *  height of about 1.2, so the web does too. Null for reviews without one, which keep the page's usual spacing. */
function lineHeightFor(doc) {
  const percent = doc?.["ink.resenha.lineSpacing"];
  if (![100, 115, 150, 200].includes(percent)) return null;
  return (1.2 * percent / 100).toFixed(2);
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
  const avatar = typeof profile?.avatar === "string" && profile.avatar.startsWith("https://") ? profile.avatar : null;
  return { handle, name: profile?.displayName || (handle ? `@${handle}` : did), avatar };
}

/** Resenha's link from a review to its book: the book's BookHive ID and the reader's BookHive record. */
async function linkFor(pds, did, documentURI) {
  const links = await listAll(pds, did, LINK);
  const found = links.find((r) => r.value?.document === documentURI);
  const hiveId = found?.value?.hiveId;
  if (typeof hiveId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(hiveId)) return null;
  // The languages the writer said the review is in, as BCP-47 codes, for the text's lang attribute.
  const langs = Array.isArray(found.value.langs)
    ? found.value.langs.filter((code) => typeof code === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(code))
    : [];
  return { hiveId, book: typeof found.value.book === "string" ? found.value.book : null, langs };
}

/** The document's text when it carries none, from its blocks. */
function plainTextOf(doc) {
  return doc?.content?.$type === "pub.leaflet.content" ? blocksPlainText(doc.content) : "";
}

/** A picture from an author's account, by its content address. Addresses never change, so it's cached for a year. */
async function image(did, cid) {
  if (!isDid(did) || !/^[a-z2-7]{20,80}$/i.test(cid ?? "")) return notFound("text/plain");
  const pds = await pdsFor(did);
  if (!pds) return notFound("text/plain");
  const upstream = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`);
  if (!upstream.ok) return notFound("text/plain");
  const type = upstream.headers.get("content-type") || "application/octet-stream";
  if (!type.startsWith("image/")) return notFound("text/plain");
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable", "Netlify-CDN-Cache-Control": "public, durable, max-age=31536000, immutable" },
  });
}

/** Whether the writer marked the review as having spoilers: a "spoiler" self-label on the document. */
function hasSpoilers(doc) {
  const values = doc?.labels?.values;
  return Array.isArray(values) && values.some((label) => label?.val === "spoiler");
}

/** The book in BookHive's catalogue: title, authors, cover and facts. */
async function bookHiveBook(hiveId) {
  const result = await json(`${BOOKHIVE}/buzz.bookhive.searchBooks?id=${encodeURIComponent(hiveId)}`);
  const book = result?.books?.[0];
  if (!book?.title) return null;
  const cover = [book.cover, book.thumbnail].find((c) => typeof c === "string" && c.startsWith("https://")) ?? null;
  return {
    title: book.title,
    authors: String(book.authors ?? "").split("\t").filter(Boolean).join(", "),
    cover,
    year: book.publicationYear,
    pages: book.numPages,
    genres: (book.genres ?? []).filter((g) => typeof g === "string").slice(0, 6),
  };
}

/** The reader's rating on their BookHive record, 1 to 10. */
async function starsOf(pds, bookURI) {
  const parts = typeof bookURI === "string" ? bookURI.split("/") : [];
  if (parts.length !== 5 || parts[3] !== "buzz.bookhive.book") return null;
  const record = await json(`${pds}/xrpc/com.atproto.repo.getRecord?repo=${parts[2]}&collection=buzz.bookhive.book&rkey=${encodeURIComponent(parts[4])}`);
  const stars = record?.value?.stars;
  return Number.isInteger(stars) && stars >= 1 && stars <= 10 ? stars : null;
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

async function render(doc, pds, did) {
  const content = doc.content;
  if (content?.$type === "at.markpub.markdown" && typeof content.text?.markdown === "string") {
    return frameMarkdownCode(markdown.parse(content.text.markdown));
  }
  if (content?.$type === "pub.leaflet.content") {
    return await renderBlocks(content, { pds, did, images: (cid) => `/img/${did}/${cid}` });
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

/** The book beside the review, as the app's book column shows it. On narrow screens it becomes a compact row. */
function bookColumn(book) {
  const facts = [book.year, book.pages ? `${book.pages} pages` : null].filter(Boolean).join(" · ");
  return `<aside class="book">
      ${book.cover ? `<img class="cover" src="${escape(book.cover)}" alt="Cover of ${escape(book.title)}">` : ""}
      <div class="book-text">
        <h2 class="book-title">${escape(book.title)}</h2>
        ${book.authors ? `<p class="book-author">${escape(book.authors)}</p>` : ""}
        ${facts ? `<p class="book-facts">${escape(facts)}</p>` : ""}
        ${book.genres.length ? `<p class="book-genres">${escape(book.genres.join(" · "))}</p>` : ""}
      </div>
    </aside>`;
}

/** A 1–10 rating as five stars in halves, like the app's. */
function starsSVG(stars) {
  const path = "M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z";
  const icons = [0, 1, 2, 3, 4].map((i) => {
    const fill = Math.max(0, Math.min(2, stars - i * 2)); // 0 empty, 1 half, 2 full
    const id = `half${i}`;
    const paint = fill === 2 ? "var(--accent)" : fill === 1 ? `url(#${id})` : "var(--rule)";
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${fill === 1 ? `<defs><linearGradient id="${id}"><stop offset="50%" stop-color="var(--accent)"/><stop offset="50%" stop-color="var(--rule)"/></linearGradient></defs>` : ""}<path d="${path}" fill="${paint}"/></svg>`;
  }).join("");
  return `<p class="stars" role="img" aria-label="${stars / 2} out of 5 stars">${icons}</p>`;
}

function page({ title, description = "", canonical, image, type = "website", head = "", body, wide = false }) {
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
  <link rel="icon" href="/icon.png">
  <style>
    /* Resenha's palette and type, as in the app: Instrument Serif for headings, New York for reading, SF for the interface. */
    @font-face { font-family: "Instrument Serif"; src: url("/fonts/InstrumentSerif-Regular.ttf") format("truetype"); font-display: swap; }
    @font-face { font-family: "Instrument Serif"; font-style: italic; src: url("/fonts/InstrumentSerif-Italic.ttf") format("truetype"); font-display: swap; }
    /* Furifont draws furigana over kanji, for Japanese review text (furifont.antfu.me, SIL OFL: /fonts/OFL-Furifont.txt).
       It covers only Japanese characters, so browsers fetch it only for a page that has some. */
    @font-face { font-family: "Furifont Serif"; src: url("/fonts/FurifontSerifVF-0.6.2.woff2") format("woff2"); font-weight: 200 900; font-display: swap;
                 unicode-range: U+3000-303F, U+3040-30FF, U+31F0-31FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF; }
    :root {
      --paper: #F4F5F7; --raised: #FCFCFD; --ink: #1D2024; --ink2: #626971; --ink3: #A3A9B0;
      --rule: #E1E4E8; --accent: #6E7782; --link: #2F5F8F; --code: #E2E5EA;
      --display: "Instrument Serif", ui-serif, Georgia, serif;
      --reading: ui-serif, "New York", "Iowan Old Style", Georgia, serif;
      --interface: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
      color-scheme: light;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--interface); -webkit-font-smoothing: antialiased; }
    main { max-width: ${wide ? "68rem" : "44rem"}; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
    a { color: inherit; }
    .eyebrow { font: 600 .75rem/1.2 var(--interface); text-transform: uppercase; letter-spacing: .1em; color: var(--ink2); margin: 0 0 .6rem; }

    /* The book, beside the review on wide screens. */
    .review-layout { display: grid; gap: 3.5rem; grid-template-columns: ${wide ? "17rem minmax(0, 1fr)" : "minmax(0, 1fr)"}; align-items: start; }
    .book { position: sticky; top: 2rem; }
    .book .cover { width: 100%; max-width: 15rem; display: block; margin: 0 auto 1.2rem; border-radius: 6px;
                   box-shadow: 0 4px 16px rgba(0,0,0,.14); border: .5px solid rgba(0,0,0,.08); }
    .book-title { font: 400 1.75rem/1.15 var(--display); margin: 0 0 .35rem; text-align: center; }
    .review-title { font: 400 2.4rem/1.1 var(--display); margin: 1rem 0 .5rem; text-wrap: balance; }
    .book-author { margin: 0 0 1rem; text-align: center; color: var(--ink2); font-size: .9rem; text-decoration: underline; text-underline-offset: 2px; }
    .book-facts, .book-genres { margin: 0 0 .4rem; color: var(--ink2); font-size: .8rem; line-height: 1.5; }
    .card-image { width: 100%; border-radius: 12px; margin-bottom: 2rem; }

    /* The review, as the app's reader lays it out. */
    .byline { display: flex; align-items: center; gap: .75rem; text-decoration: none; margin-bottom: 1rem; }
    .byline strong { display: block; font-size: 1rem; }
    .byline .date { display: block; font-size: .85rem; color: var(--ink2); margin-top: .1rem; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; object-fit: cover; flex: none; background: var(--rule); }
    .avatar.placeholder { display: grid; place-items: center; color: var(--ink2); font-weight: 600; }
    .avatar.large { width: 64px; height: 64px; }
    .stars { display: flex; gap: 3px; margin: 0 0 1.2rem; }
    .stars svg { width: 15px; height: 15px; }
    hr.rule { width: 64px; margin: 0 0 1.6rem; border: 0; border-top: 1px solid var(--rule); }
    /* The writer's line spacing when they chose one in Resenha; otherwise the spacing reviews always had. */
    .markdown { font-family: var(--reading); font-size: 1.25rem; line-height: var(--review-line, 1.6); overflow-wrap: anywhere; }
    .markdown pre { line-height: 1.5; }
    /* Japanese reviews set their kanji with furigana above them, which needs taller lines. */
    .markdown:lang(ja) { font-family: "Furifont Serif", var(--reading); line-height: max(var(--review-line, 1.6), 1.9); }
    .markdown > * { margin: 0 0 1rem; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4 { font-family: var(--display); font-weight: 400; line-height: 1.15; margin: 1.5rem 0 .8rem; }
    .markdown h1 { font-size: 2rem; } .markdown h2 { font-size: 1.6rem; } .markdown h3, .markdown h4 { font-size: 1.4rem; }
    .markdown a { color: var(--link); text-underline-offset: 3px; }
    .markdown blockquote { margin: 0 0 1rem; padding-left: 1.1rem; border-left: 3px solid rgba(110,119,130,.45); color: var(--ink2); font-style: italic; }
    .markdown blockquote p { margin: 0; }
    .markdown ul, .markdown ol { padding-left: 1.6rem; }
    .markdown li { margin-bottom: .2rem; }
    .markdown li::marker { color: var(--ink2); }
    .markdown code { font: .8em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: .1em .3em; border-radius: 4px; }
    .markdown pre { background: var(--code); border: 1px solid var(--rule); border-radius: 10px; padding: .9rem 1rem; overflow-x: auto; }
    .markdown pre code { background: none; padding: 0; font-size: .7em; }
    .markdown hr { border: 0; text-align: center; margin: 1.5rem 0; }
    .markdown hr::after { content: "⁂"; color: var(--ink3); font-family: var(--reading); }
    .markdown img { max-width: 100%; border-radius: 8px; }
${BLOCK_STYLES}
    .spoiler-badge { display: inline-block; margin: .6rem 0 0; padding: .15rem .6rem; border-radius: 999px; font-size: .8rem; font-weight: 600; color: #9B4A4A; background: rgba(155, 74, 74, .1); }
    details.spoilers > summary { cursor: pointer; list-style: none; padding: 1rem 1.1rem; border-radius: 14px; background: var(--raised); }
    details.spoilers > summary::-webkit-details-marker { display: none; }
    details.spoilers > summary span { color: var(--link); margin-left: .4rem; }
    details.spoilers[open] > summary { margin-bottom: 1.2rem; }
    .comments { margin-top: 2.5rem; padding-top: 1.2rem; border-top: 1px solid var(--rule); font-size: .95rem; }
    .comments a { color: var(--link); }

    /* A reader's publication: their reviews, newest first. */
    header.publication { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    header.publication h1 { font: 400 2.4rem/1.1 var(--display); margin: 0; }
    .meta, .note { color: var(--ink2); font-size: .9rem; margin: .3rem 0 0; }
    .reviews { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--rule); }
    .reviews a { display: block; padding: 1.1rem 0; border-bottom: 1px solid var(--rule); text-decoration: none; }
    .row-title { display: block; font: 600 1.1rem/1.3 var(--reading); }
    .row-date { display: block; font-size: .8rem; color: var(--ink3); margin: .2rem 0 .4rem; }
    .row-excerpt { display: block; font: 1rem/1.5 var(--reading); color: var(--ink2); }

    /* The invitation to the app. */
    .get-app { display: flex; align-items: center; gap: .9rem; padding: .85rem 1rem; margin: 0 0 2.5rem; border-radius: 18px;
               background: var(--raised); border: 1px solid var(--rule); }
    .get-app img { width: 44px; height: 44px; border-radius: 10px; flex: none; }
    .get-app p { margin: 0; flex: 1; font-size: .9rem; line-height: 1.35; color: var(--ink2); }
    .get-app strong { display: block; color: var(--ink); font: 400 1.35rem/1.1 var(--display); }
    .get-app a.button { flex: none; box-sizing: border-box; text-decoration: none; background: var(--ink); color: var(--paper); font-weight: 600;
                        font-size: .9rem; padding: .6rem 1rem; border-radius: 999px; white-space: nowrap; }
    .get-app[data-platform="other"] a.button { display: none; }
    footer { margin-top: 4rem; font-size: .8rem; color: var(--ink3); }
    footer a { color: var(--ink2); }

    @media (max-width: 52rem) {
      main { padding: 1.5rem 1rem 3rem; }
      .review-layout { grid-template-columns: minmax(0, 1fr); gap: 1.8rem; }
      .review-title { font-size: 2rem; }
      /* The book shrinks to a compact row above the review, as on iPhone. */
      .book { position: static; display: flex; align-items: center; gap: .9rem; padding: .7rem; background: var(--raised);
              border: 1px solid var(--rule); border-radius: 16px; }
      .book .cover { width: 52px; margin: 0; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,.12); }
      .book-title { font: 600 1.05rem/1.25 var(--reading); text-align: left; margin: 0 0 .15rem; }
      .book-author { text-align: left; margin: 0; }
      .book-facts, .book-genres { display: none; }
      .markdown { font-size: 1.15rem; }
    }
    @media (max-width: 30rem) { .get-app { flex-wrap: wrap; } .get-app a.button { width: 100%; text-align: center; } }
  </style>
</head>
<body>
  <main>
    ${getApp()}
    <script>${BLOCK_SCRIPT}</script>
    ${body}
    <footer>Published with <a href="/">Resenha</a> on the Atmosphere.</footer>
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
