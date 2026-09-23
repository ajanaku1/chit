/** The blind seam mark, drawn exactly as brand/logo.svg: an ink tile, a coral chit, an ink seam through it. */
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#171513" />
      <path fill="#FF5A3C" d="M14 14h36l4 4v28l-4 4H14l-4-4V18l4-4Z" />
      <path fill="#171513" d="M28 14h8v9l-4 4 4 5-4 5 4 4v9h-8v-7l-4-6 4-5-4-5 4-6v-7Z" />
    </svg>
  );
}

/**
 * The seam as a line down a whole screen: the same zigzag the mark cuts, stretched.
 * Points are x% at y%, left edge of the tear; both halves of the hero clip along it.
 */
export const SEAM: ReadonlyArray<readonly [number, number]> = [
  [50, 0], [46.4, 13], [52.2, 26], [46.4, 40], [52.2, 54], [46.4, 68], [52.2, 82], [48.6, 100],
];

export const leftOfSeam = `polygon(0% 0%, ${SEAM.map(([x, y]) => `${x}% ${y}%`).join(", ")}, 0% 100%)`;
export const rightOfSeam = `polygon(100% 0%, 100% 100%, ${[...SEAM].reverse().map(([x, y]) => `${x}% ${y}%`).join(", ")})`;
