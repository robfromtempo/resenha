// BookHive's catalogue for Resenha's server, which can't reach bookhive.buzz from its own machine (Notes/popfeed-feed.md).
// Two questions, nothing else: which catalogue book an ISBN is, and a book's details by its BookHive ID.
//
//   /.netlify/functions/catalog?isbn13=9780316568715   → { "hiveId": "bk_…" }, or 404 when BookHive's catalogue lacks it
//   /.netlify/functions/catalog?id=bk_…                 → { title, authors, cover, year, pages, genres, language, publisher, identifiers }, or 404
//
// Only lookups: nothing here makes BookHive add a book, so its catalogue grows from readers' own actions alone.
// The server sends CATALOG_KEY in x-catalog-key; without a matching key nothing is answered, so the function's
// quota serves Resenha alone. Answers are cached by the CDN: a match for a day, a miss for an hour.
const BOOKHIVE = "https://bookhive.buzz/xrpc";

export default async (request) => {
  const key = process.env.CATALOG_KEY;
  if (!key) return answer({ error: "NotConfigured" }, 503, 0);
  if (request.headers.get("x-catalog-key") !== key) return answer({ error: "Forbidden" }, 403, 0);
  const url = new URL(request.url);
  const isbn13 = (url.searchParams.get("isbn13") ?? "").replace(/[^0-9Xx]/g, "");
  const id = url.searchParams.get("id") ?? "";
  try {
    if (/^\d{13}$/.test(isbn13)) {
      const found = await json(`${BOOKHIVE}/buzz.bookhive.getBookIdentifiers?isbn13=${isbn13}`);
      const hiveId = found?.bookIdentifiers?.hiveId;
      return hiveId ? answer({ hiveId }, 200, 86400) : answer({ error: "NotFound" }, 404, 3600);
    }
    if (/^bk_[A-Za-z0-9]{6,40}$/.test(id)) {
      const result = await json(`${BOOKHIVE}/buzz.bookhive.searchBooks?id=${encodeURIComponent(id)}`);
      const book = (result?.books ?? []).find((b) => b?.id === id) ?? result?.books?.[0];
      if (!book?.title) return answer({ error: "NotFound" }, 404, 3600);
      const cover = [book.cover, book.thumbnail].find((c) => typeof c === "string" && c.startsWith("https://")) ?? null;
      return answer({
        hiveId: id,
        title: book.title,
        authors: String(book.authors ?? "").split("\t").filter(Boolean).join(", "),
        cover,
        year: book.publicationYear ?? null,
        pages: book.numPages ?? null,
        genres: (book.genres ?? []).filter((g) => typeof g === "string").slice(0, 6),
        language: typeof book.language === "string" ? book.language : null,
        publisher: typeof book.publisher === "string" ? book.publisher : null,
        // The edition's numbers, for a book's other editions on Resenha's server.
        identifiers: {
          isbn13: typeof book.identifiers?.isbn13 === "string" ? book.identifiers.isbn13 : null,
          isbn10: typeof book.identifiers?.isbn10 === "string" ? book.identifiers.isbn10 : null,
          goodreadsId: typeof book.identifiers?.goodreadsId === "string" ? book.identifiers.goodreadsId : null,
        },
      }, 200, 86400);
    }
    return answer({ error: "InvalidRequest", message: "isbn13 or id" }, 400, 0);
  } catch (error) {
    console.error(error);
    return answer({ error: "Upstream", message: String(error?.message ?? error) }, 502, 0);
  }
};

async function json(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(`BookHive ${response.status}`);
  return response.json();
}

function answer(body, status, seconds) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": seconds ? `public, max-age=0, s-maxage=${seconds}` : "no-store",
    },
  });
}
