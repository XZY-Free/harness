(() => {
  try {
    const employeeSurface = /\/(?:desktop|chat)(?:\/|$)/.test(window.location.pathname);
    let theme = employeeSurface ? "light" : localStorage.getItem("snow-theme");
    if (!theme)
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.classList.add(theme);
  } catch (_) {}
})();
