(() => {
  try {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
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
      const systemTheme = media.matches ? "dark" : "light";
      const theme = employeeSurface ? "light" : (explicitTheme ?? systemTheme);
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(theme);
    }
    applyTheme();
    media.addEventListener("change", applyTheme);
  } catch (_) {}
})();
