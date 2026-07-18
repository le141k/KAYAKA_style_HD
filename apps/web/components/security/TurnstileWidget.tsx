'use client';

import Script from 'next/script';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (target: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export interface TurnstileWidgetHandle {
  reset: () => void;
}

interface TurnstileWidgetProps {
  action: 'ticket-create' | 'request-link' | 'public-upload';
  onToken: (token: string | undefined) => void;
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

/** Explicit, action-bound Turnstile widget. The response token stays in memory only. */
export const TurnstileWidget = forwardRef<TurnstileWidgetHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ action, onToken }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | undefined>(undefined);
    const tokenCallback = useRef(onToken);
    tokenCallback.current = onToken;

    const render = useCallback(() => {
      if (!SITE_KEY || !hostRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(hostRef.current, {
        sitekey: SITE_KEY,
        action,
        theme: 'auto',
        callback: (token: string) => tokenCallback.current(token),
        'expired-callback': () => tokenCallback.current(undefined),
        'error-callback': () => tokenCallback.current(undefined),
      });
    }, [action]);

    useEffect(() => {
      if (!SITE_KEY && process.env.NODE_ENV !== 'production') tokenCallback.current('dev-bypass');
      render();
      return () => {
        if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = undefined;
      };
    }, [render]);

    useImperativeHandle(ref, () => ({
      reset: () => {
        tokenCallback.current(undefined);
        if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
      },
    }));

    if (!SITE_KEY && process.env.NODE_ENV === 'production') {
      return <p className="text-xs text-destructive">Проверка безопасности временно недоступна.</p>;
    }
    return (
      <>
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
          onLoad={render}
        />
        <div ref={hostRef} className="min-h-[65px]" aria-label="Проверка безопасности" />
      </>
    );
  },
);
