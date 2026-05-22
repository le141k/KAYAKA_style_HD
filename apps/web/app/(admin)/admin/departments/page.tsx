import type { Metadata } from "next";
import { DepartmentsContent } from "./departments-content";

export const metadata: Metadata = { title: "Отделы" };

export default function DepartmentsPage() {
  return <DepartmentsContent />;
}
