"use client";

import { cn } from "@/lib/utils";
import { Clock, AlertTriangle, CheckCircle2 } from "lucide-react";

interface SlaPillProps {
  dueAt?: string | null;
  className?: string;
}

function getSlaState(dueAt: string | null | undefined) {
  if (!dueAt) return null;
  const due = new Date(dueAt).getTime();
  const now = Date.now();
  const diff = due - now;
  const minutesLeft = Math.round(diff / 60_000);

  if (diff < 0) return { state: "breach" as const, label: "SLA нарушен", minutesLeft };
  if (minutesLeft < 60) return { state: "warn" as const, label: `${minutesLeft} мин`, minutesLeft };
  const hoursLeft = Math.round(minutesLeft / 60);
  return { state: "ok" as const, label: `${hoursLeft} ч`, minutesLeft };
}

export function SlaPill({ dueAt, className }: SlaPillProps) {
  const sla = getSlaState(dueAt);
  if (!sla) return null;

  const configs = {
    ok: {
      classes: "bg-sla-ok/10 text-sla-ok border-sla-ok/20",
      Icon: CheckCircle2,
    },
    warn: {
      classes: "bg-sla-warn/10 text-sla-warn border-sla-warn/20",
      Icon: Clock,
    },
    breach: {
      classes: "bg-sla-breach/10 text-sla-breach border-sla-breach/20",
      Icon: AlertTriangle,
    },
  };

  const { classes, Icon } = configs[sla.state];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        classes,
        sla.state === "breach" && "animate-status-pulse",
        className
      )}
      aria-label={`SLA: ${sla.label}`}
    >
      <Icon className="h-3 w-3" />
      {sla.label}
    </span>
  );
}
