import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, League_Spartan, Poppins } from "next/font/google";

import "./globals.css";

const display = League_Spartan({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display", display: "swap" });
const body = Poppins({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-body", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

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
