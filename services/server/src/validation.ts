// ── Username validation ───────────────────────────────────

const PROFANITY_LIST = new Set([
  "fuck",
  "shit",
  "ass",
  "bitch",
  "dick",
  "cock",
  "pussy",
  "cunt",
  "fag",
  "nigger",
  "nigga",
  "retard",
  "whore",
  "slut",
  "damn",
  "piss",
  "twat",
  "wanker",
  "arse",
  "bollock",
  "bugger",
  "chink",
  "coon",
  "dyke",
  "feck",
  "homo",
  "jizz",
  "kike",
  "knob",
  "muff",
  "nig",
  "prick",
  "spic",
  "tit",
  "turd",
  "anal",
  "anus",
  "balls",
  "boob",
  "dildo",
  "douche",
  "erect",
  "felch",
  "fudge",
  "gtfo",
  "handjob",
  "horny",
  "jackoff",
  "jerkoff",
  "milf",
  "nazi",
  "nude",
  "nutsack",
  "orgasm",
  "penis",
  "porn",
  "pube",
  "rape",
  "scrotum",
  "semen",
  "sex",
  "skank",
  "spunk",
  "stfu",
  "testicle",
  "vagina",
  "vulva",
]);

function normalizeLeetSpeak(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/@/g, "a")
    .replace(/\$/g, "s")
    .replace(/!/g, "i");
}

export function isValidUsername(name: string): boolean {
  if (name.length < 1 || name.length > 7) return false;
  // Normalize unicode (decompose accents/diacritics) before checking
  const decomposed = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  if (!/^[a-zA-Z0-9_]+$/.test(decomposed)) return false;
  const lower = decomposed.toLowerCase();
  const normalized = normalizeLeetSpeak(decomposed);
  for (const word of PROFANITY_LIST) {
    if (lower.includes(word) || normalized.includes(word)) return false;
  }
  return true;
}
