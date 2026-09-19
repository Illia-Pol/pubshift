'use client';

import { useCallback, useState } from 'react';

import {
  ARCHIVE_SIZES,
  INTEREST_ENDPOINT,
  type ArchiveSize,
  looksLikeEmail,
} from '@/lib/interest';

/**
 * The only form on this site, and the only thing that ever sends anything anywhere.
 *
 * It says so on its face rather than in a policy: the visitor is told exactly what leaves
 * and what does not, next to the field, before they type. On a site whose entire argument
 * is "your file never leaves this page", a form that was coy about this would cost more
 * trust than the addresses are worth.
 */
export default function InterestForm({ source }: { source: string }) {
  const [email, setEmail] = useState('');
  const [size, setSize] = useState<ArchiveSize | ''>('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!looksLikeEmail(email)) {
        setState('error');
        setMessage('That does not look like an email address. Please check it.');
        return;
      }
      setState('sending');
      setMessage('');
      try {
        const response = await fetch(INTEREST_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: email.trim(), archiveSize: size, source }),
        });
        if (!response.ok) throw new Error(String(response.status));
        setState('done');
      } catch {
        setState('error');
        // Never a dead end: the address is still theirs to send, and the tool is free anyway.
        setMessage(
          'We could not record that just now. The batch tool below is free to use either way, ' +
            'and you can email us instead.',
        );
      }
    },
    [email, size, source],
  );

  if (state === 'done') {
    return (
      <div className="card p-5" role="status">
        <p className="font-medium">Thank you — we have your address.</p>
        <p className="mt-2 text-sm text-muted">
          You will hear from us once, when the batch tool can be bought. Not a newsletter. In the
          meantime it is free below, and it is the finished thing, not a trial.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card p-5 sm:p-6">
      <label htmlFor="interest-email" className="block font-medium">
        Tell me when I can buy this
      </label>
      <p className="mt-1 text-sm text-muted">
        One email, when it happens. Nothing else, ever.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          id="interest-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
          placeholder="you@yourparish.org"
          aria-describedby="interest-note"
          className="w-full flex-1 rounded-xl border border-line bg-bg px-4 py-3 outline-none focus-visible:ring-4 focus-visible:ring-accent/40"
        />
        <button
          type="submit"
          disabled={state === 'sending'}
          className="rounded-xl bg-accent px-5 py-3 font-medium text-accent-ink disabled:opacity-60"
        >
          {state === 'sending' ? 'Sending…' : 'Let me know'}
        </button>
      </div>

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">
          Roughly how many .pub files do you have? <span className="text-muted">(optional)</span>
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {ARCHIVE_SIZES.map((option) => (
            <label
              key={option.id}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm ${
                size === option.id ? 'border-accent bg-accent/10' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="archive-size"
                value={option.id}
                checked={size === option.id}
                onChange={() => setSize(option.id)}
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <p id="interest-note" className="mt-5 text-sm text-muted">
        <strong className="font-medium text-ink">What this sends:</strong> the address you typed and,
        if you picked one, the rough number above. That is everything. It is unrelated to the
        converter — your Publisher files are opened by your own browser and are never sent anywhere,
        including here.
      </p>

      {state === 'error' && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
