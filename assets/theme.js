// resenha.ink's appearance: the system's, unless the visitor picked the other one with the toggle.
//
// Each page sets `data-theme` on <html> from the stored choice in a line of script in its head, before anything is
// drawn, so a page never flashes the wrong colours. This file runs the toggle. Picking the appearance the system
// already has clears the choice, so the page follows the system again from then on.
(function () {
  "use strict";

  var KEY = "resenha.theme";
  var root = document.documentElement;
  var system = window.matchMedia("(prefers-color-scheme: dark)");

  function chosen() {
    var theme = root.getAttribute("data-theme");
    return theme === "dark" || theme === "light" ? theme : null;
  }
  function current() { return chosen() || (system.matches ? "dark" : "light"); }

  function paint() {
    var dark = current() === "dark";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      var label = dark ? button.getAttribute("data-label-light") : button.getAttribute("data-label-dark");
      button.setAttribute("aria-label", label);
      button.title = label;
    });
    // The browser's own bars take the page's paper: the chosen appearance's, or each scheme's own.
    var paper = getComputedStyle(root).getPropertyValue("--paper").trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (meta) {
      if (!meta.hasAttribute("data-scheme-color")) meta.setAttribute("data-scheme-color", meta.content);
      meta.content = chosen() && paper ? paper : meta.getAttribute("data-scheme-color");
    });
  }

  function choose(theme) {
    if (theme === (system.matches ? "dark" : "light")) {
      root.removeAttribute("data-theme");
      try { localStorage.removeItem(KEY); } catch (e) {}
    } else {
      root.setAttribute("data-theme", theme);
      try { localStorage.setItem(KEY, theme); } catch (e) {}
    }
    paint();
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-theme-toggle]");
    if (button) choose(current() === "dark" ? "light" : "dark");
  });
  if (system.addEventListener) system.addEventListener("change", paint);
  // Another tab of the site changed it.
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY) return;
    if (event.newValue === "dark" || event.newValue === "light") root.setAttribute("data-theme", event.newValue);
    else root.removeAttribute("data-theme");
    paint();
  });
  paint();
})();
