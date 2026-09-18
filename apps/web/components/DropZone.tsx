'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { ACCEPTED_EXTENSION, MAX_FILE_BYTES, formatBytes } from '@/lib/types';

interface Rejection {
  /** Unique per entry, so a file refused twice for two reasons keeps both rows. */
  key: string;
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

/**
 * Enough to show everything that went wrong in a realistic batch — somebody
 * dragging a folder of forty files in which six are .docx — without the list
 * growing without limit over a long session. The oldest go first.
 */
const MAX_REJECTIONS_SHOWN = 24;

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

let rejectionCounter = 0;

export default function DropZone({ onFiles, onIntent, busy = false }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<Rejection[]>([]);
  const describedBy = useId();
  // dragenter/dragleave fire for every child element; count them instead of toggling.
  const dragDepth = useRef(0);

  const refuse = useCallback((entries: { name: string; reason: string }[]) => {
    if (entries.length === 0) return;
    setRejected((current) => {
      /*
       * Accumulate rather than replace. Replacing meant that dropping a second file
       * silently erased the explanation for the first: drag in six files, see that
       * one was refused, drag in the replacement, and the reason you were reading
       * disappears — along with any record that a file was left behind at all. In a
       * batch of forty that is how somebody ends up with thirty-nine converted files
       * and no idea which one is missing.
       */
      const next = [...current];
      for (const entry of entries) {
        rejectionCounter += 1;
        next.push({ key: `r${rejectionCounter}`, ...entry });
      }
      return next.slice(-MAX_REJECTIONS_SHOWN);
    });
  }, []);

  const accept = useCallback(
    (fileList: FileList | null) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;
      const good: File[] = [];
      const bad: { name: string; reason: string }[] = [];
      for (const file of files) {
        const problem = checkFile(file);
        if (problem) bad.push({ name: file.name, reason: problem });
        else good.push(file);
      }
      refuse(bad);
      if (good.length > 0) onFiles(good);
    },
    [onFiles, refuse],
  );

  /**
   * `busy` really does mean unusable, so it is enforced here rather than only
   * announced. Everything else in the panel — the format picker, the Remove
   * buttons — is genuinely disabled while a batch runs, and an `aria-disabled` box
   * that still accepted files would be telling a screen-reader user one thing while
   * doing another. Refusing in silence would be worse again, so a drop that lands
   * during a batch gets a reason, in the same live region as every other refusal.
   */
  const blocked = useCallback(
    (what: string) => {
      refuse([
        {
          name: what,
          reason:
            'The files already in the list are being converted. Wait for that to finish, then add this one.',
        },
      ]);
    },
    [refuse],
  );

  const openPicker = useCallback(() => {
    if (busy) {
      blocked('Cannot add files just now');
      return;
    }
    inputRef.current?.click();
  }, [blocked, busy]);

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        /*
         * Named explicitly. Left to the contents, the accessible name would be the
         * whole box — heading plus the two lines of small print — read out every
         * time focus lands on it. This is the visible heading verbatim, so voice
         * control still works, and the small print arrives as a description instead.
         */
        aria-label="Drop your Publisher file here"
        aria-describedby={describedBy}
        aria-disabled={busy}
        onFocus={() => onIntent?.()}
        onMouseEnter={() => onIntent?.()}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!busy) {
            setDragging(true);
            onIntent?.();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
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
          if (busy) {
            const dropped = Array.from(event.dataTransfer.files);
            blocked(dropped.length === 1 ? (dropped[0]?.name ?? 'That file') : 'Those files');
            return;
          }
          accept(event.dataTransfer.files);
        }}
        className={[
          'flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed',
          'px-5 py-10 text-center transition-colors sm:py-14',
          // The box is the only tab stop here, so its focus ring is the only thing
          // telling a keyboard user where they are. It must never be invisible.
          'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          busy
            ? 'cursor-not-allowed border-line bg-surface opacity-60'
            : dragging
              ? 'cursor-pointer border-accent bg-accent-soft'
              : 'cursor-pointer border-line bg-surface hover:border-accent hover:bg-accent-soft/50',
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
          {busy
            ? 'Converting the files already in the list. You can add more when it has finished.'
            : `or tap to choose one. Files ending in ${ACCEPTED_EXTENSION}, up to ${formatBytes(MAX_FILE_BYTES)}. You can add several at once.`}
        </p>

        {/*
          Opened by the box above, never tabbed to. An `sr-only` input is still a tab
          stop, and this one had no label and nothing visible to show for it: tabbing
          past the drop zone put focus somewhere invisible and unannounced, which for
          a keyboard user is indistinguishable from focus being lost. One control, one
          tab stop, one focus ring.
        */}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSION}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            accept(event.target.files);
            // Let the same file be picked twice in a row.
            event.target.value = '';
          }}
        />
      </div>

      {/*
        The live region is in the DOM from first paint, empty, and stays there.
        A region that is created in the same update as its first message is not
        announced at all — the assistive technology has nothing to observe a change
        against — so previously a refused file was reported to sighted visitors only.
        Only the contents change now, which is what `aria-live` watches for.
      */}
      <div aria-live="polite">
        <ul className="space-y-2 empty:hidden mt-4 empty:mt-0">
          {rejected.map((item) => (
            <li
              key={item.key}
              className="rounded-xl border border-line bg-surface px-4 py-3 text-sm"
            >
              <span className="font-medium">{item.name}</span>
              <span className="mt-1 block text-danger">{item.reason}</span>
            </li>
          ))}
        </ul>
      </div>

      {rejected.length > 0 && (
        <button
          type="button"
          className="mt-2 rounded-lg px-2 py-1 text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
          onClick={() => setRejected([])}
        >
          Clear {rejected.length === 1 ? 'this message' : 'these messages'}
        </button>
      )}
    </div>
  );
}
