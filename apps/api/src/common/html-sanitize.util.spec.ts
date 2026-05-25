import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml } from './html-sanitize.util';

describe('sanitizeRichHtml', () => {
  it('strips <script> and javascript: URIs', () => {
    expect(sanitizeRichHtml('<script>alert(1)</script><p>ok</p>')).not.toContain('<script>');
    expect(sanitizeRichHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
  });

  it('keeps a genuine inline raster image (data:image/png)', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">';
    const out = sanitizeRichHtml(html);
    expect(out).toContain('data:image/png;base64');
  });

  // E4: a non-image data: URI must not survive on an <img src>.
  it('drops a non-image data: URI on <img> (e.g. data:text/html)', () => {
    const html = '<img src="data:text/html;base64,PHNjcmlwdD4=" alt="x">';
    const out = sanitizeRichHtml(html);
    expect(out).not.toContain('data:text/html');
  });

  it('drops data:image/svg+xml on <img> (svg can carry script)', () => {
    const html = '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="x">';
    const out = sanitizeRichHtml(html);
    expect(out).not.toContain('svg+xml');
  });

  // Regression: leading whitespace / control chars must not bypass the data: guard
  // (browsers strip them before resolving the URL).
  it('drops a leading-space-padded data:text/html on <img>', () => {
    expect(sanitizeRichHtml('<img src=" data:text/html;base64,PHM+" alt="x">')).not.toContain(
      'data:text/html',
    );
  });

  it('drops a leading-tab/newline-padded data:image/svg+xml on <img>', () => {
    expect(sanitizeRichHtml('<img src="\tdata:image/svg+xml;base64,PHN2Zz4=">')).not.toContain('svg+xml');
    expect(sanitizeRichHtml('<img src="\ndata:image/svg+xml;base64,PHN2Zz4=">')).not.toContain('svg+xml');
  });
});
