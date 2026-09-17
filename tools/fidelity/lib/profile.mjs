// Builds a corpus profile: every librevenge event type and every property key the
// corpus actually contains, with counts and a real example value for each.
//
// This is the discovery instrument. A key that shows up here and nowhere in
// types.ts is a feature we are silently dropping.

const MAX_SAMPLES = 8;
const MAX_SAMPLE_LEN = 120;

/** `{v,u}` measure, plain string, or a nested vector of property maps. */
function kindOf(value) {
  if (Array.isArray(value)) return 'vector';
  if (value && typeof value === 'object') return 'v' in value && 'u' in value ? 'measure' : 'object';
  return typeof value;
}

function sampleOf(value) {
  if (typeof value === 'string') return value.length > MAX_SAMPLE_LEN ? value.slice(0, MAX_SAMPLE_LEN) + '…' : value;
  return value;
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

export function emptyProfile() {
  return {
    files: 0,
    events: {},      // eventType -> { count, files, props: {key: count} }
    properties: {},  // qualified key -> { count, files, kinds, units, events, samples }
    text: { events: 0, chars: 0 },
    assets: { count: 0, bytes: 0 },
  };
}

function propEntry(profile, key) {
  return (profile.properties[key] ??= {
    count: 0,
    files: 0,
    kinds: {},
    units: {},
    events: {},
    samples: [],
    _files: new Set(),
  });
}

function recordProps(profile, eventType, props, prefix, fileName) {
  for (const [rawKey, value] of Object.entries(props)) {
    const key = prefix + rawKey;
    const entry = propEntry(profile, key);
    entry.count++;
    entry._files.add(fileName);
    bump(entry.kinds, kindOf(value));
    bump(entry.events, eventType);

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') recordProps(profile, eventType, item, `${key}[].`, fileName);
      }
      if (entry.samples.length < MAX_SAMPLES) entry.samples.push({ length: value.length });
      continue;
    }

    if (value && typeof value === 'object' && 'u' in value) bump(entry.units, value.u === '' ? '(generic)' : value.u);

    const sample = sampleOf(value);
    const asJson = JSON.stringify(sample);
    if (entry.samples.length < MAX_SAMPLES && !entry.samples.some((s) => JSON.stringify(s) === asJson)) {
      entry.samples.push(sample);
    }
  }
}

export function addFile(profile, fileName, ir) {
  profile.files++;
  const seenEvents = new Set();

  for (const ev of ir.events) {
    const type = ev.t;
    const e = (profile.events[type] ??= { count: 0, files: 0, props: {}, _files: new Set() });
    e.count++;
    e._files.add(fileName);
    seenEvents.add(type);

    if (typeof ev.s === 'string') {
      profile.text.events++;
      profile.text.chars += ev.s.length;
    }
    if (ev.p) {
      for (const k of Object.keys(ev.p)) bump(e.props, k);
      recordProps(profile, type, ev.p, '', fileName);
    }
  }

  const assets = ir.assets ?? {};
  for (const k of Object.keys(assets)) {
    profile.assets.count++;
    profile.assets.bytes += Math.floor((assets[k].length * 3) / 4);
  }
  return seenEvents;
}

/** Collapses the internal Sets into counts and sorts everything for a stable diff. */
export function finalizeProfile(profile) {
  const events = {};
  for (const key of Object.keys(profile.events).sort()) {
    const e = profile.events[key];
    events[key] = {
      count: e.count,
      files: e._files.size,
      props: Object.fromEntries(Object.entries(e.props).sort((a, b) => b[1] - a[1])),
    };
  }

  const properties = {};
  for (const key of Object.keys(profile.properties).sort()) {
    const p = profile.properties[key];
    properties[key] = {
      count: p.count,
      files: p._files.size,
      kinds: p.kinds,
      ...(Object.keys(p.units).length ? { units: p.units } : {}),
      events: Object.fromEntries(Object.entries(p.events).sort((a, b) => b[1] - a[1])),
      example: p.samples[0],
      ...(p.samples.length > 1 ? { samples: p.samples } : {}),
    };
  }

  return {
    files: profile.files,
    text: profile.text,
    assets: profile.assets,
    eventTypes: Object.keys(events).length,
    propertyKeys: Object.keys(properties).length,
    events,
    properties,
  };
}

export function profileKeys(finalized) {
  return Object.keys(finalized.properties);
}
