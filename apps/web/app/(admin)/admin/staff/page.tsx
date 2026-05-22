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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MOCK_USERS } from "@/lib/mock-data";
import { getInitials } from "@/lib/utils";

export const metadata: Metadata = { title: "Сотрудники и группы" };

const ROLE_LABELS: Record<string, string> = {
  admin: "Администратор",
  agent: "Агент",
  client: "Клиент",
};

export default function StaffPage() {
  const staffUsers = MOCK_USERS.filter((u) => u.role !== "client");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Сотрудники и группы</h1>
          <p className="text-sm text-muted-foreground">
            Управление агентами, ролями и группами
          </p>
        </div>
        <Button size="sm">
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить сотрудника
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сотрудник</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Роль</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staffUsers.map((user) => (
              <TableRow key={user.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="text-xs">
                        {getInitials(user.name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="font-medium text-sm">{user.name}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {user.email}
                </TableCell>
                <TableCell>
                  <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                    {ROLE_LABELS[user.role] ?? user.role}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
