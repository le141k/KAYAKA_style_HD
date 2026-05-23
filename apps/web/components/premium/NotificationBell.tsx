'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, X, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/RelativeTime';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Notification {
  id: string;
  type: 'breach' | 'new' | 'resolved';
  message: string;
  time: string;
  read: boolean;
}

const MOCK_NOTIFICATIONS: Notification[] = [];

const TYPE_CONFIG = {
  breach: { Icon: AlertTriangle, color: 'text-sla-breach' },
  new: { Icon: Bell, color: 'text-status-open' },
  resolved: { Icon: CheckCircle2, color: 'text-status-resolved' },
};

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>(MOCK_NOTIFICATIONS);
  const [shake, setShake] = useState(false);
  const [open, setOpen] = useState(false);

  const unread = notifications.filter((n) => !n.read).length;

  // No-op: shake animation retained for future real notification wiring
  useEffect(() => {
    if (unread > 0) {
      setShake(true);
      const t = setTimeout(() => setShake(false), 600);
      return () => clearTimeout(t);
    }
  }, [unread]);

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const dismiss = (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Уведомления${unread > 0 ? `, ${unread} непрочитанных` : ''}`}
        >
          <motion.div
            animate={shake ? { rotate: [0, -12, 12, -8, 8, 0] } : {}}
            transition={{ duration: 0.5 }}
          >
            <Bell className="h-5 w-5" />
          </motion.div>
          <AnimatePresence>
            {unread > 0 && (
              <motion.span
                key="badge"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white"
              >
                {unread}
              </motion.span>
            )}
          </AnimatePresence>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Уведомления</h3>
          {unread > 0 && (
            <button onClick={markAllRead} className="text-xs text-primary hover:underline">
              Прочитать все
            </button>
          )}
        </div>

        <ScrollArea className="max-h-72">
          <AnimatePresence initial={false}>
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                <Bell className="h-8 w-8 opacity-30" />
                <p className="text-sm">Нет уведомлений</p>
              </div>
            ) : (
              notifications.map((n) => {
                const { Icon, color } = TYPE_CONFIG[n.type];
                return (
                  <motion.div
                    key={n.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className={cn(
                      'flex items-start gap-3 border-b border-border px-4 py-3 last:border-0',
                      !n.read && 'bg-primary/5',
                    )}
                  >
                    <Icon className={cn('mt-0.5 h-4 w-4 flex-shrink-0', color)} />
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-xs', !n.read && 'font-semibold')}>{n.message}</p>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <RelativeTime date={n.time} />
                      </div>
                    </div>
                    <button
                      onClick={() => dismiss(n.id)}
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Удалить уведомление"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </motion.div>
                );
              })
            )}
          </AnimatePresence>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
