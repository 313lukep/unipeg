import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/instrument-sans";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "unipegPFP",
  description:
    "Turn your Unipeg into a profile picture that survives the crop.",
};

/**
 * Applies the stored (or system) theme to <html data-theme> before first
 * paint — no flash of the wrong theme. Kept dependency-free and inline.
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem("unipegpfp.theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.setAttribute("data-theme",t)}catch(e){document.documentElement.setAttribute("data-theme","light")}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="u-transition-piece">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-screen flex-col bg-paper font-sans text-ink">
        {children}
      </body>
    </html>
  );
}
