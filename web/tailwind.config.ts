import type { Config } from "tailwindcss";

/* The palette and the radii are the design system's; nothing here is a new value. */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        coral: { DEFAULT: "#FF5A3C", lift: "#FF7A5C", deep: "#7A2415" },
        paper: { DEFAULT: "#F5EFE5", soft: "#DED6CA" },
        ink: "#171513",
        void: "#0A0908",
        surface: "#121110",
        live: "#4BD37B",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: { card: "20px", inner: "12px" },
      maxWidth: { wide: "1240px" },
      transitionTimingFunction: { out: "cubic-bezier(0.22, 1, 0.36, 1)" },
    },
  },
  plugins: [],
};
export default config;
