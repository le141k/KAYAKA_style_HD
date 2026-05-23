'use client';

import { useState } from 'react';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSavedViews, useCreateSavedView, useDeleteSavedView } from '@/lib/hooks/use-saved-views';
import { useI18n } from '@/lib/i18n';

/**
 * Compact toolbar control for the ticket list: pick a saved set of filters,
 * save the current filters under a name, or delete an existing saved view.
 */
export function SavedViews({
  currentFilters,
  onApply,
}: {
  currentFilters: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const sv = t.savedViews;
  const { data: views = [], isLoading } = useSavedViews();
  const createView = useCreateSavedView();
  const deleteView = useDeleteSavedView();

  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createView.mutate(
      { name: trimmed, filters: currentFilters },
      {
        onSuccess: () => {
          setName('');
          setSaving(false);
        },
      },
    );
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setSaving(false);
          setName('');
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark className="mr-1.5 h-4 w-4" />
          {sv.title}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{sv.title}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {isLoading ? (
          <DropdownMenuItem disabled>{sv.loading}</DropdownMenuItem>
        ) : views.length === 0 ? (
          <DropdownMenuItem disabled>{sv.empty}</DropdownMenuItem>
        ) : (
          views.map((view) => (
            <DropdownMenuItem
              key={view.id}
              className="flex items-center justify-between gap-2"
              onSelect={() => onApply(view.filters)}
            >
              <span className="truncate">{view.name}</span>
              <button
                type="button"
                aria-label={`${sv.deleteView}: ${view.name}`}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  // Keep the menu open and don't apply the view when deleting.
                  e.preventDefault();
                  e.stopPropagation();
                  deleteView.mutate(view.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />

        {saving ? (
          <div className="flex items-center gap-1.5 p-1.5">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
              placeholder={sv.namePlaceholder}
              className="h-8"
            />
            <Button size="sm" onClick={handleSave} disabled={!name.trim() || createView.isPending}>
              {sv.save}
            </Button>
          </div>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              // Stay open so the inline name field can be shown.
              e.preventDefault();
              setSaving(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {sv.saveCurrent}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
