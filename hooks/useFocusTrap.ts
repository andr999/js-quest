"use client";
import { useEffect, useRef, type RefObject } from 'react';

/**
 * Traps keyboard focus within a container element.
 * Focuses the first focusable element on mount and cycles Tab within the container.
 */
export function useFocusTrap<T extends HTMLElement>(active = true): RefObject<T | null> {
    const ref = useRef<T>(null);

    useEffect(() => {
        if (!active) return;
        const el = ref.current;
        if (!el) return;
        const opener = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const focusableSelector =
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';
        const getFocusableElements = () =>
            Array.from(el.querySelectorAll<HTMLElement>(focusableSelector));

        // Small delay to ensure render is complete (needed for conditional modals)
        const timeoutId = setTimeout(() => {
            const focusableElements = getFocusableElements();
            focusableElements[0]?.focus();
        }, 50);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const focusableElements = getFocusableElements();
            if (focusableElements.length === 0) return;
            const first = focusableElements[0];
            const last = focusableElements[focusableElements.length - 1];
            const activeEl = document.activeElement;

            if (e.shiftKey) {
                if (activeEl === first || !el.contains(activeEl)) {
                    last.focus();
                    e.preventDefault();
                }
            } else {
                if (activeEl === last || !el.contains(activeEl)) {
                    first.focus();
                    e.preventDefault();
                }
            }
        };

        el.addEventListener('keydown', handleKeyDown);
        return () => {
            el.removeEventListener('keydown', handleKeyDown);
            clearTimeout(timeoutId);
            if (opener && opener !== document.body && opener.isConnected) {
                opener.focus();
            } else {
                const fallback = document.querySelector<HTMLElement>(
                    'main textarea, textarea, [data-primary-focus], main button:not([disabled])'
                );
                fallback?.focus();
            }
        };
    }, [active]);

    return ref;
}
