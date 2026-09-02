/**
 * Is this buffer binary?
 *
 * A NUL byte in the first 8 KB is how Git itself decides a blob is binary, and
 * it is the right heuristic anywhere the alternative is decoding arbitrary
 * bytes as UTF-8 and storing whatever falls out. It lives in `lib/` because
 * two unrelated subsystems need it — the repository workspace, which uses it
 * to decide a file is not editable, and Resource ingestion, which uses it to
 * refuse to index a PNG as if it were prose.
 */
export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}
