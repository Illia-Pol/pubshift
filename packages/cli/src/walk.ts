/**
 * Finding the .pub files.
 *
 * Everything awkward in this module comes from one place: the folder being walked is
 * a fifteen-year parish or school archive on a shared drive, not a tidy checkout. It
 * has "Bulletin.PUB" next to "bulletin.pub", folder names with em dashes and accents,
 * a Windows shortcut somebody made in 2011, a file that is open in Publisher right
 * now, and a `Newsletter.pub` that is really a renamed JPEG.
 *
 * None of that is allowed to stop the run. A problem with one entry becomes a line in
 * the report; only a problem with the folder the user actually named is fatal.
 */

import { readdirSync, realpathSync, statSync, lstatSync, type Dirent } from 'node:fs';
import path from 'node:path';

import { UsageError } from './types';

export interface FoundFile {
  /** Absolute path, spelled the way it was found on disk. */
  path: string;
  /** Path relative to the folder the user named — the spelling a person recognises. */
  relative: string;
  size: number;
  /** Set when this entry was reached through a symbolic link. */
  via?: string;
}

export interface WalkProblem {
  path: string;
  relative: string;
  reason: string;
  /**
   * `attention` is something the user has to deal with — a folder we could not open, a
   * shortcut pointing nowhere. `note` is us explaining a decision we made on their
   * behalf, which belongs in the report but not in the count of files needing a person.
   */
  severity: 'attention' | 'note';
}

export interface WalkResult {
  files: FoundFile[];
  problems: WalkProblem[];
  /** True when the user named a single file rather than a folder. */
  singleFile: boolean;
}

/**
 * Deep enough for any real archive, shallow enough that a symlink loop we somehow
 * failed to notice still ends. The realpath guard below is the actual protection;
 * this is the belt to its braces.
 */
const MAX_DEPTH = 64;

export function isPubName(name: string): boolean {
  // Mixed case is the norm, not the exception: Publisher 97 wrote .PUB and later
  // versions wrote .pub, so a fifteen-year archive has both.
  return /\.pub$/i.test(name);
}

/**
 * Files that are named like documents but are not documents.
 *
 * `~$Bulletin.pub` is the lock file Office writes beside a document while it is
 * open. It is a few hundred bytes of owner name, it is not a publication, and
 * converting it produces a confusing failure for something the user never made.
 * `._Bulletin.pub` is the metadata half of a file copied from a Mac onto a non-Mac
 * volume, and has the same problem.
 */
export function isSidecarName(name: string): boolean {
  return name.startsWith('~$') || name.startsWith('._');
}

function describeIoError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'We do not have permission to read this.';
    case 'ENOENT':
      return 'This disappeared while we were looking at it.';
    case 'ELOOP':
      return 'This is a shortcut that points at itself.';
    case 'ENAMETOOLONG':
      return 'The name of this is too long for the system to open.';
    case 'EIO':
      return 'The disk reported an error reading this. If it is on a network drive, copy it to this computer and try again.';
    default:
      return `We could not read this (${code ?? 'unknown error'}).`;
  }
}

/**
 * Resolves a path through any symlinks. Returns null when it cannot be resolved,
 * which for our purposes means "treat it as its own thing and do not deduplicate".
 */
function realOrNull(target: string): string | null {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return null;
  }
}

export function walk(
  root: string,
  options: { recursive: boolean; followSymlinks: boolean },
): WalkResult {
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(
      code === 'ENOENT'
        ? `There is no folder called "${root}".`
        : `We could not open "${root}". ${describeIoError(error)}`,
      code === 'ENOENT'
        ? 'Check the spelling, and remember that a name with spaces in it needs quotes around it.'
        : undefined,
    );
  }

  if (rootStat.isFile()) {
    if (!isPubName(root)) {
      throw new UsageError(
        `"${path.basename(root)}" is not a Publisher file.`,
        'Point this at a .pub file, or at a folder that contains some.',
      );
    }
    return {
      files: [{ path: root, relative: path.basename(root), size: rootStat.size }],
      problems: [],
      singleFile: true,
    };
  }

  if (!rootStat.isDirectory()) {
    throw new UsageError(`"${root}" is not a folder or a file we can read.`);
  }

  const files: FoundFile[] = [];
  const problems: WalkProblem[] = [];

  /** Real paths of directories already entered: the guard against a symlink loop. */
  const seenDirs = new Set<string>();
  /** Real path -> its index in `files`: the guard against converting one file twice. */
  const seenFiles = new Map<string, number>();

  const rootReal = realOrNull(root);
  if (rootReal) seenDirs.add(rootReal);

  const relativeTo = (target: string): string => {
    const rel = path.relative(root, target);
    return rel === '' ? path.basename(target) : rel;
  };

  const visit = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push({
        path: dir,
        relative: relativeTo(dir),
        reason: describeIoError(error),
        severity: 'attention',
      });
      return;
    }

    // Sorted so that two runs over the same archive produce the same report, and so
    // that "(2)" suffixes land on the same file every time rather than moving about.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let via: string | undefined;

      if (entry.isSymbolicLink()) {
        via = full;
        let linked;
        try {
          linked = statSync(full);
        } catch (error) {
          // A broken shortcut is worth one line in the report and nothing more: an
          // archive that has been moved between drives is full of them, and they are
          // not what the user came here to fix.
          if (isPubName(entry.name) && !isSidecarName(entry.name)) {
            problems.push({
              path: full,
              relative: relativeTo(full),
              reason: `This is a shortcut that no longer points anywhere. ${describeIoError(error)}`,
              severity: 'attention',
            });
          }
          continue;
        }
        isDir = linked.isDirectory();
        isFile = linked.isFile();
      }

      if (isDir) {
        if (!options.recursive) continue;
        if (entry.isSymbolicLink() && !options.followSymlinks) {
          // Following folder shortcuts by default is how a walk ends up converting
          // the whole of someone's home directory, or looping forever.
          problems.push({
            path: full,
            relative: relativeTo(full),
            reason: 'This is a shortcut to another folder, and was not followed. Use --follow-symlinks to include it.',
            severity: 'note',
          });
          continue;
        }
        if (depth >= MAX_DEPTH) {
          problems.push({
            path: full,
            relative: relativeTo(full),
            reason: `Folders are nested more than ${MAX_DEPTH} deep here, so we stopped.`,
            severity: 'attention',
          });
          continue;
        }
        const real = realOrNull(full);
        if (real !== null) {
          if (seenDirs.has(real)) continue;
          seenDirs.add(real);
        }
        visit(full, depth + 1);
        continue;
      }

      if (!isFile) continue;
      if (!isPubName(entry.name)) continue;
      if (isSidecarName(entry.name)) continue;

      let size: number;
      try {
        size = (entry.isSymbolicLink() ? statSync(full) : lstatSync(full)).size;
      } catch (error) {
        problems.push({
          path: full, relative: relativeTo(full), reason: describeIoError(error),
          severity: 'attention',
        });
        continue;
      }

      const found: FoundFile = via === undefined
        ? { path: full, relative: relativeTo(full), size }
        : { path: full, relative: relativeTo(full), size, via };

      const real = realOrNull(full);
      if (real !== null) {
        const already = seenFiles.get(real);
        if (already !== undefined) {
          const kept = files[already] as FoundFile;

          // The real file wins over a shortcut to it, whichever we happened to meet
          // first. Otherwise `Shortcut to fonts.pub` sorting before `fonts.pub` means the
          // converted document is named after somebody's 2011 alias, and the document
          // itself is the one reported as a duplicate.
          const replace = kept.via !== undefined && via === undefined;
          if (replace) files[already] = found;
          const winner = replace ? found : kept;
          const duplicate = replace ? kept : found;
          problems.push({
            path: duplicate.path,
            relative: duplicate.relative,
            reason: `This is the same file as "${winner.relative}", reached through a shortcut, so it was only converted once.`,
            severity: 'note',
          });
          continue;
        }
        seenFiles.set(real, files.length);
      }

      files.push(found);
    }
  };

  visit(root, 0);

  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  problems.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  return { files, problems, singleFile: false };
}
