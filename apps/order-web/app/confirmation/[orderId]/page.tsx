import { Confirmation } from "@/components/screens/Confirmation";

export default async function Page({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return <Confirmation orderId={orderId} />;
}
