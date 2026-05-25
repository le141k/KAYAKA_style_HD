import sanitizeHtml from 'sanitize-html';

/**
 * Allowlist-based HTML sanitizer for staff-authored rich text (KB articles,
 * news, macro reply bodies). Strips <script>, event handlers, javascript: URIs,
 * and any tag/attribute not explicitly allowed — preventing stored XSS while
 * keeping common formatting, links, images and tables.
 */
const KB_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'span',
    'div',
    'blockquote',
    'pre',
    'code',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'sub',
    'sup',
    'mark',
    'ul',
    'ol',
    'li',
    'dl',
    'dt',
    'dd',
    'a',
    'img',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['class'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  // Only safe URL schemes; blocks javascript:, data: (except images), vbscript:, etc.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // Force external links to be safe.
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }),
    // E4: the img `data:` scheme is allowed for inline images, but restrict it to
    // genuine image media types — a `data:text/html`/`data:image/svg+xml` payload
    // must not ride in on an <img src>. Drop the src if it isn't a raster data URI.
    img: (tagName, attribs) => {
      const src = attribs['src'] ?? '';
      if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(src)) {
        const { src: _dropped, ...rest } = attribs;
        void _dropped;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
};

/** Sanitize staff-authored rich-text HTML. Returns safe HTML. */
export function sanitizeRichHtml(dirty: string): string {
  return sanitizeHtml(dirty, KB_OPTIONS);
}
