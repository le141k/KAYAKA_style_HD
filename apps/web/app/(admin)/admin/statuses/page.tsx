import type { Metadata } from "next";
import { StatusBadge } from "@/components/premium/StatusBadge";
import { PriorityChip } from "@/components/premium/PriorityChip";
import type { TicketStatus, TicketPriority } from "@/lib/types";

export const metadata: Metadata = { title: "Статусы и приоритеты" };

const STATUSES: TicketStatus[] = ["open", "pending", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["urgent", "high", "normal", "low"];

export default function StatusesPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Статусы и приоритеты</h1>
        <p className="text-sm text-muted-foreground">
          Конфигурация жизненного цикла заявок
        </p>
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Статусы заявок</h2>
        <div className="flex flex-wrap gap-3">
          {STATUSES.map((s) => (
            <div key={s} className="rounded-lg border border-border bg-card p-4">
              <StatusBadge status={s} />
              <p className="mt-2 text-xs font-mono text-muted-foreground">{s}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Приоритеты</h2>
        <div className="flex flex-wrap gap-3">
          {PRIORITIES.map((p) => (
            <div key={p} className="rounded-lg border border-border bg-card p-4">
              <PriorityChip priority={p} />
              <p className="mt-2 text-xs font-mono text-muted-foreground">{p}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
