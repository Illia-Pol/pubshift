/**
 * The questions this cohort actually asks, answered properly.
 *
 * One source for the visible FAQ and for the FAQPage structured data, so the two
 * cannot drift — search engines dislike that and, more to the point, it would mean
 * showing a visitor one answer and a search result another.
 *
 * Answers are plain text on purpose: they go into JSON-LD verbatim, and an answer
 * that only makes sense next to a link is not an answer.
 */

import { RETIREMENT_DATE, SUPPORT_END_DATE, CORPUS } from '@/lib/site';

export interface FaqItem {
  /** Phrased the way a person would type or say it. */
  q: string;
  /** One or more paragraphs. */
  a: string[];
}

export const FAQ: FaqItem[] = [
  {
    q: 'Can I still use Publisher after October 2026?',
    a: [
      `It depends on how you got it, and the difference is the whole story. If Publisher came as part of a Microsoft 365 subscription, Microsoft removes it on ${RETIREMENT_DATE} and it stops opening after that date.`,
      `If you bought Publisher outright as a one-off purchase — Publisher 2019 or Publisher 2021, for instance — nothing is taken away from you. The program stays on your computer and keeps opening your files. What ends, on ${SUPPORT_END_DATE}, is Microsoft’s support for it: no more updates, no more security fixes, and no help if a future version of Windows stops running it.`,
      'In neither case do your .pub files get deleted, locked or expire. They stay on your disk exactly as they are. What shrinks is the list of programs able to read them.',
    ],
  },
  {
    q: 'I have hundreds of old .pub files. What should I actually do with them?',
    a: [
      'Do not convert all of them. Sort them first, which takes an afternoon rather than a fortnight.',
      'The files you reopen and reuse — the bulletin template, the newsletter masthead, the letterhead, the annual programme — are the ones worth converting to PowerPoint and checking properly, because you will be editing them again. Everything else is an archive: you want to be able to read it in ten years, not edit it. A PDF does that, and PDFs open everywhere without argument.',
      'A reasonable plan is: convert the ten or twenty files you genuinely still use, keep the rest as PDFs, and keep the original .pub files too. They cost nothing to keep and they are the only lossless copy you will ever have.',
    ],
  },
  {
    q: 'Is this safe? Can you see my file?',
    a: [
      'No, and not because we promise not to look — because there is nothing to look at. The program that reads Publisher files was compiled to run inside your web browser. When you drop a file in, this page opens it on your own computer. It is not uploaded, copied or sent anywhere, and no server of ours ever has it.',
      'You can check that yourself: convert one file, then disconnect from the internet and convert another. It still works, because nothing about it needed the network.',
      'That is the difference that matters if your publication is a member directory, a donor list, a class list or a photo page with children’s names under it. Every other free .pub converter we know of works by uploading your file to its own servers.',
    ],
  },
  {
    q: 'Why is this free? What is the catch?',
    a: [
      'Because it costs almost nothing to run. There is no conversion server, no queue and no per-file cost — your computer does the work, and this page is only files sitting on a web host. A tool with no cost per file can be given away without a catch hiding somewhere.',
      'Converting your publications here is free: no account, no email address to hand over, no limit on how many files you do, no watermark and no advertising. What it does not come with is a support desk, so if a file defeats it, the honest answer is the fallback advice on this page rather than a ticket number.',
    ],
  },
  {
    q: 'Which format should I choose — PowerPoint, Word or PDF?',
    a: [
      'PowerPoint, if you want to keep editing the design. A Publisher page is a set of boxes placed exactly where you dragged them, and a PowerPoint slide is the same kind of thing, so the pieces land where they were.',
      'Word, if the words matter more than the layout. Word is a river of text: it flows paragraphs down a page and rearranges everything below whenever something above changes. That is why a Publisher newsletter poured into Word looks scrambled — it is not a bad conversion, it is two different ideas of what a page is.',
      'PDF, if you only need to read, print, email or archive it. It will look right and nobody will ever be able to edit it, including you.',
    ],
  },
  {
    q: 'What about my Publisher templates?',
    a: [
      'A template is just a .pub file you start from, so it converts like any other. Convert it to PowerPoint, check it over once, and keep that as the master you duplicate each week or each term.',
      'What cannot come across is anything Publisher did that the new program has no equivalent for — mail merge being the usual one. The layout converts; the merge does not. If your template pulls names from a spreadsheet, you will be rebuilding that part wherever you land.',
    ],
  },
  {
    q: 'What if it does not work on my file?',
    a: [
      `Then we say so plainly instead of handing you a blank document and calling it a success. Some Publisher files cannot be read: out of the ${CORPUS.total} real files we test against, ${CORPUS.empty} open without any error and turn out to contain nothing we can see. That is a limit of the reader, it cannot be predicted from the file, and it is the failure we most want you to hear about honestly.`,
      `If that happens, the fallback still works today: open the file in Publisher and use Save As to make a PDF, or copy the text out into another program. If your Publisher is a perpetual licence, that route stays open past ${RETIREMENT_DATE}. LibreOffice Draw, which is free, also opens some .pub files, though it needs installing and it moves complicated layouts around.`,
    ],
  },
  {
    q: 'Does this work on a Mac, a Chromebook or an iPad?',
    a: [
      'Yes. It runs in the browser, so it does not care what the computer is, and it needs nothing installed.',
      'This is worth knowing if you inherited a folder of .pub files and no Windows machine to open them with: Publisher was never released for the Mac, so for a long time there was no straightforward way to see inside those files at all.',
    ],
  },
  {
    q: 'Will the converted file look exactly like the original?',
    a: [
      'Close, but not identical, and anyone promising identical is not being straight with you. Text, pictures, colours, shapes and the position of everything on the page come across. Old clipart stored in the Windows Metafile format does not, and some of Publisher’s finer typographic effects are approximated.',
      'Whatever we could not carry over, we list on screen with the page number, so you know which two files out of forty need a human eye rather than having to check all forty.',
    ],
  },
  {
    q: 'I make our church bulletin (or school newsletter) in Publisher every week. What now?',
    a: [
      'Convert the most recent issue to PowerPoint and look at it properly — that one file tells you how well your particular layout survives, which is more useful than any general promise.',
      'If it holds up, use it as the master for next week and you have moved without a project. If it does not, PowerPoint is still the least painful place to rebuild it, because it works the same way Publisher does: you drag boxes where you want them. Keep the .pub originals either way.',
    ],
  },
  {
    q: 'Do I need to install anything, or make an account?',
    a: [
      'No to both. There is nothing to download, no add-in, no extension, no administrator password and no sign-up. Drop the file on this page and the converted file is saved to your downloads folder like any other.',
    ],
  },
  {
    q: 'Can this turn a PDF or a Word file back into a .pub file?',
    a: [
      'No. It only reads Publisher files and writes other formats. Nothing can reliably write .pub files except Publisher itself, and since Publisher is the thing going away, converting into it would be walking the wrong way.',
    ],
  },
];
