/**
 * "a" or "an" in front of a noun phrase, chosen by how its first word sounds
 * rather than how it is spelled: "an email", "a user", "an hour", "an SMS".
 *
 * Shared because the client and the server both put an article in front of
 * words they did not write — a ledger target, a page kind, a role someone
 * typed — and a hand-written "a" in front of one is how "a email" and "a
 * Account Executive" reached the product. The phrase must be bare: one that
 * already starts with "a", "an" or "the" gets a second article ("an an email
 * instruction"), so label tables keep articles out and let this add them.
 */

/**
 * Spelled with a vowel, said with a consonant: "a one-off", "a euro", "a
 * user", "a unit", "a utility", "a URL". "Un-" in front of anything else keeps
 * its vowel: "an update", "an unread email", "an uninstall".
 */
const CONSONANT_SOUND =
  /^(?:one(?![a-z])|once|eu|ewe|u(?:ni(?![dmn])|s[aeu]|t[eio]|r[aeilo]|biq|k))/;

/** Spelled with a consonant, said with a vowel: "an hour", "an honest answer", "an heir". */
const VOWEL_SOUND = /^(?:hour|honest|honou?r|heir)/;

/** Letters whose names start with a vowel sound: "an FAQ", "an HR lead", "an SMS". */
const VOWEL_SOUND_LETTERS = /^[AEFHILMNORSX]/;

/**
 * Capitals said letter by letter — "an API key", "an SMTP server", "a URL" —
 * which a short word in capitals, or one without a vowel, always is. A longer
 * one with vowels is said as a word: "a NASA grant".
 */
function isSpelledOut(word: string): boolean {
  return /^[A-Z][A-Z0-9]*$/.test(word) && (word.length <= 3 || !/[AEIOU]/.test(word));
}

/** The article the phrase's first word takes. A phrase with no word takes "a". */
export function indefiniteArticle(phrase: string): "a" | "an" {
  const word = /[\p{L}\p{N}]+/u.exec(phrase)?.[0] ?? "";
  if (isSpelledOut(word)) return VOWEL_SOUND_LETTERS.test(word) ? "an" : "a";
  const lower = word.toLowerCase();
  if (CONSONANT_SOUND.test(lower)) return "a";
  return VOWEL_SOUND.test(lower) || /^[aeiou]/.test(lower) ? "an" : "a";
}

/**
 * The phrase with its article in front: "an email instruction", "a user".
 * `capitalized` starts a sentence with it: "An Experiment", "A Routine".
 */
export function withIndefiniteArticle(
  phrase: string,
  opts: { capitalized?: boolean } = {},
): string {
  const article = indefiniteArticle(phrase);
  return `${opts.capitalized ? (article === "an" ? "An" : "A") : article} ${phrase}`;
}
