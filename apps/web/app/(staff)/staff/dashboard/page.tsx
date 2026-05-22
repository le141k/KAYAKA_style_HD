import type { Metadata } from "next";
import { DashboardContent } from "./dashboard-content";

export const metadata: Metadata = {
  title: "Дашборд",
};

export default function DashboardPage() {
  return <DashboardContent />;
}
