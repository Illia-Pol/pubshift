/**
 * @pubshift/core — read the extractor's IR, build the document model.
 *
 *   const doc = buildDoc(readIR(stdoutFromPubshiftExtract));
 *
 * `readIR` throws an `IRReadError` whose `message` is already written for the
 * person who uploaded the file.
 */

export { readIR, IRReadError } from './ir/read';
export {
  isMeasure, isVector, propMeasure, propStr, propVec,
  type IREnvelope, type IREvent, type IREventType, type IRErrorCode,
  type IRFailureWire, type IRKnownEvent, type IRMeasure, type IRPropList,
  type IRSuccessWire, type IRUnit, type IRValue, type IRWire,
} from './ir/types';
export {
  inchesToPoints, toDegrees, toFraction, toInt, toMultiplier, toPercent, toPoints,
} from './ir/units';

export { buildDoc } from './model/build';
export { assess, type Assessment, type Verdict } from './model/assess';
export type {
  Asset, Doc, DocMeta, Element, Fill, Geometry, Group, GradientStop, Image, Page,
  Paragraph, PathCommand, Point, Run, Shadow, Shape, ShapeStyle, Stroke, Table,
  TableCell, TableRow, TargetFormat, TextBox, Warning, WarningCode,
} from './model/types';
