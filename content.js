const ROOT_ID = "gvst-root";
const PANEL_ID = "gvst-panel";
const STATUS_ID = "gvst-status";
const META_STATUS_ID = "gvst-meta-status";
const EXTENSION_VERSION = "0.2.5";
const TRANSLATED_ATTR = "data-gvst-translated";
const PROCESSING_ATTR = "data-gvst-processing";
const TEXT_HASH_ATTR = "data-gvst-text-hash";
const META_TRANSLATED_ATTR = "data-gvst-meta-translated";
const PANEL_VISIBLE_KEY = "gvst:panelVisible";
const AUTO_MODE_KEY = "gvst:autoMode";
const CARD_SELECTOR = "button.appsDocsUiSidebarCard";
const SCRIPT_SELECTOR = ".appsFlixScriptsSidebarGlobalCardScript";

const state = {
  panelVisible: true,
  autoMode: true,
  observer: null,
  scanTimer: null,
  translateQueue: new Set(),
  translateInFlight: new Set(),
  lastScopeStatus: "Waiting for scene scripts...",
  metaStatus: "Waiting for page description...",
};

init().catch((error) => {
  console.error("[GVST] init failed", error);
});

async function init() {
  console.info(`[GVST] content script loaded v${EXTENSION_VERSION}`, location.href);
  await loadSettings();
  ensurePanel();
  scanAndTranslate();
  scanMetaDescription();
  observeDom();
}

async function loadSettings() {
  const data = await chrome.storage.local.get([PANEL_VISIBLE_KEY, AUTO_MODE_KEY]);
  state.panelVisible = data[PANEL_VISIBLE_KEY] !== false;
  state.autoMode = data[AUTO_MODE_KEY] !== false;
}

function observeDom() {
  state.observer = new MutationObserver((mutations) => {
    if (!state.autoMode) {
      return;
    }

    const hasRelevantMutation = mutations.some((mutation) => {
      const target = mutation.target instanceof HTMLElement ? mutation.target : mutation.target.parentElement;
      return !isManagedTranslationNode(target);
    });

    if (!hasRelevantMutation) {
      return;
    }

    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      scanAndTranslate();
      scanMetaDescription();
    }, 300);
  });

  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-selected", "aria-pressed"],
  });
}

function ensurePanel() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.documentElement.appendChild(root);
  }

  root.innerHTML = "";

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = state.panelVisible ? "gvst-visible" : "gvst-hidden";
  panel.innerHTML = `
    <div class="gvst-title">Scene Script Translator v${EXTENSION_VERSION}</div>
    <button type="button" data-gvst-action="scan">Scan scene scripts</button>
    <button type="button" data-gvst-action="toggle-auto">${state.autoMode ? "Auto scan: On" : "Auto scan: Off"}</button>
    <button type="button" data-gvst-action="toggle-visibility">${state.panelVisible ? "Hide panel" : "Show panel"}</button>
    <div id="${STATUS_ID}" class="gvst-hint">${escapeHtml(state.lastScopeStatus)}</div>
    <div id="${META_STATUS_ID}" class="gvst-meta">${escapeHtml(state.metaStatus)}</div>
  `;

  panel.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.dataset.gvstAction;
    if (!action) {
      return;
    }

    if (action === "scan") {
      scanAndTranslate(true);
      return;
    }

    if (action === "toggle-auto") {
      state.autoMode = !state.autoMode;
      await chrome.storage.local.set({ [AUTO_MODE_KEY]: state.autoMode });
      ensurePanel();
      return;
    }

    if (action === "toggle-visibility") {
      state.panelVisible = !state.panelVisible;
      await chrome.storage.local.set({ [PANEL_VISIBLE_KEY]: state.panelVisible });
      ensurePanel();
    }
  });

  root.appendChild(panel);
}

function updateStatus(text) {
  state.lastScopeStatus = text;
  const statusNode = document.getElementById(STATUS_ID);
  if (statusNode) {
    statusNode.textContent = text;
  }
}

function updateMetaStatus(text) {
  state.metaStatus = text;
  const statusNode = document.getElementById(META_STATUS_ID);
  if (statusNode) {
    statusNode.textContent = text;
  }
}

async function scanAndTranslate(force = false) {
  const { cards, scriptNodes, currentSceneNodes } = findScriptNodes();
  const scriptBackedNodes = findScriptBackedCurrentSceneNodes();
  const allNodes = [...scriptNodes, ...currentSceneNodes, ...scriptBackedNodes];
  updateStatus(
    `Scene cards: ${cards.length}, all-scenes: ${scriptNodes.length}, current-scene: ${currentSceneNodes.length}, script-backed: ${scriptBackedNodes.length}`,
  );

  for (const node of allNodes) {
    const text = extractSourceScriptText(node);
    if (!looksLikeEnglishSubtitle(text)) {
      continue;
    }

    const textHash = hashText(text);
    const translatedBlock = findTranslatedBlock(node);
    const alreadyDone = translatedBlock && translatedBlock.getAttribute(TEXT_HASH_ATTR) === textHash;

    if (alreadyDone && !force) {
      continue;
    }

    if (node.getAttribute(PROCESSING_ATTR) === "1") {
      continue;
    }

    queueTranslation(node, text, textHash);
  }
}

async function scanMetaDescription(force = false) {
  const meta = findMetaDescription();
  if (!meta) {
    updateMetaStatus("No page description meta found.");
    return;
  }

  const sourceText = getMetaSourceText(meta);
  if (!looksLikeEnglishText(sourceText)) {
    updateMetaStatus("Page description is not an English sentence.");
    return;
  }

  const textHash = hashText(sourceText);
  const pageKey = `${location.pathname}:${textHash}`;
  if (!force && state.translateInFlight.has(pageKey)) {
    return;
  }

  state.translateInFlight.add(pageKey);
  updateMetaStatus("Translating page description...");

  try {
    const translatedText = await translate(sourceText);
    const matchedCount = renderMetaTranslation(sourceText, translatedText, textHash);
    const label = matchedCount > 0
      ? `Page description translated in ${matchedCount} place(s).`
      : "Page description translated in panel only.";
    updateMetaStatus(label);
  } catch (error) {
    console.error("[GVST] meta translate failed", error);
    updateMetaStatus("Page description translation failed.");
  } finally {
    state.translateInFlight.delete(pageKey);
  }
}

function findScriptNodes() {
  const cards = Array.from(document.querySelectorAll(CARD_SELECTOR)).filter(
    (node) => node instanceof HTMLElement,
  );

  const visibleCards = cards.filter((card) => {
    if (!(card instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(card);
    return style.display !== "none" && style.visibility !== "hidden";
  });

  const scriptNodes = visibleCards
    .map((card) => card.querySelector(SCRIPT_SELECTOR))
    .filter((node) => node instanceof HTMLElement)
    .filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (node.closest(`#${ROOT_ID}`)) {
        return false;
      }

      const style = window.getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    });

  const currentSceneNodes = findCurrentSceneNodes();

  return {
    cards: visibleCards,
    scriptNodes,
    currentSceneNodes,
  };
}

function findCurrentSceneNodes() {
  const sceneLabels = findVisibleLeafElements().filter((node) =>
    /^Scene\s+\d+\s*\/\s*\d+$/i.test(normalizeText(node.textContent)),
  );

  const matches = [];
  const seen = new Set();

  for (const label of sceneLabels) {
    const container = findCurrentSceneContainer(label);
    if (!(container instanceof HTMLElement)) {
      continue;
    }

    const candidates = findCurrentSceneTextContainers(container)
      .filter((node) => node !== label)
      .filter((node) => !node.closest(CARD_SELECTOR))
      .filter((node) => {
        const text = extractSourceScriptText(node);
        return looksLikeCurrentSceneBody(text);
      })
      .sort((left, right) => {
        const leftLength = extractSourceScriptText(left).length;
        const rightLength = extractSourceScriptText(right).length;
        return rightLength - leftLength;
      });

    const primary = candidates[0];
    if (primary && !seen.has(primary)) {
      matches.push(primary);
      seen.add(primary);
    }
  }

  return matches;
}

function findScriptBackedCurrentSceneNodes() {
  const noteTexts = getCurrentSceneTextsFromModelScripts();
  if (noteTexts.length === 0) {
    return [];
  }

  const containers = getCurrentSceneCandidateContainers();
  if (containers.length === 0) {
    return [];
  }

  const matched = [];
  const usedContainers = new Set();

  for (const noteText of noteTexts) {
    const container = pickBestCurrentSceneContainer(noteText, containers, usedContainers);
    if (!container) {
      continue;
    }

    container.dataset.gvstSourceText = noteText;
    matched.push(container);
    usedContainers.add(container);
  }

  return matched;
}

function getCurrentSceneTextsFromModelScripts() {
  const texts = [];
  const seen = new Set();
  const scripts = Array.from(document.scripts);

  for (const script of scripts) {
    const content = script.textContent || "";
    if (!content.includes("DOCS_modelChunk")) {
      continue;
    }

    for (const match of content.matchAll(/\[15\s*,[\s\S]*?"((?:\\.|[^"\\])*)"\]/g)) {
      const decoded = decodeScriptString(match[1]);
      const normalized = normalizeText(decoded);
      if (!looksLikeCurrentSceneBody(normalized)) {
        continue;
      }

      if (!seen.has(normalized)) {
        seen.add(normalized);
        texts.push(normalized);
      }
    }
  }

  return texts;
}

function decodeScriptString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch (error) {
    console.warn("[GVST] failed to decode script string", error);
    return value;
  }
}

function getCurrentSceneCandidateContainers() {
  const labels = findVisibleLeafElements().filter((node) =>
    /^Scene\s+\d+\s*\/\s*\d+$/i.test(normalizeText(node.textContent)),
  );

  const containers = [];
  const seen = new Set();

  for (const label of labels) {
    const card = findCurrentSceneContainer(label);
    if (!(card instanceof HTMLElement)) {
      continue;
    }

    const candidates = Array.from(card.querySelectorAll("*"))
      .filter((node) => node instanceof HTMLElement)
      .filter((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        if (!isVisible(node) || node.closest(`#${ROOT_ID}`)) {
          return false;
        }

        if (node.hasAttribute(TRANSLATED_ATTR) || node.hasAttribute(META_TRANSLATED_ATTR)) {
          return false;
        }

        const text = normalizeText(node.innerText || node.textContent);
        if (!text || /^Scene\s+\d+\s*\/\s*\d+$/i.test(text)) {
          return false;
        }

        const rect = node.getBoundingClientRect();
        return rect.width >= 140 && rect.height >= 28;
      });

    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        containers.push(candidate);
      }
    }
  }

  return containers;
}

function pickBestCurrentSceneContainer(sourceText, containers, usedContainers) {
  const sourceWords = tokenizeEnglish(sourceText);
  let bestNode = null;
  let bestScore = 0;

  for (const container of containers) {
    if (usedContainers.has(container)) {
      continue;
    }

    const visibleText = normalizeText(container.innerText || container.textContent);
    const score = scoreTextSimilarity(sourceWords, tokenizeEnglish(visibleText), sourceText, visibleText, container);
    if (score > bestScore) {
      bestScore = score;
      bestNode = container;
    }
  }

  if (bestScore >= 0.35) {
    return bestNode;
  }

  return null;
}

function tokenizeEnglish(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreTextSimilarity(sourceWords, targetWords, sourceText, targetText, container) {
  if (sourceWords.length === 0 || targetWords.length === 0) {
    return 0;
  }

  const sourceSet = new Set(sourceWords);
  const targetSet = new Set(targetWords);
  let overlap = 0;

  for (const word of sourceSet) {
    if (targetSet.has(word)) {
      overlap += 1;
    }
  }

  const overlapScore = overlap / sourceSet.size;
  const lengthRatio = Math.min(sourceText.length, targetText.length) / Math.max(sourceText.length, targetText.length);
  const rect = container instanceof HTMLElement ? container.getBoundingClientRect() : { width: 0, height: 0 };
  const areaPenalty = Math.min((rect.width * rect.height) / 250000, 1);
  return overlapScore * 0.75 + lengthRatio * 0.2 - areaPenalty * 0.1;
}

function findCurrentSceneContainer(anchor) {
  let current = anchor.parentElement;

  while (current && current !== document.body) {
    const text = normalizeText(current.textContent);
    if (
      text.includes(normalizeText(anchor.textContent)) &&
      text.length >= 40 &&
      current.querySelectorAll("*").length >= 3 &&
      isVisible(current)
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return anchor.parentElement;
}

function findVisibleLeafElements(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof HTMLElement)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (node.closest(`#${ROOT_ID}`)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (!isVisible(node)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (node.children.length > 0) {
        return NodeFilter.FILTER_SKIP;
      }

      if (!normalizeText(node.textContent)) {
        return NodeFilter.FILTER_SKIP;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const matches = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof HTMLElement) {
      matches.push(currentNode);
    }
    currentNode = walker.nextNode();
  }

  return matches;
}

function findVisibleTextBlocks(root) {
  return findVisibleLeafElements(root).filter((node) => {
    const text = normalizeText(node.textContent);
    if (!text) {
      return false;
    }

    if (node.hasAttribute(TRANSLATED_ATTR) || node.hasAttribute(META_TRANSLATED_ATTR)) {
      return false;
    }

    return true;
  });
}

function findCurrentSceneTextContainers(root) {
  const elements = Array.from(root.querySelectorAll("*")).filter(
    (node) => node instanceof HTMLElement,
  );

  const candidates = elements.filter((node) => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (node.closest(`#${ROOT_ID}`)) {
      return false;
    }

    if (!isVisible(node)) {
      return false;
    }

    if (node.hasAttribute(TRANSLATED_ATTR) || node.hasAttribute(META_TRANSLATED_ATTR)) {
      return false;
    }

    const text = extractSourceScriptText(node);
    if (!looksLikeCurrentSceneBody(text)) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 24) {
      return false;
    }

    if (rect.width > window.innerWidth * 0.9 || rect.height > window.innerHeight * 0.8) {
      return false;
    }

    return true;
  });

  return candidates.filter((node) => isPreferredTextContainer(node, candidates));
}

function isPreferredTextContainer(node, candidates) {
  const nodeText = extractSourceScriptText(node);
  if (!nodeText) {
    return false;
  }

  for (const candidate of candidates) {
    if (candidate === node) {
      continue;
    }

    if (!candidate.contains(node)) {
      continue;
    }

    const candidateText = extractSourceScriptText(candidate);
    if (candidateText === nodeText) {
      return false;
    }
  }

  return true;
}

function extractSourceScriptText(node) {
  if (node instanceof HTMLElement && node.dataset.gvstSourceText) {
    return normalizeText(node.dataset.gvstSourceText);
  }

  const clonedNode = node.cloneNode(true);
  if (!(clonedNode instanceof HTMLElement)) {
    return normalizeText(node.textContent);
  }

  clonedNode.querySelectorAll(
    [
      `[${TRANSLATED_ATTR}]`,
      "font.immersive-translate-target-wrapper",
      "[data-immersive-translate-translation-element-mark]",
      ".immersive-translate-target-wrapper",
      ".immersive-translate-target-translation-block-wrapper",
      ".immersive-translate-target-translation-inline-wrapper",
    ].join(","),
  ).forEach((element) => element.remove());

  return normalizeText(clonedNode.innerText || clonedNode.textContent);
}

function looksLikeEnglishSubtitle(text) {
  if (!text) {
    return false;
  }

  if (/current scene|all scenes|scene script translator|auto scan|hide panel|show panel/i.test(text)) {
    return false;
  }

  if (/[\u4e00-\u9fff]/.test(text)) {
    return false;
  }

  const alphaChars = (text.match(/[A-Za-z]/g) || []).length;
  if (alphaChars < 6) {
    return false;
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount < 2 || wordCount > 80) {
    return false;
  }

  return true;
}

function looksLikeCurrentSceneBody(text) {
  if (!looksLikeEnglishSubtitle(text)) {
    return false;
  }

  if (/^Scene\s+\d+\s*\/\s*\d+$/i.test(text)) {
    return false;
  }

  if (/^[\d\s/]+$/.test(text)) {
    return false;
  }

  const wordCount = text.split(/\s+/).length;
  return wordCount >= 8;
}

function looksLikeEnglishText(text) {
  if (!text) {
    return false;
  }

  if (/[\u4e00-\u9fff]/.test(text)) {
    return false;
  }

  const alphaChars = (text.match(/[A-Za-z]/g) || []).length;
  if (alphaChars < 6) {
    return false;
  }

  const wordCount = text.split(/\s+/).length;
  if (wordCount < 3 || wordCount > 120) {
    return false;
  }

  return true;
}

function queueTranslation(node, text, textHash) {
  const queueKey = `${textHash}:${text}`;
  if (state.translateQueue.has(queueKey) || state.translateInFlight.has(queueKey)) {
    return;
  }

  state.translateQueue.add(queueKey);
  node.setAttribute(PROCESSING_ATTR, "1");

  window.setTimeout(async () => {
    state.translateQueue.delete(queueKey);
    state.translateInFlight.add(queueKey);

    try {
      const translatedText = await translate(text);
      renderTranslation(node, translatedText, textHash);
    } catch (error) {
      console.error("[GVST] translate failed", error);
    } finally {
      node.removeAttribute(PROCESSING_ATTR);
      state.translateInFlight.delete(queueKey);
    }
  }, 60);
}

async function translate(text) {
  const response = await chrome.runtime.sendMessage({
    type: "translateText",
    text,
    sourceLang: "en",
    targetLang: "zh-CN",
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Unknown translation error");
  }

  return response.translatedText;
}

function renderTranslation(node, translatedText, textHash) {
  const host = findTranslationHost(node);
  const currentSceneMode = isCurrentSceneNode(node);
  let translatedBlock = findTranslatedBlock(node);
  if (!translatedBlock) {
    translatedBlock = document.createElement("div");
    translatedBlock.className = "gvst-translation";
    translatedBlock.setAttribute(TRANSLATED_ATTR, "1");
    if (currentSceneMode) {
      translatedBlock.classList.add("gvst-current-scene-translation");
      node.insertAdjacentElement("afterend", translatedBlock);
    } else {
      host.insertAdjacentElement("afterend", translatedBlock);
    }
  }

  translatedBlock.setAttribute(TEXT_HASH_ATTR, textHash);
  translatedBlock.textContent = translatedText;
}

function renderMetaTranslation(sourceText, translatedText, textHash) {
  syncTranslatedMetaContent(translatedText);

  let matchedCount = 0;
  for (const element of findElementsByExactText(sourceText)) {
    renderMetaTranslationBlock(element, translatedText, textHash);
    matchedCount += 1;
  }

  return matchedCount;
}

function renderMetaTranslationBlock(element, translatedText, textHash) {
  const existing = findAdjacentMetaTranslation(element);
  const block = existing || document.createElement("div");
  block.className = "gvst-meta-translation";
  block.setAttribute(META_TRANSLATED_ATTR, "1");
  block.setAttribute(TEXT_HASH_ATTR, textHash);
  block.textContent = translatedText;

  if (!existing) {
    element.insertAdjacentElement("afterend", block);
  }
}

function findTranslatedBlock(node) {
  if (isCurrentSceneNode(node)) {
    const sibling = node.nextElementSibling;
    if (sibling instanceof HTMLElement && sibling.hasAttribute(TRANSLATED_ATTR)) {
      return sibling;
    }
  }

  const host = findTranslationHost(node);
  const sibling = host.nextElementSibling;
  if (sibling instanceof HTMLElement && sibling.hasAttribute(TRANSLATED_ATTR)) {
    return sibling;
  }

  return null;
}

function findAdjacentMetaTranslation(node) {
  const sibling = node.nextElementSibling;
  if (sibling instanceof HTMLElement && sibling.hasAttribute(META_TRANSLATED_ATTR)) {
    return sibling;
  }

  return null;
}

function findTranslationHost(node) {
  const card = node.closest(CARD_SELECTOR);
  if (card instanceof HTMLElement) {
    return card;
  }

  return node;
}

function isCurrentSceneHost(node) {
  return node instanceof HTMLElement && !node.closest(CARD_SELECTOR);
}

function isCurrentSceneNode(node) {
  return node instanceof HTMLElement && (
    Boolean(node.dataset.gvstSourceText) || isCurrentSceneHost(node)
  );
}

function isManagedTranslationNode(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    node.closest(`#${ROOT_ID}`) ||
    node.closest(`[${TRANSLATED_ATTR}]`) ||
    node.closest(`[${META_TRANSLATED_ATTR}]`),
  );
}

function findMetaDescription() {
  return document.querySelector('meta[property="og:description"], meta[name="description"]');
}

function syncTranslatedMetaContent(translatedText) {
  const meta = findMetaDescription();
  if (!(meta instanceof HTMLMetaElement)) {
    return;
  }

  if (!meta.dataset.gvstOriginalContent) {
    meta.dataset.gvstOriginalContent = meta.content;
  }

  meta.content = translatedText;
}

function getMetaSourceText(meta) {
  if (!(meta instanceof HTMLMetaElement)) {
    return "";
  }

  return normalizeText(meta.dataset.gvstOriginalContent || meta.content);
}

function findElementsByExactText(sourceText) {
  const normalizedSource = normalizeText(sourceText);
  if (!normalizedSource) {
    return [];
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (!(node instanceof HTMLElement)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (node.closest(`#${ROOT_ID}`)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (node.children.length > 0) {
        return NodeFilter.FILTER_SKIP;
      }

      if (!isVisible(node)) {
        return NodeFilter.FILTER_SKIP;
      }

      if (normalizeText(node.textContent) !== normalizedSource) {
        return NodeFilter.FILTER_SKIP;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const matches = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode instanceof HTMLElement) {
      matches.push(currentNode);
    }
    currentNode = walker.nextNode();
  }

  return matches;
}

function isVisible(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }

  return String(hash);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
