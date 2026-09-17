'use client';

import { useCallback, useRef, useState } from 'react';
import DropZone from '@/components/DropZone';
import FormatPicker from '@/components/FormatPicker';
import {
  FIELD_FILE,
  FIELD_FORMAT,
  type ConvertResponse,
  type QueueItem,
  type TargetFormat,
} from '@/lib/types';

/** fetch() cannot report upload progress; XHR can, and that bar is the whole reassurance. */
function send(
  file: File,
  format: TargetFormat,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<ConvertResponse> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.set(FIELD_FORMAT, format);
    form.set(FIELD_FILE, file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert');
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.upload.onload = () => onProgress(100);

    xhr.onerror = () =>
      resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'We lost the connection. Please check your internet and try again.' },
      });
    xhr.onabort = () =>
      resolve({ ok: false, error: { code: 'INTERNAL', message: 'Stopped before it finished.' } });

    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ConvertResponse);
      } catch {
        resolve({
          ok: false,
          error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' },
        });
      }
    };

    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export default function ConvertPanel() {
  const [format, setFormat] = useState<TargetFormat>('pptx');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patch = useCallback((id: string, change: Partial<QueueItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setItems((current) => [
      ...current,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        status: 'ready' as const,
        progress: 0,
      })),
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const run = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      // One request per file, in order: a church newsletter is one big file, not fifty small ones.
      const pending = items.filter((item) => item.status === 'ready' || item.status === 'error');
      for (const item of pending) {
        if (controller.signal.aborted) break;
        patch(item.id, { status: 'uploading', progress: 0, message: undefined, result: undefined });

        const response = await send(
          item.file,
          format,
          (percent) => {
            patch(item.id, percent >= 100 ? { progress: 100, status: 'converting' } : { progress: percent });
          },
          controller.signal,
        );

        if (response.ok) {
          patch(item.id, {
            status: 'done',
            progress: 100,
            result: response,
            message: response.warnings.length > 0 ? response.warnings.map((w) => w.message).join(' ') : undefined,
          });
        } else {
          patch(item.id, { status: 'error', progress: 0, message: response.error.message });
        }
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [format, items, patch]);

  const waiting = items.filter((item) => item.status === 'ready' || item.status === 'error').length;

  return (
    <div className="flex flex-col gap-8">
      <DropZone onFiles={addFiles} items={items} onRemove={remove} busy={busy} />

      <FormatPicker value={format} onChange={setFormat} disabled={busy} />

      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="btn-primary" disabled={busy || waiting === 0} onClick={run}>
          {busy
            ? 'Working…'
            : waiting > 1
              ? `Convert ${waiting} files`
              : 'Convert my file'}
        </button>
        {busy && (
          <button type="button" className="btn-quiet" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        )}
        <p className="text-sm text-muted">
          Your file is deleted from our server the moment your download is ready.
        </p>
      </div>
    </div>
  );
}
