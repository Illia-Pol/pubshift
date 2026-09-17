/**
 * What each output format is for, in one non-technical sentence each.
 *
 * The picker beside the drop zone and the explanatory section further down the
 * page both read from here, so the short version and the long version cannot
 * drift apart and start promising different things.
 *
 * PowerPoint is first and is the default on purpose. A Publisher page is a set of
 * boxes placed at fixed positions; a slide is the same thing; a Word document is
 * not. See docs/POSITIONING.md.
 */

import { TARGET_FORMATS, type TargetFormat } from '@/lib/types';

export interface FormatInfo {
  id: TargetFormat;
  /** What a normal person calls it. */
  name: string;
  /** Sits next to the name in the compact picker. */
  extension: string;
  /** One line, shown under the picker. */
  summary: string;
  opensIn: string;
  /** Why you would pick this one. */
  keeps: string;
  /** What it costs you. Never omitted. */
  costs: string;
}

export const FORMATS: Record<TargetFormat, FormatInfo> = {
  pptx: {
    id: 'pptx',
    name: 'PowerPoint',
    extension: '.pptx',
    summary: 'Closest to the original layout. Best if you want to keep editing the design.',
    opensIn: 'PowerPoint, Google Slides, Keynote, LibreOffice Impress',
    keeps:
      'Your text boxes, pictures and shapes stay where you put them, because a slide holds ' +
      'things at fixed positions exactly the way a Publisher page does.',
    costs:
      'Each page becomes a slide, so it looks a little odd in the slideshow view. You are ' +
      'using PowerPoint as a page layout program, which it is quietly rather good at.',
  },
  docx: {
    id: 'docx',
    name: 'Word',
    extension: '.docx',
    summary: 'Best when the words matter more than the design.',
    opensIn: 'Word, Google Docs, Pages, LibreOffice Writer',
    keeps:
      'All of your text, ready to edit, spell-check and paste somewhere else. Useful when ' +
      'you want to rewrite last year’s newsletter rather than reprint it.',
    costs:
      'Word pours text down the page, so anything built out of side-by-side boxes will move. ' +
      'Expect to tidy up. We offer two versions: one that keeps the boxes roughly in place, ' +
      'and one plain flowing document that gives up on the layout deliberately.',
  },
  pdf: {
    id: 'pdf',
    name: 'PDF',
    extension: '.pdf',
    summary: 'A fixed copy for printing, emailing and keeping.',
    opensIn: 'Anything, on any device',
    keeps:
      'The page as a page. Right for an archive of old issues, for the printer, and for ' +
      'anything you only need to read rather than change.',
    costs:
      'Nobody can edit it afterwards, including you. If this is the only copy you make, you ' +
      'have a picture of your publication rather than your publication.',
  },
  svg: {
    id: 'svg',
    name: 'Design file',
    extension: '.svg',
    summary: 'One file per page with every shape still separate. For designers.',
    opensIn: 'Illustrator, Inkscape, Figma, Affinity Designer',
    keeps:
      'Every line, shape and block of text as its own editable object, at any size, with ' +
      'nothing flattened into a picture.',
    costs:
      'Not something you can hand to a colleague who wants to edit it in Word, and text may ' +
      'need the original fonts installed to look right.',
  },
};

export const FORMAT_LIST: FormatInfo[] = TARGET_FORMATS.map((id) => FORMATS[id]);
