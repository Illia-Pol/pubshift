/**
 * A minimal XML reader for tests.
 *
 * There is no XML parser in the dependency tree and adding one to assert on emitter
 * output would be a heavy dependency for a light job. This parser is deliberately
 * strict: it throws on unbalanced tags, on an unescaped `<` or `&` in text, and on an
 * unterminated attribute — which makes `parseXML(svg)` itself the well-formedness test
 * that catches escaping bugs, the failure mode SVG emitters actually hit in the wild.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  /** Concatenated direct text content, with entities resolved. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const e = ENTITIES[body];
    if (e === undefined) throw new Error(`unknown entity ${whole}`);
    return e;
  });
}

export function parseXML(source: string): XNode {
  let i = 0;
  const src = source;

  const skipProlog = () => {
    for (;;) {
      const before = i;
      while (i < src.length && /\s/.test(src[i] as string)) i++;
      if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i);
        if (end < 0) throw new Error('unterminated processing instruction');
        i = end + 2;
      } else if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 3;
      } else if (src.startsWith('<!', i)) {
        const end = src.indexOf('>', i);
        if (end < 0) throw new Error('unterminated declaration');
        i = end + 1;
      }
      if (i === before) return;
    }
  };

  const readName = (): string => {
    const start = i;
    while (i < src.length && /[^\s/>=]/.test(src[i] as string)) i++;
    if (i === start) throw new Error(`expected a name at offset ${start}`);
    return src.slice(start, i);
  };

  const readAttrs = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (;;) {
      while (i < src.length && /\s/.test(src[i] as string)) i++;
      const c = src[i];
      if (c === undefined) throw new Error('unterminated start tag');
      if (c === '>' || c === '/') return out;
      const name = readName();
      if (src[i] !== '=') throw new Error(`attribute ${name} has no value`);
      i++;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") throw new Error(`attribute ${name} is not quoted`);
      i++;
      const end = src.indexOf(quote, i);
      if (end < 0) throw new Error(`unterminated value for attribute ${name}`);
      const raw = src.slice(i, end);
      if (raw.includes('<')) throw new Error(`raw '<' inside attribute ${name}`);
      if (name in out) throw new Error(`duplicate attribute ${name}`);
      out[name] = decode(raw);
      i = end + 1;
    }
  };

  const readText = (): string => {
    const start = i;
    while (i < src.length && src[i] !== '<') i++;
    const raw = src.slice(start, i);
    // A bare '&' that is not an entity is exactly the escaping bug we want to catch.
    if (/&(?!(#x?[0-9a-fA-F]+|[a-zA-Z]+);)/.test(raw)) throw new Error(`unescaped '&' in text: ${raw.slice(0, 40)}`);
    return decode(raw);
  };

  const readElement = (): XNode => {
    if (src[i] !== '<') throw new Error(`expected '<' at offset ${i}`);
    i++;
    const name = readName();
    const attrs = readAttrs();
    const node: XNode = { name, attrs, children: [], text: '' };
    if (src[i] === '/') {
      i++;
      if (src[i] !== '>') throw new Error(`malformed self-closing tag ${name}`);
      i++;
      return node;
    }
    if (src[i] !== '>') throw new Error(`malformed start tag ${name}`);
    i++;
    for (;;) {
      node.text += readText();
      if (i >= src.length) throw new Error(`unclosed element ${name}`);
      if (src.startsWith('</', i)) {
        i += 2;
        const close = readName();
        if (close !== name) throw new Error(`</${close}> closes <${name}>`);
        while (i < src.length && /\s/.test(src[i] as string)) i++;
        if (src[i] !== '>') throw new Error(`malformed end tag ${close}`);
        i++;
        return node;
      }
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        if (end < 0) throw new Error('unterminated comment');
        i = end + 3;
        continue;
      }
      node.children.push(readElement());
    }
  };

  skipProlog();
  const root = readElement();
  skipProlog();
  if (i < src.length) throw new Error(`trailing content at offset ${i}`);
  return root;
}

/** Every descendant (and the node itself) with the given tag name, in document order. */
export function findAll(node: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  const walk = (x: XNode) => {
    if (x.name === name) out.push(x);
    for (const c of x.children) walk(c);
  };
  walk(node);
  return out;
}

export function findFirst(node: XNode, name: string): XNode | undefined {
  return findAll(node, name)[0];
}

/** All text under `node`, including nested elements, in document order. */
export function allText(node: XNode): string {
  let out = node.text;
  for (const c of node.children) out += allText(c);
  return out;
}
