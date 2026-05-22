import type { Metadata } from "next";
import { Wifi, Construction } from "lucide-react";

export const metadata: Metadata = { title: "Интеграция Alaris" };

export default function AlarisPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Интеграция Alaris</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Подключение к платформе Alaris для телеком-мониторинга
        </p>
      </div>

      {/* Coming soon banner */}
      <div className="rounded-2xl border border-dashed border-indigo-500/40 bg-indigo-500/5 p-10 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-500/10">
          <Construction className="h-8 w-8 text-indigo-500" />
        </div>
        <h2 className="text-xl font-bold">Скоро</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Интеграция с платформой Alaris находится в разработке. Следите за
          обновлениями. Планируется поддержка webhook-уведомлений, автоматическое
          создание заявок по порогам SLA и bi-directional sync.
        </p>
      </div>

      {/* Non-functional placeholder form */}
      <div className="rounded-xl border border-border bg-card p-6 opacity-60 pointer-events-none select-none" aria-hidden="true">
        <h3 className="mb-4 text-base font-semibold flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Пороговые значения (не активно)
        </h3>
        <div className="grid grid-cols-2 gap-4">
          {[
            "Порог пакетных потерь, %",
            "Порог latency, мс",
            "Порог доступности, %",
            "Интервал проверки, сек",
          ].map((label) => (
            <div key={label} className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">
                {label}
              </label>
              <input
                disabled
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm opacity-50 cursor-not-allowed"
                placeholder="—"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
