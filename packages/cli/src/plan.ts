/**
 * Where each converted file goes, and what happens when something is already there.
 *
 * "Never overwrite silently" is the rule, and it has two halves that people tend to
 * conflate:
 *
 *  - **Something was already on disk before this run.** That is what `--on-conflict`
 *    is about, and the user gets to choose: rename (the default), skip, or overwrite.
 *    Skip is what makes re-running a half-finished batch cheap.
 *
 *  - **Two source files in this same run want the same output name.** No policy
 *    choice can apply here, because both `skip` and `overwrite` would mean one of the
 *    two files the user asked us to convert quietly does not exist at the end. These
 *    always get separate names. `--help` says so.
 *
 * The second case is not hypothetical. `Bulletin.pub` and `BULLETIN.PUB` are two files
 * on a Linux server and one name on the Windows machine the archive gets copied to, and
 * `2019/Easter.pub` and `2019/Easter.PUB` sitting side by side is exactly the debris a
 * fifteen-year archive accumulates.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { ConflictPolicy } from './types';

export interface Claim {
  /** Absolute path to write. */
  path: string;
  action: 'write' | 'skip';
  /** True when the name had to be changed to avoid clobbering something. */
  renamed: boolean;
  /** Internal: the pieces needed to produce the next candidate on EEXIST. */
  readonly seed: { dir: string; stem: string; ext: string; index: number };
}

/** `Bulletin March 2019.pub` -> `Bulletin March 2019` */
export function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'publication';
  const cut = base.replace(/\.pub$/i, '').trim();
  return cut === '' ? 'publication' : cut;
}

/**
 * The key two paths collide on.
 *
 * Case-folded because Windows and macOS both ignore capitals, and Unicode-normalised
 * because macOS stores `é` decomposed while Windows and Linux store it composed — so
 * the same parish newsletter copied between two machines can arrive twice under what
 * looks like one name. Folding on a case-sensitive filesystem costs nothing worse than
 * an occasional unnecessary "(2)"; not folding on a case-insensitive one costs a file.
 */
function collisionKey(target: string): string {
  return target.normalize('NFC').toLowerCase();
}

export class OutputPlanner {
  readonly #root: string;
  readonly #policy: ConflictPolicy;
  readonly #claimed = new Set<string>();
  readonly #madeDirs = new Set<string>();
  readonly #dryRun: boolean;

  constructor(root: string, policy: ConflictPolicy, dryRun: boolean) {
    this.#root = root;
    this.#policy = policy;
    this.#dryRun = dryRun;
  }

  /**
   * `relativeDir` mirrors the source folder structure under the output root, which is
   * the whole point of pointing this at an archive rather than a folder: what comes
   * out is arranged the way what went in was arranged.
   */
  plan(relativeDir: string, stem: string, ext: string): Claim {
    const dir = path.join(this.#root, relativeDir);
    return this.#candidate(dir, stem, ext, 1);
  }

  /**
   * The next name to try after an exclusive write came back EEXIST — something else
   * created the file between our check and our write. Rare, but a network drive with
   * two people tidying up at once is a real place this runs.
   */
  retry(claim: Claim): Claim {
    return this.#candidate(claim.seed.dir, claim.seed.stem, claim.seed.ext, claim.seed.index + 1);
  }

  /** Creates the folder for a claim, once per folder. Call before writing. */
  ensureDir(claim: Claim): void {
    if (this.#dryRun) return;
    const dir = path.dirname(claim.path);
    if (this.#madeDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    this.#madeDirs.add(dir);
  }

  #candidate(dir: string, stem: string, ext: string, startIndex: number): Claim {
    for (let index = startIndex; ; index++) {
      const name = index === 1 ? `${stem}.${ext}` : `${stem} (${index}).${ext}`;
      const full = path.join(dir, name);
      const key = collisionKey(full);
      const seed = { dir, stem, ext, index };

      if (this.#claimed.has(key)) continue; // taken by an earlier file in this run

      const onDisk = existsSync(full);
      if (!onDisk) {
        this.#claimed.add(key);
        return { path: full, action: 'write', renamed: index > startIndex || index > 1, seed };
      }

      // It exists. Only now does the policy get a say — and only for the first
      // candidate, because indexes past the first are us looking for a free name.
      if (index === startIndex && startIndex === 1) {
        if (this.#policy === 'skip') {
          this.#claimed.add(key);
          return { path: full, action: 'skip', renamed: false, seed };
        }
        if (this.#policy === 'overwrite') {
          this.#claimed.add(key);
          return { path: full, action: 'write', renamed: false, seed };
        }
      }
    }
  }
}
