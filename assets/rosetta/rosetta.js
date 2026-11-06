// resenha.ink/rosetta: the "Migration Facts" label's switches. Every state of the label is already on the page
// (src/rosetta/build.mjs); this shows the one the two radio groups pick, and says where the book goes for screen
// readers. Without it the page shows the label for a book found by its ISBN, and the switches stay hidden.
(function () {
  "use strict";

  var switcher = document.querySelector("[data-switcher]");
  if (!switcher) return;
  var labels = Array.prototype.slice.call(document.querySelectorAll(".facts[data-match]"));
  var live = document.querySelector("[data-live]");
  var t = {};
  try { t = JSON.parse(document.getElementById("rosetta-strings").textContent); } catch (e) {}

  function picked(name) {
    var input = switcher.querySelector('input[name="' + name + '"]:checked');
    return input ? input.value : null;
  }

  function show(announce) {
    var match = picked("match") || "isbn";
    var held = picked("held") || "no";
    var shown = null;
    labels.forEach(function (label) {
      var on = label.getAttribute("data-match") === match && label.getAttribute("data-held") === held;
      label.hidden = !on;
      if (on) shown = label;
    });
    if (announce && live && shown && t.live) {
      live.textContent = t.live
        .replace("{match}", (t.match && t.match[match]) || match)
        .replace("{heldLegend}", t.heldLegend || "")
        .replace("{held}", (t.held && t.held[held]) || held)
        .replace("{goesTo}", t.goesTo || "")
        .replace("{summary}", shown.getAttribute("data-summary") || "");
    }
  }

  switcher.addEventListener("change", function () { show(true); });
  switcher.hidden = false;
  // A reload can bring back the radios as they were left: show the label they say.
  show(false);
})();
