# Pubshift IR — the contract between the native extractor and everything else

`bin/pubshift-extract <file.pub>` writes one JSON object to stdout.

## Success

```jsonc
{
  "ok": true,
  "events": [ { "t": "<eventType>", "p": { ...props }, "s": "<text>" } ],
  "assets": { "a<hash>": "<base64 payload>" }
}
```

## Failure

```jsonc
{ "ok": false, "error": { "code": "UNSUPPORTED|PARSE_FAILED|PARSE_EXCEPTION|NO_INPUT", "message": "..." } }
```

`message` is written to be shown to a non-technical user as-is.

## Rules

- Events are the **raw librevenge callback stream**, in order. Nothing is interpreted
  natively; all semantics live in `packages/core`.
- A property is either a plain JSON string, or `{"v": number, "u": unit}` where unit is
  one of `in`, `pt`, `twip`, `%`, `""` (generic).
- Nested property vectors (`svg:d`, `svg:points`, `svg:linearGradient`,
  `librevenge:table-columns`) are arrays of property objects.
- Embedded binaries are hoisted: the event carries `assetRef` and the bytes live in
  `assets`, deduplicated by content.

## Units — measured against the real corpus, not assumed

| Property | Declared unit | Actual meaning |
|---|---|---|
| `svg:x/y/width/height` | `in` | inches — trustworthy |
| `fo:font-size` | `in` | inches; multiply by 72 for points (0.1111in = 8pt) |
| `librevenge:rotate` | `in` | **degrees** — the unit tag is meaningless |
| `draw:opacity`, `draw:shadow-opacity` | `%` | 0..1 fraction |
| `fo:line-height` | `%` | multiplier (1.15 = 115%) |
| `fo:text-scale` | `%` | already a percentage (80 = 80%) |

These are covered by `normalizeUnits` and locked down by tests in
`packages/core/test/units.test.ts`. Treat the table as authoritative over intuition.

## Observed event vocabulary (31-file corpus, Publisher 97 → 2010)

`startDocument` `metaData` `startPage` `endPage` `startLayer` `endLayer` `setStyle`
`startTextObject` `endTextObject` `openParagraph` `closeParagraph` `openSpan` `closeSpan`
`text` `insertSpace` `insertTab` `insertLineBreak` `startTableObject` `openTableRow`
`openTableCell` `coveredTableCell` `endTableObject` `drawPolygon` `drawPath`
`drawRectangle` `drawEllipse` `drawGraphicObject` `openGroup` `closeGroup` `endDocument`
