(() => {
  try {
    let theme = localStorage.getItem("snow-theme");
    if (!theme) {
      theme = window.location.pathname.startsWith("/desktop")
        ? "light"
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    document.documentElement.classList.add(theme);
  } catch (_) {}
})();
