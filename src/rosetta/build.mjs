// Builds resenha.ink/rosetta, the Popfeed migration explained, in every language the site speaks.
//
//   node src/rosetta/build.mjs
//
// English is written to /rosetta.html, the others to /<lang>/rosetta.html; Netlify serves them as /rosetta and
// /<lang>/rosetta. The pages are committed, so Netlify serves them as they are, with no build step. Edit the template
// here and the words in strings/<lang>.json, then run this. The bar's and the footer's words come from the landing
// page's strings (src/landing/strings), so the two pages say them the same way.
//
// Every state of the "Migration Facts" label is drawn here, ahead of time: the page shows one and its script only
// switches which, so without the script the label still reads, for a book found by its ISBN.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const ORIGIN = "https://resenha.ink";
const APP = "https://apps.apple.com/app/id6821354481";
const FEEDBACK = "https://userinput.app/s/did:plc:o45y7ehjcfhasrzjjtsxloc5/3mxksvihdi32z";
/** English first: it lives at the root, and is the page for languages the site doesn't have. */
const LANGUAGES = ["en", "de", "es", "fr", "it", "ja", "pt"];

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const strings = Object.fromEntries(LANGUAGES.map((lang) => [lang, read(join(here, "strings", `${lang}.json`))]));
const landing = Object.fromEntries(LANGUAGES.map((lang) => [lang, read(join(root, "src", "landing", "strings", `${lang}.json`))]));
const home = (lang) => (lang === "en" ? "/" : `/${lang}/`);
const pathFor = (lang) => (lang === "en" ? "/rosetta" : `/${lang}/rosetta`);

/** The stylesheets and scripts, addressed by their contents, so a browser never pairs a new page with an old copy. */
const fingerprint = (file) => createHash("sha256").update(readFileSync(join(root, file))).digest("hex").slice(0, 10);
const asset = (file) => `/${file}?v=${fingerprint(file)}`;
const LANDING_CSS = asset("assets/landing/landing.css");
const LANDING_JS = asset("assets/landing/landing.js");
const THEME_JS = asset("assets/theme.js");
const CSS = asset("assets/rosetta/rosetta.css");
const JS = asset("assets/rosetta/rosetta.js");

// MARK: - Helpers

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Text with `record names` in code type, which stay as they are in every language. */
const fmt = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

// MARK: - What happens to a book (docs/designs/popfeed_migration_1_6_10.md, TP-4 to TP-6, as the app does it)

const MATCHES = ["isbn", "goodreads", "title", "none"];
const HELD = ["no", "bookhive", "reading"];
const COLLECTION = {
  newBookHive: "buzz.bookhive.book",
  upgradeReading: "buzz.bookhive.book",
  mergeBookHive: "buzz.bookhive.book",
  newReading: "ink.resenha.reading",
  mergeReading: "ink.resenha.reading",
};

/** MigrationPlanner.plan: a held BookHive record is merged into; a held reading is upgraded with a certain match,
 *  merged into without; otherwise a certain match is a new BookHive record and anything else a new reading. */
function outcome(certain, held) {
  if (held === "bookhive") return "mergeBookHive";
  if (held === "reading") return certain ? "upgradeReading" : "mergeReading";
  return certain ? "newBookHive" : "newReading";
}

/** The label's columns: one, or for a title-only match, what happens if you confirm it and if you don't. */
function columns(match, held) {
  if (match === "title") return [{ key: "colYes", outcome: outcome(true, held) }, { key: "colNo", outcome: outcome(false, held) }];
  return [{ key: null, outcome: outcome(match !== "none", held) }];
}

const isNew = (o) => o === "newBookHive" || o === "newReading";
const isMerge = (o) => o === "mergeBookHive" || o === "mergeReading";

/** The amounts, for the example book: one list item, one review, one progress record. */
const AMOUNTS = [
  ["created", (o) => (isMerge(o) ? "0" : "1")],
  ["updated", (o) => (isMerge(o) ? "@updatedMaybe" : "0"), (o) => (isMerge(o) ? "updatedNote" : null)],
  ["deletedPopfeed", () => "3"],
  ["deletedReading", (o) => (o === "upgradeReading" ? "1" : "0")],
  ["commits", () => "@commitsValue"],
  ["checked", () => "@checkedValue", () => "checkedNote"],
];

/** Each field: its value and its note, by outcome. Values and notes name keys of `label.values` and `label.notes`. */
const FIELDS = [
  ["title", (o) => ({ newBookHive: "catalogue", upgradeReading: "catalogue", newReading: "keptPopfeed" })[o] ?? "unchanged"],
  ["status", (o) => (isNew(o) ? "carried" : isMerge(o) ? "fillChoose" : "readingFirst"),
    (o) => (isNew(o) ? "status" : isMerge(o) ? "merge" : "upgrade")],
  ["dates", (o) => (isNew(o) ? "carried" : isMerge(o) ? "fillChoose" : "readingFirst"),
    (o) => (isNew(o) ? "dates" : isMerge(o) ? "datesMerge" : "datesUpgrade")],
  ["rating", (o) => (isNew(o) ? "stars" : isMerge(o) ? "fillChoose" : "readingFirst"), (o) => (isNew(o) ? "rating" : null)],
  ["review", (o) => (isNew(o) ? "plainText" : isMerge(o) ? "fillChoose" : "readingFirst"), (o) => (isNew(o) ? "review" : null)],
  ["spoiler", () => "longForm", (o) => (isNew(o) ? ["spoiler"] : ["spoilerMerge", "spoiler"])],
  ["progress", (o) => (isNew(o) ? "newest" : "newer"), (o) => (isNew(o) ? "progress" : null)],
  ["ids", (o) => ({ newBookHive: "catalogue", upgradeReading: "catalogue", newReading: "keptEdition" })[o] ?? "unchanged",
    (o) => (o === "newReading" ? "ids" : null)],
  ["cover", (o) => ({ newBookHive: "catalogueCover", upgradeReading: "catalogueCover", newReading: "keptCopy", mergeBookHive: "notChanged", mergeReading: "fillMissing" })[o],
    (o) => ({ newBookHive: "catalogueCover", upgradeReading: "catalogueCover", newReading: "keptCopy" })[o] ?? null],
  ["leftovers", () => "backup"],
  ["extras", () => "notCarried"],
  ["likes", () => "lost", () => "likes"],
];

// MARK: - The label

/** One row of a table: its name, a value per column (one cell when they agree), and its notes under it. */
function row(name, values, notes, cols) {
  const cells = values.every((v) => v === values[0])
    ? `<td colspan="${cols.length}">${values[0]}</td>`
    : values.map((v) => `<td>${v}</td>`).join("");
  let html = `<tr><th scope="row">${name}</th>${cells}</tr>`;
  if (notes.length) html += `<tr class="sub"><td colspan="${cols.length + 1}">${notes.join(" ")}</td></tr>`;
  return html;
}

/** A heading followed by its text, as each language punctuates it. */
const colon = (t) => (t.ogLocale.startsWith("fr") ? " :" : t.ogLocale.startsWith("ja") ? "：" : ":");

/** Notes by column: those every column shares once, then each column's own, prefixed with its heading. */
function columnNotes(perColumn, cols, t) {
  const shared = perColumn[0].filter((n) => perColumn.every((notes) => notes.includes(n)));
  const own = perColumn.flatMap((notes, i) => {
    const rest = notes.filter((n) => !shared.includes(n));
    return rest.length ? [`<b>${esc(t.label[cols[i].key])}${colon(t)}</b> ${rest.join(" ")}`] : [];
  });
  return [...shared, ...own];
}

function label(lang, match, held) {
  const t = strings[lang];
  const L = t.label;
  const cols = columns(match, held);
  const id = `facts-${match}-${held}`;
  const word = (s) => (s.startsWith("@") ? fmt(L.amounts[s.slice(1)]) : fmt(s));

  const header = cols[0].key
    ? `<tr class="cols"><td></td>${cols.map((c) => `<th scope="col">${esc(L[c.key])}</th>`).join("")}</tr>`
    : "";

  // Where it goes.
  const dest = cols.map((c) => `<code>${COLLECTION[c.outcome]}</code><span class="dest-words">${esc(L.dest[c.outcome])}</span>`);
  const destNotes = columnNotes(cols.map((c) => {
    const notes = [];
    if (held !== "no") notes.push(fmt(L.destNote.heldBy));
    if (L.destNote[c.outcome]) notes.push(fmt(L.destNote[c.outcome]));
    return notes;
  }), cols, t);
  const goes = row(`<span class="goes">${esc(L.goesTo)}</span>`, dest, destNotes, cols).replace("<tr>", '<tr class="dest">');

  const amounts = AMOUNTS.map(([key, value, note]) => {
    const notes = columnNotes(cols.map((c) => {
      const n = note?.(c.outcome);
      return n ? [fmt(L.amounts[n])] : [];
    }), cols, t);
    return row(esc(L.amounts[key]), cols.map((c) => word(value(c.outcome))), notes, cols);
  }).join("\n          ");

  const fields = FIELDS.map(([key, value, note]) => {
    const notes = columnNotes(cols.map((c) => {
      const n = note?.(c.outcome);
      return (Array.isArray(n) ? n : n ? [n] : []).map((k) => fmt(L.notes[k]));
    }), cols, t);
    return row(esc(L.rows[key]), cols.map((c) => fmt(L.values[value(c.outcome)])), notes, cols);
  }).join("\n          ");

  // What the live region reads when the label changes: where the book goes.
  const summary = cols.map((c) => `${c.key ? L[c.key] + colon(t) + " " : ""}${L.dest[c.outcome]} (${COLLECTION[c.outcome]})`).join("; ");
  const shown = match === "isbn" && held === "no";

  return `<section class="facts" id="${id}" data-match="${match}" data-held="${held}" data-summary="${esc(summary)}" aria-labelledby="${id}-h"${shown ? "" : " hidden"}>
        <h2 class="facts-title" id="${id}-h">${esc(L.heading)}</h2>
        <p class="serving"><span>${esc(L.serving)}</span> <span>${esc(L.servingValue)}</span></p>
        <p class="serving-note">${esc(L.servingNote)}</p>
        <table class="amounts">
          <caption>${esc(L.amountPer)}</caption>
          ${header}
          ${goes}
          ${amounts}
        </table>
        <table class="fields">
          <thead><tr><th scope="col">${esc(L.fieldHeader)}</th>${cols.length > 1 ? cols.map((c) => `<th scope="col">${esc(L[c.key])}</th>`).join("") : `<th scope="col">${esc(L.valueHeader)}</th>`}</tr></thead>
          <tbody>
          ${fields}
          </tbody>
        </table>
        <p class="ingredients"><b>${esc(L.ingredientsLabel)}</b> ${fmt(L.ingredients[match])}</p>
        <p class="contains"><b>${esc(L.warningLead)}</b> ${fmt(L.warning)}</p>
        <p class="footnote">${fmt(L.footnote)}</p>
      </section>`;
}

function excluded(lang) {
  const E = strings[lang].excluded;
  const rows = E.rows.map(([name, note]) =>
    `<tr><th scope="row">${fmt(name)}${note ? `<span class="row-note">${fmt(note)}</span>` : ""}</th><td>0</td></tr>`).join("\n          ");
  return `<section class="facts small" aria-labelledby="excluded-h">
        <h2 class="facts-title" id="excluded-h">${esc(E.heading)}</h2>
        <table class="fields">
          <thead><tr><th scope="col">${esc(E.subheading)}</th><th scope="col">${esc(E.header)}</th></tr></thead>
          <tbody>
          ${rows}
          </tbody>
        </table>
        <p class="footnote">${fmt(E.footer)}</p>
      </section>`;
}

// MARK: - The page

function languageMenu(current) {
  const items = LANGUAGES.map((lang) => {
    const name = esc(landing[lang].langName);
    const here = lang === current ? ` aria-current="page"` : "";
    return `<li><a href="${pathFor(lang)}" hreflang="${lang}" lang="${lang}" data-lang="${lang}"${here}>${name}</a></li>`;
  }).join("");
  return `<details class="lang">
      <summary aria-label="${esc(landing[current].bar.language)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg><span>${current.toUpperCase()}</span></summary>
      <ul>${items}</ul>
    </details>`;
}

function radios(name, options, t, checked) {
  return options.map(([value, key]) => {
    const id = `${name}-${value}`;
    return `<input type="radio" name="${name}" id="${id}" value="${value}"${value === checked ? " checked" : ""}><label for="${id}">${esc(t.control[key])}</label>`;
  }).join("");
}

function page(lang) {
  const t = strings[lang];
  const land = landing[lang];
  const url = ORIGIN + pathFor(lang);
  const alternates = LANGUAGES.map((l) => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}${pathFor(l)}">`).join("\n");
  const labels = MATCHES.flatMap((m) => HELD.map((h) => label(lang, m, h))).join("\n      ");
  const scriptStrings = JSON.stringify({
    getApp: land.bar.getApp, getFor: land.bar.getFor,
    live: t.live,
    match: Object.fromEntries(MATCHES.map((m) => [m, t.control[m]])),
    held: { no: t.control.heldNo, bookhive: t.control.heldBookhive, reading: t.control.heldReading },
    heldLegend: t.control.heldLegend,
    goesTo: t.label.goesTo,
  });

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(t.meta.title)}</title>
  <meta name="description" content="${esc(t.meta.description)}">
  <meta name="theme-color" content="#F4F5F7" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1A1C20" media="(prefers-color-scheme: dark)">
  <meta name="color-scheme" content="light dark">
  <script>
    // The appearance picked with the toggle, set before anything is drawn. Without one the page follows the system.
    try { var theme = localStorage.getItem("resenha.theme"); if (theme === "dark" || theme === "light") document.documentElement.setAttribute("data-theme", theme); } catch (e) {}
  </script>
  <link rel="canonical" href="${url}">
${alternates}
  <link rel="alternate" hreflang="x-default" href="${ORIGIN}${pathFor("en")}">
  <link rel="icon" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Resenha">
  <meta property="og:locale" content="${t.ogLocale}">
  <meta property="og:title" content="${esc(t.meta.title)}">
  <meta property="og:description" content="${esc(t.meta.description)}">
  <meta property="og:url" content="${url}">
${lang === "en" ? `  <script>
    // As on the home page: a first visit to the English page from a browser set to another of the site's languages
    // goes to that language's page, and a language chosen from the menu wins from then on.
    (function () {
      try {
        var chosen = localStorage.getItem("resenha.lang");
        if (chosen) { if (chosen !== "en" && ${JSON.stringify(LANGUAGES.filter((l) => l !== "en"))}.indexOf(chosen) >= 0) location.replace("/" + chosen + "/rosetta"); return; }
        var have = ${JSON.stringify(LANGUAGES.filter((l) => l !== "en"))};
        var wanted = (navigator.languages || [navigator.language || "en"]).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
        for (var i = 0; i < wanted.length; i++) {
          if (wanted[i] === "en") return;
          if (have.indexOf(wanted[i]) >= 0) { location.replace("/" + wanted[i] + "/rosetta"); return; }
        }
      } catch (e) {}
    })();
  </script>
` : ""}  <link rel="stylesheet" href="${LANDING_CSS}">
  <link rel="stylesheet" href="${CSS}">
</head>
<body class="rosetta">
  <div class="glow" aria-hidden="true"></div>

  <header class="bar">
    <img src="/icon.png" alt="">
    <a class="name" href="${home(lang)}">Resenha</a>
    ${languageMenu(lang)}
    <button class="theme-toggle" type="button" data-theme-toggle data-label-dark="${esc(t.theme.toDark)}" data-label-light="${esc(t.theme.toLight)}" aria-label="${esc(t.theme.toDark)}" title="${esc(t.theme.toDark)}">
      <svg class="only-light" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>
      <svg class="only-dark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>
    </button>
    <a class="pill" href="${APP}"><span class="long" data-get-app>${esc(land.bar.getApp)}</span><span class="short">${esc(land.bar.getApp)}</span></a>
  </header>

  <main class="page">
    <header class="intro">
      <p class="eyebrow">${esc(t.intro.eyebrow)}</p>
      <h1>${esc(t.intro.title)}</h1>
${t.intro.body.map((p) => `      <p>${fmt(p)}</p>`).join("\n")}
    </header>

    <div class="explorer">
      <div class="switcher" data-switcher hidden>
        <fieldset class="segments">
          <legend>${esc(t.control.legend)}</legend>
          <div class="options four">${radios("match", [["isbn", "isbn"], ["goodreads", "goodreads"], ["title", "title"], ["none", "none"]], t, "isbn")}</div>
        </fieldset>
        <fieldset class="segments">
          <legend>${esc(t.control.heldLegend)}</legend>
          <div class="options three">${radios("held", [["no", "heldNo"], ["bookhive", "heldBookhive"], ["reading", "heldReading"]], t, "no")}</div>
        </fieldset>
      </div>
      <noscript><p class="noscript">${esc(t.control.noscript)}</p></noscript>
      <p class="visually-hidden" aria-live="polite" data-live></p>

      ${labels}
    </div>

    <div class="excluded">
      ${excluded(lang)}
    </div>

    <section class="steps-section" aria-labelledby="steps-h">
      <h2 id="steps-h">${esc(t.steps.title)}</h2>
      <ol class="steps moves">
${t.steps.items.map(([lead, body]) => `        <li><strong>${esc(lead)}</strong> ${fmt(body)}</li>`).join("\n")}
      </ol>
      <p class="aside">${fmt(t.steps.note)}</p>
    </section>
  </main>

  <footer class="closing slim">
    <nav>
      <a href="/privacy.html">${esc(land.closing.privacy)}</a>
      <a href="/terms.html">${esc(land.closing.terms)}</a>
      <a href="${pathFor(lang)}" aria-current="page">Rosetta</a>
      <a href="${FEEDBACK}">${esc(land.closing.feedback)}</a>
      <a href="https://bsky.app/profile/resenha.ink">${esc(land.closing.bluesky)}</a>
    </nav>
    <p class="legal">${esc(t.footer.legal)}</p>
  </footer>

  <script type="application/json" id="landing-strings">${JSON.stringify({ getApp: land.bar.getApp, getFor: land.bar.getFor }).replace(/</g, "\\u003c")}</script>
  <script type="application/json" id="rosetta-strings">${scriptStrings.replace(/</g, "\\u003c")}</script>
  <script src="${THEME_JS}" defer></script>
  <script src="${LANDING_JS}" defer></script>
  <script src="${JS}" defer></script>
</body>
</html>
`;
}

for (const lang of LANGUAGES) {
  const out = lang === "en" ? join(root, "rosetta.html") : join(root, lang, "rosetta.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page(lang));
  console.log(`${pathFor(lang).padEnd(12)} ${out.replace(root + "/", "")}`);
}
