"use client";

import { createContext, useContext } from "react";
import { ru } from "./ru";
import { en } from "./en";
import { uk } from "./uk";
import type { Dictionary } from "./ru";

export type Locale = "ru" | "en" | "uk";

const dictionaries: Record<Locale, Dictionary> = { ru, en, uk };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? dictionaries.ru;
}

export const I18nContext = createContext<{
  locale: Locale;
  t: Dictionary;
  setLocale: (locale: Locale) => void;
}>({
  locale: "ru",
  t: ru,
  setLocale: () => {},
});

export function useI18n() {
  return useContext(I18nContext);
}

export type { Dictionary };
