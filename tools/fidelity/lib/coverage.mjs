// Diffs what the corpus contains against what we claim to handle or to have
// consciously dropped. A key in neither list is a feature we never noticed —
// that is a build failure, not a note.

export function checkCoverage(profile, handled) {
  const propHandled = handled.properties?.handled ?? {};
  const propIgnored = handled.properties?.ignored ?? {};
  const evHandled = handled.events?.handled ?? {};
  const evIgnored = handled.events?.ignored ?? {};
  const evAbsent = handled.events?.documentedButAbsent ?? {};

  const both = (a, b) => {
    const dup = Object.keys(a).filter((k) => k in b);
    return dup;
  };

  const unknownProperties = [];
  for (const [key, info] of Object.entries(profile.properties)) {
    if (key in propHandled || key in propIgnored) continue;
    unknownProperties.push({
      key,
      count: info.count,
      files: info.files,
      events: Object.keys(info.events),
      example: info.example,
    });
  }

  const unknownEvents = [];
  for (const [type, info] of Object.entries(profile.events)) {
    if (type in evHandled || type in evIgnored) continue;
    unknownEvents.push({ event: type, count: info.count, files: info.files });
  }

  const stalePropertyKeys = [...Object.keys(propHandled), ...Object.keys(propIgnored)].filter(
    (k) => !(k in profile.properties),
  );
  const staleEventKeys = [...Object.keys(evHandled), ...Object.keys(evIgnored)].filter(
    (k) => !(k in profile.events),
  );
  const nowPresent = Object.keys(evAbsent).filter((k) => k in profile.events);

  const contradictions = [
    ...both(propHandled, propIgnored).map((k) => ({ scope: 'property', key: k })),
    ...both(evHandled, evIgnored).map((k) => ({ scope: 'event', key: k })),
  ];

  // Everything in `ignored` is a fidelity loss we have accepted on purpose.
  const knownLosses = Object.entries(propIgnored)
    .filter(([k]) => k in profile.properties)
    .map(([key, reason]) => ({
      key,
      reason,
      count: profile.properties[key].count,
      files: profile.properties[key].files,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    corpusPropertyKeys: Object.keys(profile.properties).length,
    corpusEventTypes: Object.keys(profile.events).length,
    handledProperties: Object.keys(propHandled).filter((k) => k in profile.properties).length,
    ignoredProperties: knownLosses.length,
    unknownProperties,
    unknownEvents,
    stalePropertyKeys,
    staleEventKeys,
    documentedButAbsent: Object.keys(evAbsent).filter((k) => !(k in profile.events)),
    documentedAbsentNowPresent: nowPresent,
    contradictions,
    knownLosses,
    pass: unknownProperties.length === 0 && unknownEvents.length === 0 && contradictions.length === 0,
  };
}
