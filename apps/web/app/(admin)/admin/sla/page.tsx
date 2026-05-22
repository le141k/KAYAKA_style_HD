import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "SLA-планы" };

const SLA_PLANS = [
  { id: 1, name: "Стандарт", first_response: 60, resolution: 480 },
  { id: 2, name: "Приоритет", first_response: 30, resolution: 240 },
  { id: 3, name: "Критический", first_response: 15, resolution: 120 },
];

export default function SLAPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">SLA-планы</h1>
          <p className="text-sm text-muted-foreground">
            Настройка временных ограничений для заявок
          </p>
        </div>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить план
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Первый ответ</TableHead>
              <TableHead>Решение</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SLA_PLANS.map((plan) => (
              <TableRow key={plan.id}>
                <TableCell className="font-medium">{plan.name}</TableCell>
                <TableCell className="font-mono text-sm">
                  {plan.first_response < 60
                    ? `${plan.first_response} мин`
                    : `${plan.first_response / 60} ч`}
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {plan.resolution < 60
                    ? `${plan.resolution} мин`
                    : `${plan.resolution / 60} ч`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
