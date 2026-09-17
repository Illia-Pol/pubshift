'use client';

import { useCallback, useId, useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSION,
  MAX_FILE_BYTES,
  formatBytes,
  type QueueItem,
} from '@/lib/types';

interface Rejection {
  name: string;
  reason: string;
}

interface DropZoneProps {
  /** Files that passed the local checks, in the order the user gave them. */
  onFiles: (files: File[]) => void;
  items: QueueItem[];
  onRemove: (id: string) => void;
  /** True while files are being sent; the zone still accepts more. */
  busy?: boolean;
}

function checkFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
    return 'This is not a Publisher file. Publisher files end in .pub.';
  }
  if (file.size === 0) return 'This file is empty — it may not have finished copying.';
  if (file.size > MAX_FILE_BYTES) {
    return `This file is ${formatBytes(file.size)}. We can take up to ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  return null;
}

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  ready: 'Waiting',
  uploading: 'Sending',
  converting: 'Converting',
  done: 'Ready to download',
  error: 'Did not work',
};

export default function DropZone({ onFiles, items, onRemove, busy = false }: DropZoneProps) {
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
          'px-6 py-14 text-center transition-colors',
          dragging
            ? 'border-accent bg-accent-soft'
            : 'border-line bg-surface hover:border-accent hover:bg-accent-soft/50',
        ].join(' ')}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          className={`h-12 w-12 ${dragging ? 'text-accent' : 'text-muted'}`}
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
        <p className="text-lg font-semibold">
          {dragging ? 'Let go to add your file' : 'Drag your Publisher file here'}
        </p>
        <p id={describedBy} className="text-sm text-muted">
          or click to choose one — files ending in .pub, up to {formatBytes(MAX_FILE_BYTES)}. You can
          add several at once.
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

      {items.length > 0 && (
        <ul className="mt-5 space-y-3" aria-live="polite">
          {items.map((item) => (
            <li key={item.id} className="card px-4 py-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="truncate font-medium">{item.file.name}</span>
                <span className="shrink-0 text-sm text-muted">{formatBytes(item.file.size)}</span>
              </div>

              <div className="mt-2 flex items-center gap-3">
                <span
                  className={[
                    'text-sm',
                    item.status === 'error'
                      ? 'text-danger'
                      : item.status === 'done'
                        ? 'text-positive'
                        : 'text-muted',
                  ].join(' ')}
                >
                  {STATUS_LABEL[item.status]}
                </span>

                {(item.status === 'uploading' || item.status === 'converting') && (
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent-soft"
                    role="progressbar"
                    aria-valuenow={item.status === 'uploading' ? item.progress : undefined}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progress for ${item.file.name}`}
                  >
                    <div
                      className={`h-full rounded-full bg-accent transition-[width] duration-200 ${
                        item.status === 'converting' ? 'animate-pulse' : ''
                      }`}
                      style={{ width: `${item.status === 'converting' ? 100 : item.progress}%` }}
                    />
                  </div>
                )}

                {item.status !== 'uploading' && item.status !== 'converting' && (
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    disabled={busy && item.status === 'ready'}
                    className="ml-auto rounded-lg px-2 py-1 text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>

              {item.message && (
                <p className={`mt-2 text-sm ${item.status === 'error' ? 'text-danger' : 'text-muted'}`}>
                  {item.message}
                </p>
              )}

              {item.status === 'done' && item.result && (
                <a className="btn-quiet mt-3" href={item.result.downloadUrl} download={item.result.downloadName}>
                  Download {item.result.downloadName}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
