/** Shared motion helpers. Every one of them has a still version for reduced motion. */

export const prefersReducedMotion = (): boolean =>
  typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Ease-out quart: quick start, gentle landing, the feel of --ease-out. */
export const easeOut = (t: number): number => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 4;

/** Counts a figure from `from` to `to`, calling `render` each frame. Under reduced motion, `render(to)` runs once. */
export const countTo = (render: (value: number) => void, from: number, to: number, durationMs = 600): void => {
  if (prefersReducedMotion() || from === to || typeof globalThis.requestAnimationFrame !== "function") {
    render(to);
    return;
  }
  const start = performance.now();
  const frame = (now: number): void => {
    const t = (now - start) / durationMs;
    render(t >= 1 ? to : from + (to - from) * easeOut(t));
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

/** Reveals each `[data-reveal]` once as it enters the viewport; all at once under reduced motion. */
export const revealOnEnter = (root: ParentNode = document): void => {
  const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (prefersReducedMotion() || typeof IntersectionObserver !== "function") {
    for (const target of targets) target.classList.add("is-revealed");
    return;
  }
  document.documentElement.classList.add("reveal-ready");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-revealed");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  for (const target of targets) observer.observe(target);
};
