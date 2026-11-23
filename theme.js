"use strict";

(() => {
  const storageKey = "navigator_theme";
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  let preference = "system";

  function readPreference() {
    try {
      const value = localStorage.getItem(storageKey);
      return value === "dark" || value === "light" ? value : "system";
    } catch (_error) {
      return "system";
    }
  }

  function applyTheme() {
    const dark = preference === "dark" || (preference === "system" && systemDark.matches);
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#16161b" : "#f2f2f2");
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.setAttribute("aria-pressed", String(dark));
      button.title = dark ? "Включить светлую тему" : "Включить тёмную тему";
    }
    for (const select of document.querySelectorAll("[data-theme-select]")) select.value = preference;
  }

  function setPreference(value) {
    preference = value;
    try {
      if (value === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, value);
    } catch (_error) {
      // Тема продолжает работать до закрытия страницы.
    }
    applyTheme();
  }

  preference = readPreference();
  applyTheme();
  document.addEventListener("DOMContentLoaded", applyTheme);
  document.addEventListener("click", event => {
    if (event.target.closest("[data-theme-toggle]")) {
      setPreference(root.dataset.theme === "dark" ? "light" : "dark");
    }
  });
  document.addEventListener("change", event => {
    if (event.target.matches("[data-theme-select]")) setPreference(event.target.value);
  });
  systemDark.addEventListener("change", applyTheme);
  window.addEventListener("storage", event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = readPreference();
    applyTheme();
  });
})();
