import type { Metadata } from "next";
import { HubClient } from "./hub-client";

export const metadata: Metadata = {
  title: "Hub · Example Kitchen Backoffice",
};

export default function HubPage() {
  return <HubClient />;
}
