/**
 * The emitters, declared here rather than imported from `@pubshift/core`.
 *
 * `packages/core` is written alongside this app, and the PPTX/DOCX/PDF emitters
 * may not be in the tree at the moment the app is built. `next.config.mjs` maps
 * each `@emit/<format>` specifier to the real module when the file exists and to
 * `lib/emitters/unavailable.ts` when it does not, so the build never depends on
 * files that have not landed. These declarations pin the signatures both sides
 * agreed on, which is what makes that swap type-safe.
 *
 * `Doc` still comes from the real package: the model is the contract, and if it
 * moves underneath us the compiler should say so.
 */

declare module '@emit/pptx' {
  import type { Doc } from '@pubshift/core';
  /** One slide per page. A slide is positioned boxes on a fixed canvas, same as a Publisher page. */
  export function emitPPTX(doc: Doc): Promise<Uint8Array>;
}

declare module '@emit/docx' {
  import type { Doc } from '@pubshift/core';
  /** `layout` keeps positions with frames; `flow` gives up the layout to keep the text editable. */
  export function emitDOCX(doc: Doc, options: { mode: 'layout' | 'flow' }): Promise<Uint8Array>;
}

declare module '@emit/pdf' {
  import type { Doc } from '@pubshift/core';
  export function emitPDF(doc: Doc): Promise<Uint8Array>;
}

declare module '@emit/svg' {
  import type { Doc } from '@pubshift/core';
  /** One standalone SVG document per page, in order. */
  export function emitSVGPages(doc: Doc): string[];
  /** A single page, for the results-list thumbnail. Throws `RangeError` past the end. */
  export function emitSVG(doc: Doc, options?: { page?: number }): string;
}
