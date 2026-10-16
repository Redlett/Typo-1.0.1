/**
 * Real-time Hybrid Spelling & Grammar Engine for Typo (0 MB Extra Disk Space):
 * 1. Native Windows 11 OS COM Spellchecker (`ISpellChecker` via `native.checkSpelling`) — catches 100%
 *    of misspelled English words offline with real OS dictionary suggestions.
 * 2. Instant offline contraction & grammar rules (sentence capitalization, "i" -> "I", repeated words,
 *    your/you're, its/it's, their/there, a/an, modal + of, extra spaces).
 * 3. Online contextual grammar & style checking via LanguageTool API when connected to the internet.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { settings, saveSettings } from "../core/settings";
import { native } from "../core/native";
import { emit } from "../core/state";
import { h, icon, toast } from "../ui/dom";

export interface ProofIssue {
  from: number;
  to: number;
  kind: "spelling" | "grammar";
  text: string;
  message: string;
  suggestions: string[];
}

export const proofingKey = new PluginKey<{ issues: ProofIssue[]; deco: DecorationSet }>("typoProofing");

const sessionIgnored = new Set<string>();
let manualScanActive = false;

export function isAutoSpellcheck(): boolean {
  return Boolean(settings.spellcheck);
}

export function isManualScanActive(): boolean {
  return manualScanActive;
}

export function setAutoSpellcheck(editor: any, enabled: boolean): void {
  settings.spellcheck = enabled;
  if (!enabled) {
    manualScanActive = false;
  }
  saveSettings();
  editor?.view?.dom?.setAttribute("spellcheck", "false");
  if (editor?.view) {
    editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true, fullScan: enabled }));
  }
  emit("proofing:update");
  toast(
    enabled ? "Auto Spell & Grammar Check ON" : "Auto Spell & Grammar Check OFF (click Check Now anytime)",
    "info",
    2000,
  );
}

export function runOneShotProofCheck(editor: any): ProofIssue[] {
  manualScanActive = true;
  editor?.view?.dom?.setAttribute("spellcheck", "false");
  if (editor?.view) {
    editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true, fullScan: true }));
  }
  emit("proofing:update");
  return proofingKey.getState(editor.state)?.issues ?? [];
}

export function clearProofHighlights(editor: any): void {
  manualScanActive = false;
  if (settings.spellcheck) {
    settings.spellcheck = false;
    saveSettings();
  }
  closeQuickFix();
  if (editor?.view) {
    editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true }));
  }
  emit("proofing:update");
  toast("Spelling & grammar highlights cleared", "info", 1600);
}

/**
 * Cache of words checked by the Windows 11 native COM spellchecker:
 * - `null` => word is spelled correctly
 * - `string[]` => word is misspelled, array holds suggested replacements
 */
const nativeSpellCache = new Map<string, string[] | null>();
const pendingSpellWords = new Set<string>();
let spellBatchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Cache of online LanguageTool contextual grammar checks keyed by paragraph text:
 */
interface CachedBlockIssue {
  offset: number;
  length: number;
  kind: "spelling" | "grammar";
  message: string;
  suggestions: string[];
}
const onlineBlockCache = new Map<string, CachedBlockIssue[]>();
const pendingBlocks = new Set<string>();
let onlineGrammarTimer: ReturnType<typeof setTimeout> | null = null;

let globalDefineHandler: ((word: string) => void) | null = null;
export function registerDefineHandler(fn: (word: string) => void): void {
  globalDefineHandler = fn;
}

/** High-frequency missing-apostrophe contractions & common English typos -> instant suggestions. */
const TYPO_MAP: Record<string, string[]> = {
  dont: ["don't"],
  cant: ["can't"],
  wont: ["won't"],
  im: ["I'm"],
  ive: ["I've"],
  id: ["I'd", "ID"],
  didnt: ["didn't"],
  doesnt: ["doesn't"],
  isnt: ["isn't"],
  arent: ["aren't"],
  wasnt: ["wasn't"],
  werent: ["weren't"],
  havent: ["haven't"],
  hasnt: ["hasn't"],
  hadnt: ["hadn't"],
  wouldnt: ["wouldn't"],
  couldnt: ["couldn't"],
  shouldnt: ["shouldn't"],
  mustnt: ["mustn't"],
  youre: ["you're"],
  youve: ["you've"],
  youd: ["you'd"],
  youll: ["you'll"],
  theyre: ["they're"],
  theyve: ["they've"],
  theyd: ["they'd"],
  theyll: ["they'll"],
  weve: ["we've"],
  wed: ["we'd"],
  thats: ["that's"],
  whats: ["what's"],
  whos: ["who's"],
  heres: ["here's"],
  theres: ["there's"],
  wheres: ["where's"],
  hes: ["he's"],
  shes: ["she's"],
  aint: ["isn't", "aren't"],
  teh: ["the"],
  hte: ["the"],
  adn: ["and"],
  nad: ["and"],
  taht: ["that"],
  thta: ["that"],
  wiht: ["with"],
  wtih: ["with"],
  waht: ["what"],
  hwat: ["what"],
  ahve: ["have"],
  hvae: ["have"],
  becuase: ["because"],
  beacuse: ["because"],
  becasue: ["because"],
  recieve: ["receive"],
  recieved: ["received"],
  seperate: ["separate"],
  definately: ["definitely"],
  definatly: ["definitely"],
  definetly: ["definitely"],
  occured: ["occurred"],
  untill: ["until"],
  wierd: ["weird"],
  accomodate: ["accommodate"],
  acheive: ["achieve"],
  apparantly: ["apparently"],
  begining: ["beginning"],
  beleive: ["believe"],
  belive: ["believe"],
  buisness: ["business"],
  calender: ["calendar"],
  catagory: ["category"],
  collegue: ["colleague"],
  comming: ["coming"],
  concious: ["conscious"],
  decieve: ["deceive"],
  disapoint: ["disappoint"],
  embarass: ["embarrass"],
  enviroment: ["environment"],
  existance: ["existence"],
  finaly: ["finally"],
  foriegn: ["foreign"],
  fourty: ["forty"],
  freind: ["friend"],
  freinds: ["friends"],
  goverment: ["government"],
  grammer: ["grammar"],
  guaruntee: ["guarantee"],
  harrass: ["harass"],
  immediatly: ["immediately"],
  independant: ["independent"],
  intresting: ["interesting"],
  knowlege: ["knowledge"],
  libary: ["library"],
  maintenence: ["maintenance"],
  mispell: ["misspell"],
  neccessary: ["necessary"],
  necesary: ["necessary"],
  noticable: ["noticeable"],
  occassion: ["occasion"],
  oportunity: ["opportunity"],
  percieve: ["perceive"],
  persistant: ["persistent"],
  posession: ["possession"],
  priviledge: ["privilege"],
  probaly: ["probably"],
  pronounciation: ["pronunciation"],
  realy: ["really"],
  relly: ["really"],
  remeber: ["remember"],
  rember: ["remember"],
  seige: ["siege"],
  sieze: ["seize"],
  similiar: ["similar"],
  speach: ["speech"],
  succesful: ["successful"],
  suprise: ["surprise"],
  tommorow: ["tomorrow"],
  tomorow: ["tomorrow"],
  tounge: ["tongue"],
  truely: ["truly"],
  unfortunatly: ["unfortunately"],
  wether: ["whether", "weather"],
  wich: ["which", "witch"],
  writting: ["writing"],
  alot: ["a lot", "allot"],
  noone: ["no one"],
  everytime: ["every time"],
  nevermind: ["never mind"],
  irregardless: ["regardless"],
  supposably: ["supposedly"],
  thier: ["their"],
  freindly: ["friendly"],
  greatful: ["grateful"],
  hopefuly: ["hopefully"],
  basicly: ["basically"],
  actualy: ["actually"],
  especialy: ["especially"],
  usualy: ["usually"],
};

interface GrammarRule {
  regex: RegExp;
  message: string;
  suggest: (match: RegExpExecArray) => string[];
}

const VOWEL_SOUND_EXCEPTIONS = /^(hour|honest|honor|honour|heir|herb)/i;
const CONSONANT_SOUND_VOWELS = /^(uni|use|user|usur|util|urop|eul|eup|eur|one|once)/i;

function shouldUseAn(nextWord: string): boolean {
  if (VOWEL_SOUND_EXCEPTIONS.test(nextWord)) return true;
  if (CONSONANT_SOUND_VOWELS.test(nextWord)) return false;
  return /^[aeiou]/i.test(nextWord);
}

const GRAMMAR_RULES: GrammarRule[] = [
  {
    regex: /\b([a-zA-Z]{2,})\s+\1\b/gi,
    message: "Repeated word",
    suggest: (m) => [m[1]],
  },
  {
    regex: /(?:^|[.!?]\s+)([a-z][a-z']*)\b/g,
    message: "Sentence should start with a capital letter",
    suggest: (m) => {
      const w = m[1];
      return [w.charAt(0).toUpperCase() + w.slice(1)];
    },
  },
  {
    regex: /(?:^|\s)(i)(?=\s|['’](?:m|ve|d|ll)\b|[,.!?]|$)/g,
    message: "The pronoun 'I' should always be capitalized",
    suggest: () => ["I"],
  },
  {
    regex: /\b(should|could|would|must|might)\s+of\b/gi,
    message: "Use 'have' instead of 'of' after modal verbs",
    suggest: (m) => [`${m[1]} have`],
  },
  {
    regex: /\b(shouldn't|couldn't|wouldn't|mustn't)\s+of\b/gi,
    message: "Use 'have' instead of 'of' after modal verbs",
    suggest: (m) => [`${m[1]} have`],
  },
  {
    regex: /\b(your)\s+(welcome|right|wrong|going|doing|looking|making|getting|coming|invited|awesome|amazing|late|early|ready|the|a|an|very|so|not|here|there|able|sure|certain|correct|mistaken)\b/gi,
    message: "Did you mean the contraction \"you're\" (you are)?",
    suggest: (m) => {
      const cap = m[1][0] === "Y" ? "You're" : "you're";
      return [`${cap} ${m[2]}`];
    },
  },
  {
    regex: /\b(its)\s+(a|an|the|been|going|not|very|so|too|really|always|never|still|just|only|getting|coming|making|important|essential|clear|obvious|hard|easy|time|great|good|bad)\b/gi,
    message: "Did you mean \"it's\" (it is / it has)?",
    suggest: (m) => {
      const cap = m[1][0] === "I" ? "It's" : "it's";
      return [`${cap} ${m[2]}`];
    },
  },
  {
    regex: /\b(their)\s+(is|are|was|were|has|have|will|won't|can|can't|goes|seems|appears|exists|remains)\b/gi,
    message: "Did you mean \"there\"?",
    suggest: (m) => {
      const cap = m[1][0] === "T" ? "There" : "there";
      return [`${cap} ${m[2]}`];
    },
  },
  {
    regex: /\b(there)\s+(own|house|car|home|work|life|family|friends|team|room|dog|cat|name|idea|way|place|time|parents|children|eyes|hands|heads|hearts|minds)\b/gi,
    message: "Did you mean the possessive \"their\"?",
    suggest: (m) => {
      const cap = m[1][0] === "T" ? "Their" : "their";
      return [`${cap} ${m[2]}`];
    },
  },
  {
    regex: /\b(who's)\s+(car|house|book|idea|fault|turn|name|phone|dog|cat|keys|bag|coat|job|life|work)\b/gi,
    message: "Use the possessive 'whose' instead of 'who's' (who is)",
    suggest: (m) => {
      const cap = m[1][0] === "W" ? "Whose" : "whose";
      return [`${cap} ${m[2]}`];
    },
  },
  {
    regex: /\b(better|worse|more|less|faster|slower|bigger|smaller|higher|lower|older|younger|other|rather|sooner|later|harder|easier|stronger|weaker|longer|shorter|further|greater)\s+then\b/gi,
    message: "Use 'than' for comparisons instead of 'then'",
    suggest: (m) => [`${m[1]} than`],
  },
  {
    regex: /\b(suppose|use)\s+to\b/gi,
    message: "Use past participle ('supposed to' / 'used to')",
    suggest: (m) => [`${m[1]}d to`],
  },
  {
    regex: /\b(a|an)\s+([a-zA-Z]{2,})\b/g,
    message: "Article agreement ('a' vs 'an')",
    suggest: (m) => {
      const art = m[1];
      const next = m[2];
      const needAn = shouldUseAn(next);
      const isAn = art.toLowerCase() === "an";
      if (needAn === isAn) return [];
      const fixedArt = needAn ? (art[0] === "A" ? "An" : "an") : art[0] === "A" ? "A" : "a";
      return [`${fixedArt} ${next}`];
    },
  },
  {
    regex: /\b(you|we|they)\s+(was)\b/gi,
    message: "Subject-verb agreement ('were' instead of 'was')",
    suggest: (m) => [`${m[1]} were`],
  },
  {
    regex: /\b(he|she|it)\s+(were|dont|don't|have|do)\b/gi,
    message: "Subject-verb agreement",
    suggest: (m) => {
      const p = m[1];
      const v = m[2].toLowerCase();
      const rep = v === "were" ? "was" : v === "have" ? "has" : v === "do" ? "does" : "doesn't";
      return [`${p} ${rep}`];
    },
  },
  {
    regex: /\b(i|you|we|they)\s+(doesn't|doesnt|has)\b/gi,
    message: "Subject-verb agreement",
    suggest: (m) => {
      const p = m[1];
      const v = m[2].toLowerCase();
      const rep = v === "has" ? "have" : "don't";
      return [`${p} ${rep}`];
    },
  },
  {
    regex: /\b(everyone|everybody|someone|somebody|anyone|anybody|no one|nobody)\s+(are|were|have)\b/gi,
    message: "Indefinite pronouns take a singular verb ('is', 'was', 'has')",
    suggest: (m) => {
      const v = m[2].toLowerCase();
      const rep = v === "are" ? "is" : v === "were" ? "was" : "has";
      return [`${m[1]} ${rep}`];
    },
  },
  {
    regex: /\b(there)\s+(is|was)\s+(many|several|few|numerous|multiple|both|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
    message: "Plural count requires a plural verb ('there are' / 'there were')",
    suggest: (m) => {
      const v = m[2].toLowerCase() === "is" ? "are" : "were";
      return [`${m[1]} ${v} ${m[3]}`];
    },
  },
  {
    regex: /\b(between\s+you\s+and)\s+I\b/gi,
    message: "Use the objective pronoun 'me' after a preposition",
    suggest: (m) => [`${m[1]} me`],
  },
  {
    regex: /(?:^|[.!?]\s+)(Me\s+and\s+(?:my\s+[a-zA-Z]+|him|her|them|[A-Z][a-z]+))\s+(went|are|were|have|had|will|did|made|saw|took|got)\b/g,
    message: "Put yourself second and use subject pronoun 'I' in the subject position",
    suggest: (m) => {
      const other = m[1].replace(/^Me\s+and\s+/i, "");
      const capOther = other.charAt(0).toUpperCase() + other.slice(1);
      return [`${capOther} and I ${m[2]}`];
    },
  },
  {
    regex: /\b(could)\s+care\s+less\b/gi,
    message: "Idiom check: did you mean \"couldn't care less\"?",
    suggest: (m) => [`${m[1]}n't care less`],
  },
  {
    regex: /\bfor\s+all\s+intensive\s+purposes\b/gi,
    message: "Eggcorn check: the standard phrase is 'for all intents and purposes'",
    suggest: () => ["for all intents and purposes"],
  },
  {
    regex: /\b(irregardless)\b/gi,
    message: "Non-standard word; use 'regardless' or 'irrespective'",
    suggest: (m) => [m[1][0] === "I" ? "Regardless" : "regardless"],
  },
  {
    regex: /\b(loose)\s+(weight|time|money|hope|control|track|sight|focus|patience|interest|sleep|faith|touch|ground)\b/gi,
    message: "Use the verb 'lose' instead of the adjective 'loose'",
    suggest: (m) => [`${m[1][0] === "L" ? "Lose" : "lose"} ${m[2]}`],
  },
  {
    regex: /\b(the|a|an|positive|negative|profound|dramatic|direct|immediate|lasting|side|ripple)\s+(affect)\b(?=\s+(?:on|of|upon|[,.!?]|$))/gi,
    message: "Use the noun 'effect' here instead of the verb 'affect'",
    suggest: (m) => [`${m[1]} effect`],
  },
  // Introductory transition word missing a comma
  {
    regex: /(?:^|[.!?]\s+)(However|Therefore|Furthermore|Moreover|Meanwhile|Nevertheless|Nonetheless|Consequently|Subsequently|Accordingly|Conversely|Instead|Otherwise)\s+([a-z]{2,})\b/g,
    message: "Add a comma after an introductory transition word",
    suggest: (m) => [`${m[1]}, ${m[2]}`],
  },
  // Space before punctuation (, . ! ? ; :)
  {
    regex: /([a-zA-Z0-9])\s+([,.!?;:])(?=\s|$)/g,
    message: "Remove extra space before punctuation mark",
    suggest: (m) => [`${m[1]}${m[2]}`],
  },
  // Missing space after comma, semicolon, or period (excluding decimals, URLs, and abbreviations like e.g. / i.e.)
  {
    regex: /\b([a-zA-Z]{2,})([,;])([a-zA-Z]{2,})\b/g,
    message: "Missing space after punctuation mark",
    suggest: (m) => [`${m[1]}${m[2]} ${m[3]}`],
  },
  {
    regex: /\b([a-z]{2,})([.!?])([A-Z][a-z]{2,})\b/g,
    message: "Missing space after end-of-sentence punctuation",
    suggest: (m) => [`${m[1]}${m[2]} ${m[3]}`],
  },
  // Double punctuation (,, .. !! ?? ,. .,)
  {
    regex: /([a-zA-Z0-9])(,,+|\.\.(?!\.)|!!+|\?\?+|,\.|\.,)/g,
    message: "Duplicate or mistyped punctuation mark",
    suggest: (m) => {
      const p = m[2];
      if (p === "..") return [`${m[1]}.`, `${m[1]}…`];
      return [`${m[1]}${p[0]}`];
    },
  },
  // Mid-paragraph missing full stop before a new capitalized sentence starter
  {
    regex: /\b([a-z]{3,})\s+(He|She|They|We|It|However|Therefore|Furthermore|Meanwhile|Moreover|Suddenly|Finally|Fortunately|Unfortunately)\s+([a-z]{2,})\b/g,
    message: "Possible missing full stop before a new sentence",
    suggest: (m) => [`${m[1]}. ${m[2]} ${m[3]}`, `${m[1]}; ${m[2].toLowerCase()} ${m[3]}`],
  },
  {
    regex: /([a-zA-Z,;:])( {2,})(?=[a-zA-Z])/g,
    message: "Extra space between words",
    suggest: () => [" "],
  },
];

function matchCase(suggestion: string, original: string): string {
  if (original.length > 1 && original === original.toUpperCase()) return suggestion.toUpperCase();
  if (original[0] && original[0] === original[0].toUpperCase() && suggestion[0]) {
    return suggestion[0].toUpperCase() + suggestion.slice(1);
  }
  return suggestion;
}

function scheduleNativeSpellBatch(wordsToQuery: string[], onResolved?: () => void): void {
  for (const w of wordsToQuery) {
    const key = w.toLowerCase();
    if (!nativeSpellCache.has(key)) {
      pendingSpellWords.add(key);
    }
  }
  if (pendingSpellWords.size === 0) return;
  if (spellBatchTimer) clearTimeout(spellBatchTimer);

  spellBatchTimer = setTimeout(async () => {
    spellBatchTimer = null;
    const batch = Array.from(pendingSpellWords).slice(0, 250);
    batch.forEach((w) => pendingSpellWords.delete(w));
    if (batch.length === 0) return;

    try {
      const errors = await native.checkSpelling(batch);
      for (const w of batch) {
        nativeSpellCache.set(w.toLowerCase(), null);
      }
      if (Array.isArray(errors)) {
        for (const err of errors) {
          nativeSpellCache.set(err.word.toLowerCase(), err.suggestions ?? []);
        }
      }
      onResolved?.();
    } catch {
      // If COM fails, mark batch as checked so we don't loop
      for (const w of batch) {
        if (!nativeSpellCache.has(w)) nativeSpellCache.set(w, null);
      }
    }
  }, 60);
}

function scheduleOnlineGrammarBatch(blocksToCheck: string[], onResolved?: () => void): void {
  if (settings.strictOfflinePrivacy !== false) return;
  for (const b of blocksToCheck) {
    const trimmed = b.trim();
    if (trimmed.length >= 6 && !onlineBlockCache.has(b)) {
      pendingBlocks.add(b);
    }
  }
  if (pendingBlocks.size === 0) return;
  if (onlineGrammarTimer) clearTimeout(onlineGrammarTimer);

  onlineGrammarTimer = setTimeout(async () => {
    onlineGrammarTimer = null;
    if (settings.strictOfflinePrivacy !== false) return;
    const batch = Array.from(pendingBlocks).slice(0, 6);
    batch.forEach((b) => pendingBlocks.delete(b));
    if (batch.length === 0) return;

    let anyUpdated = false;
    for (const blockText of batch) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        const body = new URLSearchParams({
          text: blockText,
          language: "en-US",
        });
        const res = await fetch("https://api.languagetool.org/v2/check", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          onlineBlockCache.set(blockText, []);
          continue;
        }
        const data = await res.json();
        const matches: CachedBlockIssue[] = [];
        if (Array.isArray(data?.matches)) {
          for (const m of data.matches) {
            const offset = Number(m.offset);
            const length = Number(m.length);
            if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0) continue;
            const issueType = String(m.rule?.issueType || "").toLowerCase();
            const categoryId = String(m.rule?.category?.id || "").toUpperCase();
            const isSpelling = issueType === "misspelling" || categoryId === "TYPOS" || String(m.rule?.id || "").includes("MORFOLOGIK");
            const suggestions = Array.isArray(m.replacements)
              ? m.replacements.slice(0, 5).map((r: any) => String(r.value)).filter(Boolean)
              : [];
            matches.push({
              offset,
              length,
              kind: isSpelling ? "spelling" : "grammar",
              message: String(m.shortMessage || m.message || (isSpelling ? "Spelling error" : "Grammar suggestion")),
              suggestions,
            });
          }
        }
        onlineBlockCache.set(blockText, matches);
        anyUpdated = true;
      } catch {
        // Offline or rate-limited; skip quietly
        onlineBlockCache.set(blockText, []);
      }
    }
    if (anyUpdated) onResolved?.();
  }, 650);
}

function checkWordSpelling(
  word: string,
  userDict: Set<string>,
  unknownCollector: string[],
): { message: string; suggestions: string[] } | null {
  if (word.length < 2) return null;
  const lower = word.toLowerCase();
  if (userDict.has(lower) || sessionIgnored.has(lower)) return null;
  if (/^\d+$/.test(word)) return null;

  // 1. Direct lookup in our high-frequency typo & contraction table
  if (TYPO_MAP[lower]) {
    return {
      message: TYPO_MAP[lower][0].includes("'") ? "Missing apostrophe in contraction" : "Spelling error",
      suggestions: TYPO_MAP[lower].map((s) => matchCase(s, word)),
    };
  }

  // 2. Windows 11 Native OS Spellchecker cache lookup
  if (nativeSpellCache.has(lower)) {
    const osSugs = nativeSpellCache.get(lower);
    if (osSugs !== null && osSugs !== undefined) {
      return {
        message: "Spelling error",
        suggestions: osSugs.slice(0, 5).map((s) => matchCase(s, word)),
      };
    }
    return null; // Valid English word verified by Windows OS spellchecker
  }

  // Queue this word for the native OS COM spellchecker batch
  unknownCollector.push(lower);

  // 3. Instant fallback heuristics while async OS check is in-flight
  if (/([a-zA-Z])\1\1/.test(word)) {
    const collapsedDouble = word.replace(/([a-zA-Z])\1{2,}/g, "$1$1");
    const collapsedSingle = word.replace(/([a-zA-Z])\1{2,}/g, "$1");
    return {
      message: "Repeated letters in word",
      suggestions: Array.from(new Set([collapsedSingle, collapsedDouble])),
    };
  }

  return null;
}

export function scanDocumentIssues(
  doc: any,
  onAsyncUpdate?: () => void,
  options?: { fullScan?: boolean; cursorPos?: number },
): ProofIssue[] {
  const fullScan = Boolean(options?.fullScan);
  if (!settings.spellcheck && !manualScanActive && !fullScan) return [];

  const issues: ProofIssue[] = [];
  const userDict = new Set((settings.userDictionary ?? []).map((w) => w.toLowerCase()));
  const unknownWords: string[] = [];
  const uncachedBlocks: string[] = [];

  // For massive documents (> 40,000 chars) during live typing, only scan a window around the cursor
  // so 1,000+ page documents remain 60fps. When "Check Now" (fullScan) is clicked, scan the entire document.
  const docSize = doc.content?.size ?? 0;
  const useWindow = !fullScan && !manualScanActive && docSize > 40000 && typeof options?.cursorPos === "number";
  const winMin = useWindow ? Math.max(0, options!.cursorPos! - 18000) : 0;
  const winMax = useWindow ? Math.min(docSize, options!.cursorPos! + 18000) : docSize;

  doc.descendants((node: any, pos: number) => {
    if (useWindow && (pos + node.nodeSize < winMin || pos > winMax)) {
      return false;
    }
    if (node.type.name === "codeBlock") return false;
    if (!node.isTextblock) return true;

    let text = "";
    const posMap: number[] = [];
    node.forEach((child: any, offset: number) => {
      if (child.isText && child.text) {
        const hasCode = child.marks?.some((m: any) => m.type.name === "code");
        for (let i = 0; i < child.text.length; i++) {
          posMap.push(pos + 1 + offset + i);
          text += hasCode ? " " : child.text[i];
        }
      } else {
        posMap.push(pos + 1 + offset);
        text += " ";
      }
    });

    if (!text.trim()) return false;

    // 1. Word-level spelling checks (Instant table + Windows 11 Native OS Spellchecker)
    const wordRegex = /\b[a-zA-Z']+\b/g;
    let m: RegExpExecArray | null;
    while ((m = wordRegex.exec(text)) !== null) {
      const rawWord = m[0].replace(/^'+|'+$/g, "");
      if (!rawWord) continue;
      const startIdx = m.index + m[0].indexOf(rawWord);
      const endIdx = startIdx + rawWord.length - 1;
      const from = posMap[startIdx];
      const to = posMap[endIdx] + 1;

      const spell = checkWordSpelling(rawWord, userDict, unknownWords);
      if (spell) {
        issues.push({
          from,
          to,
          kind: "spelling",
          text: rawWord,
          message: spell.message,
          suggestions: spell.suggestions,
        });
      }
    }

    // 2. Instant offline phrase & sentence-level grammar checks
    for (const rule of GRAMMAR_RULES) {
      rule.regex.lastIndex = 0;
      let gm: RegExpExecArray | null;
      while ((gm = rule.regex.exec(text)) !== null) {
        const suggestions = rule.suggest(gm);
        if (!suggestions.length) continue;

        let matchStart = gm.index;
        let matchLen = gm[0].length;
        if (rule.message.includes("capital letter") || rule.message.includes("pronoun 'I'")) {
          const g1 = gm[1];
          const subIdx = gm[0].lastIndexOf(g1);
          matchStart = gm.index + subIdx;
          matchLen = g1.length;
        } else if (rule.message.includes("Extra space")) {
          matchStart = gm.index + gm[1].length;
          matchLen = gm[2].length;
        } else if (rule.message.includes("introductory transition")) {
          const g1 = gm[1];
          const subIdx = gm[0].indexOf(g1);
          matchStart = gm.index + subIdx;
          matchLen = g1.length + 1 + gm[2].length;
        }

        const from = posMap[matchStart];
        const to = posMap[matchStart + matchLen - 1] + 1;
        const targetText = text.slice(matchStart, matchStart + matchLen);

        if (sessionIgnored.has(targetText.toLowerCase())) continue;
        if (issues.some((existing) => !(to <= existing.from || from >= existing.to))) continue;

        issues.push({
          from,
          to,
          kind: "grammar",
          text: targetText,
          message: rule.message,
          suggestions,
        });
      }
    }

    // 2b. Paragraph-level structural grammar checks:
    //     - Missing full stop / terminal punctuation at the end of a paragraph
    //     - Unclosed quotation marks or parentheses
    //     - Run-on sentence check (> 45 words without terminal punctuation)
    const isHeadingOrTitle =
      node.type.name === "heading" ||
      node.attrs?.styleName === "Title" ||
      node.attrs?.styleName === "Subtitle";

    if (!isHeadingOrTitle) {
      const trimmedRight = text.replace(/\s+$/, "");
      const wordsInPara = trimmedRight.trim().split(/\s+/).filter(Boolean);
      // Missing terminal punctuation on prose paragraphs with >= 4 words
      if (wordsInPara.length >= 4 && /[a-zA-Z0-9]$/.test(trimmedRight)) {
        const lastWordMatch = /([a-zA-Z0-9']+)$/.exec(trimmedRight);
        if (lastWordMatch) {
          const lw = lastWordMatch[1];
          const startIdx = lastWordMatch.index;
          const endIdx = startIdx + lw.length - 1;
          const from = posMap[startIdx];
          const to = posMap[endIdx] + 1;
          const isQuestion = /^(who|what|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|shall)\b/i.test(
            trimmedRight.trim(),
          );
          const sugs = isQuestion ? [`${lw}?`, `${lw}.`] : [`${lw}.`, `${lw}!`, `${lw}?`];
          if (
            !sessionIgnored.has(lw.toLowerCase()) &&
            !issues.some((existing) => !(to <= existing.from || from >= existing.to))
          ) {
            issues.push({
              from,
              to,
              kind: "grammar",
              text: lw,
              message: isQuestion
                ? "Missing question mark or full stop at end of sentence"
                : "Missing full stop (period) at end of sentence",
              suggestions: sugs,
            });
          }
        }
      }

      // Unclosed straight double quotes
      const straightQuoteCount = (text.match(/"/g) || []).length;
      if (straightQuoteCount % 2 === 1) {
        const lastQuoteIdx = text.lastIndexOf('"');
        if (lastQuoteIdx >= 0) {
          const from = posMap[lastQuoteIdx];
          const to = from + 1;
          if (!issues.some((existing) => !(to <= existing.from || from >= existing.to))) {
            issues.push({
              from,
              to,
              kind: "grammar",
              text: '"',
              message: "Unclosed quotation mark in paragraph",
              suggestions: ['"', ""],
            });
          }
        }
      }

      // Unclosed parentheses
      const openParens = (text.match(/\(/g) || []).length;
      const closeParens = (text.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        const targetChar = openParens > closeParens ? "(" : ")";
        const idx = text.lastIndexOf(targetChar);
        if (idx >= 0) {
          const from = posMap[idx];
          const to = from + 1;
          if (!issues.some((existing) => !(to <= existing.from || from >= existing.to))) {
            issues.push({
              from,
              to,
              kind: "grammar",
              text: targetChar,
              message: openParens > closeParens ? "Unclosed opening parenthesis '('" : "Unmatched closing parenthesis ')'",
              suggestions: [openParens > closeParens ? "()" : ""],
            });
          }
        }
      }
    }

    // 3. Online contextual LanguageTool grammar & style results (only when Strict Offline Privacy Mode is turned off)
    if (settings.strictOfflinePrivacy === false) {
      if (onlineBlockCache.has(text)) {
        const cached = onlineBlockCache.get(text) ?? [];
        for (const c of cached) {
          if (c.offset < 0 || c.offset + c.length > posMap.length) continue;
          const from = posMap[c.offset];
          const to = posMap[c.offset + c.length - 1] + 1;
          const targetText = text.slice(c.offset, c.offset + c.length);
          const lower = targetText.toLowerCase();
          if (userDict.has(lower) || sessionIgnored.has(lower)) continue;
          if (issues.some((existing) => !(to <= existing.from || from >= existing.to))) continue;
          issues.push({
            from,
            to,
            kind: c.kind,
            text: targetText,
            message: c.message,
            suggestions: c.suggestions,
          });
        }
      } else {
        uncachedBlocks.push(text);
      }
    }

    return false;
  });

  if (unknownWords.length > 0 && onAsyncUpdate) {
    scheduleNativeSpellBatch(unknownWords, onAsyncUpdate);
  }
  if (settings.strictOfflinePrivacy === false && uncachedBlocks.length > 0 && onAsyncUpdate) {
    scheduleOnlineGrammarBatch(uncachedBlocks, onAsyncUpdate);
  }

  return issues;
}

export function getIssueAtPos(state: any, pos: number): ProofIssue | null {
  const pluginState = proofingKey.getState(state);
  if (!pluginState) return null;
  return pluginState.issues.find((i) => pos >= i.from && pos <= i.to) ?? null;
}

export function ignoreIssueWord(word: string, editor: any): void {
  sessionIgnored.add(word.toLowerCase());
  editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true }));
}

export function addWordToUserDictionary(word: string, editor: any): void {
  const clean = word.trim().toLowerCase();
  if (!clean) return;
  if (!settings.userDictionary.includes(clean)) {
    settings.userDictionary.push(clean);
    saveSettings();
  }
  sessionIgnored.add(clean);
  nativeSpellCache.set(clean, null);
  editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true }));
  toast(`Added "${word}" to dictionary`, "success", 2000);
}

export function applyIssueFix(editor: any, issue: ProofIssue, replacement: string): void {
  editor
    .chain()
    .focus()
    .command(({ tr, state }: any) => {
      const $from = state.doc.resolve(issue.from);
      const marks = $from.marks();
      const textNode = state.schema.text(replacement, marks);
      tr.replaceWith(issue.from, issue.to, textNode);
      return true;
    })
    .run();
}

let activeQuickFix: HTMLElement | null = null;
let quickFixCleanup: (() => void) | null = null;

export function closeQuickFix(): void {
  quickFixCleanup?.();
  quickFixCleanup = null;
  activeQuickFix?.remove();
  activeQuickFix = null;
}

export function showQuickFixPopover(
  editor: any,
  issue: ProofIssue,
  anchorRect: DOMRect,
  onDefine?: (word: string) => void,
): void {
  closeQuickFix();
  const root = document.getElementById("overlay-root")!;

  const card = h("div", { class: "popover popover--in proof-card", role: "dialog" });
  const header = h(
    "div",
    { class: "proof-card__head" },
    h("span", { class: `proof-card__dot proof-card__dot--${issue.kind}` }),
    h(
      "span",
      { class: `proof-card__badge proof-card__badge--${issue.kind}` },
      issue.kind === "spelling" ? "Spelling" : "Grammar",
    ),
    h("code", { class: "proof-card__token" }, issue.text.trim() || "␣␣"),
    h("span", { class: "proof-card__msg" }, issue.message),
  );

  const list = h("div", { class: "proof-card__list" });
  if (issue.suggestions.length > 0) {
    issue.suggestions.forEach((sug, idx) => {
      const displaySug = sug === " " ? "Single space" : sug;
      const row = h(
        "button",
        { type: "button", class: "proof-card__row" + (idx === 0 ? " is-primary" : "") },
        h(
          "span",
          { class: "proof-card__diff" },
          h("span", { class: "proof-card__from" }, issue.text.trim() || "␣␣"),
          icon("ArrowRight", 12),
          h("strong", { class: "proof-card__to" }, displaySug),
        ),
        idx < 5 ? h("kbd", { class: "proof-card__kbd" }, String(idx + 1)) : null,
      );
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => {
        closeQuickFix();
        applyIssueFix(editor, issue, sug);
      });
      list.append(row);
    });
  } else {
    list.append(h("div", { class: "proof-card__nosug" }, "No automatic replacement suggestions available."));
  }

  const actions = h("div", { class: "proof-card__actions" });
  const ignoreBtn = h("button", { type: "button", class: "proof-card__act" }, icon("EyeOff", 13), "Ignore");
  ignoreBtn.addEventListener("click", () => {
    closeQuickFix();
    ignoreIssueWord(issue.text, editor);
  });
  actions.append(ignoreBtn);

  if (issue.kind === "spelling") {
    const dictBtn = h("button", { type: "button", class: "proof-card__act" }, icon("BookPlus", 13), "Add to Dictionary");
    dictBtn.addEventListener("click", () => {
      closeQuickFix();
      addWordToUserDictionary(issue.text, editor);
    });
    actions.append(dictBtn);
  }

  const defineHandler = onDefine ?? globalDefineHandler;
  const cleanWord = issue.text.trim();
  if (/^[a-zA-Z'-]+$/.test(cleanWord)) {
    if (defineHandler) {
      const defBtn = h("button", { type: "button", class: "proof-card__act" }, icon("BookOpen", 13), "Define");
      defBtn.addEventListener("click", () => {
        closeQuickFix();
        defineHandler(cleanWord);
      });
      actions.append(defBtn);
    }
    const webBtn = h("button", { type: "button", class: "proof-card__act" }, icon("Globe", 13), "Web Lookup");
    webBtn.addEventListener("click", () => {
      closeQuickFix();
      void native.openUrl(`https://www.google.com/search?q=define+${encodeURIComponent(cleanWord)}`);
    });
    actions.append(webBtn);
  }

  card.append(header, list, actions);
  root.append(card);

  const cr = card.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - cr.width - 8));
  let top = anchorRect.bottom + 6;
  if (top + cr.height > window.innerHeight - 8) {
    top = Math.max(8, anchorRect.top - cr.height - 6);
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;

  activeQuickFix = card;

  const onDown = (e: MouseEvent) => {
    if (!card.contains(e.target as Node)) {
      closeQuickFix();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeQuickFix();
      return;
    }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[1-5]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < issue.suggestions.length) {
        e.preventDefault();
        e.stopPropagation();
        const chosen = issue.suggestions[idx];
        closeQuickFix();
        applyIssueFix(editor, issue, chosen);
      }
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 10);
  quickFixCleanup = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
}

export const Proofing = Extension.create({
  name: "proofing",

  addProseMirrorPlugins() {
    const editor = this.editor;

    const triggerAsyncRescan = () => {
      if (!editor || !editor.view || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(proofingKey, { rescan: true }));
      emit("proofing:update");
    };

    function buildState(doc: any, fullScan = false, cursorPos = 0) {
      const issues = scanDocumentIssues(doc, triggerAsyncRescan, { fullScan, cursorPos });
      const decos = issues.map((iss) =>
        Decoration.inline(iss.from, iss.to, {
          class: iss.kind === "spelling" ? "typo-proof typo-proof--spell" : "typo-proof typo-proof--grammar",
          "data-proof-kind": iss.kind,
          "data-proof-msg": iss.message,
        }),
      );
      return { issues, deco: DecorationSet.create(doc, decos) };
    }

    return [
      new Plugin({
        key: proofingKey,
        state: {
          init(_, state) {
            return buildState(state.doc, false, state.selection.head);
          },
          apply(tr, prev, _oldState, newState) {
            const meta = tr.getMeta(proofingKey);
            if (tr.docChanged || meta?.rescan) {
              return buildState(newState.doc, Boolean(meta?.fullScan), newState.selection.head);
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return proofingKey.getState(state)?.deco ?? null;
          },
          handleClick(view, pos, event) {
            const issue = getIssueAtPos(view.state, pos);
            if (issue && event.button === 0) {
              const target = event.target as HTMLElement;
              const rect = target.getBoundingClientRect();
              showQuickFixPopover(editor, issue, rect);
            } else {
              closeQuickFix();
            }
            return false;
          },
        },
      }),
    ];
  },
});
