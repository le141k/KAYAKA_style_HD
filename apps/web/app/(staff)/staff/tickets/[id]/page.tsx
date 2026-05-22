import type { Metadata } from "next";
import { TicketDetailContent } from "./ticket-detail-content";

export const metadata: Metadata = { title: "Заявка" };

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ticketId = parseInt(id, 10);
  return <TicketDetailContent ticketId={ticketId} />;
}
