'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { I18nContext, getDictionary, type Locale } from '@/lib/i18n';
import { AuthProvider } from '@/lib/auth/auth-context';

const LOCALE_STORAGE_KEY = 'preferred_locale';

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
  if (typeof window === 'undefined') return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/** Read locale from localStorage; fall back to "ru" if missing or invalid. */
function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'ru';
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === 'ru' || stored === 'en' || stored === 'uk') return stored;
  return 'ru';
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  // Initialise from localStorage on first client render.
  const [locale, setLocaleState] = useState<Locale>('ru');

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    setLocaleState(readStoredLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    }
  }, []);

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
