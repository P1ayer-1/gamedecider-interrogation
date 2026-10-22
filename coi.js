// Registers coi-sw.js once and reloads so the page is crossOriginIsolated (multi-threaded WASM). Add ?nocoi to skip.
(function () {
  if (window.crossOriginIsolated || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  if (new URLSearchParams(location.search).has("nocoi")) return;
  const sw = new URL("coi-sw.js", document.currentScript.src);
  navigator.serviceWorker.register(sw).then(() => navigator.serviceWorker.ready).then(() => {
    if (!sessionStorage.getItem("coiReloaded")) { sessionStorage.setItem("coiReloaded", "1"); location.reload(); }
  }).catch(e => console.warn("cross-origin isolation unavailable:", e));
})();
