# Why this product is shaped the way it is

## The market is not empty

The original thesis assumed a thin field. It is not. Checked 2026-09-17:

| Who | What | Weakness we exploit |
|---|---|---|
| Zamzar, FreeConvert, Online2PDF, OnlineConvertFree, online-convert, i-converter | Free browser PUB→DOC/PDF | **Upload to their servers.** Layout flattened to a text flow. |
| Aspose (products.aspose.app) | Free, cross-platform, well-engineered | **Uploads; retains files 24h** by their own statement. |
| Univik | $39 one-time desktop converter | **Windows-only.** No Mac, no Chromebook, no phone. |
| publishmediasoftware.com | Browser-based Publisher-alike editor + heavy church/newsletter SEO | Asks you to adopt a **new editor** and stay in it. |
| pubfilerescue.com, afterpublisher.com | Deadline-themed services | Unverified delivery. |
| LibreOffice Draw | Free, opens .pub | Requires install; complex layouts shift; wrong audience entirely. |

"A browser-based .pub converter" is therefore **not** a differentiated product. Eight of them
already exist and rank. Building a ninth uploader would have been the mistake.

## The three things that are actually differentiated

**1. Nothing is uploaded. Ever.**
Every free competitor is a file-upload service. Our target users are church secretaries and school
administrators, and their `.pub` files contain member directories, donor lists, student names and
photos. In the US a school sending student records to a third-party processor is a FERPA question;
in the EU it is a GDPR processor question. Neither has a good answer when the answer is "we uploaded
it to a free converter."

Converting entirely inside the browser tab makes the question disappear. It is also the one claim
a server-side competitor cannot match without rebuilding from scratch.

Second-order benefit that matters for a founder with no audience: **marginal cost is zero.** Static
files on a CDN. No conversion servers, no queue, no per-file cost, no abuse surface. The product can
sit online for years unattended at roughly the price of a domain.

**2. Layout is preserved by anchoring, not by choosing PowerPoint.**

This claim has been rewritten twice by measurement, and the second rewrite reversed it. Both
revisions are kept here because the mistake is instructive.

*First version:* a Publisher page is absolutely-positioned boxes on a fixed canvas and so is a
PowerPoint slide, whereas Word is a flow of paragraphs — so lead with PPTX. Every competitor
converts to Word, following Microsoft's own guidance, and wrecks the layout.

*What the corpus said:* across 24 scored files the two formats were nearly tied on average but won
different documents. `tables.pub` scored **PPTX 0.960 against DOCX 0.494**; text-only files went the
other way. That looked like confirmation — layout-heavy to slides, prose to Word.

*What it actually was, in part, our own bug.* Measuring `tables.pub` at 0.494 sent someone to look
at why, and the answer was not the format. LibreOffice applies `w:tblCellMar` **on top of**
`w:trHeight` rather than inside it, so every row grew and everything below it slid down. Moving the
vertical inset onto the cell's paragraphs took that file from **0.494 to 0.948**, and `table-merged`
from 0.689 to 0.776.

Current standings: **DOCX 0.794, PPTX 0.772, SVG 0.763, PDF 0.760.** Word is now the *highest*
scoring format on this corpus.

The theory was not wrong, it was aimed at the wrong thing. Our DOCX emitter's default is **layout
mode**, which anchors every element with `wp:anchor` at an absolute position — it is not a flow at
all. "Word is a river of text" is true of *flow mode*, which we also ship and clearly label, and
true of what every other converter produces. It was never true of what we default to. Attributing a
fidelity gap to a format when it belonged to our own emitter is the kind of error that a
measurement catches and an argument does not.

So the honest claim is narrower and stronger than the original: **we preserve layout because we
anchor elements absolutely, in whichever format you choose.** PowerPoint and Word both hold up;
PDF is exact and frozen; SVG is for designers. Where the evidence supports a per-document
suggestion we make one — see `recommendFormat` — and where it does not, we say the formats are
close and let the user try both.

**3. We tell you what broke.**
Every converter claims perfect fidelity and silently drops things. We carry a `Warning` list through
the whole pipeline and show it: which pages have rotated text we approximated, which images were WMF
and could not be converted, where columns were flattened. A user under a deadline needs to know which
three of their forty files need a human look — that is more valuable than a false promise about all forty.

## Honest assessment of the opportunity

A one-off conversion is not a business. The deadline creates a spike of demand that ends, by
definition, shortly after 1 October 2026. Perpetual-licence holders can still open their files after
that date, so the true forcing function applies only to Microsoft 365 subscribers — a large group,
but smaller than "everyone with a .pub file."

What this build is really for: it is a cheap, fixed-denominator test of **distribution**, which is
the actual bottleneck. The engineering is a two-day problem with a free parser. Getting one paying
stranger is the unknown. If a Microsoft-declared deadline plus a working free tool plus a real
privacy story cannot produce a single conversion to paid, that is fast and valuable information, and
it is information about reach, not about code.

Accordingly the build is optimised to cost nothing to keep alive after the spike, and to leave behind
a reusable asset: a working, tested, MPL-compatible Publisher→OOXML pipeline that no one else has
published as open source.


---

# Correction, 2026-09-18: the main differentiator is already occupied

Market research checked after this document was written found **Korva** (korva.korsund.com),
verified on their own pages the same day:

- **$49 one-time, native macOS / Windows / Linux**, built explicitly for Publisher's October 2026 end of life.
- Their words, verbatim: *"No server, no cloud, no telemetry. Your documents never leave your computer."*
  That is our central claim, already in market, already in those words.
- A **free browser converter** for single files — our free tier.
- **Batch archive conversion** in Pro — our $29 CLI.
- A content estate (comparisons against LibreOffice, Affinity, Scribus, "migrate from Publisher")
  and a winget package — the SEO and distribution play we had planned, already running.

So differentiator #1 in this document is no longer true as written. "Nothing is uploaded" does not
distinguish us from Korva; it distinguishes both of us from the eight upload-based free converters.
And Korva is a full editor, which is more product than a converter for the same audience.

What is still genuinely ours, and it is a much narrower claim:

1. **No install at all.** Korva's privacy claim covers a native app you download. Ours runs in the
   browser tab with nothing installed. Whether their free browser converter uploads is unverified —
   check before claiming anything about it.
2. **We report what broke, per file and per page.** No competitor found does this.
3. **MPL-2.0 open source**, so the pipeline outlives the business.

## The structural error underneath all of it

Every version of this document, and the market research that followed, sized the *sympathetic*
segment — small churches, volunteer-run, no software budget — and treated it as the *urgent* one.
It is closer to the opposite.

The 1 October cutoff binds **only M365 subscribers**. Perpetual Office 2016/2019/2021 holders keep
opening and editing `.pub` indefinitely; only support ends. A no-budget, volunteer-run church is
exactly the organisation running a decade-old perpetual Office — so it faces **no deadline at all**.

The population genuinely cut off pays per seat for M365 Business Standard or above, has someone
doing IT procurement, receives Microsoft's own migration guidance, and follows it to Word,
PowerPoint or Canva.

**Urgency and willingness to pay a stranger $39 sit in different populations.** That is a cleaner
explanation for the missing pre-deadline demand ramp than any charitable reading of the proxies, and
it invalidates the targeting in docs/business/channels.md as written.

## What the demand proxies measured

No search-volume figure was obtainable — two researchers failed, and it remains the one number that
would settle this. It is free to get in about thirty minutes from Google Keyword Planner and nobody
has done it. Every revenue estimate here, including the pessimistic ones, is arithmetic on an
invented input until someone does.

What was measured, with its weakness stated:

- English Wikipedia pageviews for "Microsoft Publisher": September 2026 is running **9% below**
  September 2025. No ramp into the deadline. (Measures curiosity, not "my file will not open" — but
  the absence of any ramp is still notable.)
- News coverage peaked **December 2025**, not in the deadline month.
- The "save Publisher" petition framed for nonprofits and churches — the exact target segment,
  started six months before the deadline — has **37 signatures** worldwide.
- A $39.99 Mac `.pub` converter has sat on the App Store for 10.9 years with essentially no ratings.
- Flash's end-of-life decay: attention settled at **~40% of the pre-deadline baseline** within two
  quarters. The spike does not merely pass; demand ends up below where it started.

## The bear case in one line, which needs no demand figure

**$1,000 of gross revenue requires out-trafficking every `.pub`-specific operator in the market,
in the first month of the domain's existence.**

Honest twelve-month estimate: **$300–$1,500 gross**, concentrated in four to six weeks around
1 October, against ~$15 of hard cost — and $3,000–4,000 of opportunity cost at the owner's hourly
rate, which dominates every other line and is what the decision actually turns on.

This does not overturn `docs/PRICING.md`'s conclusion that the free tool is the product and revenue
is a test of distribution. It confirms it, and sharpens it: the thing worth buying here is a
**measurement**, and it can be bought for about seven hours rather than by shipping a business.
