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
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.classList.toggle("wa-dark", theme === "dark");
  root.classList.toggle("wa-light", theme === "light");
})();
