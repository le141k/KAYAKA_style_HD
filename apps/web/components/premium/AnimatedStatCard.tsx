"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface AnimatedStatCardProps {
  title: string;
  value: number;
  suffix?: string;
  icon: LucideIcon;
  trend?: { value: number; label: string };
  colorClass?: "brand" | "cyan" | "indigo" | "amber" | "green" | "red";
  className?: string;
}

const COLOR_CONFIGS = {
  brand: {
    gradient: "from-brand-700 to-brand-500",
    iconBg: "bg-brand-600/10",
    iconColor: "text-brand-600",
    sparkColor: "hsl(var(--brand-600))",
  },
  cyan: {
    gradient: "from-[hsl(189_94%_33%)] to-[hsl(var(--accent))]",
    iconBg: "bg-accent/10",
    iconColor: "text-accent",
    sparkColor: "hsl(var(--accent))",
  },
  indigo: {
    gradient: "from-indigo-500 to-indigo-500/70",
    iconBg: "bg-indigo-500/10",
    iconColor: "text-indigo-500",
    sparkColor: "hsl(var(--indigo-500))",
  },
  amber: {
    gradient: "from-status-pending to-status-pending/70",
    iconBg: "bg-status-pending/10",
    iconColor: "text-status-pending",
    sparkColor: "hsl(var(--status-pending))",
  },
  green: {
    gradient: "from-status-resolved to-status-resolved/70",
    iconBg: "bg-status-resolved/10",
    iconColor: "text-status-resolved",
    sparkColor: "hsl(var(--sla-ok))",
  },
  red: {
    gradient: "from-destructive to-destructive/70",
    iconBg: "bg-destructive/10",
    iconColor: "text-destructive",
    sparkColor: "hsl(var(--destructive))",
  },
};

function useCountUp(target: number, duration = 1200) {
  const [count, setCount] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const start = Date.now();
    const step = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(eased * target));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      }
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return count;
}

// Tiny sparkline using SVG
function Sparkline({
  data,
  color,
}: {
  data: number[];
  color: string;
}) {
  const max = Math.max(...data, 1);
  const w = 80;
  const h = 28;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * h;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="opacity-60"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AnimatedStatCard({
  title,
  value,
  suffix,
  icon: Icon,
  trend,
  colorClass = "brand",
  className,
}: AnimatedStatCardProps) {
  const config = COLOR_CONFIGS[colorClass];
  const displayValue = useCountUp(value);
  // Generate pseudo-sparkline data
  const sparkData = Array.from({ length: 7 }, (_, i) =>
    Math.max(1, Math.round(value * (0.5 + 0.1 * i + Math.sin(i * 0.8) * 0.2)))
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm",
        className
      )}
    >
      {/* Gradient bar on top */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r",
          config.gradient
        )}
      />

      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{title}</p>
          <p className="font-mono text-2xl font-bold tracking-tight">
            {displayValue.toLocaleString("ru-RU")}
            {suffix && (
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {suffix}
              </span>
            )}
          </p>
          {trend && (
            <p
              className={cn(
                "text-xs",
                trend.value >= 0 ? "text-status-resolved" : "text-destructive"
              )}
            >
              {trend.value >= 0 ? "+" : ""}
              {trend.value}% {trend.label}
            </p>
          )}
        </div>

        <div className={cn("rounded-lg p-2.5", config.iconBg)}>
          <Icon className={cn("h-5 w-5", config.iconColor)} />
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Sparkline data={sparkData} color={config.sparkColor} />
      </div>
    </motion.div>
  );
}
