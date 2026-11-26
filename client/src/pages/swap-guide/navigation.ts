import type { MouseEvent } from "react";

export const MOBILE_MENU_CLASS = "guide-toc-mobile";

const HEADER_OFFSET = 80;
const MOBILE_MENU_GAP = 12;

export function visibleMobileMenu(): HTMLElement | null {
  const menu = document.querySelector<HTMLElement>(`.${MOBILE_MENU_CLASS}`);
  return menu && getComputedStyle(menu).display !== "none" ? menu : null;
}

export function guideSectionOffset() {
  const menu = visibleMobileMenu();
  return menu
    ? Math.max(
        HEADER_OFFSET,
        (parseFloat(getComputedStyle(menu).top) || 0) +
          menu.offsetHeight +
          MOBILE_MENU_GAP,
      )
    : HEADER_OFFSET;
}

// Skip the fade-in so the section is measured at its final position, not mid-slide.
function revealNow(el: HTMLElement) {
  if (!el.classList.contains("g-reveal") || el.classList.contains("g-in"))
    return;
  el.style.transition = "none";
  el.classList.add("g-in");
  void el.offsetHeight;
  el.style.transition = "";
}

export function scrollToSection(id: string, animate = true) {
  const el = document.getElementById(id);
  if (!el) return;
  const details = el.closest("details");
  if (details) details.open = true;
  revealNow(el);
  const top = Math.max(
    0,
    el.getBoundingClientRect().top + window.scrollY - guideSectionOffset(),
  );
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const smooth = animate && !reduceMotion;
  const hash = `#${id}`;
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  const destination = window.location.href;
  const startY = window.scrollY;
  window.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  if (smooth) {
    // Fall back to an immediate scroll if the browser never starts the animation.
    window.setTimeout(() => {
      if (
        el.isConnected &&
        window.location.href === destination &&
        Math.abs(window.scrollY - startY) < 2 &&
        Math.abs(top - startY) >= 2
      ) {
        window.scrollTo({ top, behavior: "instant" });
      }
    }, 600);
  }
}

export function jumpTo(e: MouseEvent, id: string) {
  e.preventDefault();
  scrollToSection(id);
}
