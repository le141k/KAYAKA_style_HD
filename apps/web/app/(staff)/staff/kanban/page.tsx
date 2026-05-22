import type { Metadata } from "next";
import { KanbanPageContent } from "./kanban-content";

export const metadata: Metadata = { title: "Канбан" };

export default function KanbanPage() {
  return <KanbanPageContent />;
}
