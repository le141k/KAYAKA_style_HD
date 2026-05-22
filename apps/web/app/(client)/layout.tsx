import Link from "next/link";
import { ThemeToggle } from "@/components/premium/ThemeToggle";
import { LocaleSwitcher } from "@/components/premium/LocaleSwitcher";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      {/* Simple client topbar */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-brand text-white text-xs font-bold">
              23
            </div>
            <span className="text-sm font-semibold">Служба поддержки</span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Главная навигация">
            <Link
              href="/submit"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Новое обращение
            </Link>
            <Link
              href="/tickets"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Мои заявки
            </Link>
            <Link
              href="/kb"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              База знаний
            </Link>
          </nav>

          <div className="flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
            <Link
              href="/login"
              className="ml-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Войти
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        © 2024 23 Telecom · Служба поддержки ·{" "}
        <a href="tel:+7800000000" className="hover:text-foreground">
          8-800-000-00-00
        </a>
      </footer>
    </div>
  );
}
