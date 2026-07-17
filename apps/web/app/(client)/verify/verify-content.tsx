'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVerifyClientToken } from '@/lib/hooks/use-client-auth';

type Phase = 'verifying' | 'success' | 'invalid' | 'error';

export function VerifyContent() {
  const router = useRouter();
  const verify = useVerifyClientToken();
  const [phase, setPhase] = useState<Phase>('verifying');
  // Guard against React 18 StrictMode double-invoke consuming the single-use token twice.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // The login token arrives in the URL FRAGMENT (#token=…) so it never reaches the
    // server / proxy access logs. Read it once, then immediately strip it from the address
    // bar (history.replaceState) so it isn't left in the URL, history, or any later Referer.
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const token = new URLSearchParams(hash).get('token') ?? '';
    if (token) window.history.replaceState(null, '', window.location.pathname);

    if (!token) {
      setPhase('invalid');
      return;
    }
    verify
      .mutateAsync(token)
      .then(() => setPhase('success'))
      .catch((e: unknown) => {
        // 401 = the token is invalid, used or expired; anything else is an unexpected failure.
        setPhase((e as { status?: number }).status === 401 ? 'invalid' : 'error');
      });
    // The startedRef guard makes this run its side effect exactly once (single-use token),
    // even though `verify` gets a fresh identity each render.
  }, [verify]);

  // On success, land the customer in their ticket list.
  useEffect(() => {
    if (phase !== 'success') return;
    const t = setTimeout(() => router.replace('/tickets'), 1200);
    return () => clearTimeout(t);
  }, [phase, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm space-y-6 text-center"
      >
        <div className="flex items-center justify-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand text-white">
            <span className="text-sm font-bold">23</span>
          </div>
          <span className="text-lg font-bold">23T Help Desk</span>
        </div>

        {phase === 'verifying' && (
          <div className="rounded-xl border border-border p-6">
            <Loader2 className="mx-auto mb-3 h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Проверяем ссылку для входа…</p>
          </div>
        )}

        {phase === 'success' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-xl border border-primary/20 bg-primary/5 p-6"
          >
            <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-primary" />
            <h2 className="font-bold">Вход выполнен</h2>
            <p className="mt-2 text-sm text-muted-foreground">Открываем ваши обращения…</p>
          </motion.div>
        )}

        {(phase === 'invalid' || phase === 'error') && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
            <h2 className="font-bold">
              {phase === 'invalid' ? 'Ссылка недействительна' : 'Что-то пошло не так'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {phase === 'invalid'
                ? 'Ссылка для входа устарела или уже использована. Запросите новую.'
                : 'Не удалось выполнить вход. Попробуйте запросить ссылку ещё раз.'}
            </p>
            <Button className="mt-4" variant="outline" onClick={() => router.replace('/tickets')}>
              Запросить новую ссылку
            </Button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
