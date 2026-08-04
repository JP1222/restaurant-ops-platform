import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";

// Brand display face for the wordmark and big glanceable order labels.
const bagelFatOne = localFont({
  src: "./fonts/bagel-fat-one-latin-400-normal.woff2",
  weight: "400",
  variable: "--font-bagel",
  display: "swap"
});

// Rounded, friendly sans for titles, kickers, and item text.
const nunito = localFont({
  src: "./fonts/nunito-latin-wght-normal.woff2",
  weight: "200 1000",
  variable: "--font-nunito",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Example Kitchen KDS",
  description: "Realtime Clover kitchen display system"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${bagelFatOne.variable} ${nunito.variable}`}>{children}</body>
    </html>
  );
}
