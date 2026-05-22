import type { Config } from "tailwindcss";

/**
 * 23 Telecom Help Desk — Tailwind preset ("Telecom Signal").
 * Consumed by apps/web/tailwind.config.ts. Maps shadcn HSL CSS vars + brand/status tokens.
 */
const hsl = (v: string) => `hsl(var(${v}) / <alpha-value>)`;

const preset: Partial<Config> = {
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        border: hsl("--border"),
        input: hsl("--input"),
        ring: hsl("--ring"),
        background: hsl("--background"),
        foreground: hsl("--foreground"),
        primary: { DEFAULT: hsl("--primary"), foreground: hsl("--primary-foreground") },
        secondary: { DEFAULT: hsl("--secondary"), foreground: hsl("--secondary-foreground") },
        destructive: { DEFAULT: hsl("--destructive"), foreground: hsl("--destructive-foreground") },
        muted: { DEFAULT: hsl("--muted"), foreground: hsl("--muted-foreground") },
        accent: { DEFAULT: hsl("--accent"), foreground: hsl("--accent-foreground") },
        popover: { DEFAULT: hsl("--popover"), foreground: hsl("--popover-foreground") },
        card: { DEFAULT: hsl("--card"), foreground: hsl("--card-foreground") },
        brand: { 500: hsl("--brand-500"), 600: hsl("--brand-600"), 700: hsl("--brand-700") },
        indigo: { 500: hsl("--indigo-500") },
        status: {
          open: hsl("--status-open"), pending: hsl("--status-pending"),
          progress: hsl("--status-progress"), resolved: hsl("--status-resolved"),
          closed: hsl("--status-closed"),
        },
        sla: { ok: hsl("--sla-ok"), warn: hsl("--sla-warn"), breach: hsl("--sla-breach") },
        priority: {
          urgent: hsl("--priority-urgent"), high: hsl("--priority-high"),
          normal: hsl("--priority-normal"), low: hsl("--priority-low"),
        },
        chart: {
          1: hsl("--chart-1"), 2: hsl("--chart-2"), 3: hsl("--chart-3"),
          4: hsl("--chart-4"), 5: hsl("--chart-5"),
        },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      fontFamily: {
        sans: ["Inter", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      boxShadow: { sm: "var(--shadow-sm)", md: "var(--shadow-md)" },
      keyframes: {
        "status-pulse": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "drag-glow": {
          "0%,100%": { boxShadow: "0 0 0 0 hsl(var(--primary) / 0.0)" },
          "50%": { boxShadow: "0 0 0 4px hsl(var(--primary) / 0.25)" },
        },
      },
      animation: {
        "status-pulse": "status-pulse 1.2s ease-in-out 2",
        "drag-glow": "drag-glow 1.2s ease-in-out infinite",
      },
    },
  },
};

export default preset;
