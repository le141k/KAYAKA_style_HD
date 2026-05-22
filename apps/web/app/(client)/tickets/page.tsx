import type { Metadata } from "next";
import { ClientTicketsContent } from "./client-tickets-content";

export const metadata: Metadata = { title: "Мои заявки" };

export default function ClientTicketsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Мои обращения</h1>
        <p className="text-sm text-muted-foreground">
          История ваших обращений в службу поддержки
        </p>
      </div>
      <ClientTicketsContent />
    </div>
  );
}
