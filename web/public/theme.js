try {
  const theme = localStorage.getItem("stiva-theme");
  document.documentElement.dataset.theme =
    theme === "light" || theme === "dark"
      ? theme
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
} catch {
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
