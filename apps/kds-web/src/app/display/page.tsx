import { cookies } from "next/headers";
import React from "react";
import { CustomerDisplayScreen } from "@/components/customer-display-screen";
import { DEVICE_MERCHANT_COOKIE_NAME, DEVICE_TOKEN_COOKIE_NAME } from "@/lib/device-cookie";
import { pickSearchParam, type SearchParamsRecord } from "@/lib/search-params";

export default async function DisplayPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;

  // Device pairing (ADR-0818 Phase-2b): a paired order-ready display carries a
  // same-origin device-token cookie. When present, scope the screen to the
  // device's bound store — kds-api proves that store from the token on every
  // /api/display/* call + the /ws/display handshake (and requires it once
  // MULTITENANT_MODE=enforce). Falls back to the public ?merchantId= kiosk path
  // for an unpaired display (today's behavior, unchanged under off-mode).
  const jar = await cookies();
  const deviceMerchant = jar.get(DEVICE_TOKEN_COOKIE_NAME)?.value
    ? jar.get(DEVICE_MERCHANT_COOKIE_NAME)?.value ?? ""
    : "";

  const merchantId =
    deviceMerchant || pickSearchParam(params.merchantId) || process.env.NEXT_PUBLIC_DEFAULT_MERCHANT_ID || "";

  return (
    <CustomerDisplayScreen
      initialMerchantId={merchantId}
    />
  );
}
