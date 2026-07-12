// FILE: mobileViewportLock.ts
// Purpose: Keep the fixed app shell pinned to the top of the mobile viewport.
// Layer: Web bootstrap utility (no React)
//
// The app shell is an `overflow: hidden` full-height layout, so the page itself
// must never scroll. iOS Safari/standalone PWAs ignore that: when the on-screen
// keyboard opens it pans the LAYOUT viewport to reveal the focused editable
// (the composer), and it frequently leaves that pan offset behind after the
// keyboard closes. The result is the classic PWA bug this module fixes: the top
// bar sits above the visible viewport and cannot be tapped until the user
// pinch-zooms out and back in. Snapping `window.scrollTo(0, 0)` once no editable
// is focused restores the shell without any visible jump (the shell never
// legitimately scrolls).
//
// While the keyboard IS open we go one step further: iOS ignores
// `interactive-widget=resizes-content` (the keyboard shrinks only the VISUAL
// viewport, never the layout viewport), so the dvh-sized shell stays keyboard
// height too tall and the composer sits underneath it. We publish the visual
// viewport height as `--app-viewport-height` + `data-mobile-keyboard="open"` on
// <html>, and index.css shrinks the full-height shells to match. The composer
// then sits directly above the keyboard and the top bar stays on screen — no
// pan needed, so we can keep the window pinned at 0 the whole time.

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

function snapWindowToOrigin(): void {
  if (window.scrollX === 0 && window.scrollY === 0) return;
  window.scrollTo(0, 0);
}

/**
 * Install on touch devices only (a no-op elsewhere). Idempotent per page load.
 */
export function installMobileViewportLock(): void {
  if (typeof window === "undefined") return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;

  // --- Keyboard-aware shell height -------------------------------------------
  // Threshold filters out URL-bar collapse (~60px) vs keyboard (~260-380px);
  // browsers that resize the layout viewport themselves (Android with
  // interactive-widget=resizes-content) never cross it, so this is iOS-only in
  // practice without UA sniffing.
  const KEYBOARD_MIN_OVERLAP_PX = 120;
  const visualViewport = window.visualViewport;

  const syncKeyboardShellHeight = () => {
    if (!visualViewport) return;
    const root = document.documentElement;
    // window.innerHeight tracks the layout viewport on iOS (it does NOT shrink
    // for the keyboard), so the difference is the keyboard overlap.
    const keyboardOverlap = window.innerHeight - visualViewport.height;
    if (keyboardOverlap > KEYBOARD_MIN_OVERLAP_PX) {
      root.style.setProperty("--app-viewport-height", `${Math.round(visualViewport.height)}px`);
      root.dataset.mobileKeyboard = "open";
      // The shell now fits inside the visible area, so Safari's focus pan is
      // unnecessary — undo it even while the composer stays focused.
      snapWindowToOrigin();
    } else if (root.dataset.mobileKeyboard === "open") {
      delete root.dataset.mobileKeyboard;
      root.style.removeProperty("--app-viewport-height");
    }
  };

  const snapIfNoEditableFocused = () => {
    // Wait a frame so focus has settled (blur -> refocus between two inputs
    // must not fight the keyboard while it is still up).
    requestAnimationFrame(() => {
      if (isEditableElement(document.activeElement)) return;
      snapWindowToOrigin();
    });
  };

  // Keyboard dismissal paths: editable blur, visual viewport growing back, and
  // bfcache restores (Safari resurrects the page with the stale pan offset).
  window.addEventListener("focusout", snapIfNoEditableFocused, true);
  window.addEventListener("pageshow", snapIfNoEditableFocused);
  window.addEventListener("orientationchange", snapIfNoEditableFocused);

  visualViewport?.addEventListener("resize", () => {
    syncKeyboardShellHeight();
    snapIfNoEditableFocused();
  });
  syncKeyboardShellHeight();

  // The shell never scrolls legitimately, so any window scroll is viewport
  // drift. While the keyboard is open the shrunk shell fully fits, so drift is
  // undone even mid-focus; otherwise only when no editable is focused (undoing
  // Safari's focus pan while the shell is still full-height would hide the
  // composer behind the keyboard).
  window.addEventListener(
    "scroll",
    () => {
      const keyboardShellActive = document.documentElement.dataset.mobileKeyboard === "open";
      if (!keyboardShellActive && isEditableElement(document.activeElement)) return;
      snapWindowToOrigin();
    },
    { passive: true },
  );
}
