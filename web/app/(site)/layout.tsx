import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

// The typefaces the app ships (app/src/fonts), so the build fetches nothing and the site loads nothing from a third party.
const display = localFont({ src: "../../../app/src/fonts/LeagueSpartan.woff2", weight: "600 800", variable: "--font-display", display: "swap" });
const body = localFont({
  src: [
    { path: "../../../app/src/fonts/Poppins-400.woff2", weight: "400" },
    { path: "../../../app/src/fonts/Poppins-500.woff2", weight: "500" },
    { path: "../../../app/src/fonts/Poppins-600.woff2", weight: "600" },
  ],
  variable: "--font-body",
  display: "swap",
});
const mono = localFont({
  src: [
    { path: "../../../app/src/fonts/IBMPlexMono-400.woff2", weight: "400" },
    { path: "../../../app/src/fonts/IBMPlexMono-500.woff2", weight: "500" },
  ],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Chit",
  description: "A private line for a public fleet. The funding layer and the Telegram bot for Robinhood Chain.",
};

export const viewport: Viewport = { themeColor: "#0A0908", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
