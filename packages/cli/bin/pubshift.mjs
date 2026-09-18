#!/usr/bin/env node
/**
 * The command a person actually types.
 *
 * It does as little as possible: find the built program, run it, set the exit code.
 * Everything that can be tested lives in `dist/cli.js`; this file exists because npm
 * needs something to put on the PATH.
 */

// Installed first, before anything writes: this silences the "Error: write EPIPE" that a
// user otherwise gets from `pubshift check ./Archive | head`.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code !== 'EPIPE') throw error;
  });
}

// `process.exitCode` rather than `process.exit()`: on Windows, exiting outright can cut
// off output that is still on its way to the console, and the last thing printed is the
// list of files that need a person.
process.exitCode = 3;

/** Node 18.17 is the floor, and it is what package.json#engines says. */
const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 18 || (major === 18 && minor < 17)) {
  process.stderr.write(
    `pubshift needs Node 18.17 or newer, and this is Node ${process.versions.node}.\n` +
    'Install the current LTS release of Node and try again.\n',
  );
} else {
  let cli;
  try {
    cli = await import('../dist/cli.js');
  } catch (error) {
    process.stderr.write(
      'pubshift is not built yet. Run "npm run build" in this folder first.\n' +
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  if (cli !== undefined) {
    try {
      process.exitCode = await cli.main(process.argv.slice(2));
    } catch (error) {
      // Nothing should reach here — main() turns its own failures into exit codes — but a
      // stack trace is a bad last impression, so print the sentence and keep the code.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
    }
  }
}
