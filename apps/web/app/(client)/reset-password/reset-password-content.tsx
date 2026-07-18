'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { Lock, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { fetchWithCsrf } from '@/lib/api';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

const resetSchema = z
  .object({
    password: z.string().min(8, 'Минимум 8 символов'),
    confirm: z.string().min(1, 'Подтвердите пароль'),
  })
  .refine((d) => d.password === d.confirm, {
    message: 'Пароли не совпадают',
    path: ['confirm'],
  });

type ResetForm = z.infer<typeof resetSchema>;

export function ResetPasswordContent() {
  const router = useRouter();

  // The reset token arrives in the URL FRAGMENT (#token=…) so it never reaches the
  // server / proxy access logs. Read it once on mount, then immediately strip it from
  // the address bar with history.replaceState so it isn't left in the URL, browser
  // history, or any later Referer. Query-string tokens are deliberately rejected.
  const [token, setToken] = useState('');
  const [tokenResolved, setTokenResolved] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const fromHash = new URLSearchParams(hash).get('token');
    const resolved = fromHash ?? '';
    setToken(resolved);
    setTokenResolved(true);
    if (resolved) {
      // Drop the fragment from the visible URL.
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(resetSchema) });

  // Only flag a missing token once we've actually parsed the URL (avoids a flash of
  // the error state before the fragment is read on mount).
  const missingToken = tokenResolved && !token;

  const onSubmit = async (data: ResetForm) => {
    try {
      const res = await fetchWithCsrf(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password: data.password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError('root', {
          message: body.message ?? 'Ссылка недействительна или устарела. Запросите новую.',
        });
        return;
      }
      setDone(true);
    } catch {
      setError('root', { message: 'Ошибка сети. Попробуйте ещё раз.' });
    }
  };

  // Auto-redirect to login after success
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => router.replace('/login'), 3000);
    return () => clearTimeout(t);
  }, [done, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm space-y-6"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-brand text-white">
            <span className="text-sm font-bold">23</span>
          </div>
          <span className="text-lg font-bold">23T Help Desk</span>
        </div>

        {missingToken ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" />
            <h2 className="font-bold">Недействительная ссылка</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Ссылка для сброса пароля не содержит токен. Запросите новое письмо.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => router.replace('/login')}>
              К странице входа
            </Button>
          </div>
        ) : done ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center"
          >
            <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-primary" />
            <h2 className="font-bold">Пароль изменён</h2>
            <p className="mt-2 text-sm text-muted-foreground">Перенаправляем вас на страницу входа...</p>
          </motion.div>
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-bold">Новый пароль</h1>
              <p className="mt-1 text-sm text-muted-foreground">Введите новый пароль для вашего аккаунта.</p>
            </div>

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="password">Новый пароль</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Минимум 8 символов"
                    className={cn('pl-9 pr-9', errors.password && 'border-destructive')}
                    {...register('password')}
                    aria-invalid={!!errors.password}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">Подтверждение пароля</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="confirm"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Повторите пароль"
                    className={cn('pl-9 pr-9', errors.confirm && 'border-destructive')}
                    {...register('confirm')}
                    aria-invalid={!!errors.confirm}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showConfirm ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
              </div>

              {errors.root && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
                  role="alert"
                >
                  {errors.root.message}
                </motion.p>
              )}

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Сохранение...
                  </>
                ) : (
                  'Сохранить пароль'
                )}
              </Button>
            </form>
          </>
        )}
      </motion.div>
    </div>
  );
}
