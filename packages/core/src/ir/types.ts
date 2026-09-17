/**
 * The raw IR envelope, exactly as `bin/pubshift-extract` emits it.
 *
 * Nothing here interprets anything: these are the librevenge callbacks and
 * property names verbatim. See `docs/IR.md` for the wire contract, and
 * `./units.ts` for the (measured, not assumed) unit quirks.
 */

/** Unit tag the extractor writes. `''` is librevenge's RVNG_GENERIC. */
export type IRUnit = 'in' | 'pt' | 'twip' | '%' | '' | '?';

/** A numeric property with the unit librevenge *claimed*. Often a lie — see units.ts. */
export interface IRMeasure {
  v: number;
  u: IRUnit;
}

export type IRValue = string | IRMeasure | IRPropList[];

export interface IRPropList {
  readonly [key: string]: IRValue | undefined;
}

/**
 * The callbacks the extractor implements. Kept open-ended: librevenge can grow a
 * callback without our reader having to reject the file over it.
 */
export type IRKnownEvent =
  | 'startDocument' | 'endDocument' | 'metaData' | 'defineEmbeddedFont'
  | 'startPage' | 'endPage' | 'startMasterPage' | 'endMasterPage'
  | 'setStyle' | 'startLayer' | 'endLayer'
  | 'startEmbeddedGraphics' | 'endEmbeddedGraphics'
  | 'openGroup' | 'closeGroup'
  | 'drawRectangle' | 'drawEllipse' | 'drawPolygon' | 'drawPolyline'
  | 'drawPath' | 'drawGraphicObject' | 'drawConnector'
  | 'startTextObject' | 'endTextObject'
  | 'startTableObject' | 'openTableRow' | 'closeTableRow'
  | 'openTableCell' | 'closeTableCell' | 'coveredTableCell' | 'endTableObject'
  | 'text' | 'insertTab' | 'insertSpace' | 'insertLineBreak' | 'insertField'
  | 'openOrderedList' | 'closeOrderedList'
  | 'openUnorderedList' | 'closeUnorderedList'
  | 'openListElement' | 'closeListElement'
  | 'defineParagraphStyle' | 'openParagraph' | 'closeParagraph'
  | 'defineCharacterStyle' | 'openSpan' | 'closeSpan'
  | 'openLink' | 'closeLink';

export type IREventType = IRKnownEvent | (string & {});

export interface IREvent {
  t: IREventType;
  p?: IRPropList;
  /** Only on `text`. */
  s?: string;
}

export interface IREnvelope {
  events: IREvent[];
  /** Content-addressed binaries the extractor hoisted out of the event stream. */
  assets: Record<string, string>;
}

/**
 * `BAD_IR` is the only code the reader itself originates; the rest come from the
 * extractor and their messages are already written for a non-technical reader.
 */
export type IRErrorCode =
  | 'UNSUPPORTED' | 'PARSE_FAILED' | 'PARSE_EXCEPTION' | 'NO_INPUT' | 'BAD_IR';

export interface IRSuccessWire {
  ok: true;
  events: IREvent[];
  assets?: Record<string, string>;
}

export interface IRFailureWire {
  ok: false;
  error: { code: IRErrorCode; message: string };
}

export type IRWire = IRSuccessWire | IRFailureWire;

export function isMeasure(v: IRValue | undefined): v is IRMeasure {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && typeof (v as IRMeasure).v === 'number';
}

export function isVector(v: IRValue | undefined): v is IRPropList[] {
  return Array.isArray(v);
}

export function propStr(p: IRPropList | undefined, key: string): string | undefined {
  const v = p?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function propMeasure(p: IRPropList | undefined, key: string): IRMeasure | undefined {
  const v = p?.[key];
  return isMeasure(v) ? v : undefined;
}

export function propVec(p: IRPropList | undefined, key: string): IRPropList[] {
  const v = p?.[key];
  return isVector(v) ? v : [];
}
