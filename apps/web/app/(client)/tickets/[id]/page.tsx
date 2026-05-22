import type { Metadata } from "next";
import { ClientTicketDetail } from "./client-ticket-detail";

export const metadata: Metadata = { title: "Обращение" };

export default async function ClientTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ClientTicketDetail ticketId={parseInt(id, 10)} />;
}
