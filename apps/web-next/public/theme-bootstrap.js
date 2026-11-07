(() => {
  let theme = "light";
  try {
    if (matchMedia("(prefers-color-scheme: dark)").matches) theme = "dark";
  } catch {}
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.classList.toggle("wa-dark", theme === "dark");
  root.classList.toggle("wa-light", theme === "light");
})();
