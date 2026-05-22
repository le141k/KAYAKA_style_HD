import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Пользовательские поля" };

export default function CustomFieldsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Пользовательские поля</h1>
          <p className="text-sm text-muted-foreground">
            Расширение формы заявки дополнительными полями
          </p>
        </div>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить поле
        </Button>
      </div>

      <div className="rounded-xl border border-dashed border-border p-12 text-center">
        <p className="text-sm font-medium text-muted-foreground">
          Пользовательских полей нет
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Добавьте поля для сбора дополнительной информации от клиентов
        </p>
      </div>
    </div>
  );
}
