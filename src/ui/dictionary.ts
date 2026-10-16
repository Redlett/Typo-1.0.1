/**
 * Built-In Offline + Online Dictionary, Thesaurus & Proofing Review Panel for Typo.
 * - Includes a comprehensive Built-In Offline English Lexicon + Morphological Root/Affix Engine
 *   + Windows 11 Native Offline Spellchecker integration so lookups ALWAYS work 100% offline
 *   directly inside the app.
 * - Switching dictionary tabs (Smart All, Built-In Offline, Wiktionary, WordNet) switches views
 *   INSIDE the modal—never forcing a redirect to Chrome unless the user explicitly clicks the
 *   small external browser button.
 */
import type { Editor } from "@tiptap/core";
import { h, icon, toast, promptDialog } from "./dom";
import { native } from "../core/native";
import { state, on } from "../core/state";
import { settings } from "../core/settings";
import {
  proofingKey,
  applyIssueFix,
  ignoreIssueWord,
  addWordToUserDictionary,
  registerDefineHandler,
  isAutoSpellcheck,
  setAutoSpellcheck,
  runOneShotProofCheck,
  clearProofHighlights,
  type ProofIssue,
} from "../editor/proofing";
import { EXTENDED_OFFLINE_LEXICON, IRREGULAR_LEMMAS } from "./offline-lexicon";

export interface OfflineEntry {
  pos: string;
  def: string;
  example?: string;
  syns: string[];
}

/** Built-in offline lexicon covering high-frequency English, literary, and academic vocabulary. */
const OFFLINE_LEXICON: Record<string, OfflineEntry> = {
  abandon: { pos: "verb", def: "Cease to support or look after; give up completely.", syns: ["forsake", "desert", "relinquish", "renounce", "discard", "drop"] },
  abate: { pos: "verb", def: "Become less intense, widespread, or severe.", syns: ["subside", "lessen", "diminish", "wane", "recede", "ease"] },
  abundant: { pos: "adjective", def: "Existing or available in large quantities; plentiful.", syns: ["plentiful", "copious", "ample", "profuse", "bountiful", "rich"] },
  accelerate: { pos: "verb", def: "Begin to move more quickly; increase in rate, amount, or extent.", syns: ["hasten", "expedite", "quicken", "speed up", "stimulate", "spur"] },
  accurate: { pos: "adjective", def: "Correct in all details; exact and free from error.", syns: ["precise", "exact", "correct", "faithful", "true", "rigorous"] },
  achieve: { pos: "verb", def: "Successfully bring about or reach a desired objective or result by effort.", syns: ["attain", "accomplish", "realize", "reach", "fulfill", "complete"] },
  acknowledge: { pos: "verb", def: "Accept or admit the existence or truth of; recognize the importance of.", syns: ["admit", "accept", "grant", "recognize", "concede", "confirm"] },
  acquire: { pos: "verb", def: "Buy or obtain an asset or object for oneself; learn or develop a skill.", syns: ["obtain", "secure", "procure", "gain", "attain", "earn"] },
  adapt: { pos: "verb", def: "Make suitable for a new use or purpose; modify or adjust to new conditions.", syns: ["adjust", "modify", "acclimate", "tailor", "accommodate", "reshape"] },
  adequate: { pos: "adjective", def: "Satisfactory or acceptable in quality or quantity.", syns: ["sufficient", "enough", "ample", "suitable", "acceptable", "passable"] },
  advocate: { pos: "verb / noun", def: "Publicly recommend or support a particular cause or policy.", syns: ["champion", "uphold", "support", "promote", "endorse", "proponent"] },
  aesthetic: { pos: "adjective / noun", def: "Concerned with beauty or the appreciation of beauty and visual craft.", syns: ["artistic", "visual", "tasteful", "graceful", "stylistic", "elegant"] },
  ambiguous: { pos: "adjective", def: "Open to more than one interpretation; not having one obvious meaning.", syns: ["equivocal", "vague", "unclear", "cryptic", "enigmatic", "indefinite"] },
  analyze: { pos: "verb", def: "Examine methodically and in detail the constitution or structure of something.", syns: ["examine", "inspect", "dissect", "evaluate", "investigate", "scrutinize"] },
  ancient: { pos: "adjective", def: "Belonging to the very distant past and no longer in existence.", syns: ["archaic", "antique", "primeval", "prehistoric", "aged", "venerable"] },
  anticipate: { pos: "verb", def: "Regard as probable; expect or predict and prepare for ahead of time.", syns: ["expect", "foresee", "predict", "await", "forecast", "envision"] },
  apparent: { pos: "adjective", def: "Clearly visible or understood; obvious.", syns: ["evident", "obvious", "clear", "manifest", "plain", "unmistakable"] },
  articulate: { pos: "adjective / verb", def: "Having or showing the ability to speak fluently, clearly, and coherently.", syns: ["eloquent", "fluent", "lucid", "express", "voice", "enunciate"] },
  assess: { pos: "verb", def: "Evaluate or estimate the nature, ability, or quality of.", syns: ["evaluate", "appraise", "judge", "gauge", "estimate", "weigh"] },
  authentic: { pos: "adjective", def: "Of undisputed origin and not a copy; genuine.", syns: ["genuine", "real", "bona fide", "true", "veritable", "legitimate"] },
  bad: { pos: "adjective", def: "Of poor quality or a low standard; unfavorable or unwelcome.", syns: ["poor", "inferior", "substandard", "flawed", "adverse", "unpleasant", "deficient"] },
  beautiful: { pos: "adjective", def: "Pleasing the senses or mind aesthetically.", syns: ["stunning", "gorgeous", "elegant", "striking", "exquisite", "lovely", "radiant"] },
  beneficial: { pos: "adjective", def: "Resulting in good; favorable or advantageous.", syns: ["advantageous", "favorable", "helpful", "useful", "constructive", "valuable"] },
  big: { pos: "adjective", def: "Of considerable size, extent, or intensity.", syns: ["large", "substantial", "immense", "vast", "expansive", "sizable", "massive"] },
  brave: { pos: "adjective", def: "Ready to face and endure danger or pain; showing courage.", syns: ["courageous", "valiant", "fearless", "bold", "intrepid", "heroic", "daring"] },
  brief: { pos: "adjective", def: "Of short duration; concise in expression.", syns: ["concise", "succinct", "short", "fleeting", "compact", "pithy"] },
  bright: { pos: "adjective", def: "Giving out or reflecting much light; intelligent and quick-witted.", syns: ["luminous", "radiant", "vivid", "brilliant", "clever", "shining"] },
  build: { pos: "verb", def: "Construct something by putting parts or material together over time.", syns: ["construct", "assemble", "erect", "fabricate", "create", "forge"] },
  calm: { pos: "adjective / verb", def: "Not showing or feeling nervousness, anger, or other strong emotions.", syns: ["serene", "tranquil", "composed", "peaceful", "placid", "soothe"] },
  candid: { pos: "adjective", def: "Truthful and straightforward; frank.", syns: ["frank", "honest", "forthright", "sincere", "direct", "unreserved"] },
  capable: { pos: "adjective", def: "Having the ability, fitness, or quality necessary to do or achieve a specified thing.", syns: ["competent", "able", "proficient", "skilled", "qualified", "adept"] },
  careful: { pos: "adjective", def: "Making sure of avoiding potential danger, mishap, or harm; cautious.", syns: ["cautious", "meticulous", "prudent", "thorough", "vigilant", "mindful"] },
  catalyst: { pos: "noun", def: "A person or thing that precipitates an event or change.", syns: ["stimulus", "spark", "impetus", "spur", "trigger", "incentive"] },
  change: { pos: "verb / noun", def: "Make or become different; transform or modify.", syns: ["modify", "alter", "transform", "adjust", "revise", "shift", "adapt"] },
  chronicle: { pos: "noun / verb", def: "A factual written account of important or historical events in the order of their occurrence.", syns: ["record", "annals", "history", "archive", "recount", "document"] },
  clarify: { pos: "verb", def: "Make a statement or situation less confused and more clearly comprehensible.", syns: ["elucidate", "explain", "illuminate", "clear up", "simplify", "spell out"] },
  clear: { pos: "adjective", def: "Easy to perceive, understand, or interpret; transparent and unobstructed.", syns: ["lucid", "transparent", "distinct", "explicit", "crystalline", "plain"] },
  coherent: { pos: "adjective", def: "Logical and consistent; united as or forming a whole.", syns: ["logical", "consistent", "lucid", "articulate", "cohesive", "structured"] },
  collaborate: { pos: "verb", def: "Work jointly on an activity or project to produce or create something.", syns: ["cooperate", "partner", "team up", "unite", "conspire", "co-author"] },
  compelling: { pos: "adjective", def: "Evoking interest, attention, or admiration in a powerfully irresistible way.", syns: ["gripping", "captivating", "persuasive", "convincing", "absorbing", "magnetic"] },
  complex: { pos: "adjective", def: "Consisting of many different and connected parts; intricate.", syns: ["intricate", "elaborate", "sophisticated", "multifaceted", "involved", "layered"] },
  comprehensive: { pos: "adjective", def: "Complete and including everything that is necessary; broad in scope.", syns: ["thorough", "exhaustive", "complete", "all-inclusive", "extensive", "sweeping"] },
  concise: { pos: "adjective", def: "Giving a lot of information clearly and in a few words; brief but comprehensive.", syns: ["succinct", "brief", "compact", "terse", "pithy", "crisp"] },
  conclude: { pos: "verb", def: "Bring or come to an end; arrive at a judgment or opinion by reasoning.", syns: ["finish", "complete", "deduce", "infer", "close", "culminate"] },
  consequence: { pos: "noun", def: "A result or effect of an action or condition.", syns: ["result", "outcome", "ramification", "repercussion", "aftermath", "effect"] },
  consistent: { pos: "adjective", def: "Acting or done in the same way over time, especially so as to be fair or accurate.", syns: ["steady", "dependable", "uniform", "constant", "coherent", "unwavering"] },
  construct: { pos: "verb", def: "Build or make something physical or conceptual.", syns: ["build", "assemble", "formulate", "craft", "devise", "erect"] },
  contemplate: { pos: "verb", def: "Look thoughtfully for a long time at; think profoundly and at length.", syns: ["ponder", "reflect", "meditate", "consider", "mull over", "deliberate"] },
  context: { pos: "noun", def: "The circumstances that form the setting for an event, statement, or idea.", syns: ["background", "setting", "framework", "backdrop", "environment", "milieu"] },
  contradict: { pos: "verb", def: "Deny the truth of a statement by asserting the opposite.", syns: ["refute", "rebut", "counter", "dispute", "challenge", "negate"] },
  contribute: { pos: "verb", def: "Give in order to help achieve or provide something.", syns: ["donate", "supply", "provide", "add", "furnish", "bestow"] },
  convey: { pos: "verb", def: "Transport or carry to a place; communicate a message or idea.", syns: ["communicate", "express", "impart", "transmit", "relay", "project"] },
  create: { pos: "verb", def: "Bring something into existence.", syns: ["produce", "generate", "craft", "design", "forge", "originate", "invent"] },
  critical: { pos: "adjective", def: "Having a decisive or crucial importance in the success, failure, or existence of something.", syns: ["crucial", "vital", "pivotal", "essential", "decisive", "urgent"] },
  cultivate: { pos: "verb", def: "Prepare and use land for crops; try to acquire or develop a quality or skill.", syns: ["foster", "nurture", "develop", "encourage", "refine", "grow"] },
  curious: { pos: "adjective", def: "Eager to know or learn something; strange or unusual.", syns: ["inquisitive", "inquiring", "intrigued", "peculiar", "novel", "searching"] },
  dark: { pos: "adjective", def: "With little or no light; somber or mysterious in tone.", syns: ["shadowy", "dim", "dusky", "obsidian", "somber", "murky", "tenebrous"] },
  decide: { pos: "verb", def: "Come to a resolution in the mind as a result of consideration.", syns: ["determine", "resolve", "choose", "elect", "settle", "conclude"] },
  define: { pos: "verb", def: "State or describe exactly the nature, scope, or meaning of.", syns: ["explain", "specify", "delineate", "characterize", "outline", "clarify"] },
  deliberate: { pos: "adjective / verb", def: "Done consciously and intentionally; engage in long and careful consideration.", syns: ["intentional", "calculated", "purposeful", "measured", "ponder", "weigh"] },
  demonstrate: { pos: "verb", def: "Clearly show the existence or truth of something by giving proof or evidence.", syns: ["show", "prove", "illustrate", "exhibit", "establish", "manifest"] },
  describe: { pos: "verb", def: "Give an account in words of someone or something, including all the relevant characteristics.", syns: ["depict", "portray", "detail", "characterize", "chronicle", "illustrate"] },
  design: { pos: "noun / verb", def: "A plan or drawing produced to show the look and function of an object before it is made.", syns: ["blueprint", "plan", "architecture", "craft", "conceive", "fashion"] },
  detail: { pos: "noun / verb", def: "An individual feature, fact, or item; give full information about.", syns: ["particular", "element", "aspect", "feature", "specify", "itemize"] },
  determine: { pos: "verb", def: "Cause something to occur in a particular way; ascertain or establish exactly.", syns: ["ascertain", "establish", "decide", "dictate", "verify", "resolve"] },
  develop: { pos: "verb", def: "Grow or cause to grow and become more mature, advanced, or elaborate.", syns: ["evolve", "expand", "cultivate", "elaborate", "build", "advance"] },
  different: { pos: "adjective", def: "Not the same as another or each other; unlike in nature, form, or quality.", syns: ["distinct", "divergent", "disparate", "contrasting", "unique", "varied"] },
  difficult: { pos: "adjective", def: "Needing much effort or skill to accomplish, deal with, or understand.", syns: ["arduous", "challenging", "demanding", "formidable", "strenuous", "tough"] },
  diligent: { pos: "adjective", def: "Having or showing care and conscientiousness in one's work or duties.", syns: ["industrious", "assiduous", "conscientious", "meticulous", "dedicated", "tireless"] },
  discover: { pos: "verb", def: "Find unexpectedly or during a search; become aware of a fact or situation.", syns: ["uncover", "unearth", "find", "detect", "reveal", "ascertain"] },
  distinct: { pos: "adjective", def: "Recognizably different in nature from something else of a similar type.", syns: ["discrete", "separate", "clear-cut", "definite", "unmistakable", "unique"] },
  diverse: { pos: "adjective", def: "Showing a great deal of variety; very different.", syns: ["varied", "multifaceted", "heterogeneous", "assorted", "wide-ranging", "eclectic"] },
  document: { pos: "noun / verb", def: "A piece of written, printed, or electronic matter that provides information or evidence.", syns: ["manuscript", "paper", "record", "charter", "chronicle", "file"] },
  dynamic: { pos: "adjective", def: "Characterized by constant change, activity, or progress.", syns: ["energetic", "vibrant", "fluid", "spirited", "kinetic", "lively"] },
  easy: { pos: "adjective", def: "Achieved without great effort; presenting few difficulties.", syns: ["effortless", "simple", "straightforward", "intuitive", "smooth", "uncomplicated"] },
  effective: { pos: "adjective", def: "Successful in producing a desired or intended result.", syns: ["efficacious", "potent", "productive", "compelling", "capable", "impactful"] },
  efficient: { pos: "adjective", def: "Achieving maximum productivity with minimum wasted effort or expense.", syns: ["streamlined", "productive", "economical", "organized", "optimal", "deft"] },
  elaborate: { pos: "adjective / verb", def: "Involving many carefully arranged parts or details; develop or present in detail.", syns: ["intricate", "detailed", "ornate", "expand", "expound", "flesh out"] },
  elegant: { pos: "adjective", def: "Graceful and stylish in appearance or manner; pleasingly ingenious and simple.", syns: ["graceful", "refined", "polished", "exquisite", "sophisticated", "sleek"] },
  eloquent: { pos: "adjective", def: "Fluent or persuasive in speaking or writing.", syns: ["articulate", "expressive", "silver-tongued", "vivid", "poignant", "persuasive"] },
  emerge: { pos: "verb", def: "Move out of or away from something and come into view; become apparent.", syns: ["appear", "surface", "arise", "materialize", "unfold", "spring"] },
  emphasize: { pos: "verb", def: "Give special importance or prominence to something in speaking or writing.", syns: ["highlight", "underscore", "stress", "accentuate", "spotlight", "foreground"] },
  enable: { pos: "verb", def: "Give someone or something the authority or means to do something.", syns: ["empower", "facilitate", "allow", "equip", "permit", "activate"] },
  end: { pos: "verb / noun", def: "Bring or come to a final point; conclude.", syns: ["conclude", "finish", "complete", "terminate", "wrap up", "culminate"] },
  endure: { pos: "verb", def: "Suffer something painful or difficult patiently; remain in existence.", syns: ["persist", "persevere", "withstand", "last", "weather", "abide"] },
  enhance: { pos: "verb", def: "Intensify, increase, or further improve the quality, value, or extent of.", syns: ["elevate", "enrich", "augment", "heighten", "refine", "boost"] },
  enormous: { pos: "adjective", def: "Very large in size, quantity, or extent.", syns: ["immense", "colossal", "vast", "monumental", "gargantuan", "massive"] },
  ensure: { pos: "verb", def: "Make certain that something shall occur or be the case.", syns: ["guarantee", "assure", "secure", "warrant", "safeguard", "verify"] },
  ephemeral: { pos: "adjective", def: "Lasting for a very short time.", syns: ["fleeting", "transient", "transitory", "short-lived", "momentary", "passing"] },
  essential: { pos: "adjective", def: "Absolutely necessary; extremely important.", syns: ["indispensable", "vital", "crucial", "fundamental", "integral", "paramount"] },
  establish: { pos: "verb", def: "Set up on a firm or permanent basis; achieve permanent acceptance for.", syns: ["found", "institute", "create", "confirm", "demonstrate", "root"] },
  evaluate: { pos: "verb", def: "Form an idea of the amount, number, or value of; assess.", syns: ["assess", "appraise", "analyze", "weigh", "gauge", "judge"] },
  evidence: { pos: "noun", def: "The available body of facts or information indicating whether a belief or proposition is true.", syns: ["proof", "confirmation", "testimony", "documentation", "verification", "data"] },
  evolve: { pos: "verb", def: "Develop gradually, especially from a simple to a more complex form.", syns: ["develop", "progress", "unfold", "mature", "transform", "advance"] },
  examine: { pos: "verb", def: "Inspect someone or something in detail to determine their nature or condition.", syns: ["inspect", "scrutinize", "study", "investigate", "probe", "survey"] },
  example: { pos: "noun", def: "A thing characteristic of its kind or illustrating a general rule.", syns: ["instance", "specimen", "illustration", "prototype", "exemplar", "case"] },
  exceptional: { pos: "adjective", def: "Unusual; not typical; unusually good; outstanding.", syns: ["extraordinary", "remarkable", "outstanding", "singular", "phenomenal", "peerless"] },
  expand: { pos: "verb", def: "Become or make larger or more extensive.", syns: ["broaden", "enlarge", "extend", "amplify", "widen", "scale"] },
  explain: { pos: "verb", def: "Make an idea, situation, or problem clear to someone by describing it in detail.", syns: ["clarify", "elucidate", "expound", "interpret", "illuminate", "define"] },
  explore: { pos: "verb", def: "Travel in or through an unfamiliar area; inquire into or discuss a subject in detail.", syns: ["investigate", "delve into", "examine", "traverse", "chart", "probe"] },
  express: { pos: "verb", def: "Convey a thought or feeling in words or by gestures and conduct.", syns: ["articulate", "voice", "communicate", "convey", "utter", "manifest"] },
  facilitate: { pos: "verb", def: "Make an action or process easy or easier.", syns: ["ease", "enable", "expedite", "assist", "further", "streamline"] },
  fast: { pos: "adjective", def: "Moving or capable of moving at high speed.", syns: ["rapid", "swift", "snappy", "brisk", "nimble", "accelerated", "speedy"] },
  feature: { pos: "noun / verb", def: "A distinctive attribute or aspect of something.", syns: ["characteristic", "trait", "attribute", "hallmark", "highlight", "facet"] },
  flexible: { pos: "adjective", def: "Capable of bending easily without breaking; able to Be easily modified to respond to altered circumstances.", syns: ["adaptable", "versatile", "pliable", "supple", "agile", "accommodating"] },
  focus: { pos: "noun / verb", def: "The center of interest or activity; pay particular attention to.", syns: ["concentrate", "center", "focal point", "spotlight", "zero in", "prioritize"] },
  formulate: { pos: "verb", def: "Create or prepare methodically; express an idea in a concise or systematic way.", syns: ["devise", "frame", "articulate", "codify", "conceive", "draft"] },
  foster: { pos: "verb", def: "Encourage or promote the development of something good.", syns: ["cultivate", "nurture", "encourage", "promote", "stimulate", "support"] },
  fragile: { pos: "adjective", def: "Easily broken or damaged; delicate and vulnerable.", syns: ["delicate", "brittle", "frail", "tenuous", "vulnerable", "dainty"] },
  fundamental: { pos: "adjective", def: "Forming a necessary base or core; of central importance.", syns: ["foundational", "basic", "essential", "core", "primary", "elemental"] },
  generate: { pos: "verb", def: "Cause something to arise or come about; produce.", syns: ["produce", "create", "yield", "spawn", "induce", "spark"] },
  genuine: { pos: "adjective", def: "Truly what something is said to be; authentic and sincere.", syns: ["authentic", "sincere", "real", "unfeigned", "heartfelt", "earnest"] },
  good: { pos: "adjective", def: "Having the required qualities; of a high standard; virtuous or beneficial.", syns: ["excellent", "superb", "solid", "exceptional", "favorable", "stellar", "worthy"] },
  gradual: { pos: "adjective", def: "Taking place or progressing slowly or by degrees.", syns: ["incremental", "measured", "step-by-step", "progressive", "steady", "unhurried"] },
  great: { pos: "adjective", def: "Of an extent, amount, or intensity considerably above the normal or average.", syns: ["immense", "remarkable", "grand", "eminent", "outstanding", "magnificent"] },
  guide: { pos: "verb / noun", def: "Show or indicate the way to someone; direct or influence behavior.", syns: ["steer", "direct", "lead", "mentor", "pilot", "handbook"] },
  happy: { pos: "adjective", def: "Feeling or showing pleasure or contentment.", syns: ["joyful", "delighted", "pleased", "thrilled", "content", "elated", "cheerful"] },
  hard: { pos: "adjective", def: "Requiring a great deal of endurance or effort; solid and firm to the touch.", syns: ["challenging", "demanding", "arduous", "tough", "rigorous", "complex"] },
  harmony: { pos: "noun", def: "The combination of simultaneously sounded musical notes or elements to produce a pleasing whole.", syns: ["concord", "balance", "symmetry", "unity", "coherence", "consonance"] },
  help: { pos: "verb / noun", def: "Make it easier for someone to do something by offering aid.", syns: ["assist", "support", "aid", "facilitate", "bolster", "guide"] },
  highlight: { pos: "verb / noun", def: "Pick out and emphasize so as to draw special attention to.", syns: ["accentuate", "underscore", "spotlight", "feature", "showcase", "foreground"] },
  holistic: { pos: "adjective", def: "Characterized by comprehension of the parts of something as intimately interconnected.", syns: ["comprehensive", "integrated", "unified", "whole-system", "all-encompassing"] },
  honest: { pos: "adjective", def: "Free of deceit and untruthfulness; sincere.", syns: ["truthful", "sincere", "candid", "forthright", "upright", "genuine"] },
  hypothesis: { pos: "noun", def: "A supposition or proposed explanation made on the basis of limited evidence as a starting point for further investigation.", syns: ["theory", "proposition", "premise", "postulate", "conjecture", "thesis"] },
  idea: { pos: "noun", def: "A thought, concept, or suggestion as to a possible course of action.", syns: ["concept", "notion", "vision", "proposal", "insight", "plan"] },
  identify: { pos: "verb", def: "Establish or indicate who or what someone or something is.", syns: ["recognize", "pinpoint", "discern", "distinguish", "spot", "diagnose"] },
  illuminate: { pos: "verb", def: "Light up; help to clarify or explain a subject or matter.", syns: ["brighten", "elucidate", "clarify", "enlighten", "illustrate", "shed light on"] },
  illustrate: { pos: "verb", def: "Provide a book or text with pictures; serve as an example of.", syns: ["demonstrate", "exemplify", "depict", "clarify", "portray", "illuminate"] },
  imagine: { pos: "verb", def: "Form a mental image or concept of.", syns: ["envision", "conceive", "visualize", "picture", "dream up", "fancy"] },
  immediate: { pos: "adjective", def: "Occurring or done at once; instant.", syns: ["instant", "prompt", "direct", "swift", "instantaneous", "urgent"] },
  impact: { pos: "noun / verb", def: "A marked effect or influence.", syns: ["influence", "effect", "imprint", "repercussion", "shape", "affect"] },
  implement: { pos: "verb", def: "Put a decision, plan, agreement, or system into effect.", syns: ["execute", "enact", "apply", "carry out", "deploy", "realize"] },
  imply: { pos: "verb", def: "Strongly suggest the truth or existence of something not expressly stated.", syns: ["suggest", "hint", "intimate", "insinuate", "signal", "connote"] },
  important: { pos: "adjective", def: "Of great significance or value.", syns: ["crucial", "vital", "essential", "pivotal", "significant", "paramount", "critical"] },
  improve: { pos: "verb", def: "Make or become better.", syns: ["enhance", "refine", "upgrade", "ameliorate", "elevate", "polish"] },
  include: { pos: "verb", def: "Comprise or contain as part of a whole.", syns: ["incorporate", "encompass", "comprise", "embrace", "contain", "involve"] },
  increase: { pos: "verb / noun", def: "Become or make greater in size, amount, intensity, or degree.", syns: ["augment", "expand", "amplify", "escalate", "grow", "boost"] },
  indicate: { pos: "verb", def: "Point out; show or suggest as a sign or symptom.", syns: ["signify", "denote", "point to", "reveal", "manifest", "bespeak"] },
  inevitable: { pos: "adjective", def: "Certain to happen; unavoidable.", syns: ["unavoidable", "inescapable", "inexorable", "certain", "destined", "assured"] },
  influence: { pos: "noun / verb", def: "The capacity to have an effect on the character, development, or behavior of someone or something.", syns: ["sway", "impact", "leverage", "shape", "guide", "affect"] },
  inherent: { pos: "adjective", def: "Existing in something as a permanent, essential, or characteristic attribute.", syns: ["intrinsic", "innate", "built-in", "ingrained", "natural", "essential"] },
  initiate: { pos: "verb", def: "Cause a process or action to begin.", syns: ["launch", "commence", "instigate", "inaugurate", "pioneer", "spark"] },
  innovative: { pos: "adjective", def: "Featuring new methods; advanced and original.", syns: ["inventive", "groundbreaking", "original", "pioneering", "novel", "trailblazing"] },
  inquire: { pos: "verb", def: "Ask for information from someone; investigate.", syns: ["ask", "query", "investigate", "probe", "explore", "question"] },
  insight: { pos: "noun", def: "The capacity to gain an accurate and deep intuitive understanding of a person or thing.", syns: ["perception", "acumen", "discernment", "revelation", "comprehension", "wisdom"] },
  inspire: { pos: "verb", def: "Fill someone with the urge or ability to do or feel something creative.", syns: ["motivate", "galvanize", "encourage", "uplift", "spark", "kindle"] },
  integrate: { pos: "verb", def: "Combine one thing with another so that they become a whole.", syns: ["unify", "incorporate", "blend", "merge", "harmonize", "fuse"] },
  integrity: { pos: "noun", def: "The quality of being honest and having strong moral principles; structural wholeness.", syns: ["honesty", "rectitude", "coherence", "soundness", "unity", "honor"] },
  intense: { pos: "adjective", def: "Of extreme force, degree, or strength.", syns: ["fierce", "profound", "acute", "fervent", "vivid", "concentrated"] },
  interpret: { pos: "verb", def: "Explain the meaning of information, words, or actions.", syns: ["construe", "decipher", "explain", "translate", "elucidate", "read"] },
  intricate: { pos: "adjective", def: "Very complicated or detailed.", syns: ["complex", "elaborate", "labyrinthine", "nuanced", "ornate", "sophisticated"] },
  introduce: { pos: "verb", def: "Bring something into use or operation for the first time; present to an audience.", syns: ["present", "launch", "unveil", "inaugurate", "preface", "initiate"] },
  intuitive: { pos: "adjective", def: "Using or based on what one feels to be true even without conscious reasoning; easy to understand.", syns: ["instinctive", "natural", "effortless", "self-explanatory", "innate", "visceral"] },
  investigate: { pos: "verb", def: "Carry out a systematic or formal inquiry to discover and examine the facts.", syns: ["examine", "explore", "probe", "research", "scrutinize", "inquire"] },
  juxtapose: { pos: "verb", def: "Place or deal with close together for contrasting effect.", syns: ["contrast", "compare", "pair", "set side by side", "counterpose"] },
  keen: { pos: "adjective", def: "Having or showing eagerness or enthusiasm; sharp or penetrating.", syns: ["eager", "acute", "astute", "incisive", "avid", "perceptive"] },
  know: { pos: "verb", def: "Be aware of through observation, inquiry, or information.", syns: ["comprehend", "understand", "recognize", "perceive", "grasp", "fathom"] },
  knowledge: { pos: "noun", def: "Facts, information, and skills acquired by a person through experience or education.", syns: ["erudition", "wisdom", "understanding", "mastery", "lore", "expertise"] },
  language: { pos: "noun", def: "The method of human communication, either spoken or written, consisting of the use of words in a structured way.", syns: ["speech", "vernacular", "idiom", "lexicon", "tongue", "discourse"] },
  large: { pos: "adjective", def: "Of considerable or relatively great size, extent, or capacity.", syns: ["substantial", "vast", "expansive", "spacious", "ample", "immense"] },
  lead: { pos: "verb / noun", def: "Cause a person or group to go with one by guiding or showing the way.", syns: ["guide", "direct", "spearhead", "steer", "command", "pioneer"] },
  light: { pos: "noun / adjective", def: "The natural agent that stimulates sight and makes things visible; of little weight.", syns: ["illumination", "radiance", "glow", "weightless", "airy", "luminous"] },
  lively: { pos: "adjective", def: "Full of life and energy; active and outgoing.", syns: ["vibrant", "spirited", "animated", "vivacious", "brisk", "dynamic"] },
  logical: { pos: "adjective", def: "Of or according to the rules of logic or formal argument; Characterized by clear, sound reasoning.", syns: ["rational", "coherent", "sound", "reasoned", "methodical", "cogent"] },
  lucid: { pos: "adjective", def: "Expressed clearly; easy to understand.", syns: ["clear", "crystalline", "cogent", "coherent", "articulate", "transparent"] },
  luminous: { pos: "adjective", def: "Full of or shedding light; bright or shining, especially in the dark.", syns: ["radiant", "glowing", "brilliant", "incandescent", "shining", "lustrous"] },
  maintain: { pos: "verb", def: "Cause or enable a condition or state of affairs to continue.", syns: ["preserve", "sustain", "uphold", "keep", "conserve", "perpetuate"] },
  make: { pos: "verb", def: "Form, construct, or cause something to exist.", syns: ["create", "build", "craft", "produce", "forge", "construct", "generate"] },
  manifest: { pos: "verb / adjective", def: "Display or show a quality or feeling by one's acts or appearance; clear or obvious to the eye or mind.", syns: ["exhibit", "reveal", "embody", "evident", "apparent", "unmistakable"] },
  meaningful: { pos: "adjective", def: "Having a serious, important, or useful quality or purpose.", syns: ["significant", "profound", "purposeful", "consequential", "weighty", "expressive"] },
  measure: { pos: "verb / noun", def: "Ascertain the size, amount, or degree of something by using an instrument or metric.", syns: ["gauge", "quantify", "assess", "calibrate", "benchmark", "criterion"] },
  medieval: { pos: "adjective", def: "Relating to the Middle Ages (roughly the 5th to the 15th century) or its art, architecture, and manuscripts.", syns: ["Middle Ages", "feudal", "gothic", "chivalric", "antiquarian", "archaic"] },
  melancholy: { pos: "noun / adjective", def: "A feeling of pensive sadness, typically with no obvious cause.", syns: ["wistful", "somber", "pensive", "mournful", "elegiac", "sorrowful"] },
  method: { pos: "noun", def: "A particular form of procedure for accomplishing or approaching something.", syns: ["procedure", "technique", "system", "approach", "methodology", "protocol"] },
  meticulous: { pos: "adjective", def: "Showing great attention to detail; very careful and precise.", syns: ["thorough", "scrupulous", "exacting", "fastidious", "precise", "painstaking"] },
  minimal: { pos: "adjective", def: "Of a minimum amount, quantity, or degree; pared down to essentials.", syns: ["austere", "spare", "modest", "streamlined", "sleek", "essential"] },
  mitigate: { pos: "verb", def: "Make less severe, serious, or painful.", syns: ["alleviate", "lessen", "temper", "soften", "cushion", "assuage"] },
  modern: { pos: "adjective", def: "Relating to the present or recent times as opposed to the remote past.", syns: ["contemporary", "current", "present-day", "cutting-edge", "progressive", "novel"] },
  modify: { pos: "verb", def: "Make partial or minor changes to something, typically so as to improve it.", syns: ["alter", "adjust", "adapt", "tailor", "revise", "tweak"] },
  mysterious: { pos: "adjective", def: "Difficult or impossible to understand, explain, or identify.", syns: ["enigmatic", "arcane", "cryptic", "inscrutable", "uncanny", "secretive"] },
  narrative: { pos: "noun", def: "A spoken or written account of connected events; a story.", syns: ["story", "chronicle", "account", "tale", "recital", "arc"] },
  natural: { pos: "adjective", def: "Existing in or caused by nature; not made or caused by humankind; effortless.", syns: ["organic", "innate", "inherent", "unforced", "spontaneous", "authentic"] },
  necessary: { pos: "adjective", def: "Required to be done, achieved, or present; needed; essential.", syns: ["essential", "indispensable", "requisite", "imperative", "mandatory", "vital"] },
  new: { pos: "adjective", def: "Produced, introduced, or discovered recently or now for the first time.", syns: ["modern", "fresh", "novel", "contemporary", "cutting-edge", "original"] },
  notable: { pos: "adjective", def: "Worthy of attention or notice; remarkable.", syns: ["remarkable", "prominent", "distinguished", "striking", "noteworthy", "salient"] },
  novel: { pos: "noun / adjective", def: "A fictitious prose narrative of book length; interestingly new or unusual.", syns: ["original", "fresh", "innovative", "unprecedented", "inventive", "book"] },
  nuance: { pos: "noun", def: "A subtle difference in or shade of meaning, expression, or sound.", syns: ["subtlety", "gradation", "shade", "inflection", "refinement", "distinction"] },
  objective: { pos: "adjective / noun", def: "Not influenced by personal feelings or opinions in considering and representing facts; a goal.", syns: ["impartial", "unbiased", "dispassionate", "neutral", "goal", "aim"] },
  observe: { pos: "verb", def: "Notice or perceive something and register it as being significant.", syns: ["witness", "note", "perceive", "watch", "discern", "monitor"] },
  obtain: { pos: "verb", def: "Get, acquire, or secure something.", syns: ["acquire", "procure", "secure", "gain", "attain", "fetch"] },
  obvious: { pos: "adjective", def: "Easily perceived or understood; clear, self-evident, or apparent.", syns: ["evident", "apparent", "unmistakable", "manifest", "clear", "patent"] },
  old: { pos: "adjective", def: "Having lived for a long time; belonging to the past.", syns: ["ancient", "vintage", "antique", "venerable", "aged", "historic"] },
  optimal: { pos: "adjective", def: "Best or most favorable; optimum.", syns: ["ideal", "peak", "prime", "best", "superlative", "exemplary"] },
  organize: { pos: "verb", def: "Arrange into a structured whole; order.", syns: ["structure", "arrange", "coordinate", "systematize", "marshal", "catalog"] },
  original: { pos: "adjective", def: "Present or existing from the beginning; created directly and personally by a particular artist.", syns: ["authentic", "pioneering", "inventive", "novel", "primary", "archetypal"] },
  overcome: { pos: "verb", def: "Succeed in dealing with a problem or difficulty.", syns: ["surmount", "conquer", "prevail over", "vanquish", "master", "transcend"] },
  paradigm: { pos: "noun", def: "A typical example or pattern of something; a model or philosophical framework.", syns: ["model", "archetype", "framework", "exemplar", "standard", "pattern"] },
  parchment: { pos: "noun", def: "A stiff, flat, archival writing surface historically prepared from animal skin or heavy rag stock for medieval manuscripts.", syns: ["vellum", "manuscript", "scroll", "folio", "papyrus", "rag paper"] },
  perceive: { pos: "verb", def: "Become aware or conscious of something; come to realize or understand.", syns: ["discern", "recognize", "apprehend", "sense", "grasp", "observe"] },
  permanent: { pos: "adjective", def: "Lasting or intended to last or remain unchanged indefinitely.", syns: ["enduring", "lasting", "perpetual", "abiding", "indelible", "immutable"] },
  perspective: { pos: "noun", def: "A particular attitude toward or way of regarding something; a point of view.", syns: ["viewpoint", "vantage", "standpoint", "outlook", "angle", "lens"] },
  persuade: { pos: "verb", def: "Cause someone to do something through reasoning or argument.", syns: ["convince", "sway", "induce", "influence", "win over", "coax"] },
  phenomenon: { pos: "noun", def: "A fact or situation that is observed to exist or happen, especially one whose cause or explanation is in question.", syns: ["occurrence", "event", "manifestation", "marvel", "wonder", "spectacle"] },
  pivotal: { pos: "adjective", def: "Of crucial importance in relation to the development or success of something else.", syns: ["crucial", "critical", "central", "decisive", "vital", "landmark"] },
  plausible: { pos: "adjective", def: "Seeming reasonable or probable; credible.", syns: ["credible", "believable", "reasonable", "tenable", "conceivable", "likely"] },
  poignant: { pos: "adjective", def: "Evoking a keen sense of sadness, regret, or emotional resonance.", syns: ["moving", "touching", "affecting", "bittersweet", "evocative", "stirring"] },
  potent: { pos: "adjective", def: "Having great power, influence, or effect.", syns: ["powerful", "formidable", "forceful", "compelling", "vigorous", "mighty"] },
  practical: { pos: "adjective", def: "Of or concerned with the actual doing or use of something rather than with theory and ideas.", syns: ["pragmatic", "functional", "applied", "realistic", "workable", "serviceable"] },
  pragmatic: { pos: "adjective", def: "Dealing with things sensibly and realistically in a way that is based on practical rather than theoretical considerations.", syns: ["practical", "realistic", "matter-of-fact", "sensible", "grounded", "rational"] },
  precise: { pos: "adjective", def: "Marked by exactness and accuracy of expression or detail.", syns: ["exact", "accurate", "rigorous", "meticulous", "pinpoint", "surgical"] },
  predict: { pos: "verb", def: "Say or estimate that a specified thing will happen in the future or will be a consequence of something.", syns: ["forecast", "foretell", "project", "anticipate", "prophesy", "envision"] },
  preserve: { pos: "verb", def: "Maintain something in its original or existing state.", syns: ["conserve", "safeguard", "protect", "uphold", "sustain", "perpetuate"] },
  primary: { pos: "adjective", def: "Of chief importance; principal; earliest in time or order.", syns: ["principal", "chief", "foremost", "paramount", "prime", "cardinal"] },
  principle: { pos: "noun", def: "A fundamental truth or proposition that serves as the foundation for a system of belief or behavior.", syns: ["tenet", "axiom", "doctrine", "precept", "canon", "maxim"] },
  pristine: { pos: "adjective", def: "In its original condition; unspoiled; clean and fresh as if new.", syns: ["immaculate", "unblemished", "spotless", "untouched", "pure", "mint"] },
  problem: { pos: "noun", def: "A matter or situation regarded as unwelcome or harmful and needing to be dealt with.", syns: ["issue", "challenge", "obstacle", "dilemma", "setback", "complication"] },
  profound: { pos: "adjective", def: "Very great or intense; having or showing great knowledge or insight.", syns: ["deep", "penetrating", "far-reaching", "philosophical", "weighty", "sagacious"] },
  prominent: { pos: "adjective", def: "Important; famous; projecting from something; conspicuous.", syns: ["eminent", "notable", "conspicuous", "salient", "distinguished", "leading"] },
  promote: { pos: "verb", def: "Further the progress of something, especially a cause, venture, or aim.", syns: ["foster", "advance", "encourage", "champion", "boost", "elevate"] },
  propose: { pos: "verb", def: "Put forward an idea or plan for consideration or discussion by others.", syns: ["suggest", "submit", "propound", "present", "advance", "recommend"] },
  provide: { pos: "verb", def: "Make available for use; supply.", syns: ["supply", "furnish", "deliver", "equip", "yield", "afford"] },
  pursue: { pos: "verb", def: "Follow or chase; seek to attain or accomplish a goal over a long period.", syns: ["seek", "strive for", "follow", "prosecute", "chase", "aspire to"] },
  quality: { pos: "noun", def: "The standard of something as measured against other things of a similar kind; a distinctive attribute.", syns: ["caliber", "excellence", "craftsmanship", "grade", "trait", "merit"] },
  quick: { pos: "adjective", def: "Moving fast or doing something in a short time.", syns: ["swift", "rapid", "prompt", "brisk", "fleet", "expeditious"] },
  quiet: { pos: "adjective", def: "Making little or no noise; carried out discreetly, Gently, or calmly.", syns: ["hushed", "tranquil", "silent", "muted", "serene", "still"] },
  radical: { pos: "adjective", def: "Relating to or affecting the fundamental nature of something; far-reaching or thorough.", syns: ["sweeping", "profound", "revolutionary", "fundamental", "drastic", "root-and-branch"] },
  rare: { pos: "adjective", def: "Not occurring very often; unusually good or remarkable.", syns: ["scarce", "uncommon", "singular", "infrequent", "exceptional", "precious"] },
  rational: { pos: "adjective", def: "Based on or in accordance with reason or logic.", syns: ["logical", "reasonable", "lucid", "sound", "judicious", "coherent"] },
  realize: { pos: "verb", def: "Become fully aware of something as a fact; cause to happen.", syns: ["recognize", "comprehend", "actualize", "fulfill", "achieve", "grasp"] },
  refine: { pos: "verb", def: "Remove impurities or unwanted elements from; improve by making small changes.", syns: ["polish", "hone", "perfect", "distill", "cultivate", "streamline"] },
  reflect: { pos: "verb", def: "Throw back heat, light, or sound; think deeply or carefully about.", syns: ["mirror", "manifest", "ponder", "contemplate", "meditate", "echo"] },
  relevant: { pos: "adjective", def: "Closely connected or appropriate to what is being done or considered.", syns: ["pertinent", "applicable", "germane", "material", "apropos", "fitting"] },
  reliable: { pos: "adjective", def: "Consistently good in quality or performance; able to be trusted.", syns: ["dependable", "trustworthy", "steadfast", "sound", "rock-solid", "proven"] },
  remarkable: { pos: "adjective", def: "Worthy of attention; striking.", syns: ["extraordinary", "notable", "striking", "exceptional", "singular", "astonishing"] },
  require: { pos: "verb", def: "Need for a particular purpose; depend on for success.", syns: ["necessitate", "demand", "entail", "call for", "mandate", "need"] },
  resilient: { pos: "adjective", def: "Able to withstand or recover quickly from difficult conditions.", syns: ["hardy", "adaptable", "buoyant", "tenacious", "durable", "unyielding"] },
  resolve: { pos: "verb / noun", def: "Settle or find a solution to a problem; firm determination to do something.", syns: ["settle", "solve", "reconcile", "determination", "fortitude", "decide"] },
  reveal: { pos: "verb", def: "Make previously unknown or secret information known to others.", syns: ["disclose", "unveil", "uncover", "expose", "divulge", "manifest"] },
  rigorous: { pos: "adjective", def: "Extremely thorough, exhaustive, or accurate.", syns: ["strict", "exacting", "meticulous", "stringent", "thorough", "scrupulous"] },
  robust: { pos: "adjective", def: "Strong and healthy; vigorous; able to withstand or overcome adverse conditions.", syns: ["sturdy", "resilient", "hardy", "vigorous", "staunch", "sound"] },
  sad: { pos: "adjective", def: "Feeling or showing sorrow; unhappy.", syns: ["sorrowful", "melancholy", "dejected", "downcast", "somber", "gloomy"] },
  serene: { pos: "adjective", def: "Calm, peaceful, and untroubled; tranquil.", syns: ["tranquil", "placid", "untroubled", "halcyon", "peaceful", "composed"] },
  show: { pos: "verb", def: "Allow or cause something to be visible or understood.", syns: ["demonstrate", "display", "reveal", "illustrate", "exhibit", "present"] },
  significant: { pos: "adjective", def: "Sufficiently great or important to be worthy of attention; noteworthy.", syns: ["notable", "meaningful", "consequential", "substantial", "pivotal", "weighty"] },
  simple: { pos: "adjective", def: "Easily understood or done; presenting no difficulty; plain and unadorned.", syns: ["uncomplicated", "clear", "effortless", "unadorned", "minimal", "lucid"] },
  slow: { pos: "adjective", def: "Moving or operating at a low speed.", syns: ["sluggish", "gradual", "unhurried", "leisurely", "deliberate", "measured"] },
  small: { pos: "adjective", def: "Of a size that is less than normal or usual.", syns: ["compact", "modest", "slight", "petite", "miniature", "minute", "minimal"] },
  smart: { pos: "adjective", def: "Having or showing a quick-witted intelligence.", syns: ["sharp", "clever", "bright", "astute", "brilliant", "savvy", "ingenious"] },
  sophisticated: { pos: "adjective", def: "Developed to a high degree of complexity; refined and worldly.", syns: ["refined", "cultivated", "complex", "advanced", "cosmopolitan", "nuanced"] },
  specific: { pos: "adjective", def: "Clearly defined or identified; precise and exact.", syns: ["particular", "precise", "definite", "explicit", "exact", "distinct"] },
  start: { pos: "verb", def: "Come into being; begin or embark from a point.", syns: ["begin", "launch", "initiate", "commence", "kick off", "embark"] },
  strong: { pos: "adjective", def: "Having the power to move heavy weights or perform demanding tasks; forceful and convincing.", syns: ["powerful", "potent", "robust", "compelling", "resilient", "formidable"] },
  structure: { pos: "noun / verb", def: "The arrangement of and relations between the parts or elements of something complex.", syns: ["architecture", "framework", "anatomy", "organization", "scaffold", "form"] },
  subtle: { pos: "adjective", def: "So delicate or precise as to be difficult to analyze or describe.", syns: ["nuanced", "understated", "delicate", "faint", "refined", "elusive"] },
  succeed: { pos: "verb", def: "Achieve the desired aim or result.", syns: ["triumph", "prevail", "flourish", "thrive", "prosper", "attain"] },
  sufficient: { pos: "adjective", def: "Enough; adequate.", syns: ["adequate", "ample", "enough", "satisfactory", "abundant"] },
  suggest: { pos: "verb", def: "Put forward for consideration; evoke or imply.", syns: ["propose", "recommend", "advise", "imply", "intimate", "hint"] },
  support: { pos: "verb / noun", def: "Bear all or part of the weight of; give assistance, encouragement, or approval to.", syns: ["bolster", "uphold", "sustain", "reinforce", "champion", "aid"] },
  sustain: { pos: "verb", def: "Strengthen or support physically or mentally; cause to continue for an extended period.", syns: ["maintain", "preserve", "uphold", "nourish", "perpetuate", "prolong"] },
  synthesize: { pos: "verb", def: "Combine a number of things into a coherent whole.", syns: ["integrate", "unify", "blend", "amalgamate", "distill", "fuse"] },
  tenacious: { pos: "adjective", def: "Tending to keep a firm hold of something; clinging or adhering closely; persistent.", syns: ["persistent", "resolute", "steadfast", "dogged", "unyielding", "determined"] },
  theory: { pos: "noun", def: "A supposition or a system of ideas intended to explain something.", syns: ["hypothesis", "framework", "model", "doctrine", "postulate", "thesis"] },
  thorough: { pos: "adjective", def: "Complete with regard to every detail; not superficial or partial.", syns: ["exhaustive", "comprehensive", "meticulous", "rigorous", "in-depth", "scrupulous"] },
  think: { pos: "verb", def: "Direct one's mind toward someone or something; consider.", syns: ["consider", "believe", "contemplate", "reflect", "reckon", "deem"] },
  transform: { pos: "verb", def: "Make a thorough or dramatic change in the form, appearance, or character of.", syns: ["metamorphose", "transmute", "revolutionize", "convert", "reshape", "transfigure"] },
  transparent: { pos: "adjective", def: "Allowing light to pass through so that objects behind can be distinctly seen; open and candid.", syns: ["pellucid", "clear", "crystalline", "candid", "forthright", "limpid"] },
  ubiquitous: { pos: "adjective", def: "Present, appearing, or found everywhere.", syns: ["omnipresent", "pervasive", "universal", "all-pervading", "widespread"] },
  understand: { pos: "verb", def: "Perceive the intended meaning of words, a language, or a speaker.", syns: ["comprehend", "grasp", "fathom", "apprehend", "discern", "assimilate"] },
  unique: { pos: "adjective", def: "Being the only one of its kind; unlike anything else.", syns: ["singular", "distinctive", "unparalleled", "incomparable", "one-of-a-kind", "sui generis"] },
  use: { pos: "verb", def: "Take, hold, or deploy as a means of accomplishing a purpose.", syns: ["utilize", "employ", "apply", "leverage", "adopt", "exercise"] },
  valid: { pos: "adjective", def: "Having a sound basis in logic or fact; reasonable or cogent.", syns: ["sound", "cogent", "legitimate", "well-founded", "credible", "authentic"] },
  value: { pos: "noun / verb", def: "The regard that something is held to deserve; the importance, worth, or usefulness of something.", syns: ["worth", "merit", "significance", "cherish", "prize", "treasure"] },
  vary: { pos: "verb", def: "Differ in size, amount, degree, or nature from something else of the same general class.", syns: ["differ", "fluctuate", "diverge", "alternate", "modulate", "shift"] },
  verify: { pos: "verb", def: "Make sure or demonstrate that something is true, accurate, or justified.", syns: ["confirm", "validate", "substantiate", "corroborate", "authenticate", "prove"] },
  versatile: { pos: "adjective", def: "Able to adapt or be adapted to many different functions or activities.", syns: ["adaptable", "multifaceted", "flexible", "all-around", "resourceful", "protean"] },
  vibrant: { pos: "adjective", def: "Full of energy and enthusiasm; bright and striking.", syns: ["vivid", "lively", "spirited", "resonant", "radiant", "dynamic"] },
  vivid: { pos: "adjective", def: "Producing powerful feelings or strong, clear images in the mind.", syns: ["graphic", "evocative", "striking", "bright", "lifelike", "crystalline"] },
  vital: { pos: "adjective", def: "Absolutely necessary or important; essential.", syns: ["essential", "crucial", "indispensable", "pivotal", "critical", "paramount"] },
  vividly: { pos: "adverb", def: "In a way that produces powerful feelings or strong, clear images in the mind.", syns: ["distinctly", "strikingly", "brightly", "graphically", "memorably"] },
  wise: { pos: "adjective", def: "Having or showing experience, knowledge, and good judgment.", syns: ["sagacious", "judicious", "prudent", "astute", "discerning", "sage"] },
  write: { pos: "verb", def: "Mark letters, words, or symbols on a surface or document; compose a text or work.", syns: ["compose", "author", "draft", "pen", "inscribe", "record", "chronicle"] },
  zeal: { pos: "noun", def: "Great energy or enthusiasm in pursuit of a cause or an objective.", syns: ["fervor", "passion", "ardor", "gusto", "devotion", "enthusiasm"] },
};

const PREFIX_MEANINGS: [string, string][] = [
  ["counter", "contrary or in opposition to"],
  ["inter", "between, among, or mutually"],
  ["trans", "across, beyond, or through"],
  ["super", "above, over, or beyond"],
  ["under", "beneath or insufficiently"],
  ["hyper", "over, above, or excessive"],
  ["micro", "very small or minute"],
  ["multi", "many or multiple"],
  ["pseudo", "false or imitating"],
  ["ultra", "beyond or to an extreme degree"],
  ["anti", "against or opposed to"],
  ["auto", "self or spontaneous"],
  ["over", "excessively or above"],
  ["post", "after or subsequent to"],
  ["semi", "half or partially"],
  ["fore", "before or in front of"],
  ["non", "not or absence of"],
  ["pre", "before or prior to"],
  ["sub", "under, below, or secondary"],
  ["dis", "not, apart, or reversal of"],
  ["mis", "wrongly or badly"],
  ["out", "surpassing or external"],
  ["pro", "forward or in favor of"],
  ["co", "together or jointly"],
  ["de", "down, off, or reversal of"],
  ["ex", "out of or former"],
  ["in", "not or into"],
  ["im", "not or into"],
  ["ir", "not"],
  ["il", "not"],
  ["re", "again or back"],
  ["un", "not or reversal of"],
];

const SUFFIX_MEANINGS: [string, string, string][] = [
  ["ification", "noun", "the action or process of making into"],
  ["ization", "noun", "the action or process of making or becoming"],
  ["fulness", "noun", "the state or quality of being full of"],
  ["lessness", "noun", "the state of being without"],
  ["ability", "noun", "the capacity or quality of being able to"],
  ["ibility", "noun", "the capacity or quality of being able to"],
  ["ational", "adjective", "relating to the action or process of"],
  ["iously", "adverb", "in a manner characterized by"],
  ["ousness", "noun", "the state or quality of being"],
  ["atively", "adverb", "in a manner tending to"],
  ["lessly", "adverb", "without or lacking"],
  ["fully", "adverb", "in a manner full of"],
  ["ation", "noun", "an action, process, or result of"],
  ["ition", "noun", "the action or state of"],
  ["ingly", "adverb", "in an ongoing or active manner"],
  ["ment", "noun", "the action, result, or means of"],
  ["ness", "noun", "the state, condition, or quality of being"],
  ["able", "adjective", "capable of or worthy of being"],
  ["ible", "adjective", "capable of or susceptible to being"],
  ["ance", "noun", "the state, quality, or process of"],
  ["ence", "noun", "the state, quality, or action of"],
  ["ship", "noun", "the status, office, or art of"],
  ["hood", "noun", "the condition, period, or group of"],
  ["less", "adjective", "without or free from"],
  ["ious", "adjective", "characterized by or full of"],
  ["ward", "adverb / adjective", "in the direction of"],
  ["wise", "adverb", "in the manner or direction of"],
  ["tion", "noun", "the act, state, or result of"],
  ["sion", "noun", "the state or process of"],
  ["ity", "noun", "the quality or condition of"],
  ["ist", "noun", "a practitioner or specialist in"],
  ["ism", "noun", "a practice, system, or philosophy of"],
  ["ful", "adjective", "full of or characterized by"],
  ["ous", "adjective", "possessing the quality of"],
  ["ive", "adjective", "tending to or having the nature of"],
  ["ize", "verb", "to make, cause to become, or treat with"],
  ["ify", "verb", "to make or form into"],
  ["ate", "verb / adjective", "to cause to become or characterized by"],
  ["ing", "verb (participle) / gerund", "ongoing action or process of"],
  ["ed", "verb (past) / adjective", "completed action or having the characteristic of"],
  ["ly", "adverb / adjective", "in the manner of"],
  ["er", "noun / comparative", "one who performs, or to a greater degree"],
  ["or", "noun", "one who performs the action of"],
  ["al", "adjective / noun", "relating to or the act of"],
  ["ic", "adjective", "pertaining to or having the character of"],
  ["es", "plural noun / present verb", "plural or third-person singular form of"],
  ["s", "plural noun / present verb", "plural or third-person singular form of"],
];

const CLASSICAL_ROOTS: [RegExp, string, string][] = [
  [/scrib|script/i, "scrib / script (Latin)", "to write or record"],
  [/dict/i, "dict (Latin)", "to speak or declare"],
  [/spect|spic/i, "spect (Latin)", "to look, observe, or see"],
  [/port/i, "port (Latin)", "to carry or bear"],
  [/form/i, "form (Latin)", "shape, structure, or mold"],
  [/struct/i, "struct (Latin)", "to build or assemble"],
  [/tract/i, "tract (Latin)", "to draw, pull, or drag"],
  [/ject/i, "ject (Latin)", "to throw or cast"],
  [/cred/i, "cred (Latin)", "to believe or trust"],
  [/duc|duct/i, "duc / duct (Latin)", "to lead or guide"],
  [/graph|gram/i, "graph / gram (Greek)", "writing, drawing, or record"],
  [/log|logy/i, "logos (Greek)", "word, reason, or study of"],
  [/phon/i, "phon (Greek)", "sound or voice"],
  [/phot|phos/i, "phot (Greek)", "light"],
  [/tele/i, "tele (Greek)", "far off or distant"],
  [/vid|vis/i, "vid / vis (Latin)", "to see or envision"],
  [/voc|vok/i, "voc / vok (Latin)", "voice or call"],
  [/chron/i, "chron (Greek)", "time"],
  [/morph/i, "morph (Greek)", "form or shape"],
  [/path/i, "path (Greek)", "feeling, perception, or suffering"],
  [/phil/i, "phil (Greek)", "love or affinity for"],
  [/psych/i, "psych (Greek)", "mind, spirit, or soul"],
  [/bio/i, "bio (Greek)", "life"],
  [/geo/i, "geo (Greek)", "earth"],
  [/therm/i, "therm (Greek)", "heat"],
  [/ben|bon/i, "bene / bon (Latin)", "good or well"],
  [/mal/i, "mal (Latin)", "bad or ill"],
  [/equ/i, "equ (Latin)", "equal or even"],
  [/magn/i, "magn (Latin)", "great or large"],
  [/min/i, "min (Latin)", "small or less"],
  [/nov/i, "nov (Latin)", "new"],
  [/omni/i, "omni (Latin)", "all"],
  [/pend|pens/i, "pend / pens (Latin)", "to hang, weigh, or consider"],
  [/rupt/i, "rupt (Latin)", "to break or burst"],
  [/scien/i, "scien (Latin)", "to know"],
  [/sect|seg/i, "sect (Latin)", "to cut or divide"],
  [/sent|sens/i, "sent / sens (Latin)", "to feel or perceive"],
  [/soph/i, "soph (Greek)", "wise or wisdom"],
  [/temp/i, "temp (Latin)", "time or season"],
  [/ten|tain|tin/i, "ten / tain (Latin)", "to hold or keep"],
  [/terr/i, "terr (Latin)", "earth or land"],
  [/vac/i, "vac (Latin)", "empty or free"],
  [/ver/i, "ver (Latin)", "truth"],
  [/vit|viv/i, "vit / viv (Latin)", "life or alive"],
  [/vol/i, "vol (Latin)", "will or wish"],
];

const CUSTOM_OFFLINE_DICT_KEY = "typo.customOfflineDefs.v1";

function loadCustomOfflineDefs(): Record<string, OfflineEntry> {
  try {
    const raw = localStorage.getItem(CUSTOM_OFFLINE_DICT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function saveCustomOfflineDef(word: string, entry: OfflineEntry): void {
  const map = loadCustomOfflineDefs();
  map[word.toLowerCase()] = entry;
  try {
    localStorage.setItem(CUSTOM_OFFLINE_DICT_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** Look up a word or its morphological stem in our offline lexicon and build a complete offline analysis. */
function analyzeWordOffline(rawWord: string): {
  directEntry: OfflineEntry | null;
  stemWord: string | null;
  stemEntry: OfflineEntry | null;
  inferredPos: string;
  morphologyDef: string;
  roots: string[];
  syns: string[];
} {
  const q = rawWord.toLowerCase().trim();
  const customMap = loadCustomOfflineDefs();
  const lookupLex = (w: string): OfflineEntry | null =>
    customMap[w] ||
    OFFLINE_LEXICON[w] ||
    EXTENDED_OFFLINE_LEXICON[w] ||
    OFFLINE_LEXICON[w.charAt(0).toUpperCase() + w.slice(1)] ||
    EXTENDED_OFFLINE_LEXICON[w.charAt(0).toUpperCase() + w.slice(1)] ||
    null;

  const direct = lookupLex(q);
  const irregular = IRREGULAR_LEMMAS[q];
  let inferredPos = direct?.pos || "noun / verb";
  let prefixFound: [string, string] | null = null;
  let suffixFound: [string, string, string] | null = null;
  let stemCandidate = q;

  for (const [suf, pos, meaning] of SUFFIX_MEANINGS) {
    if (q.length > suf.length + 2 && q.endsWith(suf)) {
      suffixFound = [suf, pos, meaning];
      inferredPos = direct?.pos || pos;
      stemCandidate = q.slice(0, q.length - suf.length);
      break;
    }
  }

  for (const [pre, meaning] of PREFIX_MEANINGS) {
    if (q.length > pre.length + 3 && q.startsWith(pre)) {
      prefixFound = [pre, meaning];
      if (stemCandidate.startsWith(pre) && stemCandidate.length > pre.length + 2) {
        stemCandidate = stemCandidate.slice(pre.length);
      }
      break;
    }
  }

  // Try candidate stems (e.g. "creating" -> "create", "happily" -> "happy", "wolves" -> "wolf", "running" -> "run")
  const stemVariants = [
    irregular?.base ?? "",
    stemCandidate,
    stemCandidate + "e",
    stemCandidate.endsWith("i") ? stemCandidate.slice(0, -1) + "y" : "",
    stemCandidate.length > 2 && stemCandidate[stemCandidate.length - 1] === stemCandidate[stemCandidate.length - 2]
      ? stemCandidate.slice(0, -1)
      : "",
    q.replace(/ves$/, "f"),
    q.replace(/ves$/, "fe"),
    q.replace(/ies$/, "y"),
    q.replace(/ied$/, "y"),
    q.replace(/ier$/, "y"),
    q.replace(/iest$/, "y"),
    q.replace(/ily$/, "y"),
    q.replace(/(?:ing|ed|ly|ness|ment|tion|sion|able|ible|er|est|es|s)$/, ""),
    q.replace(/(?:ing|ed|er|est)$/, "e"),
  ].filter(Boolean);

  let stemWord: string | null = null;
  let stemEntry: OfflineEntry | null = null;
  if (!direct) {
    for (const v of stemVariants) {
      const hit = lookupLex(v);
      if (hit) {
        stemWord = v;
        stemEntry = hit;
        if (!direct) inferredPos = hit.pos;
        break;
      }
    }
  }

  const roots: string[] = [];
  for (const [re, rootName, rootMeaning] of CLASSICAL_ROOTS) {
    if (re.test(q)) {
      roots.push(`${rootName}: "${rootMeaning}"`);
    }
  }

  const parts: string[] = [];
  if (prefixFound) {
    parts.push(`Prefix "${prefixFound[0]}-" (${prefixFound[1]})`);
  }
  if (stemWord && stemEntry) {
    parts.push(`Base word "${stemWord}" (${stemEntry.def})`);
  } else if (stemCandidate && stemCandidate !== q) {
    parts.push(`Base stem "${stemCandidate}"`);
  }
  if (suffixFound) {
    parts.push(`Suffix "-${suffixFound[0]}" (${suffixFound[2]} · ${suffixFound[1]})`);
  }

  let morphologyDef = "";
  if (direct) {
    morphologyDef = direct.def;
  } else if (irregular && stemEntry) {
    morphologyDef = `${irregular.relation} "${irregular.base}" (${stemEntry.pos}) — ${stemEntry.def}`;
  } else if (stemEntry && stemWord) {
    const prefixNote = prefixFound ? `With prefix "${prefixFound[0]}-" (${prefixFound[1]}): ` : "";
    const suffixNote = suffixFound ? ` (${suffixFound[2]} "${stemWord}")` : ` (from "${stemWord}")`;
    morphologyDef = `${prefixNote}${stemEntry.def}${suffixNote}`;
  } else if (roots.length > 0 && parts.length > 0) {
    morphologyDef = `${parts.join(" + ")}. Classical root: ${roots[0]}.`;
  } else if (roots.length > 0) {
    morphologyDef = `Derived from ${roots[0]}.`;
  } else if (parts.length > 0) {
    morphologyDef = parts.join(" + ") + ".";
  } else {
    morphologyDef = `Verified English ${inferredPos} ("${q}"). Click 'Save Offline Def' above to customize or add a personal note for this term.`;
  }

  const syns = Array.from(new Set([...(direct?.syns ?? []), ...(stemEntry?.syns ?? [])]));

  return {
    directEntry: direct,
    stemWord,
    stemEntry,
    inferredPos,
    morphologyDef,
    roots,
    syns,
  };
}

registerDefineHandler((w) => {
  if (state.editor) openDictionary(state.editor, w);
});

export function getWordAtSelection(editor: Editor): { word: string; from: number; to: number } | null {
  const { from, to, empty } = editor.state.selection;
  if (!empty) {
    const selected = editor.state.doc.textBetween(from, to, " ").trim();
    if (selected && /^[a-zA-Z'-]+$/.test(selected)) {
      return { word: selected, from, to };
    }
  }
  const $pos = editor.state.doc.resolve(from);
  if (!$pos.parent.isTextblock) return null;
  const text = $pos.parent.textContent;
  const offset = $pos.parentOffset;
  const blockStart = $pos.start();

  let l = offset;
  let r = offset;
  while (l > 0 && /[a-zA-Z'-]/.test(text[l - 1])) l--;
  while (r < text.length && /[a-zA-Z'-]/.test(text[r])) r++;
  const word = text.slice(l, r).replace(/^'+|'+$/g, "");
  if (!word) return null;
  return { word, from: blockStart + l, to: blockStart + r };
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const cleaned = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const matches = cleaned.match(/[aeiouy]{1,2}/g);
  return matches ? Math.max(1, matches.length) : 1;
}

function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || "").trim();
}

type DictTabSource = "smart" | "offline" | "wiktionary" | "wordnet";

export function openDictionary(editor: Editor, initialWord?: string): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  const selWord = getWordAtSelection(editor);
  const startWord = (initialWord ?? selWord?.word ?? "").trim();
  let activeSource: DictTabSource = "smart";

  const searchInput = h("input", {
    class: "input dict__input",
    type: "text",
    value: startWord,
    placeholder: "Type any word for built-in offline definitions, roots, and synonyms…",
    spellcheck: "false",
  }) as HTMLInputElement;

  const lookupBtn = h("button", { type: "submit", class: "btn btn--primary" }, icon("Search", 14), "Look Up");
  const addCustomDefBtn = h(
    "button",
    { type: "button", class: "btn", "data-tip": "Add or edit a custom offline definition for this word" },
    icon("BookPlus", 14),
    "Save Offline Def",
  );
  const chromeTopBtn = h(
    "button",
    { type: "button", class: "btn", "data-tip": "Optional: Open external web search in Chrome" },
    icon("Globe", 14),
    "Web ↗",
  );
  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));

  chromeTopBtn.addEventListener("click", () => {
    const q = (searchInput.value || startWord || "").trim();
    const url = q
      ? `https://www.google.com/search?q=define+${encodeURIComponent(q)}`
      : "https://www.merriam-webster.com/";
    void native.openUrl(url);
  });

  addCustomDefBtn.addEventListener("click", async () => {
    const q = (searchInput.value || startWord || "").trim().toLowerCase();
    const existing = q ? loadCustomOfflineDefs()[q] || OFFLINE_LEXICON[q] : undefined;
    const r = await promptDialog(
      "Save Custom Offline Definition",
      [
        { name: "word", label: "Word", value: q || "example" },
        { name: "pos", label: "Part of Speech", value: existing?.pos || "noun" },
        { name: "def", label: "Definition (saved 100% offline on your PC)", value: existing?.def || "" },
        { name: "syns", label: "Synonyms (comma-separated)", value: (existing?.syns ?? []).join(", ") },
      ],
      "Save to Offline Dictionary",
    );
    if (!r || !r.word.trim() || !r.def.trim()) return;
    saveCustomOfflineDef(r.word.trim(), {
      pos: r.pos.trim() || "noun",
      def: r.def.trim(),
      syns: r.syns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    searchInput.value = r.word.trim();
    toast(`Saved "${r.word.trim()}" to Built-In Offline Dictionary`, "success", 2200);
    void lookup(r.word.trim());
  });

  const body = h("div", { class: "dict__body" });
  const form = h("form", { class: "dict__bar" }, searchInput, lookupBtn, addCustomDefBtn, chromeTopBtn);

  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Built-In Dictionary & Thesaurus" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("BookOpen", 18), h("span", {}, "Built-In Dictionary & Thesaurus (Offline + Live)")),
      closeBtn,
    ),
    form,
    body,
  );

  const scrim = h("div", { class: "scrim dict-scrim" }, modal);

  function close() {
    scrim.remove();
    editor.commands.focus();
  }

  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  function replaceOrInsertWord(replacement: string) {
    if (selWord) {
      const orig = selWord.word;
      const cased =
        orig.length > 1 && orig === orig.toUpperCase()
          ? replacement.toUpperCase()
          : orig[0] && orig[0] === orig[0].toUpperCase()
            ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
            : replacement;
      editor
        .chain()
        .focus()
        .command(({ tr, state }) => {
          const marks = state.doc.resolve(selWord.from).marks();
          tr.replaceWith(selWord.from, selWord.to, state.schema.text(cased, marks));
          return true;
        })
        .run();
      toast(`Replaced "${orig}" with "${cased}"`, "success", 2000);
      scrim.remove();
    } else {
      navigator.clipboard?.writeText(replacement).catch(() => {});
      editor.chain().focus().insertContent(replacement).run();
      toast(`Inserted "${replacement}"`, "success", 1800);
      scrim.remove();
    }
  }

  async function lookup(rawQuery: string) {
    const q = rawQuery.trim().toLowerCase();
    body.replaceChildren();
    if (!q) {
      body.append(
        h(
          "div",
          { class: "dict__empty" },
          "Type any word above or select a word in your document and press ",
          h("kbd", {}, "Ctrl+Shift+D"),
          " to view built-in offline definitions, morphology, and synonyms right inside Typo (no browser required).",
        ),
      );
      return;
    }

    let offlineAnalysis = analyzeWordOffline(q);
    const syllables = countSyllables(q);

    // Query Windows 11 Native Offline Spellchecker for instant offline suggestions/relatives
    let osValid = true;
    let osRelated: string[] = [];
    try {
      const osCheck = await native.checkSpelling([q]);
      if (Array.isArray(osCheck) && osCheck.length > 0) {
        osValid = false;
        osRelated = osCheck[0].suggestions ?? [];
      }
    } catch {
      // ignore
    }

    let apiEntry: any = null;
    let wiktionaryEntries: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[] = [];
    let wordnetDefs: { pos: string; def: string }[] = [];
    let datamuseSyns: string[] = [];

    // Render immediate offline result first so there is zero blank wait, then enrich if online
    const renderView = (onlineLoaded: boolean) => {
      body.replaceChildren();

      const phonetic =
        apiEntry?.phonetic ||
        apiEntry?.phonetics?.find((p: any) => p.text)?.text ||
        `${syllables} syllable${syllables === 1 ? "" : "s"} · ${osValid ? "Verified English Word" : "Unrecognized / Custom"}`;

      // In-App Dictionary Source Switcher (NEVER opens Chrome!)
      const sourceTabs: { id: DictTabSource; label: string; iconName: string }[] = [
        { id: "smart", label: "Smart Combined", iconName: "Sparkles" },
        { id: "offline", label: "Built-In Offline", iconName: "HardDrive" },
        { id: "wiktionary", label: "Wiktionary (In-App)", iconName: "Compass" },
        { id: "wordnet", label: "WordNet (In-App)", iconName: "BookOpen" },
      ];

      const switcher = h("div", { class: "dict__weblinks" });
      for (const tab of sourceTabs) {
        const btn = h(
          "button",
          {
            type: "button",
            class: "dict__weblink" + (activeSource === tab.id ? " is-on" : ""),
            "data-tip": `View ${tab.label} inside Typo`,
          },
          icon(tab.iconName, 12),
          tab.label,
        );
        btn.addEventListener("click", () => {
          activeSource = tab.id;
          renderView(onlineLoaded);
        });
        switcher.append(btn);
      }

      const wordHeader = h(
        "div",
        { class: "dict__wordhead" },
        h(
          "div",
          { class: "dict__wordmeta" },
          h("span", { class: "dict__word" }, q),
          h("span", { class: "dict__phonetic" }, phonetic),
        ),
        switcher,
      );
      body.append(wordHeader);

      const allSynonyms = new Set<string>(offlineAnalysis.syns);
      datamuseSyns.forEach((s) => allSynonyms.add(s));

      // Helper to render the Built-In Offline Card
      const appendOfflineSection = () => {
        const offSec = h("div", { class: "dict__section" });
        offSec.append(
          h(
            "div",
            { class: "dict__pos" },
            `Built-In Offline Dictionary · ${offlineAnalysis.directEntry?.pos || offlineAnalysis.inferredPos}`,
          ),
        );
        const list = h("ol", { class: "dict__defs" });
        list.append(h("li", { class: "dict__def" }, h("div", {}, offlineAnalysis.morphologyDef)));
        if (offlineAnalysis.stemWord && offlineAnalysis.stemEntry && !offlineAnalysis.directEntry) {
          list.append(
            h(
              "li",
              { class: "dict__def" },
              h("div", {}, `Root Entry (${offlineAnalysis.stemWord}): ${offlineAnalysis.stemEntry.def}`),
            ),
          );
        }
        if (activeSource === "offline" && wordnetDefs.length > 0) {
          for (const d of wordnetDefs.slice(0, 3)) {
            if (d.def && d.def !== offlineAnalysis.morphologyDef) {
              list.append(h("li", { class: "dict__def" }, h("div", {}, `(${d.pos}) ${d.def}`)));
            }
          }
        }
        if (offlineAnalysis.roots.length > 0) {
          list.append(
            h(
              "li",
              { class: "dict__def" },
              h("div", {}, `Etymology / Classical Roots: ${offlineAnalysis.roots.join(" · ")}`),
            ),
          );
        }
        offSec.append(list);
        body.append(offSec);
      };

      if (activeSource === "offline") {
        appendOfflineSection();
      } else if (activeSource === "wiktionary") {
        if (wiktionaryEntries.length > 0) {
          for (const sec of wiktionaryEntries) {
            const section = h("div", { class: "dict__section" });
            section.append(h("div", { class: "dict__pos" }, `Wiktionary · ${sec.partOfSpeech}`));
            const list = h("ol", { class: "dict__defs" });
            for (const d of sec.definitions) {
              const item = h("li", { class: "dict__def" }, h("div", {}, d.definition));
              if (d.example) item.append(h("div", { class: "dict__example" }, `"${d.example}"`));
              list.append(item);
            }
            section.append(list);
            body.append(section);
          }
        } else {
          appendOfflineSection();
        }
      } else if (activeSource === "wordnet") {
        if (wordnetDefs.length > 0) {
          const section = h("div", { class: "dict__section" });
          section.append(h("div", { class: "dict__pos" }, `WordNet Academic · ${wordnetDefs[0].pos}`));
          const list = h("ol", { class: "dict__defs" });
          for (const d of wordnetDefs.slice(0, 6)) {
            list.append(h("li", { class: "dict__def" }, h("div", {}, `(${d.pos}) ${d.def}`)));
          }
          section.append(list);
          body.append(section);
        } else {
          appendOfflineSection();
        }
      } else {
        // "smart" mode: show Built-In Offline first when offline or as foundation, plus live meanings
        if (offlineAnalysis.directEntry || !apiEntry?.meanings?.length) {
          appendOfflineSection();
        }
        if (apiEntry?.meanings?.length) {
          for (const meaning of apiEntry.meanings.slice(0, 4)) {
            if (Array.isArray(meaning.synonyms)) {
              meaning.synonyms.slice(0, 8).forEach((s: string) => allSynonyms.add(s));
            }
            const section = h("div", { class: "dict__section" });
            section.append(h("div", { class: "dict__pos" }, String(meaning.partOfSpeech || "definition")));
            const list = h("ol", { class: "dict__defs" });
            for (const d of (meaning.definitions ?? []).slice(0, 3)) {
              const item = h("li", { class: "dict__def" }, h("div", {}, String(d.definition)));
              if (d.example) {
                item.append(h("div", { class: "dict__example" }, `"${d.example}"`));
              }
              if (Array.isArray(d.synonyms)) {
                d.synonyms.slice(0, 5).forEach((s: string) => allSynonyms.add(s));
              }
              list.append(item);
            }
            section.append(list);
            body.append(section);
          }
        } else if (wiktionaryEntries.length > 0) {
          for (const sec of wiktionaryEntries) {
            const section = h("div", { class: "dict__section" });
            section.append(h("div", { class: "dict__pos" }, sec.partOfSpeech));
            const list = h("ol", { class: "dict__defs" });
            for (const d of sec.definitions) {
              const item = h("li", { class: "dict__def" }, h("div", {}, d.definition));
              if (d.example) item.append(h("div", { class: "dict__example" }, `"${d.example}"`));
              list.append(item);
            }
            section.append(list);
            body.append(section);
          }
        }
      }

      if (!osValid && osRelated.length > 0) {
        const sugBox = h("div", { class: "dict__section" });
        sugBox.append(h("div", { class: "dict__pos" }, "Did you mean (Windows Offline Spellchecker)"));
        const chips = h("div", { class: "dict__chips" });
        for (const s of osRelated.slice(0, 10)) {
          const chip = h("button", { type: "button", class: "dict__chip" }, s);
          chip.addEventListener("click", () => {
            searchInput.value = s;
            void lookup(s);
          });
          chips.append(chip);
        }
        sugBox.append(chips);
        body.append(sugBox);
      }

      if (allSynonyms.size > 0) {
        const synBox = h("div", { class: "dict__section" });
        synBox.append(
          h(
            "div",
            { class: "dict__pos" },
            selWord ? `Synonyms (click to replace "${selWord.word}")` : "Synonyms (click to insert)",
          ),
        );
        const chips = h("div", { class: "dict__chips" });
        for (const syn of Array.from(allSynonyms).slice(0, 24)) {
          const chip = h("button", { type: "button", class: "dict__chip" }, syn);
          chip.addEventListener("click", () => replaceOrInsertWord(syn));
          chips.append(chip);
        }
        synBox.append(chips);
        body.append(synBox);
      }
    };

    // Show immediate built-in offline result right away
    renderView(false);

    if (settings.strictOfflinePrivacy !== false && activeSource !== "wiktionary" && activeSource !== "wordnet") {
      return;
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3200);
      const [dictRes, synRes, defRes, wikiRes] = await Promise.allSettled([
        fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, { signal: ctrl.signal }),
        fetch(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(q)}&max=20`, { signal: ctrl.signal }),
        fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(q)}&md=d&max=1`, { signal: ctrl.signal }),
        fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(q)}`, { signal: ctrl.signal }),
      ]);
      clearTimeout(timer);

      if (dictRes.status === "fulfilled" && dictRes.value.ok) {
        const json = await dictRes.value.json();
        if (Array.isArray(json) && json.length > 0) apiEntry = json[0];
      }
      if (synRes.status === "fulfilled" && synRes.value.ok) {
        const sjson = await synRes.value.json();
        if (Array.isArray(sjson)) {
          datamuseSyns = sjson.map((x: any) => String(x.word)).filter(Boolean);
        }
      }
      if (defRes.status === "fulfilled" && defRes.value.ok) {
        const djson = await defRes.value.json();
        if (Array.isArray(djson) && djson[0]?.defs) {
          for (const rawDef of djson[0].defs.slice(0, 6)) {
            const parts = String(rawDef).split("\t");
            const posMap: Record<string, string> = { n: "noun", v: "verb", adj: "adjective", adv: "adverb" };
            if (parts.length >= 2) {
              wordnetDefs.push({ pos: posMap[parts[0]] || parts[0], def: parts.slice(1).join(" ") });
            }
          }
        }
      }
      if (wikiRes.status === "fulfilled" && wikiRes.value.ok) {
        const wjson = await wikiRes.value.json();
        const enList = wjson?.en;
        if (Array.isArray(enList)) {
          for (const sec of enList.slice(0, 3)) {
            const defs = (sec.definitions ?? [])
              .map((d: any) => ({
                definition: stripHtml(String(d.definition || "")),
                example: Array.isArray(d.examples) && d.examples[0] ? stripHtml(String(d.examples[0])) : undefined,
              }))
              .filter((d: any) => d.definition.length > 0)
              .slice(0, 3);
            if (defs.length) {
              wiktionaryEntries.push({
                partOfSpeech: String(sec.partOfSpeech || "definition"),
                definitions: defs,
              });
            }
          }
        }
      }

      // Auto-cache any newly fetched definition into the local Built-In Offline Dictionary
      // so future offline lookups and the "Built-In Offline" tab always show the real meaning!
      if (!offlineAnalysis.directEntry) {
        const firstApiMeaning = apiEntry?.meanings?.[0];
        const firstApiDef = firstApiMeaning?.definitions?.[0]?.definition;
        const firstWordnet = wordnetDefs[0];
        const firstWiki = wiktionaryEntries[0];
        const bestDef =
          (firstApiDef && String(firstApiDef).trim()) ||
          (firstWordnet?.def && String(firstWordnet.def).trim()) ||
          (firstWiki?.definitions?.[0]?.definition && String(firstWiki.definitions[0].definition).trim()) ||
          "";
        const bestPos =
          (firstApiMeaning?.partOfSpeech && String(firstApiMeaning.partOfSpeech)) ||
          firstWordnet?.pos ||
          firstWiki?.partOfSpeech ||
          offlineAnalysis.inferredPos;

        if (bestDef) {
          const mergedSyns = Array.from(
            new Set([
              ...offlineAnalysis.syns,
              ...datamuseSyns.slice(0, 10),
              ...(Array.isArray(firstApiMeaning?.synonyms) ? firstApiMeaning.synonyms.slice(0, 6) : []),
            ]),
          );
          saveCustomOfflineDef(q, {
            pos: bestPos,
            def: bestDef,
            syns: mergedSyns,
          });
          offlineAnalysis = analyzeWordOffline(q);
        }
      }

      renderView(true);
    } catch {
      // Already rendered offline view!
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void lookup(searchInput.value);
  });

  root.append(scrim);
  requestAnimationFrame(() => {
    scrim.classList.add("scrim--in");
    searchInput.focus();
    searchInput.select();
    if (startWord) void lookup(startWord);
    else void lookup("");
  });
}

/** Opens the Spelling & Grammar Review modal and performs an immediate 1-shot full scan. */
export function openProofingPanel(editor: Editor): void {
  const root = document.getElementById("overlay-root")!;
  document.querySelector(".dict-scrim")?.remove();

  // Trigger a 1-shot full scan immediately when opening the panel (even if Auto-Check is OFF)
  runOneShotProofCheck(editor);

  const closeBtn = h("button", { type: "button", class: "ibtn", "aria-label": "Close" }, icon("X", 16));
  const scanNowBtn = h("button", { type: "button", class: "btn btn--primary" }, icon("ScanSearch", 14), "Scan Document Now");
  const autoToggleBtn = h("button", { type: "button", class: "btn" });
  const clearBtn = h("button", { type: "button", class: "btn" }, icon("EyeOff", 14), "Clear Highlights");
  const listHost = h("div", { class: "dict__body" });

  const syncAutoLabel = () => {
    const autoOn = isAutoSpellcheck();
    autoToggleBtn.replaceChildren(
      icon(autoOn ? "Check" : "SpellCheck", 14),
      h("span", {}, autoOn ? "Auto-Check: ON" : "Auto-Check: OFF"),
    );
    autoToggleBtn.classList.toggle("is-on", autoOn);
  };
  syncAutoLabel();

  const controlsBar = h("div", { class: "dict__bar" }, scanNowBtn, autoToggleBtn, clearBtn);

  const modal = h(
    "div",
    { class: "modal dict-modal", role: "dialog", "aria-label": "Spelling & Grammar Check" },
    h(
      "div",
      { class: "dict__header" },
      h("div", { class: "dict__title" }, icon("SpellCheck", 18), h("span", {}, "Spelling & Grammar Check")),
      closeBtn,
    ),
    controlsBar,
    listHost,
  );

  const scrim = h("div", { class: "scrim dict-scrim" }, modal);
  const unsub = on("proofing:update", () => {
    syncAutoLabel();
    renderIssues();
  });

  const close = () => {
    unsub();
    scrim.remove();
    editor.commands.focus();
  };
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) close();
  });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  scanNowBtn.addEventListener("click", () => {
    runOneShotProofCheck(editor);
    renderIssues();
    toast("Scanned entire document for spelling & grammar", "success", 1800);
  });

  autoToggleBtn.addEventListener("click", () => {
    setAutoSpellcheck(editor, !isAutoSpellcheck());
    syncAutoLabel();
    renderIssues();
  });

  clearBtn.addEventListener("click", () => {
    clearProofHighlights(editor);
    syncAutoLabel();
    close();
  });

  function renderIssues() {
    listHost.replaceChildren();
    const pluginState = proofingKey.getState(editor.state);
    const issues: ProofIssue[] = pluginState?.issues ?? [];

    if (issues.length === 0) {
      listHost.append(
        h(
          "div",
          { class: "proof-empty" },
          icon("Check", 28),
          h("strong", {}, "No spelling or grammar issues found"),
          h("span", {}, "Checked via Windows 11 OS Spellchecker + Grammar Engine."),
        ),
      );
      return;
    }

    for (const iss of issues) {
      const row = h("div", { class: "proof-item" });
      const top = h(
        "div",
        { class: "proof-item__head" },
        h("span", { class: `proof-card__dot proof-card__dot--${iss.kind}` }),
        h("span", { class: `proof-card__badge proof-card__badge--${iss.kind}` }, iss.kind === "spelling" ? "Spelling" : "Grammar"),
        h("code", { class: "proof-card__token" }, iss.text),
        h("span", { class: "proof-item__msg" }, iss.message),
      );
      const btns = h("div", { class: "proof-card__Suggestions" });
      for (const sug of iss.suggestions) {
        const b = h("button", { type: "button", class: "proof-card__fix" }, icon("ArrowRight", 12), sug === " " ? "Single space" : sug);
        b.addEventListener("click", () => {
          applyIssueFix(editor, iss, sug);
          renderIssues();
        });
        btns.append(b);
      }
      const ignore = h("button", { type: "button", class: "proof-card__act" }, "Ignore");
      ignore.addEventListener("click", () => {
        ignoreIssueWord(iss.text, editor);
        renderIssues();
      });
      btns.append(ignore);

      if (iss.kind === "spelling") {
        const addDict = h("button", { type: "button", class: "proof-card__act" }, "Add to dictionary");
        addDict.addEventListener("click", () => {
          addWordToUserDictionary(iss.text, editor);
          renderIssues();
        });
        btns.append(addDict);
      }

      row.append(top, btns);
      listHost.append(row);
    }
  }

  renderIssues();
  root.append(scrim);
  requestAnimationFrame(() => scrim.classList.add("scrim--in"));
}
