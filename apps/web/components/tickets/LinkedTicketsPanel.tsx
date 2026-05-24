'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Link2, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useTicketLinks } from '@/lib/hooks/use-tickets';
import { useI18n } from '@/lib/i18n';

/**
 * Ticket-detail panel showing the linked counterpart tickets (client ↔ supplier
 * in the 23T broker model). Lists links, opens the counterpart, and lets staff
 * link/unlink by ticket id.
 */
export function LinkedTicketsPanel({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const l = t.linkedTickets;
  const { list, add, remove, spawnSupplier } = useTicketLinks(ticketId);
  const [targetId, setTargetId] = useState('');
  const [linkType, setLinkType] = useState<'supplier' | 'client' | 'related'>('supplier');
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [supEmail, setSupEmail] = useState('');
  const [supName, setSupName] = useState('');
  const [supSubject, setSupSubject] = useState('');
  const [supMsg, setSupMsg] = useState('');

  const typeLabel = (lt: string) => (lt === 'supplier' ? l.supplier : lt === 'client' ? l.client : l.related);

  function handleAdd() {
    const id = Number(targetId.trim());
    if (!Number.isInteger(id) || id <= 0) return;
    add.mutate(
      { targetId: id, linkType },
      {
        onSuccess: () => setTargetId(''),
        onError: () => toast({ title: l.linkError, variant: 'destructive' }),
      },
    );
  }

  function handleSpawn() {
    if (!supEmail.trim() || !supMsg.trim()) return;
    spawnSupplier.mutate(
      {
        supplierEmail: supEmail.trim(),
        supplierName: supName.trim() || undefined,
        subject: supSubject.trim() || undefined,
        contents: supMsg.trim(),
      },
      {
        onSuccess: () => {
          setSupEmail('');
          setSupName('');
          setSupSubject('');
          setSupMsg('');
          setSpawnOpen(false);
        },
        onError: () => toast({ title: l.spawnError, variant: 'destructive' }),
      },
    );
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Link2 className="h-3.5 w-3.5" />
        {l.title}
      </h3>

      {list.isLoading ? (
        <p className="text-xs text-muted-foreground">{l.loading}</p>
      ) : (list.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">{l.empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {list.data!.map((link) => (
            <li key={link.linkId} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/staff/tickets/${link.ticket.id}`}
                className="min-w-0 flex-1 truncate hover:underline"
                title={link.ticket.subject}
              >
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                  {typeLabel(link.linkType)}
                </span>{' '}
                <span className="font-mono text-xs">{link.ticket.mask}</span>{' '}
                <span className="text-muted-foreground">{link.ticket.subject}</span>
              </Link>
              <button
                type="button"
                aria-label={`${l.unlink}: ${link.ticket.mask}`}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={() => remove.mutate(link.linkId)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <select
          value={linkType}
          onChange={(e) => setLinkType(e.target.value as 'supplier' | 'client' | 'related')}
          className="h-8 rounded-md border border-input bg-transparent px-1.5 text-xs"
        >
          <option value="supplier">{l.supplier}</option>
          <option value="client">{l.client}</option>
          <option value="related">{l.related}</option>
        </select>
        <Input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={l.addPlaceholder}
          inputMode="numeric"
          className="h-8 flex-1"
        />
        <Button size="sm" variant="outline" onClick={handleAdd} disabled={!targetId.trim() || add.isPending}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {l.add}
        </Button>
      </div>

      {/* The NOC "Contact supplier" action — spawns a linked Vendor-Issue ticket. */}
      {!spawnOpen ? (
        <Button size="sm" variant="secondary" className="w-full" onClick={() => setSpawnOpen(true)}>
          {l.spawnSupplier}
        </Button>
      ) : (
        <div className="space-y-1.5 rounded-md border border-border p-2">
          <Input
            value={supEmail}
            onChange={(e) => setSupEmail(e.target.value)}
            placeholder={l.supplierEmail}
            type="email"
            className="h-8"
          />
          <Input
            value={supName}
            onChange={(e) => setSupName(e.target.value)}
            placeholder={l.supplierName}
            className="h-8"
          />
          <Input
            value={supSubject}
            onChange={(e) => setSupSubject(e.target.value)}
            placeholder={l.subject}
            className="h-8"
          />
          <textarea
            value={supMsg}
            onChange={(e) => setSupMsg(e.target.value)}
            placeholder={l.message}
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm"
          />
          <div className="flex gap-1.5">
            <Button
              size="sm"
              onClick={handleSpawn}
              disabled={!supEmail.trim() || !supMsg.trim() || spawnSupplier.isPending}
            >
              {l.spawnSubmit}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSpawnOpen(false)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
