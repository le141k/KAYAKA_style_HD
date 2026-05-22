"use client";

import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import type { TicketStatus } from "@/lib/types";

const STATUS_CONFIG: Record<
  TicketStatus,
  { label: string; dotClass: string; badgeClass: string }
> = {
  open: {
    label: "Открыта",
    dotClass: "bg-status-open",
    badgeClass:
      "bg-status-open/10 text-status-open border-status-open/20",
  },
  pending: {
    label: "Ожидает",
    dotClass: "bg-status-pending",
    badgeClass:
      "bg-status-pending/10 text-status-pending border-status-pending/20",
  },
  in_progress: {
    label: "В работе",
    dotClass: "bg-status-progress",
    badgeClass:
      "bg-status-progress/10 text-status-progress border-status-progress/20",
  },
  resolved: {
    label: "Решена",
    dotClass: "bg-status-resolved",
    badgeClass:
      "bg-status-resolved/10 text-status-resolved border-status-resolved/20",
  },
  closed: {
    label: "Закрыта",
    dotClass: "bg-status-closed",
    badgeClass:
      "bg-status-closed/10 text-status-closed border-status-closed/20",
  },
};

interface StatusBadgeProps {
  status: TicketStatus;
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({
  status,
  pulse = false,
  size = "md",
  className,
}: StatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <AnimatePresence mode="wait">
      <motion.span
        key={status}
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ duration: 0.15 }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border font-medium",
          size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs",
          config.badgeClass,
          className
        )}
      >
        <span className="relative flex items-center justify-center">
          {pulse && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
                config.dotClass
              )}
            />
          )}
          <span
            className={cn(
              "relative inline-flex rounded-full",
              size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
              config.dotClass
            )}
          />
        </span>
        {config.label}
      </motion.span>
    </AnimatePresence>
  );
}
