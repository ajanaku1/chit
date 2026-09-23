import type { Metadata, Viewport } from "next";

import "@fleet-app/styles/tokens.css";
import "@fleet-app/styles/components.css";
import "@fleet-app/styles/pages.css";

/* The app's own root: its stylesheet is chit-fleet's (the site's look), and its pages scroll like pages. */
export const metadata: Metadata = { title: "Chit", icons: { icon: "/app/favicon.svg" } };
export const viewport: Viewport = { themeColor: "#171513", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="fleet-body">{children}</body>
    </html>
  );
}
