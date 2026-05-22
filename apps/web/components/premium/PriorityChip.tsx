import { cn } from "@/lib/utils";
import type { TicketPriority } from "@/lib/types";

const PRIORITY_CONFIG: Record<
  TicketPriority,
  { label: string; classes: string }
> = {
  urgent: {
    label: "Критический",
    classes: "bg-priority-urgent/10 text-priority-urgent border-priority-urgent/20",
  },
  high: {
    label: "Высокий",
    classes: "bg-priority-high/10 text-priority-high border-priority-high/20",
  },
  normal: {
    label: "Обычный",
    classes: "bg-priority-normal/10 text-priority-normal border-priority-normal/20",
  },
  low: {
    label: "Низкий",
    classes: "bg-priority-low/10 text-priority-low border-priority-low/20",
  },
};

interface PriorityChipProps {
  priority: TicketPriority;
  className?: string;
}

export function PriorityChip({ priority, className }: PriorityChipProps) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold",
        config.classes,
        className
      )}
    >
      {config.label}
    </span>
  );
}
