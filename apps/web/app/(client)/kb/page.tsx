import type { Metadata } from "next";
import { KBContent } from "./kb-content";

export const metadata: Metadata = { title: "База знаний" };

export default function KBPage() {
  return <KBContent />;
}
