import type {
  Ticket,
  User,
  Reply,
  KBArticle,
  KBCategory,
  DashboardStats,
  Department,
} from "./types";

export const MOCK_USERS: User[] = [
  {
    id: 1,
    name: "Александр Петров",
    email: "a.petrov@23telecom.ru",
    role: "agent",
    department_id: 1,
  },
  {
    id: 2,
    name: "Мария Сидорова",
    email: "m.sidorova@23telecom.ru",
    role: "agent",
    department_id: 2,
  },
  {
    id: 3,
    name: "Иван Клиентов",
    email: "ivan@example.com",
    role: "client",
  },
  {
    id: 4,
    name: "Елена Новикова",
    email: "e.novikova@23telecom.ru",
    role: "admin",
  },
];

export const MOCK_DEPARTMENTS: Department[] = [
  { id: 1, name: "Техническая поддержка", email: "tech@23telecom.ru" },
  { id: 2, name: "Биллинг", email: "billing@23telecom.ru" },
  { id: 3, name: "NOC", email: "noc@23telecom.ru" },
];

export const MOCK_TICKETS: Ticket[] = [
  {
    id: 1,
    mask: "TT-000001",
    subject: "Не работает интернет после смены тарифа",
    body: "После перехода на тариф «Бизнес Pro» пропал интернет. Роутер перезагружал, не помогло.",
    status: "open",
    priority: "urgent",
    requester: MOCK_USERS[2]!,
    assignee: MOCK_USERS[0],
    department: MOCK_DEPARTMENTS[0],
    sla_due_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    reply_count: 2,
    tags: ["интернет", "тариф"],
  },
  {
    id: 2,
    mask: "TT-000002",
    subject: "Вопрос по счёту за октябрь",
    body: "В счёте указана сумма 8500 руб, но по договору должно быть 7200. Прошу разъяснить.",
    status: "pending",
    priority: "normal",
    requester: MOCK_USERS[2]!,
    assignee: MOCK_USERS[1],
    department: MOCK_DEPARTMENTS[1],
    sla_due_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    reply_count: 4,
    tags: ["биллинг"],
  },
  {
    id: 3,
    mask: "TT-000003",
    subject: "Подключить дополнительный IP-адрес",
    body: "Нужно подключить ещё один статический IP для VPN-сервера.",
    status: "in_progress",
    priority: "normal",
    requester: MOCK_USERS[2]!,
    assignee: MOCK_USERS[0],
    department: MOCK_DEPARTMENTS[0],
    sla_due_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
    reply_count: 6,
    tags: ["IP", "VPN"],
  },
  {
    id: 4,
    mask: "TT-000004",
    subject: "Восстановить доступ в личный кабинет",
    body: "Забыл пароль, письмо на сброс не приходит.",
    status: "resolved",
    priority: "low",
    requester: MOCK_USERS[2]!,
    department: MOCK_DEPARTMENTS[0],
    sla_due_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    reply_count: 3,
    tags: ["доступ", "пароль"],
  },
  {
    id: 5,
    mask: "TT-000005",
    subject: "Высокий latency на CDN-хосте",
    body: "С 18:00 мск наблюдаются пакетные потери ~15% до CDN. Трейс во вложении.",
    status: "open",
    priority: "high",
    requester: MOCK_USERS[2]!,
    assignee: MOCK_USERS[0],
    department: MOCK_DEPARTMENTS[2],
    sla_due_at: new Date(Date.now() - 15 * 60_000).toISOString(), // breached
    created_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    reply_count: 1,
    tags: ["CDN", "latency", "NOC"],
  },
];

export const MOCK_REPLIES: Reply[] = [
  {
    id: 1,
    ticket_id: 1,
    author: MOCK_USERS[0]!,
    body: "Добрый день! Уже разбираемся — проверяем сессию на нашем оборудовании. Сообщим в течение часа.",
    is_internal: false,
    created_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
  },
  {
    id: 2,
    ticket_id: 1,
    author: MOCK_USERS[0]!,
    body: "Внутренняя заметка: PPPoE-сессия оборвалась на BRAS-01, перезапускаем.",
    is_internal: true,
    created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
  },
];

export const MOCK_STATS: DashboardStats = {
  open_tickets: 12,
  pending_tickets: 5,
  resolved_today: 8,
  sla_breached: 1,
  avg_first_response_minutes: 23,
};

export const MOCK_KB_CATEGORIES: KBCategory[] = [
  { id: 1, name: "Подключение и настройка", description: "Гайды по подключению оборудования", article_count: 14 },
  { id: 2, name: "Биллинг и оплата", description: "Тарифы, счета, платежи", article_count: 8 },
  { id: 3, name: "Устранение неполадок", description: "Диагностика и решение проблем", article_count: 22 },
  { id: 4, name: "API и интеграции", description: "Документация для разработчиков", article_count: 11 },
];

export const MOCK_KB_ARTICLES: KBArticle[] = [
  {
    id: 1,
    slug: "router-setup-guide",
    title: "Как настроить роутер для подключения по PPPoE",
    body: "Пошаговая инструкция по настройке PPPoE-соединения на популярных моделях роутеров...",
    category: MOCK_KB_CATEGORIES[0]!,
    author: MOCK_USERS[0]!,
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    views: 1247,
  },
  {
    id: 2,
    slug: "check-invoice",
    title: "Как проверить и оплатить счёт",
    body: "В личном кабинете перейдите в раздел «Биллинг»...",
    category: MOCK_KB_CATEGORIES[1]!,
    author: MOCK_USERS[1]!,
    created_at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
    views: 892,
  },
];
