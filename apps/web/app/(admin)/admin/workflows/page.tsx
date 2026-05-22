import type { Metadata } from "next";
import { Plus, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Правила и макросы" };

export default function WorkflowsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Правила и макросы</h1>
          <p className="text-sm text-muted-foreground">
            Автоматизация рутинных операций
          </p>
        </div>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Создать правило
        </Button>
      </div>

      <div className="rounded-xl border border-dashed border-border p-12 text-center">
        <Zap className="mx-auto mb-3 h-8 w-8 text-muted-foreground opacity-40" />
        <p className="text-sm font-medium">Правил пока нет</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Создайте правило для автоматического назначения, изменения статуса или
          отправки уведомлений
        </p>
        <Button className="mt-4" size="sm" variant="outline">
          <Plus className="mr-1.5 h-4 w-4" />
          Создать первое правило
        </Button>
      </div>
    </div>
  );
}
