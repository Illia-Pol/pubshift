/**
 * Stand-in for an emitter that is not in the tree yet.
 *
 * `next.config.mjs` points `@emit/<format>` at the real module in
 * `packages/core/src/emit/` when that file exists, and at this one when it does
 * not. The app therefore always builds, and a format whose emitter has not landed
 * says so plainly in the results list instead of offering a button that does
 * nothing — which is the same rule `assess()` applies to empty documents.
 *
 * Nothing here is a fallback conversion. There is no such thing as a partial
 * PPTX; refusing is the honest answer.
 */

/**
 * The marker `convert.ts` looks for. A real emitter module does not export it, so
 * `availableFormats()` can tell the picker the truth before anyone picks a file.
 */
export const EMITTER_UNAVAILABLE = true;

export class EmitterUnavailableError extends Error {
  readonly format: string;

  constructor(format: string) {
    super(
      `We cannot make a ${format.toUpperCase()} file in this build yet. ` +
        'Pick a different format — the others on this page work.',
    );
    this.name = 'EmitterUnavailableError';
    this.format = format;
    Object.setPrototypeOf(this, EmitterUnavailableError.prototype);
  }
}

export function emitPPTX(): Promise<Uint8Array> {
  return Promise.reject(new EmitterUnavailableError('pptx'));
}

export function emitDOCX(): Promise<Uint8Array> {
  return Promise.reject(new EmitterUnavailableError('docx'));
}

export function emitPDF(): Promise<Uint8Array> {
  return Promise.reject(new EmitterUnavailableError('pdf'));
}

export function emitSVGPages(): string[] {
  throw new EmitterUnavailableError('svg');
}

export function emitSVG(): string {
  throw new EmitterUnavailableError('svg');
}
