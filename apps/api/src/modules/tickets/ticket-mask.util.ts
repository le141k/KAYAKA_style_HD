/**
 * Generates the human-readable ticket mask.
 * Format: TT-XXXXXX (zero-padded to 6 digits minimum).
 *
 * @param id  The numeric ticket ID assigned by the database.
 */
export function formatTicketMask(id: number): string {
  return `TT-${String(id).padStart(6, '0')}`;
}
