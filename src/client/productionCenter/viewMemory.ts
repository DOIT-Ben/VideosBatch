import { useLayoutEffect, useRef, useState, type SetStateAction } from "react";
const memory = new Map<string, unknown>();
export function readView<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try { const raw = sessionStorage.getItem(`vb:view:${key}`); if (raw !== null) return JSON.parse(raw); } catch {}
  return fallback;
}
export function writeView(key: string, value: unknown) { memory.set(key, value); try { sessionStorage.setItem(`vb:view:${key}`, JSON.stringify(value)); } catch {} }
export function useViewState<T>(key: string, initial: T) {
  const [state, setState] = useState<T>(() => readView(key, initial));
  const set = (value: SetStateAction<T>) => setState(previous => { const next = typeof value === "function" ? (value as (previous: T) => T)(previous) : value; writeView(key, next); return next; });
  return [state, set] as const;
}
export function useViewPosition(key: string) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const scroller = ["auto", "scroll"].includes(getComputedStyle(element).overflowY) ? element : document.scrollingElement;
    let focus = readView<any>(`${key}:focus`, undefined);
    const remember = () => {
      const active = document.activeElement;
      if ((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && element.contains(active)) {
        const label = active.getAttribute("aria-label");
        if (label) focus = { label, start: active.selectionStart, end: active.selectionEnd };
      }
    };
    const scroll = () => writeView(`${key}:scroll`, scroller?.scrollTop || 0);
    const frame = requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = readView(`${key}:scroll`, 0);
      if (focus) {
        const savedFocus = focus;
        const input = [...element.querySelectorAll("textarea,input")].find(item => item.getAttribute("aria-label") === focus.label) as HTMLInputElement | HTMLTextAreaElement | undefined;
        if (input) { input.focus({ preventScroll: true }); try { input.setSelectionRange(savedFocus.start, savedFocus.end); } catch {} }
      }
    });
    const focusEvents = ["focusin", "keyup", "pointerup", "focusout", "input", "select"];
    for (const event of focusEvents) element.addEventListener(event, remember);
    const scrollTarget = scroller === element ? element : document;
    scrollTarget.addEventListener("scroll", scroll, { passive: true });
    return () => { cancelAnimationFrame(frame); remember(); writeView(`${key}:focus`, focus); for (const event of focusEvents) element.removeEventListener(event, remember); scrollTarget.removeEventListener("scroll", scroll); };
  }, [key]);
  return root;
}
