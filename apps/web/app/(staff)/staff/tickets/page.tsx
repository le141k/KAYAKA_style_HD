import type { Metadata } from "next";
import { TicketsListContent } from "./tickets-list-content";

export const metadata: Metadata = { title: "Заявки" };

export default function TicketsPage() {
  return <TicketsListContent />;
}
