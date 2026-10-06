/**
 * Split a recipient list on the commas between recipients, keeping each entry
 * as written.
 *
 * Not `value.split(",")`: a quoted name can hold a comma, so
 * `"Doe, Zoë" <doe@x.com>, Bob <bob@x.com>` is two recipients, not three. A
 * backslash inside the quotes escapes the next character, so `"Ann \"Q, Jr"`
 * stays one name, and a comma inside `<…>` belongs to the address.
 *
 * The same reading as `splitAddressList` in `server/services/mail/mime.ts`,
 * which the client cannot import. Change the two together.
 */
export function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === "\\" && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    current += ch;
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}
