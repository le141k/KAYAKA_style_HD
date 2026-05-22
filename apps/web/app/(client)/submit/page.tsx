import type { Metadata } from "next";
import { SubmitTicketForm } from "./submit-form";

export const metadata: Metadata = { title: "Новое обращение" };

export default function SubmitPage() {
  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Новое обращение</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Опишите проблему, и специалист ответит в кратчайшие сроки.
        </p>
      </div>
      <SubmitTicketForm />
    </div>
  );
}
