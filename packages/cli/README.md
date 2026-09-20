# Pubshift — convert a folder of Publisher files

This converts Microsoft Publisher files (`.pub`) into PowerPoint, Word, PDF or SVG.
It is meant for the case where you have a **folder** of them — a parish archive, a school's
newsletters, fifteen years of bulletins on a shared drive — rather than one file.

**Everything happens on your own computer.** No file is uploaded, nothing is sent anywhere,
and it works with the network switched off. That is the point of it: a folder of parish
bulletins contains member names, addresses and donor lists, and those should not be handed
to a website in order to be converted.

If you only have one or two files, you do not need this. Use the free converter on the
website instead — it does the same conversion, in your browser, for nothing.

---

## Before you start

You need **Node** on the computer. It is free, it is from the Node.js Foundation, and
installing it does not change anything else on the machine.

- Download the "LTS" version from **nodejs.org** and run the installer.
- Anything from version 18.17 onwards works.

You do **not** need Publisher, Office, a developer account, or an internet connection after
the install.

## Where to type the commands below

Every command in this guide is typed into a text window and followed by Return:

- **Mac:** press `⌘ Space`, type `Terminal`, press Return.
- **Windows:** open the Start menu, type `PowerShell`, press Return.

Nothing here needs to be run "as administrator". If a command prints something that looks like an
error, copy the whole line — the wording matters more than it looks.

## Installing

```
npm install -g pubshift
```

**If that prints `E404` or "not found":** the package has not been published to npm yet. Install it
from the source repository instead — this needs `git` (Mac: it is offered automatically the first
time you type `git`; Windows: install it from **git-scm.com**):

```
git clone https://github.com/Illia-Pol/pubshift.git
cd pubshift
npm install
npm run build -w pubshift
npm install -g ./packages/cli
```

Then `pubshift --version` should print a version number, and you can delete the `pubshift` folder
you cloned — the installed copy does not depend on it.

Then check it is there:

```
pubshift --version
```

If that prints a number, you are ready.

---

## The two commands

### Look first

```
pubshift check "Parish Bulletins" --recursive
```

This reads every `.pub` file it can find and tells you what would happen. **It does not
write anything.** Run this first: it takes seconds, and it tells you in advance which files
are going to need your attention.

### Convert

```
pubshift convert "Parish Bulletins" --recursive --out "Converted" --report report.html
```

That reads every `.pub` file in the folder *and in the folders inside it*, converts each one
to PowerPoint, puts the results in a new folder called `Converted`, and writes a page called
`report.html` that you can open in a browser or send to somebody.

On Windows, if the folder is on your desktop:

```
pubshift convert "%USERPROFILE%\Desktop\Parish Bulletins" --recursive --out "%USERPROFILE%\Desktop\Converted" --report "%USERPROFILE%\Desktop\report.html"
```

On a Mac:

```
pubshift convert ~/Desktop/"Parish Bulletins" --recursive --out ~/Desktop/Converted --report ~/Desktop/report.html
```

**A folder name with spaces in it needs quotation marks around it.** That is the single
commonest thing that goes wrong.

---

## Choosing what to convert to

| You want | Use |
|---|---|
| Something that looks like the original page | `--to pptx` (PowerPoint) — the default |
| Something you will retype and edit as text | `--to docx` (Word) |
| Something to print, email or file away | `--to pdf` |
| Something for a website | `--to svg` |
| More than one of those | `--to pptx,pdf` |
| Let it pick, file by file | `--to auto` |

PowerPoint is the default because a Publisher page is boxes placed on a page, and that is
what a PowerPoint slide is too — so the page usually comes out looking like the page. Word
wants to reflow text, which is right for a letter and wrong for a newsletter.

With `--to auto` it chooses per file and the report says why it chose what it did.

---

## Reading the report

The report always **starts with the files that need a person to look at them**, and the
number of those is the only number that matters: it is the list of things you still have to
do. The files that converted cleanly are listed after, because there is nothing to do about
them.

Choose what kind of report you get by the ending you type:

- `--report report.html` — a page you open in a browser and can send to somebody.
- `--report report.csv` — a spreadsheet, for Excel or LibreOffice.
- `--report report.json` — for whoever looks after your computers.

Each flagged file is named with what it lost, in plain words: *"Older Publisher clip art is
stored in a Windows-only picture format we cannot read, so it is missing."* The same
sentences appear on the website, so the two never tell you different things about the same
file.

---

## What it will not do, stated plainly

**Some Publisher files cannot be read at all — and you will be told, not handed a blank
document.**

We test against 31 real Publisher files, from Publisher 97 through 2010. Of those: 24
convert with their text and pictures, 1 comes through partly, 1 turns out not to be a
Publisher file at all, and **5 open without any error and contain nothing we can read.**
Those five are the honest weak point. The reader that opens Publisher files is the same one
LibreOffice uses, and it simply cannot get anything out of them.

When that happens, **no file is written.** You get a line in the report saying we could not
read it. Handing you an empty Word document and calling it a success is the one thing this
tool will never do, and it is why the report is worth reading.

Until **1 October 2026**, when Publisher leaves Microsoft 365, you can still open such a
file in Publisher itself and save it as a PDF from there. After that date, a perpetual
licence of Publisher still opens them; a Microsoft 365 subscription does not.

**Old clip art usually goes missing.** Publisher clip art from the 1990s and 2000s is stored
in a Windows-only picture format that cannot be read outside Windows. Where that happens,
the report names the file and the page. It is the largest single thing still lost.

**Text that overflowed its box in the original is drawn rather than cut off**, so a converted
page can show words that Publisher was hiding.

---

## Everything else it can do

| Option | What it does |
|---|---|
| `--recursive` or `-r` | Also look inside the folders in the folder. Without it, only the folder you named is searched. |
| `--out <folder>` | Where the converted files go. The folder structure of the archive is recreated there. Default: `Converted`. |
| `--jobs 4` | Convert four files at a time. Faster, and uses more memory. `--jobs auto` uses the machine's processors. |
| `--dry-run` | Do everything except write the converted files. |
| `--on-conflict skip` | If a converted file is already there, leave it. Useful for finishing an interrupted run. |
| `--on-conflict overwrite` | Replace it. |
| `--docx-mode flow` | With `--to docx`: give up the page layout to get ordinary Word paragraphs you can edit. |
| `--follow-symlinks` | Follow shortcuts that point at other folders. Off by default, because following them can walk the whole drive. |
| `--quiet` / `--verbose` | Less, or a line per file. |
| `--help` | All of it. |

**Nothing is ever overwritten without being asked.** If `Bulletin.pptx` is already there,
the new one is written as `Bulletin (2).pptx`. If two different publications in your archive
want the same name, both are written, one of them numbered — losing one of them silently
would be worse than an odd name.

---

## For whoever looks after the computers

The command sets an exit code, so it can go in a script:

| Code | Meaning |
|---|---|
| `0` | Every file converted, and nothing was lost. |
| `1` | Some files need a person to look at them. |
| `2` | Nothing could be converted. |
| `3` | Something was wrong with the command, the folder, or the disk. |

It reads the folder you name and writes only into `--out` and the `--report` file. It opens
no network connection of any kind — there is no update check, no licence check and no usage
reporting, and the test suite fails if any of that is ever added. It needs no compiler, no
Homebrew and no administrator rights beyond the initial `npm install -g`.

Memory is flat in the number of files: it holds one publication at a time (a few more with
`--jobs`), never the whole folder. Four hundred files is a normal amount of work for it.

---

## If something goes wrong

- **"There is no folder called…"** — the spelling is off, or the name has spaces in it and
  needs quotation marks.
- **"It looks like this file is open in another program"** — the file is open in Publisher,
  or somebody else has it open on the shared drive. Close it and run the command again.
- **"This file is named .pub but it is not a Publisher publication inside"** — something was
  renamed, or a download went wrong. Try the original file.
- **Everything is flagged** — check you pointed it at the right folder, and that the files
  really are Publisher files.

Run the same command again whenever you like: with `--on-conflict skip` it picks up where it
left off, and by default it never destroys anything it wrote before.

---

Licensed under the MPL-2.0. Third-party notices are in `THIRD-PARTY-NOTICES.md` at the root
of the project.
