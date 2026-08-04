import { cookies } from "next/headers";

import { BoardScreen } from "@/components/board-screen";
import { DEVICE_MERCHANT_COOKIE_NAME, DEVICE_TOKEN_COOKIE_NAME } from "@/lib/device-cookie";
import { pickSearchParam, searchParamsToQueryString, type SearchParamsRecord } from "@/lib/search-params";
import { getServerPasskeys, requireServerAuthSession } from "@/lib/server-auth";

export default async function BoardPage({
  searchParams
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const params = await searchParams;
  const boardTimeZone = process.env.BOARD_TIMEZONE || process.env.NEXT_PUBLIC_BOARD_TIMEZONE || "UTC";
  const drawer = pickSearchParam(params.drawer);
  const initialDrawer = drawer === "settings" ? "settings" : drawer === "completed" ? "completed" : null;

  // Device pairing (ADR-0818 Phase-2b): a paired device carries a same-origin
  // device-token cookie. When present, boot straight into the bound store's board
  // — no login, no store-id entry. kds-api resolves + access-checks the store from
  // the token on every call; the merchant cookie just scopes the board's own
  // requests. Falls through to the existing session board otherwise (unchanged).
  const jar = await cookies();
  if (jar.get(DEVICE_TOKEN_COOKIE_NAME)?.value) {
    const deviceMerchant = jar.get(DEVICE_MERCHANT_COOKIE_NAME)?.value ?? "";
    return (
      <BoardScreen
        initialBoardTimeZone={boardTimeZone}
        initialDrawer={initialDrawer}
        initialMerchantId={deviceMerchant}
        initialPasskeys={[]}
      />
    );
  }

  const serialized = searchParamsToQueryString(params, { leadingQuestionMark: false });
  const session = await requireServerAuthSession(serialized ? `/board?${serialized}` : "/board");
  const passkeys = await getServerPasskeys();
  const merchantId = pickSearchParam(params.merchantId) || process.env.NEXT_PUBLIC_DEFAULT_MERCHANT_ID || "";

  return (
    <BoardScreen
      authSession={session}
      initialBoardTimeZone={boardTimeZone}
      initialDrawer={initialDrawer}
      initialMerchantId={merchantId}
      initialPasskeys={passkeys}
    />
  );
}
