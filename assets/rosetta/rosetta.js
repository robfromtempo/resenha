// resenha.ink/rosetta: the "Migration Facts" switches. Every state of the label, and of the words beside it, is
// already on the page (src/rosetta/build.mjs); this shows the one the two radio groups pick, slides each switch's
// lens to the picked option, marks the label's rows whose value changed, and says where the book goes for screen
// readers. Without it the page shows the label for a book found by its ISBN, and the switches stay hidden.
(function () {
  "use strict";

  var switcher = document.querySelector("[data-switcher]");
  if (!switcher) return;
  var states = Array.prototype.slice.call(document.querySelectorAll("[data-match][data-held]"));
  var live = document.querySelector("[data-live]");
  var tracks = Array.prototype.slice.call(switcher.querySelectorAll("[data-track]"));
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var t = {};
  try { t = JSON.parse(document.getElementById("rosetta-strings").textContent); } catch (e) {}

  function picked(name) {
    var input = switcher.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : null;
  }

  function shownLabel() {
    return document.querySelector(".facts[data-match]:not([hidden])");
  }

  // MARK: - The lens: a raised thumb over the picked option, placed by measuring it, so it fits any layout.

  function placeLens(track, instant) {
    var lens = track.querySelector(".lens");
    var input = track.querySelector("input:checked");
    var label = input && track.querySelector('label[for="' + input.id + '"]');
    if (!lens || !label) return;
    if (instant) lens.classList.add("instant");
    lens.style.width = label.offsetWidth + "px";
    lens.style.height = label.offsetHeight + "px";
    lens.style.transform = "translate(" + label.offsetLeft + "px," + label.offsetTop + "px)";
    lens.classList.add("ready");
    if (instant) { void lens.offsetWidth; lens.classList.remove("instant"); }
    // A track that scrolls sideways (phones) brings the picked option into view.
    if (track.scrollWidth > track.clientWidth + 1) {
      var left = label.offsetLeft - (track.clientWidth - label.offsetWidth) / 2;
      track.scrollTo({ left: Math.max(0, left), behavior: instant || reduceMotion.matches ? "auto" : "smooth" });
    }
    edges(track);
  }

  // Fades at a scrolling track's edges, only where there is more to see.
  function edges(track) {
    var max = track.scrollWidth - track.clientWidth;
    track.classList.toggle("fade-start", max > 1 && track.scrollLeft > 1);
    track.classList.toggle("fade-end", max > 1 && track.scrollLeft < max - 1);
  }

  // MARK: - Showing a state

  function show(announce) {
    var match = picked("match") || "isbn";
    var held = picked("held") || "no";
    var before = shownLabel();
    states.forEach(function (el) {
      el.hidden = !(el.getAttribute("data-match") === match && el.getAttribute("data-held") === held);
    });
    var after = shownLabel();
    if (announce && before && after && before !== after) markChanges(before, after);
    if (announce && live && after && t.live) {
      live.textContent = t.live
        .replace("{match}", (t.match && t.match[match]) || match)
        .replace("{heldLegend}", t.heldLegend || "")
        .replace("{held}", (t.held && t.held[held]) || held)
        .replace("{goesTo}", t.goesTo || "")
        .replace("{summary}", after.getAttribute("data-summary") || "");
    }
  }

  function rowTexts(label) {
    var texts = {};
    label.querySelectorAll("tr[data-row]").forEach(function (row) {
      var key = row.getAttribute("data-row");
      texts[key] = (texts[key] || "") + "|" + row.textContent.replace(/\s+/g, " ").trim();
    });
    return texts;
  }

  // Rows whose words differ from the label shown before get a brief highlight, so the difference is easy to see.
  function markChanges(before, after) {
    var old = rowTexts(before);
    var now = rowTexts(after);
    after.querySelectorAll("tr[data-row]").forEach(function (row) {
      row.classList.remove("changed");
      if (old[row.getAttribute("data-row")] !== now[row.getAttribute("data-row")]) {
        void row.offsetWidth; // restarts the highlight when the same row changes again
        row.classList.add("changed");
      }
    });
  }

  switcher.addEventListener("change", function (event) {
    var track = event.target.closest("[data-track]");
    if (track) placeLens(track, false);
    show(true);
  });
  tracks.forEach(function (track) {
    track.addEventListener("scroll", function () { edges(track); }, { passive: true });
  });
  var resizing = 0;
  window.addEventListener("resize", function () {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(function () { tracks.forEach(function (track) { placeLens(track, true); }); });
  });

  switcher.hidden = false;
  // A reload can bring back the radios as they were left: show the state they say.
  show(false);
  tracks.forEach(function (track) { placeLens(track, true); });
  // The display face can change the options' widths once it loads.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { tracks.forEach(function (track) { placeLens(track, true); }); });
  }
})();
