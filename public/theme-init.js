(() => {
  try {
    const employeeSurface = /\/(?:desktop|chat|login|setup-password)(?:\/|$)/.test(
      window.location.pathname,
    );
    let storedTheme = null;
    if (!employeeSurface) {
      try {
        storedTheme = localStorage.getItem("snow-theme");
      } catch (_) {}
    }
    const explicitTheme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : null;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    const theme = employeeSurface ? "light" : (explicitTheme ?? systemTheme);
    document.documentElement.classList.add(theme);
  } catch (_) {}
})();
