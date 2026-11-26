import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { guideSectionOffset } from "./navigation";

// A section becomes active once its heading scrolls above this line (px from the top).
const ACTIVE_LINE_MARGIN = 40;

export function useScrollPosition(ids: readonly string[]) {
  const [state, setState] = useState({ activeId: ids[0] ?? "", progress: 0 });

  useEffect(() => {
    const update = () => {
      const line = guideSectionOffset() + ACTIVE_LINE_MARGIN;
      let activeId = ids[0] ?? "";
      let lastVisibleId = activeId;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el?.getClientRects().length) continue;
        lastVisibleId = id;
        if (el.getBoundingClientRect().top <= line) activeId = id;
      }
      const max = document.documentElement.scrollHeight - window.innerHeight;
      // The last section can be too short to reach the line, so pick it at the very bottom.
      if (max > 0 && window.scrollY >= max - 2) activeId = lastVisibleId;
      const progress =
        max > 0
          ? Math.min(100, Math.max(0, Math.round((window.scrollY / max) * 100)))
          : 0;
      setState((prev) =>
        prev.activeId === activeId && prev.progress === progress
          ? prev
          : { activeId, progress },
      );
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    document.addEventListener("toggle", update, true);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("toggle", update, true);
    };
  }, [ids]);

  return state;
}

export function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".g-reveal"));
    if (typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("g-in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("g-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

export function useInViewOnce(
  ref: RefObject<Element | null>,
  threshold = 0.35,
) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold, seen]);
  return seen;
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export type CopyState = "idle" | "copied" | "failed";

export function useCopyToClipboard(resetAfterMs = 1500) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    (text: string) => {
      const settle = (next: CopyState) => {
        setState(next);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), resetAfterMs);
      };
      if (!navigator.clipboard) {
        settle("failed");
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => settle("copied"),
        () => settle("failed"),
      );
    },
    [resetAfterMs],
  );

  return { state, copy };
}
