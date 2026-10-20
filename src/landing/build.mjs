// Builds resenha.ink's landing page in every language the app speaks.
//
//   node src/landing/build.mjs
//
// English is written to /index.html, the others to /<lang>/index.html. The pages are committed, so Netlify serves
// them as they are, with no build step. Edit the template here and the words in strings/<lang>.json, then run this.

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

const strings = Object.fromEntries(LANGUAGES.map((lang) => [lang, JSON.parse(readFileSync(join(here, "strings", `${lang}.json`), "utf8"))]));
const pathFor = (lang) => (lang === "en" ? "/" : `/${lang}/`);

/** The stylesheet and script, addressed by their contents, so a browser never pairs a new page with an old copy. */
const fingerprint = (file) => createHash("sha256").update(readFileSync(join(root, file))).digest("hex").slice(0, 10);
const CSS = `/assets/landing/landing.css?v=${fingerprint("assets/landing/landing.css")}`;
const JS = `/assets/landing/landing.js?v=${fingerprint("assets/landing/landing.js")}`;

// MARK: - The books around the phone, at three depths

const covers = [
  // file, x, y, size, depth, rotation, wide screens only, phone x, phone y, drift seconds, delay
  ["piranesi", "6%", 40, 110, "near", -6, false, "-7%", 40, 9, 0],
  ["circe", "22%", 120, 84, "mid", 4, false, "4%", 210, 11, 1.2],
  ["the-night-circus", "3%", 300, 96, "mid", 3, true, null, null, 10, 0.6],
  ["dune", "25%", 340, 120, "near", -3, false, "-5%", 340, 12, 2],
  ["jane-eyre", "11%", 520, 86, "far", 6, true, null, null, 13, 0.3],
  ["the-hobbit", "24%", 580, 100, "near", 5, false, "3%", 480, 9.5, 1.6],
  ["beloved", "14%", 200, 70, "far", -8, true, null, null, 14, 2.4],
  ["middlemarch", "2%", 660, 78, "far", -4, true, null, null, 12, 1],
  ["project-hail-mary", "70%", 60, 118, "near", 5, false, "83%", 50, 10, 0.4],
  ["klara-and-the-sun", "86%", 160, 88, "mid", -5, false, "79%", 200, 12, 1.8],
  ["the-song-of-achilles", "68%", 310, 92, "mid", -3, true, null, null, 11, 0.9],
  ["babel", "84%", 360, 112, "near", 6, false, "85%", 330, 9, 2.2],
  ["normal-people", "72%", 540, 104, "near", -6, false, "80%", 470, 10.5, 1.1],
  ["the-left-hand-of-darkness", "89%", 590, 80, "far", 4, true, null, null, 13, 0.2],
  ["station-eleven", "80%", 240, 70, "far", 8, true, null, null, 14, 1.4],
  ["never-let-me-go", "93%", 40, 72, "far", -6, true, null, null, 12.5, 2.6],
];
const depthZ = { near: 4, mid: 2, far: 1 };
const depthSpeed = { near: 0.18, mid: 0.1, far: 0.05 };

const coverHTML = covers
  .map(([file, x, y, size, depth, r, wide, mx, my, t, d]) => {
    let style = `--x:${x};--y:${y}px;--size:${size}px;--r:${r}deg;--z:${depthZ[depth]};--t:${t}s;--d:-${d}s`;
    if (mx) style += `;--mx:${mx};--my:${my}px`;
    return `        <div class="cover ${depth}${wide ? " wide" : ""}" style="${style}" data-speed="${depthSpeed[depth]}"><img src="/assets/landing/covers/${file}.jpg" alt="" width="${size}" decoding="async"></div>`;
  })
  .join("\n");

/** A few covers set into a line of text. */
function books(...names) {
  const tilt = [-6, 4, -3, 5];
  const imgs = names.map((n, i) => `<img src="/assets/landing/covers/${n}.jpg" alt="" style="--r:${tilt[i % 4]}deg" loading="lazy" decoding="async">`).join("");
  return `<span class="books" aria-hidden="true">${imgs}</span>`;
}

const statementBooks = {
  1: books("the-night-circus", "the-song-of-achilles"),
  2: books("one-hundred-years-of-solitude", "lessons-in-chemistry"),
  3: books("a-gentleman-in-moscow", "the-midnight-library", "pride-and-prejudice"),
};

// MARK: - Helpers

/** Text for an attribute or a text node. Strings marked as HTML in the strings files are inserted as they are. */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const chips = (list) => `<ul class="chips">${list.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`;

function languageMenu(current) {
  const items = LANGUAGES.map((lang) => {
    const name = esc(strings[lang].langName);
    const here = lang === current ? ` aria-current="page"` : "";
    return `<li><a href="${pathFor(lang)}" hreflang="${lang}" lang="${lang}" data-lang="${lang}"${here}>${name}</a></li>`;
  }).join("");
  return `<details class="lang">
      <summary aria-label="${esc(strings[current].bar.language)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18"/></svg><span>${lang2(current)}</span></summary>
      <ul>${items}</ul>
    </details>`;
}
const lang2 = (lang) => lang.toUpperCase();

// MARK: - The page

function page(lang) {
  const t = strings[lang];
  const url = ORIGIN + pathFor(lang);
  const alternates = LANGUAGES.map((l) => `  <link rel="alternate" hreflang="${l}" href="${ORIGIN}${pathFor(l)}">`).join("\n");
  const statement = t.statement.replace(/\{([123])\}/g, (_, n) => statementBooks[n]);
  const scriptStrings = JSON.stringify({ getApp: t.bar.getApp, getFor: t.bar.getFor, noteDevice: t.hero.noteDevice, noteOther: t.hero.noteOther });

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(t.meta.title)}</title>
  <meta name="description" content="${esc(t.meta.description)}">
  <meta name="apple-itunes-app" content="app-id=6821354481">
  <meta name="theme-color" content="#F4F5F7">
  <link rel="canonical" href="${url}">
${alternates}
  <link rel="alternate" hreflang="x-default" href="${ORIGIN}/">
  <link rel="icon" href="/icon.png">
  <link rel="apple-touch-icon" href="/icon.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Resenha">
  <meta property="og:locale" content="${t.ogLocale}">
  <meta property="og:title" content="${esc(t.meta.title)}">
  <meta property="og:description" content="${esc(t.meta.ogDescription)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${ORIGIN}/assets/landing/og.png">
  <meta name="twitter:card" content="summary_large_image">
${lang === "en" ? `  <script>
    // A first visit to the English page from a browser set to another of the site's languages goes to that page.
    // Choosing a language from the menu is remembered, and wins from then on.
    (function () {
      try {
        var chosen = localStorage.getItem("resenha.lang");
        if (chosen) { if (chosen !== "en") location.replace("/" + chosen + "/"); return; }
        var have = ${JSON.stringify(LANGUAGES.filter((l) => l !== "en"))};
        var wanted = (navigator.languages || [navigator.language || "en"]).map(function (l) { return String(l).slice(0, 2).toLowerCase(); });
        for (var i = 0; i < wanted.length; i++) {
          if (wanted[i] === "en") return;
          if (have.indexOf(wanted[i]) >= 0) { location.replace("/" + wanted[i] + "/"); return; }
        }
      } catch (e) {}
    })();
  </script>
` : ""}  <link rel="preload" href="/fonts/InstrumentSerif-Regular.ttf" as="font" type="font/ttf" crossorigin>
  <link rel="stylesheet" href="${CSS}">
</head>
<body>
  <div class="glow" aria-hidden="true"></div>

  <header class="bar">
    <img src="/icon.png" alt="">
    <a class="name" href="${pathFor(lang)}">Resenha</a>
    ${languageMenu(lang)}
    <a class="pill" href="${APP}"><span class="long" data-get-app>${esc(t.bar.getApp)}</span><span class="short">${esc(t.bar.getApp)}</span></a>
  </header>

  <main>
    <section class="hero">
      <p class="eyebrow">${esc(t.hero.eyebrow)}</p>
      <h1>${t.hero.title}</h1>
      <p class="lede">${t.hero.lede}</p>
      <div class="cta">
        <a class="badge" href="${APP}" aria-label="${esc(t.hero.badgeLabel)}"><img src="/assets/landing/badges/app-store-black-${lang}.svg" alt="${esc(t.hero.badgeAlt)}" height="52"></a>
        <p class="note" data-get-app-note>${esc(t.hero.note)}</p>
      </div>

      <div class="stage">
${coverHTML}
        <figure class="iphone">
          <img src="/assets/landing/screens/iphone-library.webp" alt="${esc(t.hero.phoneAlt)}" width="780" height="1695" fetchpriority="high">
        </figure>
      </div>
    </section>

    <p class="statement reveal">${statement}</p>

    <section class="feature reveal">
      <div class="copy">
        <p class="eyebrow">${esc(t.write.eyebrow)}</p>
        <h2>${esc(t.write.title)}</h2>
        <p>${esc(t.write.body)}</p>
        ${chips(t.write.chips)}
      </div>
      <div class="device">
        <div class="macbook"><div class="lid"><img src="/assets/landing/screens/mac-editor.webp" alt="${esc(t.write.alt)}" width="1800" height="1125" loading="lazy"></div><div class="base"></div></div>
      </div>
    </section>

    <section class="feature flip reveal">
      <div class="copy">
        <p class="eyebrow">${esc(t.follow.eyebrow)}</p>
        <h2>${esc(t.follow.title)}</h2>
        <p>${esc(t.follow.body)}</p>
        ${chips(t.follow.chips)}
      </div>
      <div class="device">
        <figure class="ipad"><img src="/assets/landing/screens/ipad-parlor.webp" alt="${esc(t.follow.alt)}" width="1240" height="1799" loading="lazy"></figure>
      </div>
    </section>

    <section class="feature reveal">
      <div class="copy">
        <p class="eyebrow">${esc(t.publish.eyebrow)}</p>
        <h2>${esc(t.publish.title)}</h2>
        <p>${esc(t.publish.body)}</p>
        ${chips(t.publish.chips)}
      </div>
      <div class="device">
        <figure class="iphone"><img src="/assets/landing/screens/iphone-review.webp" alt="${esc(t.publish.alt)}" width="780" height="1695" loading="lazy"></figure>
      </div>
    </section>

    <section class="feature flip reveal import">
      <div class="copy">
        <p class="eyebrow">${esc(t.import.eyebrow)}</p>
        <h2>${esc(t.import.title)}</h2>
        <p>${esc(t.import.body)}</p>
        <ol class="steps">
${t.import.steps.map((s) => `          <li>${s}</li>`).join("\n")}
        </ol>
        <p class="aside">${esc(t.import.aside)}</p>
      </div>
      <div class="device">
        <div class="import-art">
          <img class="flow" style="--r:-12deg;left:4%;top:12%" src="/assets/landing/covers/the-hobbit.jpg" alt="" loading="lazy">
          <img class="flow" style="--r:9deg;right:2%;top:22%" src="/assets/landing/covers/one-hundred-years-of-solitude.jpg" alt="" loading="lazy">
          <img class="flow" style="--r:-6deg;left:10%;bottom:10%" src="/assets/landing/covers/jane-eyre.jpg" alt="" loading="lazy">
          <img class="flow" style="--r:7deg;right:8%;bottom:6%" src="/assets/landing/covers/station-eleven.jpg" alt="" loading="lazy">
          <figure class="iphone"><img src="/assets/landing/screens/iphone-import.webp" alt="${esc(t.import.alt)}" width="780" height="1695" loading="lazy"></figure>
        </div>
      </div>
    </section>

    <section class="feature reveal">
      <div class="copy">
        <p class="eyebrow">${esc(t.collect.eyebrow)}</p>
        <h2>${esc(t.collect.title)}</h2>
        <p>${esc(t.collect.body)}</p>
        ${chips(t.collect.chips)}
      </div>
      <div class="device">
        <div class="macbook"><div class="lid"><img src="/assets/landing/screens/mac-library.webp" alt="${esc(t.collect.alt)}" width="1800" height="1125" loading="lazy"></div><div class="base"></div></div>
      </div>
    </section>
  </main>

  <footer class="closing">
    <div class="shelf" aria-hidden="true">
      ${["the-remains-of-the-day", "the-martian", "tomorrow-and-tomorrow-and-tomorrow", "circe", "dune", "piranesi", "babel"].map((f) => `<img src="/assets/landing/covers/${f}.jpg" alt="" loading="lazy">`).join("")}
    </div>
    <img class="icon" src="/icon.png" alt="">
    <h2>${esc(t.closing.title)}</h2>
    <p>${esc(t.closing.subtitle)}</p>
    <a class="badge" href="${APP}" aria-label="${esc(t.hero.badgeLabel)}"><img src="/assets/landing/badges/app-store-white-${lang}.svg" alt="${esc(t.hero.badgeAlt)}" height="52"></a>
    <nav>
      <a href="/privacy.html">${esc(t.closing.privacy)}</a>
      <a href="/terms.html">${esc(t.closing.terms)}</a>
      <a href="${FEEDBACK}">${esc(t.closing.feedback)}</a>
      <a href="https://bsky.app/profile/resenha.ink">${esc(t.closing.bluesky)}</a>
    </nav>
    <p class="legal">${esc(t.closing.legal)}</p>
  </footer>

  <script type="application/json" id="landing-strings">${scriptStrings.replace(/</g, "\\u003c")}</script>
  <script src="${JS}" defer></script>
</body>
</html>
`;
}

for (const lang of LANGUAGES) {
  const out = lang === "en" ? join(root, "index.html") : join(root, lang, "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page(lang));
  console.log(`${pathFor(lang).padEnd(5)} ${out.replace(root + "/", "")}`);
}
