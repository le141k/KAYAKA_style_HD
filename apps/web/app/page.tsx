import { redirect } from "next/navigation";

// Root → redirect to client portal
export default function RootPage() {
  redirect("/kb");
}
