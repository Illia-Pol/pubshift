'use client';

import { useId } from 'react';
import { TARGET_FORMATS, type TargetFormat } from '@/lib/types';

interface FormatOption {
  id: TargetFormat;
  name: string;
  opensIn: string;
  /** One honest sentence: what it keeps. */
  keeps: string;
  /** One honest sentence: what it costs. */
  loses: string;
}

// PPTX is first and default on purpose: a slide is a page of positioned boxes, which is
// exactly what a Publisher page is, so it is the closest thing to a like-for-like copy.
const OPTIONS: Record<TargetFormat, FormatOption> = {
  pptx: {
    id: 'pptx',
    name: 'PowerPoint',
    opensIn: 'PowerPoint, Google Slides, Keynote',
    keeps: 'Keeps your design closest, because a slide holds boxes wherever you put them, just like a Publisher page.',
    loses: 'Pages become slides, so it is for editing and printing rather than presenting.',
  },
  docx: {
    id: 'docx',
    name: 'Word',
    opensIn: 'Word, Google Docs, Pages',
    keeps: 'Best when the words matter most: all your text stays easy to edit and re-use.',
    loses: 'Word wants to flow text down a page, so a complicated design can shift as you edit it.',
  },
  pdf: {
    id: 'pdf',
    name: 'PDF',
    opensIn: 'Anything, on any device',
    keeps: 'Looks exactly like your publication and prints exactly the same everywhere.',
    loses: 'Nobody can edit it afterwards, including you — keep it as a copy, not a working file.',
  },
  svg: {
    id: 'svg',
    name: 'Design file (SVG)',
    opensIn: 'Illustrator, Inkscape, Figma, Canva',
    keeps: 'One file per page with every shape and line still separate, for a designer to work on.',
    loses: 'Not meant for Word or PowerPoint, and text may need the original fonts installed.',
  },
};

interface FormatPickerProps {
  value: TargetFormat;
  onChange: (format: TargetFormat) => void;
  disabled?: boolean;
}

export default function FormatPicker({ value, onChange, disabled = false }: FormatPickerProps) {
  const name = useId();

  return (
    <fieldset disabled={disabled} className="w-full">
      <legend className="text-base font-semibold">What would you like back?</legend>
      <p className="mt-1 text-sm text-muted">You can come back and pick a different one afterwards.</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {TARGET_FORMATS.map((id) => {
          const option = OPTIONS[id];
          const selected = value === id;
          return (
            <label
              key={id}
              className={[
                'flex cursor-pointer flex-col gap-1 rounded-2xl border p-4 transition',
                'focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2',
                selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-accent',
                disabled ? 'cursor-not-allowed opacity-60' : '',
              ].join(' ')}
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name={name}
                  value={id}
                  checked={selected}
                  onChange={() => onChange(id)}
                  className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
                />
                <span className="text-base font-semibold">{option.name}</span>
              </span>
              <span className="text-xs uppercase tracking-wide text-muted">
                Opens in {option.opensIn}
              </span>
              <span className="mt-1 text-sm">{option.keeps}</span>
              <span className="text-sm text-muted">{option.loses}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
