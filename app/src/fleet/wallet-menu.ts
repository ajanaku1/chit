/**
 * The parts of the header's wallet menu that need no wallet: the address's
 * dot mark and the menu's icons. The mark uses the round dots of the app's LED
 * figures, in paper tones only (coral is kept for what is live), so a trader
 * learns their wallet's mark at a glance and it reads as Chit, not a generic
 * avatar.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export type MarkCell = "off" | "dim" | "lit";

/**
 * A 5×5 grid mirrored down the middle: 15 cells, one hex digit of the address
 * each. Most digits leave a cell dark, some light it dimly, a few fully.
 */
export const markCells = (address: string): MarkCell[][] => {
  const hex = address.toLowerCase().replace(/^0x/, "").padEnd(15, "0");
  const cell = (digit: string): MarkCell => {
    const value = parseInt(digit, 16);
    return value >= 12 ? "lit" : value >= 7 ? "dim" : "off";
  };
  return Array.from({ length: 5 }, (_, row) => {
    const left = [0, 1, 2].map((col) => cell(hex[row * 3 + col]!));
    return [left[0]!, left[1]!, left[2]!, left[1]!, left[0]!];
  });
};

export const walletMark = (address: string): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 5 5");
  svg.setAttribute("class", "wallet-mark");
  svg.setAttribute("aria-hidden", "true");
  markCells(address).forEach((cells, row) => {
    cells.forEach((state, col) => {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(col + 0.5));
      dot.setAttribute("cy", String(row + 0.5));
      dot.setAttribute("r", "0.36");
      dot.setAttribute("class", state);
      svg.append(dot);
    });
  });
  return svg;
};

const ICONS = {
  copy: ["M9 9h10v10H9z", "M5 15V5h10"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  swap: ["M4 8h14", "M15 5l3 3-3 3", "M20 16H6", "M9 13l-3 3 3 3"],
  leave: ["M14 4h5v16h-5", "M10 8l-4 4 4 4", "M6 12h10"],
  chevron: ["M6 9l6 6 6-6"],
} as const;

export type IconName = keyof typeof ICONS;

export const icon = (name: IconName, className = "wallet-icon"): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};
