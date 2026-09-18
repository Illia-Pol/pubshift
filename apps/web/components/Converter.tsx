'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DropZone from '@/components/DropZone';
import FormatPicker from '@/components/FormatPicker';
import PagePreview from '@/components/PagePreview';
import { availableFormats } from '@/lib/available';
import { ConversionRunner, type RunMode } from '@/lib/runner';
import type { Stage } from '@/lib/convert';
import { FORMATS } from '@/lib/formats';
import { groupNotes, pageList } from '@/lib/notes';
import {
  TARGET_FORMATS,
  formatBytes,
  type DocxMode,
  type OutputFile,
  type QueueItem,
  type TargetFormat,
} from '@/lib/types';

/**
 * Which emitters this build has is settled while the site is compiled, so it is a
 * constant rather than state and the picker can tell the truth on first paint.
 * Asking `lib/convert` would have put every emitter in this page's bundle — see
 * lib/available.ts.
 */
const AVAILABLE = availableFormats();

/**
 * How long a failed extractor load is left alone before an idle hover may try it
 * again. The visitor can always retry immediately with the button on the error.
 */
const WARM_RETRY_COOLDOWN_MS = 15_000;

const STATUS_LABEL: Record<QueueItem['status'], string> = {
  ready: 'Waiting',
  working: 'Converting on your computer',
  done: 'Ready to save',
  unreadable: 'We could not read this one',
  error: 'Something went wrong',
};

/** Said in the order they happen, in words that describe the actual step. */
const STAGE_LABEL: Record<Stage, string> = {
  reading: 'Reading the file from your disk',
  extracting: 'Opening the publication',
  assembling: 'Working out the layout',
  checking: 'Checking there is really something in it',
  writing: 'Writing the new file',
};

function isStage(value: string | undefined): value is Stage {
  return value !== undefined && value in STAGE_LABEL;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

let idCounter = 0;

/**
 * An id for a queued file: a React key and the key of the preview-URL map, so it
 * only has to be unique within this tab.
 *
 * `crypto.randomUUID` is **not available outside a secure context** — on plain
 * HTTP, `crypto` exists but `randomUUID` is undefined, and calling it throws inside
 * a React event handler, which unmounts the whole panel. Nobody would see an error
 * message; the page would simply vanish when they dropped their first file.
 *
 * That is not a hypothetical deployment. This is a static directory any parish or
 * school IT volunteer can copy onto an internal box and serve over http:// to the
 * office, which is a perfectly sensible thing to do with a tool whose entire point
 * is that it needs no server. It has to work there.
 */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Some hardened builds throw on access rather than leaving it undefined.
  }
  idCounter += 1;
  return `file-${Date.now().toString(36)}-${idCounter}`;
}

/** Hands a Blob that only exists in this tab to the browser's download machinery. */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Long enough for the download to have started, short enough not to pin a
  // hundred megabytes of zip in memory for the rest of the session.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * A download link for a Blob that only exists in this tab. The object URL is
 * created when the link appears and revoked when it goes away, so a long session
 * converting forty bulletins does not quietly pin forty documents in memory.
 */
function DownloadLink({ output, primary }: { output: OutputFile; primary: boolean }) {
  const [href, setHref] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(output.blob);
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [output.blob]);

  if (!href) return null;

  return (
    <a className={primary ? 'btn-primary' : 'btn-quiet'} href={href} download={output.name}>
      Save {output.name}
      <span className="text-xs font-normal opacity-80">{formatBytes(output.sizeBytes)}</span>
    </a>
  );
}

export default function Converter() {
  const [format, setFormat] = useState<TargetFormat>(
    // Never open on something this build cannot produce.
    () => TARGET_FORMATS.find((id) => AVAILABLE[id]) ?? 'pptx',
  );
  const [docxMode, setDocxMode] = useState<DocxMode>('layout');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [engineProblem, setEngineProblem] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<RunMode | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipProblem, setZipProblem] = useState<string | null>(null);
  /** The single sentence a screen reader hears as the batch moves along. */
  const [announcement, setAnnouncement] = useState('');

  /**
   * 'idle' before the first attempt and after a failed one, so a retry is possible;
   * 'running' while in flight; 'ok' once the extractor is up, after which there is
   * nothing to retry.
   */
  const warmState = useRef<'idle' | 'running' | 'ok'>('idle');
  /**
   * Earliest a failed attempt may repeat itself. `onIntent` fires on every mouse
   * enter, and without this a broken extractor would re-fetch 465 KB every time the
   * pointer crossed the drop zone.
   */
  const warmRetryAfter = useRef(0);
  const stopping = useRef(false);
  const runnerRef = useRef<ConversionRunner | null>(null);
  /** Preview object URLs by item id, so each is revoked exactly once. */
  const previews = useRef(new Map<string, string>());

  /** One worker for the life of the page, created on first use, stopped on the way out. */
  const runner = useCallback(() => {
    runnerRef.current ??= new ConversionRunner();
    return runnerRef.current;
  }, []);

  useEffect(() => {
    const open = previews.current;
    return () => {
      for (const url of open.values()) URL.revokeObjectURL(url);
      open.clear();
      runnerRef.current?.dispose();
      runnerRef.current = null;
    };
  }, []);

  const releasePreview = useCallback((id: string) => {
    const url = previews.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      previews.current.delete(id);
    }
  }, []);

  /**
   * Load the extractor as soon as someone looks like they are about to use the
   * page. Doing it on page load would make everyone who came to read pay for a
   * download they may never need; doing it on the Convert click would hide the
   * 465 KB fetch inside the first conversion and make it look slow.
   */
  const warm = useCallback(
    // An options object rather than a positional `force` flag on purpose: this is
    // handed straight to `onMouseEnter`/`onFocus`, which call it with a React event.
    // A positional boolean would read that event as `force: true` and defeat the
    // cooldown on every hover; a missing `force` property cannot.
    (options?: { force?: boolean }) => {
      const force = options?.force === true;
      if (warmState.current === 'ok' || warmState.current === 'running') return;
      // One transient failure — a flaky first fetch of the extractor, a proxy
      // hiccup, a laptop that woke up mid-request — must not disable the Convert
      // button for the life of the tab. The attempt is repeatable, so the state
      // goes back to 'idle' on failure rather than latching on the first try.
      if (!force && Date.now() < warmRetryAfter.current) return;

      warmState.current = 'running';
      setEngineProblem(null);

      const failed = (message: string) => {
        warmState.current = 'idle';
        warmRetryAfter.current = Date.now() + WARM_RETRY_COOLDOWN_MS;
        setEngineProblem(message);
      };

      runner()
        .warm()
        .then((status) => {
          if (status.ok) {
            warmState.current = 'ok';
            setEngineReady(true);
          } else {
            failed(status.message ?? 'The Publisher reader could not start here.');
          }
          setRunMode(runner().mode);
        })
        .catch((error: unknown) => {
          failed(
            error instanceof Error && error.message
              ? error.message
              : 'The Publisher reader could not start in this browser. A current version of ' +
                  'Chrome, Edge, Firefox or Safari will work.',
          );
        });
    },
    [runner],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      warm();
      setItems((current) => [
        ...current,
        ...files.map((file) => ({
          id: newId(),
          file,
          status: 'ready' as const,
        })),
      ]);
    },
    [warm],
  );

  const patch = useCallback((id: string, change: Partial<QueueItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const remove = useCallback(
    (id: string) => {
      releasePreview(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    [releasePreview],
  );

  const run = useCallback(async () => {
    /*
     * The queue is read once, from the state we had when the button was pressed,
     * and it is **every file in the list** rather than only the ones not yet done.
     *
     * Skipping the finished ones looks like an optimisation and is a trap: convert
     * a batch to PowerPoint, decide you wanted PDF as well, press Convert, and
     * nothing at all happens — no output, no error, no explanation. The most common
     * second thing anybody does with this tool is convert the same files to another
     * format, so re-running has to mean re-running, and the new outputs replace the
     * old ones on each row (`format` records which one they are).
     */
    const queue = items;
    if (queue.length === 0) return;

    warm();
    stopping.current = false;
    setBusy(true);
    setZipProblem(null);

    let converted = 0;
    let unreadable = 0;
    let failed = 0;

    try {
      for (const [index, item] of queue.entries()) {
        if (stopping.current) break;

        setAnnouncement(
          queue.length === 1
            ? `Converting ${item.file.name}.`
            : `Converting ${index + 1} of ${queue.length}: ${item.file.name}.`,
        );

        releasePreview(item.id);
        patch(item.id, {
          status: 'working',
          stage: 'reading',
          message: undefined,
          outputs: undefined,
          notes: undefined,
          verdict: undefined,
          stats: undefined,
          preview: undefined,
        });

        try {
          const outcome = await runner().convert(item.file, { format, docxMode }, (stage) =>
            patch(item.id, { stage }),
          );

          // Only knowable after the first job: the worker reports itself dead by
          // failing to start, not by refusing to be created.
          setRunMode(runner().mode);

          if (outcome.kind === 'done') {
            converted += 1;
            let preview: QueueItem['preview'];
            if (outcome.preview) {
              const url = URL.createObjectURL(outcome.preview.svg);
              previews.current.set(item.id, url);
              preview = {
                url,
                width: outcome.preview.width,
                height: outcome.preview.height,
                pageCount: outcome.preview.pageCount,
              };
            }
            patch(item.id, {
              status: 'done',
              stage: undefined,
              format,
              outputs: outcome.outputs,
              notes: outcome.notes,
              message: outcome.caveat,
              suggestion: outcome.suggestion,
              verdict: outcome.verdict,
              stats: outcome.stats,
              preview,
            });
          } else if (outcome.kind === 'unreadable') {
            unreadable += 1;
            patch(item.id, {
              status: 'unreadable',
              stage: undefined,
              message: outcome.message,
              stats: outcome.stats,
            });
          } else {
            failed += 1;
            patch(item.id, { status: 'error', stage: undefined, message: outcome.message });
          }
        } catch (error) {
          failed += 1;
          patch(item.id, {
            status: 'error',
            stage: undefined,
            message:
              error instanceof Error && error.message
                ? error.message
                : 'Something went wrong converting this file. Trying a different format usually works.',
          });
        }
      }

      const parts = [plural(converted, 'file converted', 'files converted')];
      if (unreadable > 0) parts.push(`${unreadable} we could not read`);
      if (failed > 0) parts.push(plural(failed, 'problem', 'problems'));
      setAnnouncement(
        `${stopping.current ? 'Stopped' : 'Finished'}. ${parts.join(', ')}. Your files are listed below.`,
      );
    } finally {
      stopping.current = false;
      setBusy(false);
    }
  }, [docxMode, format, items, patch, releasePreview, runner, warm]);

  const ready = useMemo(() => items.filter((item) => item.status === 'done'), [items]);
  const outputCount = useMemo(
    () => ready.reduce((total, item) => total + (item.outputs?.length ?? 0), 0),
    [ready],
  );

  const zipAll = useCallback(async () => {
    setZipProblem(null);
    setZipping(true);
    try {
      const entries = ready.flatMap((item) =>
        (item.outputs ?? []).map((output) => ({ name: output.name, blob: output.blob })),
      );

      // What did not convert travels with what did. Somebody opening this folder in
      // eighteen months should not have to remember which three files to chase.
      const trouble = items.filter(
        (item) => item.status === 'unreadable' || item.status === 'error',
      );
      const comment =
        trouble.length > 0
          ? [
              'These files are not in this folder, because we could not convert them:',
              '',
              ...trouble.map(
                (item) => `${item.file.name}\n    ${item.message ?? 'Unknown problem.'}`,
              ),
              '',
              'Until 1 October 2026 you can still open them in Publisher itself and save them as',
              'PDF from there.',
            ].join('\n')
          : undefined;

      const blob = await runner().zip(entries, comment);
      save(blob, 'converted-publications.zip');
      setAnnouncement(`Your .zip of ${plural(entries.length, 'file', 'files')} is downloading.`);
    } catch (error) {
      setZipProblem(
        error instanceof Error && error.message
          ? error.message
          : 'We could not put your files into one .zip. You can still save them one at a time.',
      );
    } finally {
      setZipping(false);
    }
  }, [items, ready, runner]);

  const formatName = FORMATS[format].name;

  /*
   * The button describes what pressing it will do, which — since `run` takes the
   * whole list — is the whole list. Counting only the unconverted ones made it
   * disable itself after a successful batch and then sit there greyed out reading
   * "Convert to PDF" once the format was changed, which is the opposite of the
   * truth. `unreadable` and `error` rows are included in the count for the same
   * reason: they are files in the list, and pressing Convert does try them again.
   */
  const alreadyInThisFormat =
    items.length > 0 && items.every((item) => item.status === 'done' && item.format === format);

  const buttonLabel = busy
    ? 'Converting…'
    : alreadyInThisFormat
      ? items.length > 1
        ? `Convert all ${items.length} again to ${formatName}`
        : `Convert again to ${formatName}`
      : items.length > 1
        ? `Convert ${items.length} files to ${formatName}`
        : `Convert to ${formatName}`;

  return (
    <div className="flex flex-col gap-6">
      <DropZone onFiles={addFiles} onIntent={warm} busy={busy} />

      <FormatPicker
        value={format}
        onChange={setFormat}
        docxMode={docxMode}
        onDocxModeChange={setDocxMode}
        available={AVAILABLE}
        disabled={busy}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || items.length === 0 || engineProblem !== null}
          onClick={() => void run()}
        >
          {buttonLabel}
        </button>

        {busy && (
          <button
            type="button"
            className="btn-quiet"
            onClick={() => {
              stopping.current = true;
              setAnnouncement('Stopping after the file being converted now.');
            }}
          >
            Stop after this file
          </button>
        )}

        {!busy && outputCount > 1 && (
          <button
            type="button"
            className="btn-quiet"
            disabled={zipping}
            onClick={() => void zipAll()}
          >
            {zipping ? 'Packing…' : `Save all ${outputCount} files as one .zip`}
          </button>
        )}

        <p className="text-sm text-muted">
          {engineReady
            ? 'The reader is loaded. You can disconnect from the internet and this will still work.'
            : 'Your file is opened here, on this computer. It is never sent anywhere.'}
        </p>
      </div>

      {/* The one place progress is announced. The list itself is not a live region:
          it changes on every step of every file, and hearing all of that is worse
          than hearing none of it. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {engineProblem && (
        <div
          role="alert"
          className="max-w-prose rounded-xl border border-line bg-surface p-4 text-sm text-danger"
        >
          <p>
            {engineProblem} Until 1 October 2026 you can still open your file in Publisher itself
            and save it as PDF from there.
          </p>
          {/* A failed load is usually a flaky fetch, not a verdict on the browser, so
              there has to be a way back. Without this the Convert button stayed
              disabled for the life of the tab and reloading the page was the only cure. */}
          <p className="mt-3">
            <button type="button" className="btn-quiet" onClick={() => warm({ force: true })}>
              Try loading the reader again
            </button>
          </p>
        </div>
      )}

      {zipProblem && (
        <p
          role="alert"
          className="max-w-prose rounded-xl border border-line bg-surface p-4 text-sm text-danger"
        >
          {zipProblem}
        </p>
      )}

      {runMode === 'inline' && (
        <p className="max-w-prose text-sm text-muted">
          This browser will not let us convert in the background, so the page may sit still for a
          moment while it works. Nothing is wrong — give it a few seconds.
        </p>
      )}

      {items.length > 0 && (
        <ul className="space-y-3" aria-busy={busy}>
          {items.map((item) => {
            const notes = groupNotes(item.notes);
            return (
              <li key={item.id} className="card p-4">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="truncate font-medium">{item.file.name}</span>
                  <span className="shrink-0 text-sm text-muted">{formatBytes(item.file.size)}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className={[
                      'text-sm',
                      item.status === 'error' || item.status === 'unreadable'
                        ? 'text-danger'
                        : item.status === 'done'
                          ? 'text-positive'
                          : 'text-muted',
                    ].join(' ')}
                  >
                    {item.status === 'working' && isStage(item.stage)
                      ? `${STAGE_LABEL[item.stage]}…`
                      : STATUS_LABEL[item.status]}
                  </span>

                  {item.status === 'done' && item.stats && (
                    <span className="text-sm text-muted">
                      {plural(item.stats.pages, 'page', 'pages')}
                      {item.stats.images > 0
                        ? `, ${plural(item.stats.images, 'picture', 'pictures')}`
                        : ', no pictures'}
                    </span>
                  )}

                  {item.status !== 'working' && (
                    <button
                      type="button"
                      onClick={() => remove(item.id)}
                      disabled={busy}
                      className="ml-auto rounded-lg px-2 py-1 text-sm text-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                    >
                      Remove<span className="sr-only"> {item.file.name}</span>
                    </button>
                  )}
                </div>

                {item.message && (
                  <p
                    className={`mt-2 max-w-prose text-sm ${
                      item.status === 'done' ? 'text-caution' : 'text-danger'
                    }`}
                  >
                    {item.message}
                  </p>
                )}

                {item.status === 'done' && item.suggestion && (
                  <p className="mt-2 max-w-prose text-sm text-muted">
                    {item.suggestion.because}{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-fg"
                      onClick={() => setFormat(item.suggestion!.format)}
                    >
                      Convert to {FORMATS[item.suggestion.format].name} instead
                    </button>
                  </p>
                )}

                {item.status === 'done' && item.preview && (
                  <PagePreview
                    url={item.preview.url}
                    width={item.preview.width}
                    height={item.preview.height}
                    pageCount={item.preview.pageCount}
                    fileName={item.file.name}
                  />
                )}

                {/* There is deliberately no download button for a file we could not
                    read. Handing someone a blank document and calling it a success is
                    the exact failure this product exists to prevent — docs/FIDELITY.md. */}
                {item.status === 'done' && item.outputs && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.outputs.map((output, index) => (
                      <DownloadLink key={output.name} output={output} primary={index === 0} />
                    ))}
                  </div>
                )}

                {item.status === 'done' && notes.length > 0 && (
                  <details className="mt-3 rounded-xl border border-line bg-canvas p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      {notes.length === 1
                        ? 'One thing changed on the way across'
                        : `${notes.length} things changed on the way across`}
                    </summary>
                    <ul className="mt-2 space-y-1.5 text-sm text-muted">
                      {notes.map((note) => (
                        <li key={note.code}>
                          {note.title}
                          <span className="block text-xs">
                            {note.count > 1 ? `${note.count} times` : 'Once'}
                            {note.pages.length > 0 ? `, on ${pageList(note.pages)}` : ''}.
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
