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

**2. PPTX first, not DOCX first.**
Everyone converts Publisher to Word, because Microsoft's own guidance says Word. This is the wrong
target and it is why every existing converter produces a mess.

A Publisher page is a set of absolutely-positioned boxes on a fixed-size canvas. A Word document is
a *flow* of paragraphs. Mapping one to the other destroys the layout — which is the entire reason
the document was made in Publisher and not in Word.

A PowerPoint slide is *also* a set of absolutely-positioned boxes on a fixed-size canvas. The mapping
is close to one-to-one. We lead with PPTX, explain why in one sentence the user understands, and
still offer DOCX for the cases where the words matter more than the layout.

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
