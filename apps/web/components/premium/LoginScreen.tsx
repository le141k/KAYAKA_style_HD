'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Wifi, Lock, Mail, ArrowRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLogin } from '@/lib/hooks/use-auth';
import { useI18n } from '@/lib/i18n';

const loginSchema = z.object({
  email: z.string().email('Введите корректный email'),
  password: z.string().min(6, 'Минимум 6 символов'),
});
type LoginForm = z.infer<typeof loginSchema>;

interface LoginScreenProps {
  redirectTo?: string;
}

// Animated broadcast arcs logo
function BrandLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-12 w-12', className)}
      aria-hidden="true"
    >
      {/* Outer arc */}
      <motion.path
        d="M12 44 C12 28 24 16 40 12"
        stroke="url(#grad1)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.2 }}
      />
      {/* Middle arc */}
      <motion.path
        d="M18 44 C18 31 27 22 40 19"
        stroke="url(#grad1)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.4 }}
      />
      {/* Inner arc */}
      <motion.path
        d="M24 44 C24 35 31 29 40 27"
        stroke="url(#grad1)"
        strokeWidth="3.5"
        strokeLinecap="round"
        fill="none"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.6 }}
      />
      {/* Center dot */}
      <motion.circle
        cx="40"
        cy="44"
        r="4"
        fill="url(#grad1)"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.4, delay: 0.9 }}
      />
      <defs>
        <linearGradient id="grad1" x1="10" y1="10" x2="50" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="hsl(210 90% 42%)" />
          <stop offset="1" stopColor="hsl(189 94% 43%)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LoginScreen({ redirectTo = '/staff/dashboard' }: LoginScreenProps) {
  const { t } = useI18n();
  const [showPassword, setShowPassword] = useState(false);
  const loginMutation = useLogin();

  const {
    register,
    handleSubmit,
    formState: { errors },
    setError,
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (data: LoginForm) => {
    try {
      await loginMutation.mutateAsync(data);
      // Hard navigation: a soft router.push can be pre-empted by the (client)
      // layout's RSC prefetch of /tickets, landing staff on the client portal.
      window.location.assign(redirectTo);
    } catch {
      setError('root', { message: t.auth.loginError });
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Left: brand panel */}
      <div className="hidden flex-col justify-between bg-gradient-brand p-12 lg:flex lg:w-[45%]">
        <div className="flex items-center gap-3">
          <BrandLogo />
          <div>
            <div className="text-lg font-bold text-white">23 Telecom</div>
            <div className="text-xs text-white/70">Help Desk</div>
          </div>
        </div>

        <div className="space-y-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h2 className="text-3xl font-bold leading-tight text-white">
              Управляйте обращениями
              <br />
              без хаоса
            </h2>
            <p className="mt-3 text-base text-white/75">
              Единая платформа для агентов, клиентов и NOC-команды с мониторингом SLA в реальном времени.
            </p>
          </motion.div>

          {/* Feature list */}
          <motion.ul
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="space-y-3"
          >
            {[
              'Канбан-доска с drag & drop',
              'SLA-таймеры и автоэскалация',
              'База знаний и клиентский портал',
              'Командная строка ⌘K',
            ].map((f) => (
              <li key={f} className="flex items-center gap-2.5 text-sm text-white/90">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20">
                  <ArrowRight className="h-3 w-3 text-white" />
                </span>
                {f}
              </li>
            ))}
          </motion.ul>
        </div>

        <p className="text-xs text-white/50">© 2024 23 Telecom. Все права защищены.</p>
      </div>

      {/* Right: form */}
      <div className="flex flex-1 items-center justify-center bg-background p-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-sm space-y-6"
        >
          {/* Mobile logo */}
          <div className="flex items-center gap-3 lg:hidden">
            <BrandLogo />
            <span className="text-lg font-bold">23T Help Desk</span>
          </div>

          <div>
            <h1 className="text-2xl font-bold">{t.auth.loginTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t.auth.loginSubtitle}</p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t.auth.email}</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="agent@23telecom.ru"
                  className={cn('pl-9', errors.email && 'border-destructive')}
                  {...register('email')}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                />
              </div>
              {errors.email && (
                <p id="email-error" className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password">{t.auth.password}</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className={cn('pl-9 pr-9', errors.password && 'border-destructive')}
                  {...register('password')}
                  aria-invalid={!!errors.password}
                  aria-describedby={errors.password ? 'pw-error' : undefined}
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
              {errors.password && (
                <p id="pw-error" className="text-xs text-destructive">
                  {errors.password.message}
                </p>
              )}
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

            <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Вход...
                </>
              ) : (
                t.auth.login
              )}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            <a href="#" className="text-primary hover:underline">
              {t.auth.forgotPassword}
            </a>
          </p>

          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Wifi className="h-3.5 w-3.5" />
            <span>23 Telecom Help Desk v1.0</span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
