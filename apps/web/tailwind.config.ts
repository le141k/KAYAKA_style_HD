import type { Config } from "tailwindcss";
import animatePlugin from "tailwindcss-animate";

const hsl = (v: string) => `hsl(var(${v}) / <alpha-value>)`;

const config: Config = {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
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
        brand: {
          500: hsl("--brand-500"),
          600: hsl("--brand-600"),
          700: hsl("--brand-700"),
        },
        indigo: { 500: hsl("--indigo-500") },
        status: {
          open: hsl("--status-open"),
          pending: hsl("--status-pending"),
          progress: hsl("--status-progress"),
          resolved: hsl("--status-resolved"),
          closed: hsl("--status-closed"),
        },
        sla: {
          ok: hsl("--sla-ok"),
          warn: hsl("--sla-warn"),
          breach: hsl("--sla-breach"),
        },
        priority: {
          urgent: hsl("--priority-urgent"),
          high: hsl("--priority-high"),
          normal: hsl("--priority-normal"),
          low: hsl("--priority-low"),
        },
        chart: {
          1: hsl("--chart-1"),
          2: hsl("--chart-2"),
          3: hsl("--chart-3"),
          4: hsl("--chart-4"),
          5: hsl("--chart-5"),
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        "brand-glow": "0 0 0 3px hsl(var(--primary) / 0.2)",
        "drag-glow": "0 8px 32px hsl(var(--primary) / 0.35)",
      },
      keyframes: {
        "status-pulse": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "drag-glow": {
          "0%,100%": { boxShadow: "0 0 0 0 hsl(var(--primary) / 0.0)" },
          "50%": { boxShadow: "0 0 0 4px hsl(var(--primary) / 0.25)" },
        },
        "bell-shake": {
          "0%,100%": { transform: "rotate(0deg)" },
          "20%": { transform: "rotate(-12deg)" },
          "40%": { transform: "rotate(12deg)" },
          "60%": { transform: "rotate(-8deg)" },
          "80%": { transform: "rotate(8deg)" },
        },
        "count-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(100%)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%": { transform: "translateY(16px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "status-pulse": "status-pulse 1.2s ease-in-out 2",
        "drag-glow": "drag-glow 1.2s ease-in-out infinite",
        "bell-shake": "bell-shake 0.5s ease-in-out",
        "count-up": "count-up 0.4s ease-out",
        "slide-in-right": "slide-in-right 0.3s ease-out",
        "fade-in": "fade-in 0.2s ease-out",
        "slide-up": "slide-up 0.3s ease-out",
        shimmer: "shimmer 2s linear infinite",
      },
    },
  },
  plugins: [animatePlugin],
};

export default config;
