/** Small shared helpers for anything printed to a person. No dependencies, by design. */

const ESC = '[';

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  amber(s: string): string;
  green(s: string): string;
}

const PLAIN: Paint = {
  bold: (s) => s, dim: (s) => s, red: (s) => s, amber: (s) => s, green: (s) => s,
};

const COLOUR: Paint = {
  bold: (s) => `${ESC}1m${s}${ESC}22m`,
  dim: (s) => `${ESC}2m${s}${ESC}22m`,
  red: (s) => `${ESC}31m${s}${ESC}39m`,
  amber: (s) => `${ESC}33m${s}${ESC}39m`,
  green: (s) => `${ESC}32m${s}${ESC}39m`,
};

/**
 * NO_COLOR is honoured because this gets run from scripts and scheduled jobs, where
 * escape codes end up in a log file that somebody later has to read.
 */
export function paint(wanted: boolean, stream: { isTTY?: boolean }): Paint {
  if (!wanted) return PLAIN;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return PLAIN;
  if (process.env.TERM === 'dumb') return PLAIN;
  return stream.isTTY === true ? COLOUR : PLAIN;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes} ${plural(minutes, 'minute')} ${rest} ${plural(rest, 'second')}`;
}

/** Trims a path for a progress line so it never wraps and scrolls the counter away. */
export function shorten(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return `…${text.slice(text.length - (width - 1))}`;
}
