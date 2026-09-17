'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { ACCEPTED_EXTENSION, MAX_FILE_BYTES, formatBytes } from '@/lib/types';

interface Rejection {
  name: string;
  reason: string;
}

interface DropZoneProps {
  /** Files that passed the local checks, in the order they were given. */
  onFiles: (files: File[]) => void;
  /**
   * Fired the moment someone shows intent — hovering a file over the page, or
   * tabbing to the box. The panel uses it to warm the extractor up so that the
   * conversion itself is instant. Called often; must be cheap.
   */
  onIntent?: () => void;
  busy?: boolean;
}

function checkFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
    return 'This is not a Publisher file. Publisher files end in .pub.';
  }
  if (file.size === 0) return 'This file is empty — it may not have finished copying.';
  if (file.size > MAX_FILE_BYTES) {
    return `This file is ${formatBytes(file.size)}, and we open files up to ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  return null;
}

export default function DropZone({ onFiles, onIntent, busy = false }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const describedBy = useId();
  // dragenter/dragleave fire for every child element; count them instead of toggling.
  const dragDepth = useRef(0);

  const accept = useCallback(
    (fileList: FileList | null) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;
      const good: File[] = [];
      const bad: Rejection[] = [];
      for (const file of files) {
        const problem = checkFile(file);
        if (problem) bad.push({ name: file.name, reason: problem });
        else good.push(file);
      }
      setRejected(bad);
      if (good.length > 0) onFiles(good);
    },
    [onFiles],
  );

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        aria-describedby={describedBy}
        aria-disabled={busy}
        onFocus={onIntent}
        onMouseEnter={onIntent}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
          onIntent?.();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          accept(event.dataTransfer.files);
        }}
        className={[
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed',
          'px-5 py-10 text-center transition-colors sm:py-14',
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line bg-surface hover:border-accent hover:bg-accent-soft/50',
        ].join(' ')}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          className={`h-10 w-10 sm:h-12 sm:w-12 ${dragging ? 'text-accent' : 'text-muted'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M24 32V10" />
          <path d="M15 19l9-9 9 9" />
          <path d="M8 30v6a4 4 0 004 4h24a4 4 0 004-4v-6" />
        </svg>

        <p className="text-lg font-semibold sm:text-xl">
          {dragging ? 'Let go to open it' : 'Drop your Publisher file here'}
        </p>

        <p id={describedBy} className="max-w-sm text-sm text-muted">
          or tap to choose one. Files ending in .pub, up to {formatBytes(MAX_FILE_BYTES)}. You can add
          several at once.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSION}
          multiple
          className="sr-only"
          onChange={(event) => {
            accept(event.target.files);
            // Let the same file be picked twice in a row.
            event.target.value = '';
          }}
        />
      </div>

      {rejected.length > 0 && (
        <ul className="mt-4 space-y-2" aria-live="polite">
          {rejected.map((item) => (
            <li
              key={`${item.name}-${item.reason}`}
              className="rounded-xl border border-line bg-surface px-4 py-3 text-sm"
            >
              <span className="font-medium">{item.name}</span>
              <span className="mt-1 block text-danger">{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
