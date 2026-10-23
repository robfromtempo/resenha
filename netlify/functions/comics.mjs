// A catalog of the comics published on the network with the sequential.work lexicons, for Resenha's Comics page.
//
// sequential.work has no AppView yet, so there's nowhere to ask for every series. The relay knows which accounts
// hold series records, and each account's server has its records. This function reads them all, once an hour, and
// Resenha downloads the result in one request. If an AppView appears, this is the one place to switch to it.

const RELAY = "https://relay1.us-east.bsky.network/xrpc";
const APPVIEW = "https://public.api.bsky.app/xrpc";
const SERIES = "work.sequential.series";
const CHAPTER = "work.sequential.chapter";
/// Creators' servers answer in a second or two; the function has about ten before Netlify stops it. The scan
/// stops launching work at the budget and returns what it has, cached only briefly, so the next visit finishes it.
const BUDGET_MS = 8000;
const CONCURRENCY = 12;

export const config = { path: "/api/comics" };

/// What's been read in this warm instance, by account, so a scan cut short picks up where it left off.
const creators = new Map();

export default async () => {
  const started = Date.now();
  try {
    const dids = await listCreators();
    const results = await inPool(dids, CONCURRENCY, (did) => creator(did), () => Date.now() - started > BUDGET_MS);
    const complete = results.every((r) => r !== undefined);
    const series = results.flatMap((r) => r?.series ?? []);
    const profiles = await profilesOf(series.map((s) => s.did));
    for (const item of series) item.creator = profiles.get(item.did) ?? { handle: null, name: null, avatar: null };
    series.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const body = JSON.stringify({ generatedAt: new Date().toISOString(), complete, series });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
        "Netlify-CDN-Cache-Control": `public, durable, s-maxage=${complete ? 3600 : 120}, stale-while-revalidate=86400`,
      },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "The catalog couldn’t be read. Try again in a moment." }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" },
    });
  }
};

/** Every account the relay has seen series records in. Accounts that deleted theirs since are listed too, and
 *  turn out empty when read. */
async function listCreators() {
  const dids = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await json(`${RELAY}/com.atproto.sync.listReposByCollection?collection=${SERIES}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const repos = result?.repos ?? [];
    dids.push(...repos.map((r) => r.did).filter(isDid));
    cursor = result?.cursor;
    if (!cursor || repos.length === 0) break;
  }
  return dids;
}

/** One creator's series, with how many chapters each has and when the last one came, from their own server. */
async function creator(did) {
  const cached = creators.get(did);
  if (cached && Date.now() - cached.at < 3600_000) return cached;
  const pds = await pdsFor(did);
  if (!pds) return remember(did, { series: [] });
  const [seriesRecords, chapterRecords] = await Promise.all([listAll(pds, did, SERIES), listAll(pds, did, CHAPTER)]);
  const chapters = new Map();
  for (const record of chapterRecords) {
    const uri = record.value?.series;
    if (typeof uri !== "string") continue;
    const entry = chapters.get(uri) ?? { count: 0, latest: "" };
    entry.count += 1;
    const at = typeof record.value?.createdAt === "string" ? record.value.createdAt : "";
    if (at > entry.latest) entry.latest = at;
    chapters.set(uri, entry);
  }
  const series = seriesRecords.map((record) => seriesEntry(record, did, pds, chapters.get(record.uri))).filter(Boolean);
  return remember(did, { series });
}

function remember(did, result) {
  const entry = { ...result, at: Date.now() };
  creators.set(did, entry);
  return entry;
}

function seriesEntry(record, did, pds, chapters) {
  const v = record.value ?? {};
  const title = localized(v.title);
  if (!title) return null;
  const createdAt = typeof v.createdAt === "string" ? v.createdAt : "";
  return {
    uri: record.uri,
    cid: record.cid,
    did,
    pds,
    title,
    titles: textsOf(v.title),
    description: localized(v.description) ?? "",
    descriptions: textsOf(v.description),
    format: typeof v.format === "string" ? v.format : "page",
    readingDirection: v.readingDirection === "rtl" ? "rtl" : "ltr",
    status: typeof v.status === "string" ? v.status : "ongoing",
    nativeLanguage: typeof v.nativeLanguage === "string" ? v.nativeLanguage : null,
    categories: Array.isArray(v.categories) ? v.categories.filter((c) => typeof c === "string") : [],
    labels: Array.isArray(v.labels?.values) ? v.labels.values.map((l) => l?.val).filter((l) => typeof l === "string") : [],
    poster: blob(v.poster),
    banner: blob(v.banner),
    // Small copies for lists, resized on the way through resenha.ink: the originals run to several megabytes.
    posterThumb: thumbnail(pds, did, v.poster, 400),
    bannerThumb: thumbnail(pds, did, v.banner, 900),
    chapters: chapters?.count ?? 0,
    createdAt,
    // When something last happened to the series: its newest chapter, or else its own creation.
    updatedAt: chapters?.latest && chapters.latest > createdAt ? chapters.latest : createdAt,
  };
}

/** A blob resized by Netlify's image CDN, which netlify.toml lets fetch from account servers' getBlob only. */
function thumbnail(pds, did, value, width) {
  const cid = value?.ref?.$link;
  if (typeof cid !== "string") return null;
  const source = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
  return `https://resenha.ink/.netlify/images?url=${encodeURIComponent(source)}&w=${width}&q=75`;
}

/** A blob as a record keeps it: its content address, type and size. Null for anything else. */
function blob(value) {
  const cid = value?.ref?.$link;
  if (typeof cid !== "string") return null;
  return { cid, mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream", size: Number(value.size) || 0 };
}

/** The first text of a localized list, which Resenha shows when it has none in the reader's language. */
function localized(list) {
  const first = Array.isArray(list) ? list.find((e) => typeof e?.text === "string" && e.text.trim()) : null;
  return first ? first.text.trim() : null;
}

/** Every language's text, so the app can pick the reader's. */
function textsOf(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => typeof e?.text === "string" && e.text.trim()).map((e) => ({ lang: typeof e.lang === "string" ? e.lang : "", text: e.text.trim() }));
}

/** Creators' names, handles and pictures, 25 to a request. */
async function profilesOf(dids) {
  const unique = [...new Set(dids)];
  const profiles = new Map();
  await inPool(chunks(unique, 25), 4, async (group) => {
    const result = await json(`${APPVIEW}/app.bsky.actor.getProfiles?${group.map((d) => `actors=${encodeURIComponent(d)}`).join("&")}`);
    for (const p of result?.profiles ?? []) {
      profiles.set(p.did, {
        handle: typeof p.handle === "string" ? p.handle : null,
        name: typeof p.displayName === "string" ? p.displayName : null,
        avatar: typeof p.avatar === "string" && p.avatar.startsWith("https://") ? p.avatar : null,
      });
    }
  });
  return profiles;
}

// MARK: - The AT Protocol

function isDid(did) {
  return typeof did === "string" && (/^did:plc:[a-z2-7]{24}$/.test(did) || /^did:web:[a-z0-9.-]+\.[a-z]{2,}$/i.test(did));
}

const didDocuments = new Map();

async function pdsFor(did) {
  let doc = didDocuments.get(did);
  if (!doc) {
    doc = await json(did.startsWith("did:plc:") ? `https://plc.directory/${did}` : `https://${did.slice("did:web:".length)}/.well-known/did.json`);
    if (doc) didDocuments.set(did, doc);
  }
  const service = doc?.service?.find((s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`);
  const endpoint = service?.serviceEndpoint;
  return typeof endpoint === "string" && endpoint.startsWith("https://") ? endpoint.replace(/\/$/, "") : null;
}

async function listAll(pds, did, collection) {
  const records = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await json(`${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${collection}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    records.push(...(result?.records ?? []));
    cursor = result?.cursor;
    if (!cursor || !result?.records?.length) break;
  }
  return records;
}

async function json(address) {
  try {
    const response = await fetch(address, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// MARK: - Helpers

/** Runs `work` over `items`, `limit` at a time. Once `stop()` says so, items not yet started are left undefined. */
async function inPool(items, limit, work, stop = () => false) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length && !stop()) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunks(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
