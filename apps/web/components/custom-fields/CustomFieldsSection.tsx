'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { PublicCustomField } from '@/lib/hooks/use-custom-fields';

export type CustomFieldValue = string | string[] | boolean;

interface Props {
  fields: PublicCustomField[];
  values: Record<string, CustomFieldValue>;
  onChange: (fieldKey: string, value: CustomFieldValue) => void;
  errors?: Record<string, string>;
}

/**
 * Renders TICKET-scope custom fields as dynamic inputs. The collected values are
 * keyed by `fieldKey` and forwarded as the `customFields` map on ticket submit.
 * Reused by both the staff-create dialog and the client-submit form.
 */
export function CustomFieldsSection({ fields, values, onChange, errors }: Props) {
  if (!fields.length) return null;

  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const value = values[f.fieldKey];
        const error = errors?.[f.fieldKey];
        const id = `cf-${f.fieldKey}`;
        const required = f.isRequired;
        const label = (
          <Label htmlFor={id}>
            {f.title}
            {required && <span className="ml-0.5 text-destructive">*</span>}
          </Label>
        );

        return (
          <div key={f.id} className="space-y-1.5">
            {f.type !== 'CHECKBOX' && label}

            {(f.type === 'TEXT' || f.type === 'PASSWORD') && (
              <Input
                id={id}
                type={f.type === 'PASSWORD' ? 'password' : 'text'}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.fieldKey, e.target.value)}
                aria-invalid={!!error}
                aria-required={required}
              />
            )}

            {f.type === 'TEXTAREA' && (
              <Textarea
                id={id}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.fieldKey, e.target.value)}
                aria-invalid={!!error}
                aria-required={required}
              />
            )}

            {f.type === 'NUMBER' && (
              <Input
                id={id}
                type="number"
                value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                onChange={(e) => onChange(f.fieldKey, e.target.value)}
                aria-invalid={!!error}
                aria-required={required}
              />
            )}

            {f.type === 'DATE' && (
              <Input
                id={id}
                type="date"
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.fieldKey, e.target.value)}
                aria-invalid={!!error}
                aria-required={required}
              />
            )}

            {f.type === 'SELECT' && (
              <Select
                value={typeof value === 'string' ? value : ''}
                onValueChange={(v) => onChange(f.fieldKey, v)}
              >
                <SelectTrigger id={id} aria-label={f.title} aria-invalid={!!error}>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {f.options.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {f.type === 'RADIO' && (
              <div className="space-y-1.5" role="radiogroup" aria-label={f.title}>
                {f.options.map((opt) => (
                  <label key={opt} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={id}
                      value={opt}
                      checked={value === opt}
                      onChange={() => onChange(f.fieldKey, opt)}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {f.type === 'MULTISELECT' && (
              <div className="space-y-1.5">
                {f.options.map((opt) => {
                  const arr = Array.isArray(value) ? value : [];
                  const checked = arr.includes(opt);
                  return (
                    <label key={opt} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        value={opt}
                        checked={checked}
                        onChange={(e) =>
                          onChange(
                            f.fieldKey,
                            e.target.checked ? [...arr, opt] : arr.filter((x) => x !== opt),
                          )
                        }
                      />
                      {opt}
                    </label>
                  );
                })}
              </div>
            )}

            {f.type === 'CHECKBOX' && (
              <label htmlFor={id} className="flex items-center gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => onChange(f.fieldKey, e.target.checked)}
                  aria-required={required}
                />
                {f.title}
                {required && <span className="ml-0.5 text-destructive">*</span>}
              </label>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Builds the `customFields` payload from collected values, dropping empties.
 * Returns `{ values, missing }` where `missing` lists required fieldKeys with no value.
 */
export function buildCustomFieldsPayload(
  fields: PublicCustomField[],
  values: Record<string, CustomFieldValue>,
): { values: Record<string, CustomFieldValue>; missing: PublicCustomField[] } {
  const out: Record<string, CustomFieldValue> = {};
  const missing: PublicCustomField[] = [];
  for (const f of fields) {
    const v = values[f.fieldKey];
    const isEmpty = v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0);
    if (!isEmpty) out[f.fieldKey] = v;
    if (f.isRequired && isEmpty) missing.push(f);
  }
  return { values: out, missing };
}
