'use client';

import { useId } from 'react';
import { FORMATS, FORMAT_LIST } from '@/lib/formats';
import { TARGET_FORMATS, type DocxMode, type TargetFormat } from '@/lib/types';

interface FormatPickerProps {
  value: TargetFormat;
  onChange: (format: TargetFormat) => void;
  docxMode: DocxMode;
  onDocxModeChange: (mode: DocxMode) => void;
  /**
   * Which formats this build can actually produce. A format that is not ready is
   * shown and disabled rather than hidden — quietly removing an option people came
   * for looks like it never existed.
   */
  available?: Record<TargetFormat, boolean> | null;
  disabled?: boolean;
}

export default function FormatPicker({
  value,
  onChange,
  docxMode,
  onDocxModeChange,
  available,
  disabled = false,
}: FormatPickerProps) {
  const name = useId();
  const modeName = useId();
  const selected = FORMATS[value];
  const isReady = (id: TargetFormat) => available == null || available[id];

  return (
    <div className="w-full">
      <fieldset disabled={disabled}>
        <legend className="text-sm font-semibold">Convert it to</legend>

        <div className="mt-2 flex flex-wrap gap-2">
          {TARGET_FORMATS.map((id) => {
            const format = FORMATS[id];
            const active = value === id;
            const ready = isReady(id);
            return (
              <label
                key={id}
                className={[
                  'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm transition',
                  'focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2',
                  active ? 'border-accent bg-accent-soft font-semibold' : 'border-line bg-surface',
                  ready && !disabled ? 'cursor-pointer hover:border-accent' : 'cursor-not-allowed opacity-55',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name={name}
                  value={id}
                  checked={active}
                  disabled={!ready}
                  onChange={() => onChange(id)}
                  className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span>{format.name}</span>
                <span className="text-xs text-muted">{format.extension}</span>
                {!ready && <span className="text-xs text-muted">· not ready yet</span>}
              </label>
            );
          })}
        </div>
      </fieldset>

      <p className="mt-2.5 text-sm text-muted">
        {selected.summary}{' '}
        <a href="#formats" className="underline underline-offset-2 hover:text-ink">
          How to choose
        </a>
      </p>

      {value === 'docx' && (
        <fieldset disabled={disabled} className="mt-3 rounded-xl border border-line bg-surface p-3.5">
          <legend className="px-1 text-sm font-semibold">Word version</legend>
          <div className="mt-1 flex flex-col gap-2">
            {(
              [
                {
                  id: 'layout' as DocxMode,
                  label: 'Keep the boxes where they are',
                  hint: 'Closer to the original page. Harder to edit as one flowing document.',
                },
                {
                  id: 'flow' as DocxMode,
                  label: 'Plain flowing text',
                  hint: 'Gives up the layout on purpose. Easiest to rewrite and re-use.',
                },
              ] as const
            ).map((option) => (
              <label key={option.id} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="radio"
                  name={modeName}
                  value={option.id}
                  checked={docxMode === option.id}
                  onChange={() => onDocxModeChange(option.id)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {available != null && FORMAT_LIST.some((f) => !available[f.id]) && (
        <p className="mt-2 text-sm text-muted">
          Formats marked “not ready yet” are still being finished. The ones offered above work now.
        </p>
      )}
    </div>
  );
}
