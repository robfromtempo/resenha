// resenha.ink, the landing page: names the visitor's device on the download buttons, as the review pages do,
// lets the covers around the phone drift at their own depths as the page scrolls, and fades sections in.
(function () {
  "use strict";

  // MARK: - The visitor's device

  var ua = navigator.userAgent;
  // iPadOS asks for desktop sites and says it's a Mac, but a Mac has no touch screen.
  var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  var device = /iPhone|iPod/.test(ua) ? "iPhone" : (/iPad/.test(ua) || touchMac) ? "iPad" : /Macintosh/.test(ua) ? "Mac" : null;
  document.documentElement.dataset.device = device || "other";

  // Each page carries its own words for these, in its language.
  var t = {};
  try { t = JSON.parse(document.getElementById("landing-strings").textContent); } catch (e) {}
  function fill(template) { return String(template || "").replace("{device}", device); }

  document.querySelectorAll("[data-get-app]").forEach(function (link) {
    if (device && t.getFor) link.textContent = fill(t.getFor);
  });
  var note = document.querySelector("[data-get-app-note]");
  if (note) {
    if (device && t.noteDevice) note.textContent = fill(t.noteDevice);
    else if (!device && t.noteOther) note.textContent = t.noteOther;
  }

  // MARK: - Language

  // A language chosen from the menu is remembered, so the English page stops sending this browser elsewhere.
  document.querySelectorAll(".lang a[data-lang]").forEach(function (link) {
    link.addEventListener("click", function () {
      try { localStorage.setItem("resenha.lang", link.dataset.lang); } catch (e) {}
    });
  });
  // The menu closes when the page is clicked or tapped elsewhere, or Escape is pressed.
  var menu = document.querySelector("details.lang");
  if (menu) {
    document.addEventListener("click", function (event) { if (!menu.contains(event.target)) menu.open = false; });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") menu.open = false; });
  }

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // MARK: - Sections fade in as they come into view

  var reveals = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    reveals.forEach(function (el) { observer.observe(el); });
  }

  // MARK: - Covers at three depths

  if (reduceMotion) return;
  var covers = Array.prototype.slice.call(document.querySelectorAll(".cover[data-speed]"));
  var ticking = false;
  function place() {
    ticking = false;
    var y = window.scrollY;
    // Past the hero there's nothing to move.
    if (y > window.innerHeight * 1.6) return;
    covers.forEach(function (cover) {
      cover.style.transform = "translate3d(0," + (-y * parseFloat(cover.dataset.speed)).toFixed(1) + "px,0)";
    });
  }
  window.addEventListener("scroll", function () {
    if (!ticking) {
      ticking = true;
      window.requestAnimationFrame(place);
    }
  }, { passive: true });
  place();
})();
