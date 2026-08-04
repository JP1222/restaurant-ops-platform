import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { OrderShell } from "@/components/order-shell";

/*
 * The four families ARE the Example Kitchen "Berry" brand (per the Claude Design
 * handoff). Self-hosted via next/font/local (vendored woff2 in ./fonts) so
 * `next build` stays hermetic on the self-hosted CI runners — see
 * app/fonts/README.md. Do NOT swap to Plus Jakarta / Inter / system —
 * globals.css reads these vars inside @theme.
 */
const bagel = localFont({
  src: "./fonts/bagel-fat-one-latin-400-normal.woff2",
  weight: "400",
  display: "swap",
  variable: "--font-bagel",
});

const caprasimo = localFont({
  src: "./fonts/caprasimo-latin-400-normal.woff2",
  weight: "400",
  display: "swap",
  variable: "--font-caprasimo",
});

const dmSans = localFont({
  src: "./fonts/dm-sans-latin-wght-normal.woff2",
  weight: "100 1000",
  display: "swap",
  variable: "--font-dmsans",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-geistmono",
});

export const metadata: Metadata = {
  title: "Example Kitchen — Order",
  description:
    "Order hand-rolled ice cream, bubble tea & smoothies from your phone. Skip the line — pickup at Anytown.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#E91E63",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${bagel.variable} ${caprasimo.variable} ${dmSans.variable} ${geistMono.variable}`}
    >
      <body>
        <OrderShell>{children}</OrderShell>
      </body>
    </html>
  );
}
