// Loaded in the <head> of the docs, /benchmarks/ and /cloud/, before anything paints: the theme the visitor picked
// in the footer, if they picked one. Without a choice the pages follow the system's light or dark (docs.css).
try {
  const theme = localStorage.getItem("alden-theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}
