"use client";

import React, { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { I18nContext, getDictionary, type Locale } from "@/lib/i18n";
import { AuthProvider } from "@/lib/auth/auth-context";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [locale, setLocale] = useState<Locale>("ru");
  const t = getDictionary(locale);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <I18nContext.Provider value={{ locale, t, setLocale }}>
          <AuthProvider>{children}</AuthProvider>
        </I18nContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
