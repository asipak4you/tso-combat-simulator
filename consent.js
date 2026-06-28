// © 2026 Dennis Thielsch – Alle Rechte vorbehalten / All rights reserved. Siehe LICENSE.
//
// Consent-Banner + bedingtes Laden von Google Analytics (GA4).
// Google Analytics wird ERST nach ausdrücklicher Einwilligung geladen
// (§ 25 TTDSG/DDG, DSGVO). Ohne Zustimmung werden keine Analytics-Skripte
// geladen und keine Cookies gesetzt.
(function () {
  // GA4 Measurement-ID. Leeren/„XXXX" lassen, um GA komplett zu deaktivieren.
  const GA_ID = "G-FM0RTJQVC5";
  const KEY = "tso_consent";               // gespeicherte Wahl: "granted" | "denied"

  // Sprache: ?lang= > Pfad-Locale (/en/, /pl/) > gespeicherte Wahl > <html lang> > de.
  function lang() {
    try {
      const q = new URLSearchParams(location.search).get("lang");
      const path = (location.pathname.match(/^\/(en|pl)(\/|$)/) || [])[1];
      const l = (q || path || localStorage.getItem("tso_lang")
        || document.documentElement.lang || "de").toLowerCase().slice(0, 2);
      return (l === "en" || l === "pl") ? l : "de";
    } catch (e) { return "de"; }
  }

  // Banner-Texte je Sprache. Die Datenschutzseite (datenschutz.html) ist rechtlich DE.
  const TXT = {
    de: { msg: "Wir nutzen Google Analytics, um die Nutzung dieser Seite zu verstehen. Die Analyse wird nur mit deiner Einwilligung geladen.",
          privacy: "Datenschutz", no: "Ablehnen", yes: "Akzeptieren" },
    en: { msg: "We use Google Analytics to understand how this site is used. Analytics is only loaded with your consent.",
          privacy: "Privacy", no: "Decline", yes: "Accept" },
    pl: { msg: "Używamy Google Analytics, aby zrozumieć, jak korzysta się z tej strony. Analityka jest ładowana wyłącznie za Twoją zgodą.",
          privacy: "Prywatność", no: "Odrzuć", yes: "Akceptuj" },
  };

  function loadGA() {
    if (!GA_ID || GA_ID.indexOf("XXXX") >= 0) return;   // ohne echte ID nichts laden
    if (window.__gaLoaded) return;
    window.__gaLoaded = true;
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_ID);
  }

  function store(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }

  function injectStyle() {
    if (document.getElementById("consent-style")) return;
    const st = document.createElement("style");
    st.id = "consent-style";
    st.textContent =
      "#consent{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;flex-wrap:wrap;" +
      "gap:10px 16px;align-items:center;justify-content:space-between;padding:12px 16px;" +
      "background:#f2ead7;border-top:1px solid #cdbb95;color:#392719;" +
      "font:14px/1.5 system-ui,sans-serif;box-shadow:0 -4px 16px rgba(57,39,25,.25)}" +
      "#consent .ct{flex:1;min-width:240px}#consent a{color:#745238}" +
      "#consent .cb{display:flex;gap:8px;flex:0 0 auto}" +
      "#consent button{padding:8px 16px;border:0;border-radius:7px;cursor:pointer;font:inherit}" +
      "#c-no{background:#e7dcc3;color:#392719}#c-yes{background:#745238;color:#f2ead7;font-weight:600}";
    document.head.appendChild(st);
  }

  function hideBanner() { const b = document.getElementById("consent"); if (b) b.remove(); }

  function showBanner() {
    if (document.getElementById("consent")) return;
    injectStyle();
    const t = TXT[lang()];
    const bar = document.createElement("div");
    bar.id = "consent";
    bar.innerHTML =
      '<span class="ct">' + t.msg + ' <a href="datenschutz.html">' + t.privacy + "</a></span>" +
      '<span class="cb"><button id="c-no">' + t.no + "</button>" +
      '<button id="c-yes">' + t.yes + "</button></span>";
    document.body.appendChild(bar);
    document.getElementById("c-yes").onclick = function () { store("granted"); hideBanner(); loadGA(); };
    document.getElementById("c-no").onclick = function () { store("denied"); hideBanner(); };
  }

  // Footer-Link „Cookie-Einstellungen": Wahl zurücksetzen und Banner erneut zeigen.
  window.openConsent = function () { try { localStorage.removeItem(KEY); } catch (e) {} showBanner(); };

  const c = read();
  if (c === "granted") loadGA();
  else if (c !== "denied") showBanner();
})();
