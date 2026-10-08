'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Accessibility for custom (non-Radix) modal dialogs:
 *  - locks background scroll while the dialog is open
 *  - traps Tab / Shift+Tab focus within the dialog container so keyboard and
 *    screen-reader users can't wander into the inert background
 *
 * Pass a ref to the dialog container element and the open boolean. Safe no-op
 * when closed, when the container isn't mounted, or when it has no focusable
 * children. Re-queries focusable elements on every Tab so two-phase dialogs
 * (e.g. create-key's form → created-key view) stay correct.
 */
export function useDialogA11y(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, containerRef]);
}
