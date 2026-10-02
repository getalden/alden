/** Light, dark, or whatever the system says (the default). Kept per browser; it's a viewing preference. */
export type Theme = "system" | "light" | "dark";

const KEY = "alden.theme";

export function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page
  }
}
