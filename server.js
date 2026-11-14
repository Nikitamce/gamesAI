const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  RARITY_TIERS,
  OCEAN_ZONES,
  PROMPTS,
  DIVES,
  PROMPT_DOMAIN_VALIDATORS,
  OFFLINE_TRANSLATIONS
} = require('./data/prompts');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = Number(process.env.PORT) || 3456;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const LANG_META = {
  en: { name: 'English', flag: '🇬🇧' },
  ru: { name: 'Русский', flag: '🇷🇺' },
  uk: { name: 'Українська', flag: '🇺🇦' },
  be: { name: 'Беларуская', flag: '🇧🇾' },
  kk: { name: 'Қазақша', flag: '🇰🇿' },
  es: { name: 'Español', flag: '🇪🇸' },
  fr: { name: 'Français', flag: '🇫🇷' },
  de: { name: 'Deutsch', flag: '🇩🇪' },
  it: { name: 'Italiano', flag: '🇮🇹' },
  pt: { name: 'Português', flag: '🇵🇹' },
  ja: { name: '日本語', flag: '🇯🇵' },
  zh: { name: '中文', flag: '🇨🇳' },
  'zh-cn': { name: '中文 (简体)', flag: '🇨🇳' },
  'zh-tw': { name: '中文 (繁體)', flag: '🇹🇼' },
  ko: { name: '한국어', flag: '🇰🇷' },
  ar: { name: 'العربية', flag: '🇸🇦' },
  tr: { name: 'Türkçe', flag: '🇹🇷' },
  pl: { name: 'Polski', flag: '🇵🇱' },
  nl: { name: 'Nederlands', flag: '🇳🇱' },
  sv: { name: 'Svenska', flag: '🇸🇪' },
  no: { name: 'Norsk', flag: '🇳🇴' },
  fi: { name: 'Suomi', flag: '🇫🇮' },
  hi: { name: 'हिन्दी', flag: '🇮🇳' },
  el: { name: 'Ελληνικά', flag: '🇬🇷' },
  he: { name: 'עברית', flag: '🇮🇱' },
  cs: { name: 'Čeština', flag: '🇨🇿' },
  ro: { name: 'Română', flag: '🇷🇴' },
  hu: { name: 'Magyar', flag: '🇭🇺' },
  vi: { name: 'Tiếng Việt', flag: '🇻🇳' },
  th: { name: 'ไทย', flag: '🇹🇭' },
  id: { name: 'Bahasa Indonesia', flag: '🇮🇩' },
  ka: { name: 'ქართული', flag: '🇬🇪' },
  hy: { name: 'Հայերեն', flag: '🇦🇲' }
};

// In-memory caches to keep repeated lookups fast and resilient
const translationCache = new Map();
const datamuseCache = new Map();
const wikiSearchCache = new Map();
const wikiExtractCache = new Map();
const ruWikiCache = new Map();

/**
 * Normalize text for comparison: lowercase, strip diacritics, strip punctuation, collapse whitespace.
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Light singularization helper for English nouns.
 */
function singularize(word) {
  const w = normalizeText(word);
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('es') && /(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

/**
 * Optimal String Alignment (Damerau-Levenshtein) distance for typo & morphological tolerance.
 */
function damerauLevenshtein(a, b) {
  const s = a;
  const t = b;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }
  return dp[m][n];
}

function similarityRatio(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const dist = damerauLevenshtein(na, nb);
  return (maxLen - dist) / maxLen;
}

function formatLangMeta(code, rawText) {
  const normalizedCode = (code || '').toLowerCase();
  if (LANG_META[normalizedCode]) {
    return { code: normalizedCode, ...LANG_META[normalizedCode] };
  }
  // Heuristic fallback for script detection if API returned unusual code
  if (/[\u0400-\u04FF]/.test(rawText)) {
    return { code: 'ru', ...LANG_META.ru };
  }
  if (/[\u3040-\u30FF\u31F0-\u31FF]/.test(rawText)) {
    return { code: 'ja', ...LANG_META.ja };
  }
  if (/[\u4E00-\u9FFF]/.test(rawText)) {
    return { code: 'zh', ...LANG_META.zh };
  }
  if (/[\uAC00-\uD7AF]/.test(rawText)) {
    return { code: 'ko', ...LANG_META.ko };
  }
  if (/[\u0600-\u06FF]/.test(rawText)) {
    return { code: 'ar', ...LANG_META.ar };
  }
  return {
    code: normalizedCode || 'auto',
    name: normalizedCode ? normalizedCode.toUpperCase() : 'Auto',
    flag: '🌐'
  };
}

/**
 * Fetch wrapper with timeout.
 */
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper to parse translate.googleapis.com /translate_a/single response.
 */
function parseGoogleSingleResponse(data) {
  if (!Array.isArray(data)) return null;
  let translated = '';
  if (Array.isArray(data[0])) {
    translated = data[0]
      .map(seg => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('')
      .trim();
  }
  const detectedCode = typeof data[2] === 'string' ? data[2] : 'auto';
  const confidence = typeof data[6] === 'number' ? data[6] : 1;
  const dictTerms = [];
  if (Array.isArray(data[1])) {
    for (const posGroup of data[1]) {
      if (Array.isArray(posGroup) && Array.isArray(posGroup[1])) {
        for (const term of posGroup[1]) {
          if (typeof term === 'string' && term.trim()) {
            dictTerms.push(term.trim());
          }
        }
      }
    }
  }
  return {
    translated,
    detectedCode,
    confidence,
    hasDict: dictTerms.length > 0,
    dictTerms
  };
}

const CYRILLIC_LATIN_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/**
 * Phonetic Cyrillic -> Latin transliteration plus common scientific cognate variants.
 */
function transliterateCyrillicToLatin(text) {
  return String(text || '')
    .toLowerCase()
    .split('')
    .map(ch => (Object.prototype.hasOwnProperty.call(CYRILLIC_LATIN_MAP, ch) ? CYRILLIC_LATIN_MAP[ch] : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCyrillicTransliterations(text) {
  const raw = String(text || '').trim().toLowerCase();
  const base = transliterateCyrillicToLatin(raw);
  const forms = new Set([base]);
  if (/ий$/.test(raw)) {
    const ium = base.replace(/iy$/, 'ium');
    forms.add(ium);
    forms.add(ium.replace(/k/g, 'c'));
  }
  if (/^г/.test(raw)) {
    forms.add(base.replace(/^g/, 'h'));
    if (/ий$/.test(raw)) forms.add(base.replace(/^g/, 'h').replace(/iy$/, 'ium'));
  }
  if (base.includes('kh')) {
    forms.add(base.replace(/kh/g, 'h'));
    forms.add(base.replace(/kh/g, 'ch'));
  }
  return Array.from(forms).filter(Boolean);
}

/**
 * Resolve Russian/Ukrainian queries via multilingual Wikipedia interlanguage links and extracts.
 */
async function resolveViaMultilingualWikipedia(rawText, langCode = 'ru') {
  const clean = String(rawText || '').trim();
  if (!clean) return [];
  const cacheKey = `${langCode}:${clean.toLowerCase()}`;
  if (ruWikiCache.has(cacheKey)) return ruWikiCache.get(cacheKey);

  try {
    const url =
      `https://${langCode}.wikipedia.org/w/api.php?action=query` +
      `&generator=search&gsrsearch=${encodeURIComponent(clean)}&gsrlimit=3` +
      `&prop=langlinks|extracts|info&lllang=en&exintro=true&explaintext=true&format=json`;
    const data = await fetchJsonWithTimeout(
      url,
      { headers: { 'User-Agent': 'KrillionMultilang/1.0 (https://github.com/Nikitamce/krillion-multilang; educational-game)' } },
      5500
    );
    const pages = Object.values(data?.query?.pages || {});
    pages.sort((a, b) => (a.index || 99) - (b.index || 99));
    const mapped = pages.map(page => ({
      title: page.title || '',
      enTitle: page.langlinks && page.langlinks[0] ? page.langlinks[0]['*'] : null,
      extract: String(page.extract || ''),
      length: page.length || 0,
      index: page.index || 99
    }));
    ruWikiCache.set(cacheKey, mapped);
    return mapped;
  } catch {
    return [];
  }
}

/**
 * Stage 0: Multilingual Translation Engine
 * Combines Google Translate (auto + smart Cyrillic/European disambiguation),
 * MyMemory fallback, built-in offline dictionary, Russian Wikipedia interlanguage links,
 * and phonetic Cyrillic transliteration.
 */
async function translateToEnglish(rawText) {
  const trimmed = String(rawText || '').trim();
  const cacheKey = trimmed.toLowerCase();
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  const offlineHit = OFFLINE_TRANSLATIONS[cacheKey];
  const isPureAscii = /^[\x00-\x7F]+$/.test(trimmed);
  const hasCyrillic = /[\u0400-\u04FF]/.test(trimmed);
  const hasNonRussianCyrillic = /[іїєґўәғқңөұүһ]/i.test(trimmed);
  let primaryEnglish = trimmed;
  let detectedCode = isPureAscii ? 'en' : 'auto';
  const alternatives = new Set();
  let source = 'passthrough';

  const encoded = encodeURIComponent(trimmed);
  // Query translate.googleapis.com once (and explicit sl=ru for ambiguous Cyrillic nouns).
  // Calling a single primary Google endpoint cuts request volume in half and avoids burst throttling.
  const requests = [
    fetchJsonWithTimeout(
      `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=en&dt=t&dt=bd&q=${encoded}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
  ];

  if (hasCyrillic && !hasNonRussianCyrillic) {
    requests.push(
      fetchJsonWithTimeout(
        `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=ru&tl=en&dt=t&dt=bd&q=${encoded}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      )
    );
  }

  const [singleRes, ruRes] = await Promise.allSettled(requests);

  let autoParsed = null;
  if (singleRes.status === 'fulfilled') {
    autoParsed = parseGoogleSingleResponse(singleRes.value);
    if (autoParsed && autoParsed.translated) {
      primaryEnglish = autoParsed.translated;
      alternatives.add(autoParsed.translated);
      if (autoParsed.detectedCode) detectedCode = autoParsed.detectedCode;
      autoParsed.dictTerms.forEach(t => alternatives.add(t));
      source = 'google-translate';
    }
  }

  // Fallback to clients5 only if singleRes failed or returned nothing
  if (source === 'passthrough') {
    try {
      const c5 = await fetchJsonWithTimeout(
        `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=${encoded}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (Array.isArray(c5) && c5.length > 0) {
        const first = c5[0];
        if (Array.isArray(first) && typeof first[0] === 'string' && first[0].trim()) {
          primaryEnglish = first[0].trim();
          if (typeof first[1] === 'string' && first[1].trim()) detectedCode = first[1].trim();
          source = 'google-translate';
        } else if (typeof first === 'string' && first.trim()) {
          primaryEnglish = first.trim();
          source = 'google-translate';
        }
      }
    } catch {
      // Proceed to fallbacks
    }
  }

  // Prefer explicit Russian translation when sl=auto misidentified a Russian word without dictionary backing
  if (ruRes && ruRes.status === 'fulfilled') {
    const ruParsed = parseGoogleSingleResponse(ruRes.value);
    if (ruParsed && ruParsed.translated) {
      ruParsed.dictTerms.forEach(t => alternatives.add(t));
      const autoMisclassified =
        detectedCode !== 'ru' &&
        (!autoParsed || !autoParsed.hasDict || ['kk', 'sr', 'bg', 'mk', 'uk'].includes(detectedCode));
      if (ruParsed.hasDict || autoMisclassified) {
        primaryEnglish = ruParsed.translated;
        detectedCode = 'ru';
        alternatives.add(ruParsed.translated);
        source = 'google-translate';
      }
    }
  }

  // Guard against Google sl=auto misidentifying rare English nouns (e.g., "Eurasian hoopoe" -> Hawaiian)
  const MAJOR_LATIN_LANGS = new Set([
    'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'no', 'fi', 'da',
    'pl', 'tr', 'ro', 'cs', 'sk', 'hu', 'hr', 'sl', 'et', 'lv', 'lt',
    'id', 'ms', 'vi', 'tl', 'ca', 'gl', 'eu'
  ]);
  if (isPureAscii && !MAJOR_LATIN_LANGS.has(detectedCode)) {
    primaryEnglish = trimmed;
    detectedCode = 'en';
    alternatives.add(trimmed);
  }

  // If single pure-Latin word returned unchanged with detectedCode === 'en' and low confidence,
  // check major Latin-script languages (de, fr, es, it, pt) only if not already recognized as an English entity.
  if (
    isPureAscii &&
    !trimmed.includes(' ') &&
    normalizeText(primaryEnglish) === normalizeText(trimmed) &&
    (!autoParsed || autoParsed.confidence < 0.75)
  ) {
    const enWikiCheck = await searchWikipedia(trimmed);
    const exactEnWiki = enWikiCheck.results.some(
      r => normalizeText(r.title) === normalizeText(trimmed)
    );
    if (!exactEnWiki) {
      const probeLangs = ['de', 'fr', 'es', 'it', 'pt'];
      const probeResults = await Promise.allSettled(
        probeLangs.map(lang =>
          fetchJsonWithTimeout(
            `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=${lang}&tl=en&dt=t&dt=bd&q=${encoded}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } },
            2800
          ).then(d => ({ lang, parsed: parseGoogleSingleResponse(d) }))
        )
      );
      for (const pr of probeResults) {
        if (pr.status === 'fulfilled' && pr.value.parsed) {
          const { lang, parsed } = pr.value;
          if (
            parsed.translated &&
            normalizeText(parsed.translated) !== normalizeText(trimmed) &&
            parsed.hasDict
          ) {
            primaryEnglish = parsed.translated;
            detectedCode = lang;
            alternatives.add(parsed.translated);
            parsed.dictTerms.forEach(t => alternatives.add(t));
            source = 'google-translate';
            break;
          }
        }
      }
    }
  }

  const translits = hasCyrillic ? buildCyrillicTransliterations(trimmed) : [];
  translits.forEach(t => alternatives.add(t));

  // Fallback to MyMemory if Google endpoints failed or echoed Cyrillic untouched
  const stillCyrillicAfterGoogle = hasCyrillic && /[\u0400-\u04FF]/.test(primaryEnglish);
  if ((source === 'passthrough' || stillCyrillicAfterGoogle) && !isPureAscii) {
    try {
      const mmLangPair = hasCyrillic && !hasNonRussianCyrillic ? 'ru|en' : 'autodetect|en';
      const mm = await fetchJsonWithTimeout(
        `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${mmLangPair}`
      );
      const tx = mm?.responseData?.translatedText;
      if (
        tx &&
        tx.trim() &&
        !tx.toUpperCase().includes('INVALID') &&
        normalizeText(tx) !== normalizeText(trimmed) &&
        !(hasCyrillic && /[\u0400-\u04FF]/.test(tx))
      ) {
        primaryEnglish = tx.trim();
        alternatives.add(primaryEnglish);
        if (mm.responseData.detectedLanguage) {
          detectedCode = mm.responseData.detectedLanguage;
        } else if (mmLangPair === 'ru|en') {
          detectedCode = 'ru';
        }
        source = 'mymemory';
      }
    } catch {
      // Continue to offline / Wikipedia fallback
    }
  }

  // Always include offline dictionary hit if present
  if (offlineHit) {
    alternatives.add(offlineHit);
    if (
      source === 'passthrough' ||
      !primaryEnglish ||
      normalizeText(primaryEnglish) === normalizeText(trimmed) ||
      (hasCyrillic && /[\u0400-\u04FF]/.test(primaryEnglish))
    ) {
      primaryEnglish = offlineHit;
      source = source === 'passthrough' ? 'offline-dict' : `${source}+dict`;
    }
  }

  // Fallback to Russian/Ukrainian Wikipedia interlanguage link if still untranslated Cyrillic
  if (hasCyrillic && (/[\u0400-\u04FF]/.test(primaryEnglish) || source === 'passthrough')) {
    const wikiLang = hasNonRussianCyrillic ? 'uk' : 'ru';
    const ruPages = await resolveViaMultilingualWikipedia(trimmed, wikiLang);
    const exactOrFirst =
      ruPages.find(p => p.enTitle && normalizeText(p.title) === normalizeText(trimmed)) ||
      ruPages.find(p => p.enTitle);
    if (exactOrFirst && exactOrFirst.enTitle) {
      const cleanEnTitle = exactOrFirst.enTitle.replace(/\s*\([^)]*\)$/, '').trim();
      primaryEnglish = cleanEnTitle || exactOrFirst.enTitle;
      alternatives.add(exactOrFirst.enTitle);
      if (cleanEnTitle) alternatives.add(cleanEnTitle);
      if (!hasNonRussianCyrillic) detectedCode = 'ru';
      source = 'ru-wiki-langlink';
    }
  }

  // Last-resort phonetic transliteration for Cyrillic when external translators and Wiki langlinks failed
  if (hasCyrillic && /[\u0400-\u04FF]/.test(primaryEnglish) && translits.length > 0) {
    primaryEnglish = translits[0];
    if (!hasNonRussianCyrillic && detectedCode === 'auto') detectedCode = 'ru';
    source = 'translit';
  }

  if (!primaryEnglish || !primaryEnglish.trim()) {
    primaryEnglish = trimmed;
  }

  // Strip leading English articles added by machine translators ("a platypus" -> "platypus")
  const cleanedPrimary = primaryEnglish.replace(/^(a|an|the)\s+/i, '').trim() || primaryEnglish;
  if (cleanedPrimary !== primaryEnglish) {
    alternatives.add(cleanedPrimary);
  }
  alternatives.add(primaryEnglish);

  const detectedLang = formatLangMeta(detectedCode, trimmed);
  const result = {
    original: trimmed,
    primaryEnglish: cleanedPrimary,
    rawTranslatedEnglish: primaryEnglish,
    alternatives: Array.from(alternatives).filter(Boolean),
    detectedLang,
    source
  };

  // Never poison cache with failed untranslated/fallback non-ASCII results
  const shouldCache =
    isPureAscii ||
    (source !== 'passthrough' && source !== 'translit' && !/[\u0400-\u04FF]/.test(cleanedPrimary));
  if (shouldCache) {
    translationCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Query Datamuse API for English synonyms and close semantic associations.
 */
async function getDatamuseSynonyms(term) {
  const clean = normalizeText(term);
  if (!clean || clean.length < 2) return [];
  if (datamuseCache.has(clean)) return datamuseCache.get(clean);

  try {
    const data = await fetchJsonWithTimeout(
      `https://api.datamuse.com/words?ml=${encodeURIComponent(clean)}&max=15`,
      {},
      4000
    );
    const words = Array.isArray(data)
      ? data.map(item => {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        return {
          word: item.word,
          tags,
          score: item.score || 0,
          isStrictSyn: tags.includes('syn'),
          isPrimaryRel: tags.includes('results_type:primary_rel')
        };
      })
      : [];
    datamuseCache.set(clean, words);
    return words;
  } catch {
    return [];
  }
}

/**
 * Query Wikipedia search + summary extracts for paraphrase resolution and open-world verification.
 */
async function searchWikipedia(query) {
  const clean = String(query || '').trim();
  if (!clean) return { totalhits: 0, results: [] };
  const key = clean.toLowerCase();
  if (wikiSearchCache.has(key)) return wikiSearchCache.get(key);

  try {
    const data = await fetchJsonWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(clean)}&srlimit=5&format=json`,
      { headers: { 'User-Agent': 'KrillionMultilang/1.0 (https://github.com/Nikitamce/krillion-multilang; educational-game)' } },
      4500
    );
    const results = (data?.query?.search || []).map(item => ({
      title: item.title,
      snippet: String(item.snippet || '').replace(/<[^>]+>/g, ''),
      size: item.size || 0,
      pageid: item.pageid
    }));
    const payload = {
      totalhits: data?.query?.searchinfo?.totalhits || 0,
      results
    };
    wikiSearchCache.set(key, payload);
    return payload;
  } catch {
    return { totalhits: 0, results: [] };
  }
}

async function fetchWikipediaExtract(title) {
  const key = String(title || '').trim().toLowerCase();
  if (!key) return null;
  if (wikiExtractCache.has(key)) return wikiExtractCache.get(key);

  try {
    const data = await fetchJsonWithTimeout(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|categories&exintro=true&explaintext=true&cllimit=20&titles=${encodeURIComponent(title)}&format=json`,
      { headers: { 'User-Agent': 'KrillionMultilang/1.0 (https://github.com/Nikitamce/krillion-multilang; educational-game)' } },
      4500
    );
    const pages = data?.query?.pages || {};
    const firstKey = Object.keys(pages)[0];
    const page = pages[firstKey];
    if (!page || page.missing !== undefined) return null;
    const categories = (page.categories || []).map(c => c.title.replace(/^Category:/i, '').toLowerCase());
    const result = {
      title: page.title,
      extract: String(page.extract || ''),
      categories
    };
    wikiExtractCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Build a flat index of all candidate strings (canonical + aliases) for a prompt.
 */
function buildCandidateForms(prompt) {
  const forms = [];
  for (const entry of prompt.answers) {
    forms.push({ entry, term: entry.canonical, isCanonical: true });
    for (const alias of entry.aliases || []) {
      forms.push({ entry, term: alias, isCanonical: false });
    }
  }
  return forms;
}

const TIER_ORDER = ['plankton', 'too_clever', 'schooler', 'rare', 'deep_cut', 'krillion'];

const FAKE_OBJECT_MODIFIERS = new Set([
  'toy', 'rubber', 'plastic', 'chocolate', 'candy', 'sugar', 'wooden', 'origami',
  'fake', 'plush', 'stuffed', 'cartoon', 'animated', 'fictional', 'virtual',
  'ceramic', 'clay', 'porcelain', 'statue', 'painting'
]);

const GENERIC_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'some', 'one', 'just', 'very', 'really',
  'typical', 'normal', 'regular', 'common', 'animal', 'creature', 'thing',
  'bird', 'fruit', 'country', 'republic', 'state', 'kingdom', 'federation',
  'principality', 'island', 'city', 'capital', 'language', 'metal', 'of', 'in', 'from'
]);

function boostTierInfo(entry) {
  const idx = TIER_ORDER.indexOf(entry.tier);
  if (idx === -1) return { tierKey: entry.tier, frequencyPct: entry.frequencyPct };
  const boostSteps = idx === 0 ? 2 : 1;
  const nextIdx = Math.min(TIER_ORDER.length - 1, idx + boostSteps);
  const tierKey = TIER_ORDER[nextIdx];
  const frequencyPct = Number(Math.max(0.05, Math.min(entry.frequencyPct * 0.3, 12)).toFixed(2));
  return { tierKey, frequencyPct };
}

/**
 * Find closest canonical entries in the curated pool for typo/near-spelling hints.
 */
function findClosestCuratedSuggestions(prompt, candidates, minSim = 0.66) {
  const pool = buildCandidateForms(prompt);
  const cleanedCandidates = candidates
    .map(c => normalizeText(c))
    .filter(n => n.length >= 3);
  const byCanonical = new Map();

  for (const cand of cleanedCandidates) {
    for (const item of pool) {
      const targetNorm = normalizeText(item.term);
      if (targetNorm.length < 3) continue;
      if (Math.abs(cand.length - targetNorm.length) > 4) continue;
      const ratio = similarityRatio(cand, targetNorm);
      if (ratio >= minSim) {
        const prev = byCanonical.get(item.entry.canonical);
        if (!prev || ratio > prev.ratio) {
          byCanonical.set(item.entry.canonical, { entry: item.entry, ratio });
        }
      }
    }
  }
  return Array.from(byCanonical.values()).sort((a, b) => b.ratio - a.ratio);
}

/**
 * Stage 1 & 2: Exact, Alias, Singular/Plural, Fuzzy, Subtype, and Phrase Token Match
 */
function matchAgainstCuratedPool(prompt, candidates) {
  const pool = buildCandidateForms(prompt);
  const cleanedCandidates = candidates
    .map(c => ({ raw: c, norm: normalizeText(c), sing: singularize(c) }))
    .filter(c => c.norm.length > 0);

  // Stage 1: Exact / Alias / Named-Subtype Alias match
  for (const cand of cleanedCandidates) {
    for (const item of pool) {
      const targetNorm = normalizeText(item.term);
      const targetSing = singularize(item.term);
      if (cand.norm === targetNorm || cand.sing === targetSing) {
        if (!item.isCanonical) {
          const canonNorm = normalizeText(item.entry.canonical);
          const targetTokens = targetNorm.split(' ').filter(Boolean);
          const canonTokens = canonNorm.split(' ').filter(Boolean);
          const containsCanonWord =
            canonNorm.length >= 4 &&
            targetNorm !== canonNorm &&
            new RegExp(`(^|\\s)${escapeRegex(canonNorm)}($|\\s)`).test(targetNorm);
          const hasMeaningfulModifier = targetTokens.some(
            t => !canonTokens.includes(t) && !GENERIC_FILLER_WORDS.has(t)
          );
          if (
            containsCanonWord &&
            targetTokens.length >= 2 &&
            targetTokens.length <= 4 &&
            hasMeaningfulModifier
          ) {
            return {
              entry: item.entry,
              matchedTerm: item.term,
              matchedRaw: item.term,
              matchType: 'subtype',
              semanticScore: 96
            };
          }
        }
        return {
          entry: item.entry,
          matchedTerm: item.term,
          matchType: item.isCanonical ? 'exact' : 'alias',
          semanticScore: 100
        };
      }
    }
  }

  // Stage 2A: Fuzzy typo / morphological similarity (Damerau-Levenshtein >= 0.85 for words >= 4 chars)
  let bestFuzzy = null;
  for (const cand of cleanedCandidates) {
    if (cand.norm.length < 4) continue;
    for (const item of pool) {
      const targetNorm = normalizeText(item.term);
      if (targetNorm.length < 4) continue;
      if (Math.abs(cand.norm.length - targetNorm.length) > 3) continue;
      const ratio = similarityRatio(cand.norm, targetNorm);
      if (ratio >= 0.85 && (!bestFuzzy || ratio > bestFuzzy.ratio)) {
        bestFuzzy = { entry: item.entry, matchedTerm: item.term, ratio };
      }
    }
  }
  if (bestFuzzy) {
    return {
      entry: bestFuzzy.entry,
      matchedTerm: bestFuzzy.matchedTerm,
      matchType: 'fuzzy',
      semanticScore: Math.round(bestFuzzy.ratio * 100)
    };
  }

  // Stage 2B: Subtype / Variety & Phrase token containment (e.g., "Emperor penguin" -> subtype of "Penguin")
  // Sort targets longest-first so "Black Pepper" wins over "Pepper"
  const sortedPool = [...pool].sort((a, b) => b.term.length - a.term.length);
  for (const cand of cleanedCandidates) {
    const candTokens = cand.norm.split(' ').filter(Boolean);
    if (candTokens.length < 2) continue;
    // Reject non-living/toy phrases like "rubber duck" or "chocolate egg"
    if (candTokens.some(t => FAKE_OBJECT_MODIFIERS.has(t))) continue;

    for (const item of sortedPool) {
      const targetNorm = normalizeText(item.term);
      if (targetNorm.length < 4) continue;
      const regex = new RegExp(`(^|\\s)${targetNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
      if (regex.test(cand.norm) || regex.test(cand.sing)) {
        const targetTokens = targetNorm.split(' ').filter(Boolean);
        const meaningfulModifiers = candTokens.filter(
          t => !targetTokens.includes(t) && !GENERIC_FILLER_WORDS.has(t)
        );
        const isSubtype =
          candTokens.length <= 4 &&
          targetTokens.length <= 2 &&
          meaningfulModifiers.length >= 1;
        return {
          entry: item.entry,
          matchedTerm: item.term,
          matchedRaw: cand.raw,
          matchType: isSubtype ? 'subtype' : 'phrase',
          semanticScore: isSubtype ? 96 : 92
        };
      }
    }
  }

  return null;
}

/**
 * Build a balanced sample spectrum showing representative answers across all 6 tiers for this prompt.
 */
function buildSampleSpectrum(prompt) {
  const tierOrder = ['plankton', 'too_clever', 'schooler', 'rare', 'deep_cut', 'krillion'];
  return tierOrder.map(tierId => {
    const tierInfo = RARITY_TIERS[tierId];
    const items = prompt.answers
      .filter(a => a.tier === tierId)
      .slice(0, 3)
      .map(a => ({ name: a.canonical, frequencyPct: a.frequencyPct }));
    return {
      tierId,
      name: tierInfo.name,
      ruName: tierInfo.ruName,
      points: tierInfo.points,
      depth: tierInfo.depth,
      color: tierInfo.color,
      emoji: tierInfo.emoji,
      examples: items
    };
  });
}

/**
 * Optional Stage 5: Gemini AI Judge when GEMINI_API_KEY is configured.
 */
async function evaluateWithGemini(prompt, rawAnswer, translatedEnglish, apiKey) {
  if (!apiKey) return null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const promptText = `You are the judge for the rare-answer trivia game Krillion.
Category (EN): "${prompt.enPrompt}"
Category (RU): "${prompt.ruPrompt}"
Player raw answer: "${rawAnswer}"
Machine English translation: "${translatedEnglish}"

Determine:
1. Is the answer factually valid and semantically appropriate for this category?
2. What is its clean canonical English name?
3. How rare is it among general trivia players (plankton, too_clever, schooler, rare, deep_cut, krillion)?
4. Semantic confidence 0-100.

Reply strictly in JSON:
{"valid": boolean, "canonicalEnglish": string, "tier": "plankton"|"too_clever"|"schooler"|"rare"|"deep_cut"|"krillion", "semanticScore": number, "reasonRu": string}`;

  try {
    const data = await fetchJsonWithTimeout(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      },
      6000
    );
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function corpusHasEnglishExclude(lowerCorpus, term) {
  const clean = String(term || '').trim().toLowerCase();
  if (!clean) return false;
  const pattern = clean.includes(' ')
    ? `\\b${escapeRegex(clean)}\\b`
    : `\\b${escapeRegex(clean)}(?:s|es)?\\b`;
  return new RegExp(pattern, 'i').test(lowerCorpus);
}

/**
 * Validate an English or Russian Wikipedia corpus against prompt domain rules.
 */
function validateOpenWorldCorpus(prompt, rawCorpus, lang = 'en') {
  const corpus = String(rawCorpus || '').toLowerCase();
  if (!corpus.trim()) {
    return { valid: false, excluded: false, nearDomain: false };
  }
  const validator = PROMPT_DOMAIN_VALIDATORS[prompt.id] || {};
  const keywords = lang === 'ru' ? (validator.ruKeywords || []) : (prompt.wikiKeywords || []);
  const excludes = lang === 'ru' ? (validator.ruExclude || []) : (prompt.wikiExclude || []);

  let hasKeyword = keywords.some(kw => {
    const k = kw.toLowerCase();
    if (lang === 'en' && k.length <= 3) return corpusHasEnglishExclude(corpus, k);
    return corpus.includes(k);
  });
  let hasExcluded = excludes.some(ex =>
    lang === 'ru' ? corpus.includes(ex.toLowerCase()) : corpusHasEnglishExclude(corpus, ex)
  );

  if (prompt.id === 'egg-animal') {
    const isMammal = lang === 'ru'
      ? /(млекопитающ|плацентарн|живородящ|сумчат)/i.test(corpus)
      : /\bmammals?\b/i.test(corpus);
    const isOviparous = lang === 'ru'
      ? /(однопроходн|яйцекладущ|откладыва[ею]т\s+яйц|яйцеродящ)/i.test(corpus)
      : /\b(monotremes?|egg-laying|lays?\s+eggs|oviparous)\b/i.test(corpus);
    if (isMammal && !isOviparous) {
      hasExcluded = true;
    }
  } else if (prompt.id === 'metal-element') {
    const isElement = lang === 'ru'
      ? corpus.includes('химический элемент')
      : /\bchemical element\b/i.test(corpus);
    const isNonMetal = lang === 'ru'
      ? /(благородный газ|неметалл|галоген)/i.test(corpus)
      : /\b(noble gas|halogen|nonmetal|non-metal)\b/i.test(corpus);
    if (isElement && !isNonMetal) {
      hasExcluded = false;
      hasKeyword = true;
    }
  } else if (prompt.id === 'red-fruit') {
    const introText = corpus.split(/[.!?]\s/).slice(0, 2).join('. ');
    const hasRedClue = /\b(?:red|crimson|scarlet|ruby)\b|(?:красн|бордов|рубин|(?:^|[^а-яё])ал(?:ый|ая|ое|ые|ых)(?=$|[^а-яё]))/i.test(introText);
    const isNonRedPrimary = /\b(?:usually|typically|bright|is a)\s+(?:yellow|green|orange)\b/i.test(introText);
    const hasFruitClue = /\b(?:fruit|berry|drupe|pome)\b|(?:плод|ягод|фрукт|костянк)/i.test(corpus);
    hasKeyword = hasRedClue && !isNonRedPrimary && hasFruitClue;
  } else if (prompt.id === 'flightless-bird') {
    const hasFlightless = /(flightless|cannot fly|unable to fly|нелетающ|не\s+уме[ею]т\s+летать)/i.test(corpus);
    hasKeyword = hasKeyword && hasFlightless;
  } else if (prompt.id === 'euro-capital') {
    const hasCapital = /(capital|столиц)/i.test(corpus);
    const hasEurope = /(europe|european|европ)/i.test(corpus);
    hasKeyword = hasCapital && hasEurope;
  } else if (prompt.id === 'sa-country') {
    const hasSA = /(south america|южн\w+\s+америк|guiana|гвиан)/i.test(corpus);
    hasKeyword = hasKeyword && hasSA;
  }

  const nearKeywords = validator.nearDomainKeywords || [];
  const nearDomain = nearKeywords.some(kw => corpus.includes(kw.toLowerCase()));

  return {
    valid: hasKeyword && !hasExcluded,
    excluded: hasExcluded,
    nearDomain
  };
}

/**
 * Compute diagnostic closeness score, explanation, and suggestions when an answer is rejected.
 */
function computeNearMissDiagnostics(prompt, trimmed, translation, candidateStrings, wikiDiagnostics, dmResults) {
  const validator = PROMPT_DOMAIN_VALIDATORS[prompt.id] || {};
  const combinedCorpus = `${wikiDiagnostics.enCorpus} ${wikiDiagnostics.ruCorpus}`.toLowerCase();
  const dmWordsJoined = dmResults.map(d => d.word.toLowerCase()).join(' ');

  let partialScore = 0;
  const reasons = [];

  const hasNearKeywordInCorpus = (validator.nearDomainKeywords || []).some(kw =>
    combinedCorpus.includes(kw.toLowerCase())
  );
  const matchedNearCorpus =
    hasNearKeywordInCorpus || (wikiDiagnostics.nearDomainHit && !wikiDiagnostics.wikiExcludedHit);

  if (matchedNearCorpus && validator.nearDomainMessage) {
    partialScore = wikiDiagnostics.wikiExcludedHit ? 48 : 36;
    reasons.push(`Ответ «${translation.primaryEnglish}» — ${validator.nearDomainMessage}`);
  } else if ((validator.nearDomainKeywords || []).some(kw => dmWordsJoined.includes(kw.toLowerCase())) && validator.nearDomainMessage) {
    partialScore = 28;
    reasons.push(`Ответ «${translation.primaryEnglish}» — ${validator.nearDomainMessage}`);
  }

  let suggestions = [];
  if (!wikiDiagnostics.checked) {
    const closest = findClosestCuratedSuggestions(prompt, candidateStrings, 0.66);
    suggestions = closest.slice(0, 2).map(item => item.entry.canonical);
    if (closest.length > 0) {
      const spellingScore = Math.min(68, Math.round(closest[0].ratio * 72));
      partialScore = Math.max(partialScore, spellingScore);
      reasons.push(`Возможно, вы имели в виду: ${suggestions.join(' или ')} (проверьте написание).`);
    }
  }

  const untranslatedNonAscii =
    translation.source === 'passthrough' && !/^[\x00-\x7F]+$/.test(trimmed);

  let matchExplanation;
  if (untranslatedNonAscii) {
    matchExplanation = `Не удалось перевести «${trimmed}» и подтвердить его через энциклопедию для категории «${prompt.ruPrompt}». Проверьте написание или попробуйте уточнить слово.`;
  } else if (reasons.length > 0) {
    matchExplanation = reasons.join(' ');
  } else {
    matchExplanation = `Перевод «${translation.primaryEnglish}» не подходит по смыслу для категории «${prompt.ruPrompt}».`;
  }

  return {
    semanticScore: partialScore,
    matchExplanation,
    closestSuggestions: suggestions
  };
}

/**
 * Full 5-Stage Evaluation Pipeline:
 * Translate -> Exact/Alias/Fuzzy/Subtype -> Dual EN/RU Wikipedia Paraphrase & Open-World -> Datamuse -> Optional Gemini
 */
async function evaluateAnswer(prompt, rawAnswer, options = {}) {
  const trimmed = String(rawAnswer || '').trim();
  const spectrum = buildSampleSpectrum(prompt);

  if (!trimmed) {
    return {
      ok: true,
      accepted: false,
      originalInput: '',
      detectedLang: { code: 'none', name: 'Пусто', flag: '⏳' },
      translatedEnglish: '',
      alternativeTranslations: [],
      canonicalAnswer: null,
      matchType: 'empty',
      semanticScore: 0,
      matchExplanation: 'Время вышло или ответ не введён — 0 метров погружения в этом раунде.',
      tier: null,
      points: 0,
      depth: 0,
      frequencyPct: null,
      closestSuggestions: [],
      sampleSpectrum: spectrum
    };
  }

  // Stage 0: Translate to English
  const translation = await translateToEnglish(trimmed);
  const hasCyrillic = /[\u0400-\u04FF]/.test(trimmed);
  const hasNonRussianCyrillic = /[іїєґўәғқңөұүһ]/i.test(trimmed);
  const candidateStrings = Array.from(
    new Set([translation.primaryEnglish, ...translation.alternatives, trimmed])
  );

  // Stage 1 & 2: Exact, Alias, Fuzzy, Subtype, Phrase match against curated prompt pool
  let match = matchAgainstCuratedPool(prompt, candidateStrings);
  let explanation = '';

  if (match) {
    if (match.matchType === 'exact') {
      explanation = `Перевод «${translation.primaryEnglish}» точно совпадает с каноническим ответом «${match.entry.canonical}».`;
    } else if (match.matchType === 'alias') {
      explanation = `Перевод «${translation.primaryEnglish}» распознан как синоним/альтернативное название для «${match.entry.canonical}».`;
    } else if (match.matchType === 'fuzzy') {
      explanation = `Перевод «${translation.primaryEnglish}» близок по написанию и смыслу (${match.semanticScore}%) к «${match.entry.canonical}».`;
    } else if (match.matchType === 'subtype') {
      explanation = `✨ Найдена конкретная редкая разновидность «${translation.primaryEnglish}» (базовый класс: «${match.entry.canonical}») — начислен бонус за уникальность!`;
    } else {
      explanation = `Во фразе «${translation.primaryEnglish}» распознан верный ответ «${match.entry.canonical}».`;
    }
  }

  // Stage 3: Dual English + Russian Wikipedia Resolution (Paraphrases & Open-World Unique Answers)
  let wikiMatchInfo = null;
  const wikiDiagnostics = {
    checked: false,
    entityTitle: null,
    enCorpus: '',
    ruCorpus: '',
    wikiExcludedHit: false,
    nearDomainHit: false
  };

  if (!match) {
    const cleanQuery = translation.primaryEnglish
      .replace(/\b(a|an|the|that|which|is|are|who|with|from|in|of)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const wikiRes = await searchWikipedia(cleanQuery || translation.primaryEnglish);

    if (wikiRes.results.length > 0) {
      const isMultiWord = cleanQuery.split(' ').length >= 2;
      const candidateTitles = (isMultiWord ? wikiRes.results.slice(0, 3) : wikiRes.results.slice(0, 1))
        .map(r => r.title);
      const wikiPoolMatch = matchAgainstCuratedPool(prompt, candidateTitles);

      if (wikiPoolMatch) {
        match = {
          entry: wikiPoolMatch.entry,
          matchedTerm: wikiPoolMatch.matchedTerm,
          matchType: 'paraphrase',
          semanticScore: 88
        };
        explanation = `Описание «${translation.primaryEnglish}» семантически соответствует сущности «${match.entry.canonical}» (подтверждено энциклопедией).`;
      } else if (cleanQuery.split(' ').length >= 3) {
        const snippetMatch = matchAgainstCuratedPool(
          prompt,
          wikiRes.results.slice(0, 2).map(r => r.snippet)
        );
        if (snippetMatch) {
          match = {
            entry: snippetMatch.entry,
            matchedTerm: snippetMatch.matchedTerm,
            matchType: 'paraphrase',
            semanticScore: 86
          };
          explanation = `Описание «${translation.primaryEnglish}» семантически соответствует сущности «${match.entry.canonical}» (подтверждено энциклопедией).`;
        }
      }
      if (!match) {
        // 3B: Open-World Unique Answer Verification on English Wikipedia (try top non-disambiguation hit)
        const candidatesToInspect = wikiRes.results.slice(0, 2);
        for (const item of candidatesToInspect) {
          const titleSim = similarityRatio(translation.primaryEnglish, item.title);
          const normTrans = normalizeText(translation.primaryEnglish);
          const normTitle = normalizeText(item.title);

          if (
            normTrans.length < 3 ||
            !(titleSim >= 0.72 || normTitle.includes(normTrans) || normTrans.includes(normTitle))
          ) {
            continue;
          }

          const extractData = await fetchWikipediaExtract(item.title);
          const cats = extractData?.categories || [];
          const isDisambig =
            cats.some(c => c.includes('disambiguation')) ||
            /\bmay refer to:\b/i.test(extractData?.extract || '');
          if (isDisambig) continue;

          const enCorpus = [item.title, item.snippet, extractData?.extract || '', ...cats].join(' ');
          const checkEn = validateOpenWorldCorpus(prompt, enCorpus, 'en');

          wikiDiagnostics.checked = true;
          wikiDiagnostics.entityTitle = item.title;
          wikiDiagnostics.enCorpus = enCorpus;
          wikiDiagnostics.wikiExcludedHit = wikiDiagnostics.wikiExcludedHit || checkEn.excluded;
          wikiDiagnostics.nearDomainHit = wikiDiagnostics.nearDomainHit || checkEn.nearDomain;

          if (checkEn.valid) {
            const isUltraObscure = wikiRes.totalhits < 4500 || item.size < 25000;
            const dynamicTier = isUltraObscure ? 'krillion' : 'deep_cut';
            const dynamicFreq = isUltraObscure ? 0.08 : 0.42;
            wikiMatchInfo = {
              canonical: item.title,
              tier: dynamicTier,
              frequencyPct: dynamicFreq
            };
            explanation = `🌟 Уникальный ответ! «${item.title}» не входит в базовый словарь популярных вариантов, но подтверждён энциклопедией (Open-World Wikipedia) — максимальный бонус редкости!`;
          }
          break;
        }
      }
    }

    // 3C: Russian/Ukrainian Wikipedia Resolution (catches rare Cyrillic terms, paraphrases, and diagnostics)
    if (hasCyrillic && !match && !wikiMatchInfo) {
      const wikiLang = hasNonRussianCyrillic ? 'uk' : 'ru';
      const ruPages = await resolveViaMultilingualWikipedia(trimmed, wikiLang);

      if (ruPages.length > 0) {
        const isMultiWordRu = trimmed.split(/\s+/).length >= 3;
        if (isMultiWordRu) {
          const ruEnTitles = ruPages.map(p => p.enTitle).filter(Boolean);
          const ruParaphraseMatch = matchAgainstCuratedPool(prompt, ruEnTitles);
          if (ruParaphraseMatch && !wikiDiagnostics.wikiExcludedHit) {
            match = {
              entry: ruParaphraseMatch.entry,
              matchedTerm: ruParaphraseMatch.matchedTerm,
              matchType: 'paraphrase',
              semanticScore: 86
            };
            explanation = `Описание «${trimmed}» семантически соответствует сущности «${match.entry.canonical}» (подтверждено русскоязычной Википедией).`;
          }
        }

        if (!match) {
          const bestRuPage =
            ruPages.find(p => normalizeText(p.title) === normalizeText(trimmed)) || ruPages[0];
          const ruTitleSim = similarityRatio(trimmed, bestRuPage.title);
          const normRuIn = normalizeText(trimmed);
          const normRuTitle = normalizeText(bestRuPage.title);

          if (
            bestRuPage.enTitle &&
            !wikiDiagnostics.wikiExcludedHit &&
            (ruTitleSim >= 0.65 || normRuTitle.includes(normRuIn) || normRuIn.includes(normRuTitle))
          ) {
            const cleanEnTitle = bestRuPage.enTitle.replace(/\s*\([^)]*\)$/, '').trim();
            const curatedRuLink = matchAgainstCuratedPool(prompt, [bestRuPage.enTitle, cleanEnTitle]);
            if (curatedRuLink) {
              match = {
                entry: curatedRuLink.entry,
                matchedTerm: curatedRuLink.matchedTerm,
                matchType: curatedRuLink.matchType,
                semanticScore: curatedRuLink.semanticScore
              };
              explanation = `Русскоязычная энциклопедия связала «${trimmed}» с «${match.entry.canonical}».`;
            }
          }

          if (!match) {
            const ruCorpus = [bestRuPage.title, bestRuPage.extract].join(' ');
            const checkRu = validateOpenWorldCorpus(prompt, ruCorpus, 'ru');

            wikiDiagnostics.checked = true;
            wikiDiagnostics.entityTitle = wikiDiagnostics.entityTitle || bestRuPage.title;
            wikiDiagnostics.ruCorpus = ruCorpus;
            wikiDiagnostics.wikiExcludedHit = wikiDiagnostics.wikiExcludedHit || checkRu.excluded;
            wikiDiagnostics.nearDomainHit = wikiDiagnostics.nearDomainHit || checkRu.nearDomain;

            if (
              checkRu.valid &&
              !wikiDiagnostics.wikiExcludedHit &&
              (ruTitleSim >= 0.65 || normRuTitle.includes(normRuIn) || normRuIn.includes(normRuTitle))
            ) {
              const displayTitle = bestRuPage.enTitle
                ? bestRuPage.enTitle.replace(/\s*\([^)]*\)$/, '').trim()
                : bestRuPage.title;
              const isUltraObscure = bestRuPage.length < 18000;
              const dynamicTier = isUltraObscure ? 'krillion' : 'deep_cut';
              const dynamicFreq = isUltraObscure ? 0.08 : 0.42;
              wikiMatchInfo = {
                canonical: displayTitle,
                tier: dynamicTier,
                frequencyPct: dynamicFreq
              };
              explanation = `🌟 Уникальный ответ! «${bestRuPage.title}» (${displayTitle}) не входит в базовый список частых вариантов, но подтверждён русскоязычной Википедией!`;
            }
          }
        }
      }
    }
  }

  // Stage 4: Datamuse Semantic Synonym Expansion (strict syn + safe semantic relations)
  let dmResults = [];
  let datamuseSynonymsChecked = [];
  if (!match && !wikiMatchInfo) {
    dmResults = await getDatamuseSynonyms(translation.primaryEnglish);
    datamuseSynonymsChecked = dmResults.slice(0, 6).map(d => d.word);

    const strictFactualPrompt = ['egg-animal', 'metal-element', 'sa-country', 'euro-capital'].includes(prompt.id);
    const eligibleDmWords = dmResults
      .filter(d => {
        if (wikiDiagnostics.wikiExcludedHit) return false;
        if (d.isStrictSyn) return true;
        return !strictFactualPrompt && d.isPrimaryRel;
      })
      .map(d => d.word);

    if (eligibleDmWords.length > 0) {
      const dmMatch = matchAgainstCuratedPool(prompt, eligibleDmWords);
      if (dmMatch) {
        match = {
          entry: dmMatch.entry,
          matchedTerm: dmMatch.matchedTerm,
          matchType: dmMatch.matchType === 'exact' ? 'synonym' : 'semantic_close',
          semanticScore: 88
        };
        explanation = `Семантический анализ (Datamuse) связал перевод «${translation.primaryEnglish}» по смыслу с «${match.entry.canonical}».`;
      }
    }
  }

  // Stage 5: Optional Gemini AI Judge (only if key supplied and still unmatched)
  const apiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!match && !wikiMatchInfo && apiKey) {
    const geminiRes = await evaluateWithGemini(
      prompt,
      trimmed,
      translation.primaryEnglish,
      apiKey
    );
    if (geminiRes && geminiRes.valid) {
      const canonical = geminiRes.canonicalEnglish || translation.primaryEnglish;
      const curatedAgain = matchAgainstCuratedPool(prompt, [canonical]);
      if (curatedAgain) {
        match = {
          entry: curatedAgain.entry,
          matchedTerm: canonical,
          matchType: 'gemini',
          semanticScore: geminiRes.semanticScore || 90
        };
        explanation = geminiRes.reasonRu || `ИИ-судья подтвердил смысл ответа: «${match.entry.canonical}».`;
      } else {
        const tierKey = RARITY_TIERS[geminiRes.tier] ? geminiRes.tier : 'deep_cut';
        wikiMatchInfo = {
          canonical,
          tier: tierKey,
          frequencyPct: tierKey === 'krillion' ? 0.12 : 0.6
        };
        explanation = geminiRes.reasonRu || `ИИ-судья засчитал редкий ответ «${canonical}».`;
      }
    }
  }

  // Build final accepted or rejected response
  if (match || wikiMatchInfo) {
    if (match && match.matchType === 'subtype') {
      const boosted = boostTierInfo(match.entry);
      const tier = RARITY_TIERS[boosted.tierKey];
      const displayCanonical = match.matchedRaw
        ? `${match.matchedRaw} (${match.entry.canonical})`
        : match.entry.canonical;
      return {
        ok: true,
        accepted: true,
        originalInput: trimmed,
        detectedLang: translation.detectedLang,
        translatedEnglish: translation.primaryEnglish,
        alternativeTranslations: translation.alternatives,
        translationSource: translation.source,
        semanticHints: datamuseSynonymsChecked,
        canonicalAnswer: displayCanonical,
        matchType: 'subtype',
        semanticScore: match.semanticScore,
        matchExplanation: explanation,
        tier,
        points: tier.points,
        depth: tier.depth,
        frequencyPct: boosted.frequencyPct,
        closestSuggestions: [],
        sampleSpectrum: spectrum
      };
    }

    const chosen = match ? match.entry : wikiMatchInfo;
    const tier = RARITY_TIERS[chosen.tier];
    return {
      ok: true,
      accepted: true,
      originalInput: trimmed,
      detectedLang: translation.detectedLang,
      translatedEnglish: translation.primaryEnglish,
      alternativeTranslations: translation.alternatives,
      translationSource: translation.source,
      semanticHints: datamuseSynonymsChecked,
      canonicalAnswer: chosen.canonical,
      matchType: match ? match.matchType : 'unique_discovery',
      semanticScore: match ? match.semanticScore : 95,
      matchExplanation: explanation,
      tier,
      points: tier.points,
      depth: tier.depth,
      frequencyPct: chosen.frequencyPct,
      closestSuggestions: [],
      sampleSpectrum: spectrum
    };
  }

  const nearMiss = computeNearMissDiagnostics(
    prompt,
    trimmed,
    translation,
    candidateStrings,
    wikiDiagnostics,
    dmResults
  );

  return {
    ok: true,
    accepted: false,
    originalInput: trimmed,
    detectedLang: translation.detectedLang,
    translatedEnglish: translation.primaryEnglish,
    alternativeTranslations: translation.alternatives,
    translationSource: translation.source,
    semanticHints: datamuseSynonymsChecked,
    canonicalAnswer: null,
    matchType: 'none',
    semanticScore: nearMiss.semanticScore,
    matchExplanation: nearMiss.matchExplanation,
    tier: null,
    points: 0,
    depth: 0,
    frequencyPct: null,
    closestSuggestions: nearMiss.closestSuggestions,
    sampleSpectrum: spectrum
  };
}

/**
 * Helper to read JSON request body safely.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * HTTP Server Request Handler
 */
async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API: Health Check
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      promptsCount: PROMPTS.length,
      divesCount: DIVES.length
    });
  }

  // API: Get all dives, prompts (metadata + examples, without full answer spoiler), tiers, and ocean zones
  if (req.method === 'GET' && pathname === '/api/dives') {
    const publicPrompts = {};
    for (const p of PROMPTS) {
      publicPrompts[p.id] = {
        id: p.id,
        diveId: p.diveId,
        ruPrompt: p.ruPrompt,
        enPrompt: p.enPrompt,
        hint: p.hint,
        examples: p.examples,
        totalCuratedAnswers: p.answers.length
      };
    }

    return sendJson(res, 200, {
      ok: true,
      tiers: RARITY_TIERS,
      oceanZones: OCEAN_ZONES,
      dives: DIVES,
      prompts: publicPrompts
    });
  }

  // API: Evaluate an answer in any language against a prompt
  if (req.method === 'POST' && (pathname === '/api/evaluate' || pathname === '/api/translate-check')) {
    try {
      const body = await readJsonBody(req);
      const promptId = body.promptId;
      const answer = body.answer ?? '';
      const geminiApiKey = body.geminiApiKey;

      const prompt = PROMPTS.find(p => p.id === promptId);
      if (!prompt) {
        return sendJson(res, 404, { ok: false, error: `Prompt "${promptId}" not found.` });
      }

      const evaluation = await evaluateAnswer(prompt, answer, { geminiApiKey });
      return sendJson(res, 200, evaluation);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message || 'Invalid request' });
    }
  }

  // Static File Serving from /public
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const absPath = path.join(PUBLIC_DIR, filePath);

  if (!absPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(absPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Internal Server Error');
    }
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function startServer(port, attemptsLeft = 5) {
  const server = http.createServer(handleRequest);
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`Port ${port} is busy, trying ${port + 1}...`);
      startServer(port + 1, attemptsLeft - 1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log(`Krillion Multilingual running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = {
  translateToEnglish,
  evaluateAnswer,
  normalizeText,
  similarityRatio
};


