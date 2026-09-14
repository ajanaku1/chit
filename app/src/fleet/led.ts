/**
 * The landing's LED dot numerals (landing/public/main.js, "10. LED DOT TYPE"),
 * for the handful of headline figures. The SVG is decoration; the value sits
 * beside it as real text, so a screen reader reads it once and a copy picks
 * it up.
 */

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
  ":": ["0", "0", "1", "0", "1", "0", "0"],
};

const PITCH = 5;
const ROW = 4;
const RADIUS = 1.55;
const HEIGHT = 7 * ROW;
const SVG_NS = "http://www.w3.org/2000/svg";

export type Dot = { cx: number; cy: number };

export const canLed = (text: string): boolean => text.length > 0 && [...text].every((char) => char in GLYPHS);

export const ledDots = (text: string): { dots: Dot[]; width: number } => {
  const dots: Dot[] = [];
  let x = 0;
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`led: no glyph for ${JSON.stringify(char)}`);
    glyph.forEach((bits, row) => {
      [...bits].forEach((bit, col) => {
        if (bit === "1") dots.push({ cx: x + col * PITCH + RADIUS, cy: row * ROW + RADIUS });
      });
    });
    x += glyph[0]!.length * PITCH + PITCH;
  }
  return { dots, width: Math.max(x - PITCH, 1) };
};

/** Draws `value` into `host` as dots; anything the glyphs can't draw (like "—") stays plain text. */
export const renderLed = (host: HTMLElement, value: string, unit?: string): void => {
  host.replaceChildren();
  host.classList.add("led");
  if (canLed(value)) {
    const { dots, width } = ledDots(value);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "led__dots");
    svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const dot of dots) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(dot.cx));
      circle.setAttribute("cy", String(dot.cy));
      circle.setAttribute("r", String(RADIUS));
      svg.append(circle);
    }
    const text = document.createElement("span");
    text.className = "sr-only";
    text.textContent = value;
    host.append(svg, text);
  } else {
    const text = document.createElement("span");
    text.textContent = value;
    host.append(text);
  }
  if (unit) {
    const tag = document.createElement("span");
    tag.className = "led__unit";
    tag.textContent = unit;
    host.append(tag);
  }
};

/** Renders every `[data-led]` element under `root` from its data-led value and optional data-unit. */
export const hydrateLed = (root: ParentNode = document): void => {
  for (const host of Array.from(root.querySelectorAll<HTMLElement>("[data-led]"))) {
    renderLed(host, host.dataset["led"] ?? "", host.dataset["unit"]);
  }
};
