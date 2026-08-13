(() => {
  const key = "infinite-quest.theme";
  let stored = null;
  try {
    stored = localStorage.getItem(key);
  } catch {}
  const explicit = stored === "light" || stored === "dark" ? stored : null;
  let systemDark = false;
  if (!explicit) {
    try {
      systemDark = typeof matchMedia === "function"
        && matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {}
  }
  const theme = explicit || (systemDark ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
