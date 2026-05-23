/**
 * Strip quoted reply history from an inbound email body. Kayako stores the full
 * quoted thread on every reply; we keep only the new content above the first
 * "break line" marker. Patterns mirror Kayako's `swbreaklines` plus the common
 * MUA quote headers.
 */

/** Default break-line markers (Kayako swbreaklines + common MUA quote headers). */
export const DEFAULT_BREAK_LINES = [
  '----- Original Message -----',
  '-----Original Message-----',
  '<!-- Break Line -->',
];

/** Regexes for the dynamic "On <date>, <person> wrote:" / quoted-header forms. */
const QUOTE_HEADER_RE = [
  /^On .+ wrote:\s*$/im,
  /^From:.*$/im,
  /^_{5,}\s*$/m, // a line of underscores (Outlook divider)
];

/**
 * Return the body with everything from the first break-line / quote header onward
 * removed. If stripping would empty the body, the original is returned unchanged
 * (better to keep quoted content than to store nothing).
 */
export function stripQuotedReply(body: string, breakLines: string[] = DEFAULT_BREAK_LINES): string {
  if (!body) return body;

  let cut = body.length;
  for (const marker of breakLines) {
    const idx = body.indexOf(marker);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  for (const re of QUOTE_HEADER_RE) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }

  if (cut >= body.length) return body;
  const stripped = body.slice(0, cut).trimEnd();
  return stripped.length > 0 ? stripped : body;
}
