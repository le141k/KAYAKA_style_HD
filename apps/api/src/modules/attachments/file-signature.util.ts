/**
 * Magic-byte verification for uploaded files.
 *
 * The Multer fileFilter only checks the client-declared Content-Type, which is
 * trivially spoofable. This verifies the actual file bytes against the declared
 * MIME so an attacker cannot upload an executable/script by labelling it as an
 * allowed type (or as application/octet-stream, which we no longer accept).
 */

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** True if the buffer looks like text (UTF-8, no NUL/control bytes). */
function looksTextual(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    // Allow tab(9), LF(10), CR(13); reject other C0 control chars and NUL.
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) return false;
  }
  return true;
}

const SIGNATURE_CHECKS: Record<string, (buf: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]),
  // RIFF....WEBP
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  'application/pdf': (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]), // %PDF
  // ZIP container — also covers .docx/.xlsx (OOXML are zip files).
  'application/zip': (b) =>
    startsWith(b, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(b, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(b, [0x50, 0x4b, 0x07, 0x08]),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) =>
    startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  // Legacy .doc — OLE2 compound file.
  'application/msword': (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  // Plain-text formats have no signature — verify the content is textual.
  'text/plain': looksTextual,
  'text/csv': looksTextual,
};

/**
 * Verify that the file's bytes match its declared MIME type.
 * Throws nothing — returns true/false; the caller raises the HTTP error.
 */
export function verifyFileSignature(declaredMime: string, buffer: Buffer): boolean {
  const check = SIGNATURE_CHECKS[declaredMime];
  if (!check) return false; // unknown/disallowed type
  return check(buffer);
}

/**
 * Executable / script extensions that must never be stored, even when the bytes
 * look textual and the declared MIME is an allowed text type. The MIME allowlist
 * alone doesn't catch a `payload.php` sent as `text/plain` — `looksTextual()`
 * happily accepts it. A defence-in-depth denylist on the final extension closes
 * that gap (the file would still need a server misconfig to *execute*, but we
 * refuse to store it regardless).
 */
export const BLOCKED_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  // shells / scripts
  'sh',
  'bash',
  'zsh',
  'ksh',
  'csh',
  'php',
  'phtml',
  'php3',
  'php4',
  'php5',
  'phar',
  'py',
  'pyc',
  'rb',
  'pl',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'cgi',
  'asp',
  'aspx',
  'jsp',
  // windows executables / scripts
  'exe',
  'dll',
  'com',
  'bat',
  'cmd',
  'msi',
  'scr',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'wsf',
  'hta',
  'cpl',
  // unix executables / libraries
  'bin',
  'run',
  'so',
  'dylib',
  'app',
  'command',
  // jvm / other
  'jar',
  'class',
  'apk',
  'deb',
  'rpm',
]);

/**
 * Reject dangerous file extensions regardless of declared MIME / content.
 * Returns true when the name's final extension is safe to store.
 */
export function isExtensionAllowed(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return true; // no extension → nothing to block here
  const ext = fileName
    .slice(dot + 1)
    .trim()
    .toLowerCase();
  return !BLOCKED_UPLOAD_EXTENSIONS.has(ext);
}
