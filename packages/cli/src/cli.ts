/**
 * The command itself: parse, walk, convert, report, exit.
 *
 * Everything here is arranged around one person — a parish or school administrator who
 * was handed a folder and a line of instructions by somebody else, and who will run this
 * once, under a deadline, on a machine they do not administer. So:
 *
 *  - Anything that can fail before the work starts, fails before the work starts. A
 *    misspelled folder, an unwritable output directory or a bad `--report` path is found
 *    in the first second, not after forty minutes of conversion.
 *  - One bad file never ends the run. It becomes a line in the report.
 *  - The summary leads with what needs a person. That ordering is the product.
 *  - Nothing opens a socket. Ever. The offline guarantee is why this exists at all
 *    (docs/POSITIONING.md), and there is no telemetry, no update check, and no path
 *    through this program that touches the network.
 */

import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseArgs, type Options } from './args';
import { convertOne, writeProduced } from './convert';
import { EngineUnavailable, loadEngine } from './engine';
import { OutputPlanner } from './plan';
import { Progress } from './progress';
import {
  checkReportDestination, needsAttention, renderTextSummary, summariseResults,
  writeReport, type ReportContext,
} from './report';
import { openPool } from './pool';
import { EXIT, UsageError, type ExitCode, type FileResult } from './types';
import { duration, paint as makePaint } from './ui';
import { walk, type FoundFile, type WalkProblem } from './walk';

declare const __PUBSHIFT_CLI_VERSION__: string | undefined;
/** Replaced at build time by build.mjs; the fallback is for running from a checkout. */
export const VERSION =
  typeof __PUBSHIFT_CLI_VERSION__ === 'string' ? __PUBSHIFT_CLI_VERSION__ : '0.1.0-dev';

export interface Streams {
  out: { write(chunk: string): unknown; isTTY?: boolean; columns?: number };
  err: { write(chunk: string): unknown; isTTY?: boolean; columns?: number };
}

const HELP = `pubshift ${VERSION} — convert a folder of Microsoft Publisher files.

Everything happens on this computer. No file is uploaded, and nothing is sent anywhere.

USAGE
  pubshift convert <folder> [options]   convert every .pub file it finds
  pubshift check   <folder> [options]   look, and say what would happen. Writes nothing.

EXAMPLES
  pubshift convert "Parish Bulletins" --recursive --report report.html
  pubshift convert Newsletters --to pdf --out "Converted PDFs"
  pubshift check ./Archive --recursive --report check.csv

OPTIONS
  -t, --to <formats>     What to convert to: pptx, docx, pdf, svg, or auto.
                         Several at once with commas: --to pptx,pdf
                         "auto" picks per file and the report says why.
                         Default: pptx.
  -o, --out <folder>     Where to put the converted files. The folders inside your
                         archive are recreated here. Default: ./Converted
  -r, --recursive        Also look inside folders. Without this, only the folder
                         you named is searched.
      --report <file>    Write the full list to a file. The ending chooses the kind:
                         .csv opens in Excel, .html opens in a browser and can be
                         emailed to somebody, .json is for scripting.
  -j, --jobs <n>         Convert n files at the same time (1-8, or "auto").
                         Default: 1. Higher is faster and uses more memory.
      --dry-run          Do everything except write the converted files.
      --on-conflict <w>  When a converted file is already there: rename (default,
                         writes "Bulletin (2).pptx"), skip, or overwrite.
      --docx-mode <m>    For --to docx: layout (default, keeps the page looking like
                         the original) or flow (ordinary Word paragraphs you can retype).
      --follow-symlinks  Follow shortcuts that point at other folders.
      --max-file-size <n> Skip files larger than this. Default 128MB.
  -q, --quiet            Print nothing but errors.
  -v, --verbose          Print a line for every file.
      --no-color         Plain text, no colours.
  -h, --help             This page.
  -V, --version          Print the version and stop.

WHAT COMES BACK
  The summary starts with the files that need a person to look at them, because those
  are the only ones you have to do anything about. A file we could read but could not
  get anything out of is never written as an empty document: you are told instead.

EXIT CODES, for anyone putting this in a script
  0  every file converted, nothing lost
  1  some files need a person
  2  nothing could be converted
  3  something was wrong with the command, the folder, or the disk
`;

/** Fails now rather than after forty minutes of work. */
function checkOutputDestination(out: string): void {
  try {
    mkdirSync(out, { recursive: true });
    accessSync(out, constants.W_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(
      `We cannot write converted files into "${out}" (${code ?? 'unknown error'}).`,
      'Pick somewhere you can write with --out, for example --out "%USERPROFILE%\\Desktop\\Converted" on Windows or --out ~/Desktop/Converted on a Mac.',
    );
  }
}

/**
 * Refuses to write converted files inside the folder being converted.
 *
 * Not tidiness: with `--recursive` the output folder is inside the walk, so a second run
 * would find the first run's output, and a `.pub` copied in later would land beside
 * files it has nothing to do with. Better to say so than to make a mess of an archive
 * somebody has been keeping since 2011.
 */
function checkOutputIsOutside(options: Options): void {
  if (options.command === 'check' || options.dryRun || !options.recursive) return;
  const input = path.resolve(options.input);
  const out = path.resolve(options.out);
  const inside = out === input || out.startsWith(input + path.sep);
  if (!inside) return;
  throw new UsageError(
    `The output folder "${out}" is inside the folder being converted.`,
    'With --recursive that would make the next run convert its own output. Choose an --out somewhere else.',
  );
}

function problemRow(problem: WalkProblem): FileResult {
  let size = 0;
  try { size = statSync(problem.path).size; } catch { /* it is unreadable; that is the point */ }
  return {
    source: problem.relative,
    absolute: problem.path,
    sizeBytes: size,
    outcome: problem.severity === 'attention' ? 'failed' : 'skipped',
    outputs: [],
    pages: 0,
    warnings: [],
    message: problem.reason,
  };
}

/**
 * The exit code, which is a documented interface somebody's backup script branches on.
 *
 * `skipped` counts as success: a re-run of a finished batch has nothing to do and should
 * not report failure. A file that converted but lost something counts as needing a
 * person, which is the whole reason the warnings are carried this far.
 */
export function exitCodeFor(results: readonly FileResult[]): ExitCode {
  const summary = summariseResults(results);
  if (summary.total === 0) return EXIT.NOTHING;
  if (summary.written === 0) return EXIT.NOTHING;
  if (summary.needsAttention > 0) return EXIT.ATTENTION;
  return EXIT.OK;
}

async function runFiles(
  files: readonly FoundFile[],
  options: Options,
  planner: OutputPlanner,
  progress: Progress,
  onResult: (result: FileResult) => void,
): Promise<void> {
  const deps = { options, planner };

  const oneAtATime = async (): Promise<void> => {
    for (const file of files) {
      const result = await convertOne(file, deps);
      progress.tick(result);
      onResult(result);
    }
  };

  if (options.jobs <= 1) return oneAtATime();

  // No point starting eight readers for three bulletins: each one is its own copy of the
  // WebAssembly module and costs memory whether or not it is given anything to do.
  const pool = openPool(Math.min(options.jobs, files.length), options);
  if (pool === null) {
    // No worker module beside us — a source checkout rather than a built install. Slower
    // is better than refusing to run.
    if (options.verbose) progress.note('Converting one file at a time.');
    return oneAtATime();
  }

  try {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(options.jobs, files.length) }, async () => {
        for (;;) {
          const index = next++;
          const file = files[index];
          if (file === undefined) return;
          // Producing happens on the worker; every decision about *which name to write*
          // stays here, where one planner sees all of them.
          const produced = await pool.run(file);
          const result = await writeProduced(file, produced, deps);
          progress.tick(result);
          onResult(result);
        }
      }),
    );
  } finally {
    await pool.close();
  }
}

export async function main(
  argv: readonly string[],
  cwd: string = process.cwd(),
  streams: Streams = { out: process.stdout, err: process.stderr },
): Promise<ExitCode> {
  const started = Date.now();
  let peakRss = 0;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  let options: Options | undefined;
  try {
    const parsed = parseArgs(argv, cwd);
    if (parsed.kind === 'help') {
      streams.out.write(HELP);
      return EXIT.OK;
    }
    if (parsed.kind === 'version') {
      streams.out.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    options = parsed.options;

    if (options.command === 'convert' && !options.dryRun) {
      checkOutputIsOutside(options);
      checkOutputDestination(options.out);
    }
    if (options.reportPath !== null) checkReportDestination(options.reportPath);
  } catch (error) {
    return fail(error, streams, options);
  }

  const progress = new Progress(streams.err, options);
  const results: FileResult[] = [];

  try {
    const found = walk(options.input, {
      recursive: options.recursive,
      followSymlinks: options.followSymlinks,
    });

    for (const problem of found.problems) results.push(problemRow(problem));

    progress.start(found.files.length);

    if (found.files.length > 0) {
      // Start the reader once, before the loop, so that "it will not start at all" is one
      // message rather than four hundred.
      if (options.jobs <= 1) await loadEngine();

      const planner = new OutputPlanner(options.out, options.conflict, options.dryRun);
      const timer = setInterval(sampleRss, 100);
      timer.unref?.();
      try {
        await runFiles(found.files, options, planner, progress, (result) => {
          results.push(result);
          sampleRss();
        });
      } finally {
        clearInterval(timer);
      }
    }
  } catch (error) {
    progress.finish();
    return fail(error, streams, options);
  }

  progress.finish();
  sampleRss();

  const ms = Date.now() - started;
  const context: ReportContext = {
    root: options.input,
    command: options.command,
    dryRun: options.dryRun,
    ms,
    version: VERSION,
    when: new Date().toISOString(),
    ...(options.command === 'convert' && !options.dryRun ? { out: options.out } : {}),
  };

  if (options.reportPath !== null) {
    try {
      writeReport(options.reportPath, results, context);
    } catch (error) {
      return fail(error, streams, options);
    }
  }

  if (!options.quiet) {
    const paint = makePaint(options.colour, streams.out);
    streams.out.write(renderTextSummary(results, context));
    const flagged = results.filter(needsAttention).length;
    streams.out.write(
      `\n${flagged > 0 ? paint.amber(`${flagged} to look at`) : paint.green('All clear')}` +
      `  ${paint.dim(`in ${duration(ms)}`)}\n`,
    );
    if (options.reportPath !== null) {
      streams.out.write(`The full list is in ${options.reportPath}\n`);
    } else if (results.length > 8) {
      streams.out.write(
        `${paint.dim('Add --report report.html for a page you can send to somebody, or --report report.csv for a spreadsheet.')}\n`,
      );
    }
    if (options.verbose && peakRss > 0) {
      streams.out.write(
        `${paint.dim(`Most memory used at any point: ${Math.round(peakRss / (1024 * 1024))} MB`)}\n`,
      );
    }
  }

  return exitCodeFor(results);
}

function fail(error: unknown, streams: Streams, options: Options | undefined): ExitCode {
  const paint = makePaint(options?.colour ?? true, streams.err);
  if (error instanceof UsageError) {
    streams.err.write(`${paint.red(error.message)}\n`);
    if (error.hint !== undefined) streams.err.write(`${error.hint}\n`);
    return EXIT.USAGE;
  }
  if (error instanceof EngineUnavailable) {
    streams.err.write(`${paint.red(error.message)}\n`);
    return EXIT.USAGE;
  }
  streams.err.write(
    `${paint.red('Something went wrong that we did not expect.')}\n` +
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  return EXIT.USAGE;
}
