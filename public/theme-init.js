(() => {
  try {
    const employeeSurface = /\/(?:desktop|chat)(?:\/|$)/.test(window.location.pathname);
    const studioSurface = /\/studio(?:\/|$)/.test(window.location.pathname);
    let storedTheme = null;
    if (!employeeSurface) {
      try {
        storedTheme = localStorage.getItem("snow-theme");
      } catch (_) {}
    }
    const explicitTheme = storedTheme === "dark" || storedTheme === "light" ? storedTheme : null;
    const theme = employeeSurface
      ? "light"
      : studioSurface
        ? (explicitTheme ?? "light")
        : (explicitTheme ??
          (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    document.documentElement.classList.add(theme);
  } catch (_) {}
})();
