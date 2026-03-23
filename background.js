const CACHE_PREFIX = "translation:";
const DEFAULT_TARGET_LANG = "zh-CN";
const DEFAULT_SOURCE_LANG = "en";
const MAX_TEXT_LENGTH = 4000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "translateText") {
    translateText(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  }

  return false;
});

async function translateText(message) {
  const rawText = normalizeText(message.text);

  if (!rawText) {
    return { translatedText: "" };
  }

  if (rawText.length > MAX_TEXT_LENGTH) {
    throw new Error("Text is too long for a single translation request.");
  }

  const sourceLang = message.sourceLang || DEFAULT_SOURCE_LANG;
  const targetLang = message.targetLang || DEFAULT_TARGET_LANG;
  const cacheKey = `${CACHE_PREFIX}${sourceLang}:${targetLang}:${rawText}`;

  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) {
    return { translatedText: cached[cacheKey], cached: true };
  }

  const translatedText = await requestGoogleTranslate(rawText, sourceLang, targetLang);

  await chrome.storage.local.set({
    [cacheKey]: translatedText,
  });

  return { translatedText, cached: false };
}

async function requestGoogleTranslate(text, sourceLang, targetLang) {
  const query = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: targetLang,
    dt: "t",
    q: text,
  });

  const url = `https://translate.googleapis.com/translate_a/single?${query.toString()}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Google Translate request failed: ${response.status}`);
  }

  const data = await response.json();
  const translatedText = Array.isArray(data?.[0])
    ? data[0]
        .map((part) => (Array.isArray(part) ? part[0] : ""))
        .join("")
        .trim()
    : "";

  if (!translatedText) {
    throw new Error("Translation response was empty.");
  }

  return translatedText;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}
