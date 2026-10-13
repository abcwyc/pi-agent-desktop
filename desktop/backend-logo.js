(() => {
  if (window.top !== window) return;
  const target = "https://pi-desktop.invalid/backend-switcher";
  const selector = '[data-backend-switcher], .brand';
  const label = navigator.language.startsWith("zh") ? "切换后端" : "Switch backend";
  let fallback;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth;
  };
  const refresh = () => {
    const logos = [...document.querySelectorAll(selector)].filter(visible);
    for (const logo of logos) {
      if (logo.getAttribute("aria-label") !== label) {
        logo.setAttribute("aria-label", label);
        logo.setAttribute("title", label);
        logo.setAttribute("aria-haspopup", "menu");
        logo.setAttribute("data-no-drag", "");
        if (!logo.matches("a, button")) {
          logo.setAttribute("role", "button");
          logo.tabIndex = 0;
        }
      }
    }
    if (!fallback && document.body) {
      fallback = document.createElement("button");
      fallback.type = "button";
      fallback.textContent = "π ▾";
      fallback.setAttribute("aria-label", label);
      fallback.setAttribute("title", label);
      fallback.setAttribute("aria-haspopup", "menu");
      fallback.setAttribute("data-no-drag", "");
      fallback.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647;border:1px solid #9996;border-radius:8px;background:var(--bg-panel,#f7f7f5);color:var(--text,#222);padding:5px 10px;font:600 17px system-ui;cursor:pointer";
      if (/Mac/.test(navigator.platform) && !window.__PI_REMOTE_BACKEND__) fallback.style.left = "80px";
      fallback.addEventListener("click", () => window.location.assign(target));
      document.body.append(fallback);
    }
    if (fallback) fallback.hidden = logos.length > 0;
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(selector)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(target);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key) || !(event.target instanceof Element) || !event.target.closest(selector)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(target);
  }, true);
  const start = () => {
    refresh();
    new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", refresh);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
