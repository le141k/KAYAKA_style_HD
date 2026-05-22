/**
 * @telecom-hd/shared — cross-cutting contracts shared by api and web.
 * Kept intentionally small; domain DTOs live with their owning module.
 */

export const TICKET_STATUS = ['OPEN', 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatusKey = (typeof TICKET_STATUS)[number];

export const TICKET_PRIORITY = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriorityKey = (typeof TICKET_PRIORITY)[number];

export const LOCALES = ['ru', 'en', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
