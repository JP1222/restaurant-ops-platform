// EXAMPLE KITCHEN Marketing Site — client-side JS
//
// Three interactive pieces:
//   1. Sticky nav: toggles a `.scrolled` class once the page is scrolled.
//   2. Menu tabs: shows one of #panel-rolled / #panel-bubble / #panel-smoothies.
//   3. Gift card amount picker: highlights the active button, updates the
//      "$25" / "$50" labels in the CTA and on the card mock.
//
// No bundler, no framework — vanilla DOM. Loaded with `defer`, so by the
// time we run, the DOM is parsed.

(() => {
  // ── Sticky nav background on scroll ─────────────────────────────────
  const nav = document.getElementById("site-nav");
  if (nav) {
    const onScroll = () => {
      if (window.scrollY > 24) nav.classList.add("scrolled");
      else nav.classList.remove("scrolled");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ── Menu tabs ──────────────────────────────────────────────────────
  // Each tab button carries data-tab; each panel has id panel-<key>.
  // Implements the WAI-ARIA Authoring Practices tabs pattern: click +
  // ArrowLeft/ArrowRight (wrapping), Home, End, and a roving tabindex so
  // only the selected tab is in the Tab sequence.
  const tabs = Array.from(document.querySelectorAll(".menu-tabs .tab"));
  const panels = {
    rolled:    document.getElementById("panel-rolled"),
    bubble:    document.getElementById("panel-bubble"),
    smoothies: document.getElementById("panel-smoothies"),
  };

  // Move selection to the tab at `idx`. `focus` lets keyboard nav move the
  // focus ring along with the selection; a plain click leaves focus alone.
  const selectTab = (idx, { focus = false } = {}) => {
    const btn = tabs[idx];
    const key = btn && btn.dataset.tab;
    if (!btn || !panels[key]) return;
    tabs.forEach((b) => {
      const on = b === btn;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
    });
    Object.entries(panels).forEach(([k, panel]) => {
      if (!panel) return;
      if (k === key) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    if (focus) btn.focus();
  };

  tabs.forEach((btn, idx) => {
    // Roving tabindex: only the initially-selected tab is focusable.
    btn.setAttribute("tabindex", btn.getAttribute("aria-selected") === "true" ? "0" : "-1");

    btn.addEventListener("click", () => selectTab(idx));

    btn.addEventListener("keydown", (e) => {
      let next;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = (idx + 1) % tabs.length;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = (idx - 1 + tabs.length) % tabs.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = tabs.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      selectTab(next, { focus: true });
    });
  });

  // ── Gift card amount picker ────────────────────────────────────────
  const amounts = document.querySelectorAll(".gift-amt");
  const ctaLabel  = document.getElementById("gift-amount-label");
  const cardLabel = document.getElementById("gift-card-amount");
  amounts.forEach((btn) => {
    btn.addEventListener("click", () => {
      const amt = btn.dataset.amt;
      amounts.forEach((b) => {
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
      if (ctaLabel)  ctaLabel.textContent  = `$${amt}`;
      if (cardLabel) cardLabel.textContent = `$${amt}`;
    });
  });
})();
