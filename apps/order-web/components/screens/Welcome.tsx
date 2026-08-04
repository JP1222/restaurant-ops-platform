"use client";

import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/brand-visuals";

/**
 * Welcome — the brand moment. Storefront video fills the screen behind a warm
 * scrim; the wordmark, tagline, and one big "Start your order" CTA sit in the
 * thumb zone. Butter background shows through before the video loads.
 */
export function Welcome() {
  const router = useRouter();
  return (
    <div className="yr" style={{ background: "var(--butter)" }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <video
          autoPlay
          muted
          loop
          playsInline
          poster="/storefront-photo.webp"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        >
          <source src="/video/storefront.mp4" type="video/mp4" />
        </video>
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(180deg, rgba(42,23,34,.28) 0%, rgba(42,23,34,.10) 38%, rgba(42,23,34,.78) 100%)",
          }}
        />
      </div>

      <div
        style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          textAlign: "center",
          padding: "0 24px 48px",
          color: "#fff",
        }}
      >
        <span className="eyebrow" style={{ color: "rgba(255,255,255,.85)", marginBottom: 14 }}>
          Anytown Mall · Anytown
        </span>
        <Wordmark size={64} style={{ filter: "drop-shadow(0 4px 14px rgba(0,0,0,.35))" }} />
        <h1 className="disp" style={{ fontSize: "clamp(34px,9vw,56px)", margin: "14px 0 8px", color: "#fff" }}>
          You only ROLL once.
        </h1>
        <p style={{ maxWidth: 320, fontSize: 16, lineHeight: 1.5, color: "rgba(255,255,255,.9)", marginBottom: 26 }}>
          Hand-rolled ice cream, bubble tea &amp; smoothies. Order from your phone, skip the line — the show happens when you arrive.
        </p>
        <button className="btn btn-lg btn-block press" type="button" onClick={() => router.push("/menu")} style={{ maxWidth: 420 }}>
          Start your order →
        </button>
        <p style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: "rgba(255,255,255,.7)" }}>
          Pickup only · real prices, no hidden fees
        </p>
      </div>
    </div>
  );
}
