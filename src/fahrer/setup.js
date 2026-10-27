// Seiten-Einstellungen nur für die Fahrer-App: Titel, Manifest (Installieren
// auf dem Startbildschirm), iPhone-Icons/-Vollbild und Service Worker.
export function setupFahrerPage() {
  document.title = "Frachtbrief – Fahrer";
  const add = (tag, attrs) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    document.head.appendChild(el);
  };
  add("link", { rel: "manifest", href: "/fahrer/manifest.webmanifest" });
  add("link", { rel: "apple-touch-icon", href: "/fahrer/icon-maskable-512.png" });
  add("link", { rel: "icon", type: "image/png", href: "/fahrer/icon-512.png" });
  add("meta", { name: "theme-color", content: "#16202A" });
  add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  add("meta", { name: "mobile-web-app-capable", content: "yes" });
  add("meta", { name: "apple-mobile-web-app-title", content: "Frachtbrief" });
  add("meta", { name: "apple-mobile-web-app-status-bar-style", content: "default" });
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1.0, viewport-fit=cover");
  document.body.style.margin = "0";

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/fahrer/sw.js", { scope: "/fahrer/" }).catch(() => {});
  }
}
