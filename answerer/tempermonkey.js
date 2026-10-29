// ==UserScript==
// @name         Krillion Answer Indexer
// @namespace    krillion-local-indexer
// @version      0.3
// @description  Index best answers and 50 alternatives
// @match        https://playdaily.org/krillion*
// @icon         https://krillion.io/tiers/krillion-halloween-2026.png
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  // Chat-bot command prefix: players type "/<BOT_PREFIX> <command>".
  const BOT_PREFIX = "portik";
  // Shorter prefixes that work the same way, e.g. "/p ans".
  const BOT_PREFIX_ALIASES = ["p"];

  const DB_NAME = "krillion-answer-index";
  const STORE = "answers";
  const MAX_ARCHIVE = 50;
  const AFK_THRESHOLD = 3;

  const matches = new Map();
  const pending = new Map();
  const submittedAnswers = new Map();
  const inFlightAnswers = new Set();
  const roomModes = new Map();
  const roomClientIds = new Map();
  let currentRoom = null;

  function isClassicMatch(key) {
    const separator = key.lastIndexOf(":");
    if (separator === -1) {
      return false;
    }

    const room = key.slice(0, separator);

    return roomModes.get(room) === "classic";
  }

  function getKey(url) {
    const room = url.searchParams.get("room");
    const match = url.searchParams.get("match");
    return room && match ? `${room}:${match}` : null;
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, {
            keyPath: "promptId",
          });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const dbPromise = openDB();

  function normalize(answer) {
    return answer.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function toCandidate(row) {
    if (
      typeof row.a !== "string" ||
      !row.a.trim() ||
      typeof row.p !== "number" ||
      !Number.isFinite(row.p) ||
      row.p <= 0
    ) {
      return null;
    }
    return {
      answer: row.a.trim(),
      score: row.p,
      rarity: typeof row.t === "string" ? row.t : "",
    };
  }

  function mergeAnswers(existing, incoming) {
    const unique = new Map();

    function add(candidate) {
      if (!candidate || !candidate.answer) return;

      const key = normalize(candidate.answer);
      const previous = unique.get(key);

      if (!previous || candidate.score > previous.score) {
        unique.set(key, candidate);
      }
    }

    // Existing entries go first to preserve the
    // primary answer when scores are tied.
    if (existing) {
      add({
        answer: existing.bestAnswer || existing.answer,
        score: existing.bestScore ?? existing.score,
        rarity: existing.bestRarity || "",
      });

      for (const item of existing.archive || []) {
        add(item);
      }
    }

    for (const candidate of incoming) {
      add(candidate);
    }

    const ranked = [...unique.values()].sort((a, b) => b.score - a.score);

    return {
      best: ranked[0],
      archive: ranked.slice(1, MAX_ARCHIVE + 1),
    };
  }

  function helperUrl(promptId, category, { worst = false } = {}) {
    const url = new URL(
      "http://127.0.0.1:3001/helper/" + encodeURIComponent(promptId),
    );

    if (typeof category === "string" && category.trim()) {
      url.searchParams.set("cat", category.trim());
    }

    if (worst) {
      url.searchParams.set("worst", "1");
    }

    return url.toString();
  }

  async function savePrompt(prompt, candidates, key) {
    if (!isClassicMatch(key)) {
      return;
    }

    if (!candidates.length) return;

    // Keep the highest observed score per answer.
    const unique = new Map();

    for (const candidate of candidates) {
      const answer = candidate.answer.trim();
      const normalized = answer.replace(/\s+/g, " ").toLowerCase();

      const key = `${prompt.id}:${normalized}`;
      const previous = unique.get(key);

      if (!previous || candidate.score > previous.score) {
        unique.set(key, {
          key,
          answer,
          score: candidate.score,
        });
      }
    }

    // Only submit new or improved answers.
    // Also skip answers with requests already in progress.
    const pendingAnswers = [...unique.values()].filter((item) => {
      const savedScore = submittedAnswers.get(item.key);

      return (
        (savedScore === undefined || item.score > savedScore) &&
        !inFlightAnswers.has(item.key)
      );
    });

    if (!pendingAnswers.length) return;

    for (const item of pendingAnswers) {
      inFlightAnswers.add(item.key);
    }

    const payload = {
      promptId: prompt.id,
      question: prompt.text,
      category: typeof prompt.cat === "string" ? prompt.cat : null,
      answers: pendingAnswers.map((item) => ({
        answer: item.answer,
        score: item.score,
      })),
    };

    try {
      const response = await fetch("http://127.0.0.1:3001/index", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      // Mark as submitted ONLY after server success.
      for (const item of pendingAnswers) {
        const oldScore = submittedAnswers.get(item.key);

        if (oldScore === undefined || item.score > oldScore) {
          submittedAnswers.set(item.key, item.score);
        }
      }

      if (result.newAnswers || result.improvedAnswers) {
        console.log(
          `[Krillion] ${prompt.text}`,
          `| New: ${result.newAnswers}`,
          `| Improved: ${result.improvedAnswers}`,
        );
      }
    } catch (error) {
      console.error("[Krillion] Submission failed:", prompt.text, error);
    } finally {
      for (const item of pendingAnswers) {
        inFlightAnswers.delete(item.key);
      }
    }
  }

  function processRows(key, rows) {
    if (!isClassicMatch(key)) {
      return;
    }

    const prompts = matches.get(key);

    // If we haven't received the lineup yet,
    // save the results for later processing.
    if (!prompts) {
      const waiting = pending.get(key) || [];
      pending.set(key, [...waiting, ...rows].slice(-2000));
      return;
    }

    const grouped = new Map();
    const deferred = [];

    for (const row of rows) {
      if (!Number.isInteger(row.r)) {
        continue;
      }

      // Only process revealed, valid answers.
      if (
        typeof row.a !== "string" ||
        !row.a.trim() ||
        typeof row.p !== "number" ||
        !Number.isFinite(row.p) ||
        row.p <= 0
      ) {
        continue;
      }

      const prompt = prompts[row.r];

      // The lineup might not include this round yet.
      if (!prompt?.id || !prompt?.text) {
        deferred.push(row);
        continue;
      }

      if (!grouped.has(row.r)) {
        grouped.set(row.r, []);
      }

      grouped.get(row.r).push({
        answer: row.a.trim(),
        score: row.p,
        rarity: row.t || "",
      });
    }

    // Preserve results whose prompts haven't arrived yet.
    if (deferred.length > 0) {
      const waiting = pending.get(key) || [];

      pending.set(key, [...waiting, ...deferred].slice(-2000));
    }

    // Send each question's answers to the backend.
    for (const [round, candidates] of grouped) {
      const prompt = prompts[round];

      savePrompt(prompt, candidates, key).catch((error) => {
        console.error("[Krillion] Processing error:", error);
      });
    }
  }

  function handleData(urlString, data) {
    const url = new URL(urlString, location.href);
    const endpoint = url.pathname.split("/").pop();

    if (endpoint !== "lineup" && endpoint !== "results") return;

    const key = getKey(url);
    if (!key) return;

    if (endpoint === "lineup" && Array.isArray(data.prompts)) {
      const previous = matches.get(key) || [];

      if (data.prompts.length >= previous.length) {
        matches.set(key, data.prompts);
      }

      const waiting = pending.get(key);
      if (waiting?.length) {
        pending.delete(key);
        processRows(key, waiting);
      }

      console.log("[Krillion] Lineup:", key, data.prompts.length, "prompts");
    }

    if (endpoint === "results" && Array.isArray(data.rows)) {
      processRows(key, data.rows);

      // Allow AUTO-MODE to detect an accepted answer.
      window.krillionAuto?.onResults(key, data.rows);
    }
  }

  async function detectGameMode(requestUrl, input, options, promise) {
    const url = new URL(requestUrl, location.href);
    const rpc = url.pathname.split("/").pop();

    if (
      !url.pathname.includes("/rest/v1/rpc/") ||
      !/^krillion_.*_touch_seat$/.test(rpc)
    ) {
      return;
    }

    let payload;

    try {
      if (typeof options?.body === "string") {
        payload = JSON.parse(options.body);
      } else if (input instanceof Request) {
        payload = await input.clone().json();
      } else {
        return;
      }
    } catch (error) {
      console.warn("[Krillion] Cannot read seat payload", error);
      return;
    }

    const room = payload?.p_room_id;

    if (typeof room !== "string" || !room) {
      return;
    }

    // Immediately revoke any previous authorization.
    roomModes.delete(room);

    try {
      const response = await promise;

      if (!response.ok) {
        return;
      }

      currentRoom = room;

      if (rpc === "krillion_arena_touch_seat") {
        roomModes.set(room, "classic");
        if (typeof payload.p_client_id === "string") {
          roomClientIds.set(room, payload.p_client_id);
        }
        console.log(`[Krillion] Classic room verified: ${room}`);
        window.krillionAuto?.onSeatVerified(room);
      } else {
        roomModes.set(room, "other");
        roomClientIds.delete(room);
        console.log(`[Krillion] Ignoring ${rpc}: ${room}`);
      }
    } catch (error) {
      console.warn("[Krillion] Seat request failed", error);
    }
  }

  const originalFetch = window.fetch;

  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);

    try {
      const input = args[0];
      const requestUrl =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input?.url;

      if (!requestUrl) return promise;

      detectGameMode(requestUrl, args[0], args[1], promise).catch(
        console.error,
      );

      const url = new URL(requestUrl, location.href);
      const endpoint = url.pathname.split("/").pop();

      if (endpoint === "lineup" || endpoint === "results") {
        promise
          .then(async (response) => {
            if (!response.ok) return;
            const data = await response.clone().json();
            handleData(response.url || url.href, data);
          })
          .catch(console.warn);
      }
    } catch (error) {
      console.warn("[Krillion]", error);
    }

    return promise;
  };

  async function getAll() {
    const db = await dbPromise;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  window.krillionIndex = {
    getAll,

    async stats() {
      const records = await getAll();
      const totalAnswers = records.reduce(
        (sum, r) => sum + 1 + (r.archive || []).length,
        0,
      );

      const stats = {
        questions: records.length,
        answers: totalAnswers,
        perfectQuestions: records.filter(
          (r) => (r.bestScore ?? r.score) === 100,
        ).length,
        averageBestScore: records.length
          ? (
              records.reduce((sum, r) => sum + (r.bestScore ?? r.score), 0) /
              records.length
            ).toFixed(2)
          : 0,
      };

      console.table(stats);
      return stats;
    },

    async export() {
      const records = await getAll();
      const blob = new Blob([JSON.stringify(records, null, 2)], {
        type: "application/json",
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = "krillion-answers-v02.json";
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  function createAnswerHelper() {
    if (document.getElementById("kh-root")) {
      return;
    }

    const root = document.createElement("div");
    root.id = "kh-root";

    const style = document.createElement("style");
    style.textContent = `
        #kh-root {
            --kh-font: Georgia, serif;
            position: fixed;
            right: 20px;
            bottom: 20px;
            z-index: 2147483647;
            font-family: var(--kh-font);
            color: #eaf7ff;
        }

        #kh-root * {
            box-sizing: border-box;
        }

        #kh-panel {
            display: none;
            width: 380px;
            max-width: calc(100vw - 40px);
            max-height: 78vh;
            overflow: hidden;
            margin-bottom: 12px;
            border: 1px solid #32738a;
            border-radius: 18px;
            background-color: #071a2b;
            background-image:
                radial-gradient(
                    ellipse at 50% 0%,
                    rgba(49, 137, 164, 0.28),
                    transparent 60%
                ),
                linear-gradient(
                    180deg,
                    #10334b 0%,
                    #0a263b 40%,
                    #061522 100%
                );
            box-shadow:
                0 20px 65px rgba(0, 0, 0, 0.65),
                inset 0 1px rgba(180, 236, 255, 0.12);
            padding: 16px;
        }

        #kh-root .kh-header {
            text-align: center;
            margin-bottom: 16px;
            padding: 12px;
            border: 1px solid rgba(123, 203, 220, 0.20);
            border-radius: 12px;
            background: rgba(4, 22, 38, 0.35);
        }

        #kh-root .kh-eyebrow {
            font-family: var(--kh-font);
            font-size: 10px;
            letter-spacing: 2.5px;
            text-transform: uppercase;
            color: #79c9dc;
            margin-bottom: 9px;
        }

        #kh-root .kh-title {
            font-size: 19px;
            font-weight: 700;
            color: #f0fbff;
            margin-bottom: 8px;
        }

        #kh-root .kh-subtitle {
            font-size: 10px;
            letter-spacing: 1.5px;
            color: #8bb3c5;
        }

        #kh-root #kh-prompts {
            width: 100%;
            background: #102e43;
            color: #d8f3ff;
            border: 1px solid #32627b;
            border-radius: 8px;
            padding: 10px;
            font-family: var(--kh-font);
            font-size: 12px;
        }

        #kh-root #kh-toggle {
            display: block;
            margin-left: auto;
            padding: 10px 18px;
            border: 1px solid #32738a;
            border-radius: 999px;
            background: #10334b;
            color: #eaf7ff;
            font-family: var(--kh-font);
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
        }

        #kh-root #kh-refresh {
            margin-top: 8px;
            background: transparent;
            border: 1px solid #32627b;
            border-radius: 6px;
            color: #8dc9dd;
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
        }

        #kh-root #kh-status {
            margin: 12px 0;
            text-align: center;
            font-size: 11px;
            letter-spacing: 0.5px;
            color: #94b8c9;
        }

        #kh-root #kh-results {
            display: flex;
            flex-direction: column;
            gap: 7px;
            max-height: 42vh;
            overflow-y: auto;
            padding: 2px 5px 2px 0;
            scrollbar-width: thin;
            scrollbar-color: #39788b transparent;
        }

        #kh-root .kh-answer {
            --tone: #aec4cf;
            --tint: rgba(140, 163, 180, 0.10);

            display: flex;
            align-items: center;
            justify-content: space-between;
            width: 100%;
            gap: 12px;
            padding: 11px 12px;
            border: 1px solid var(--tone);
            border-radius: 9px;
            background: var(--tint);
            color: var(--tone);
            font-family: var(--kh-font);
            text-align: left;
            cursor: pointer;
            transition:
                transform 120ms ease,
                filter 120ms ease,
                background 120ms ease;
        }

        #kh-root .kh-answer:hover {
            transform: none;
            filter: brightness(1.28);
        }

        #kh-root .kh-answer:active {
            transform: scale(0.985);
        }

        #kh-root .kh-answer-name {
            font-size: 14px;
            font-weight: 600;
            overflow-wrap: anywhere;
        }

        #kh-root .kh-answer-tier {
            font-size: 9px;
            opacity: 0.8;
            letter-spacing: 1px;
            margin-top: 4px;
            text-transform: uppercase;
        }

        #kh-root .kh-score {
            flex-shrink: 0;
            text-align: right;
        }

        #kh-root .kh-score-number {
            display: block;
            font-size: 21px;
            font-weight: 800;
            line-height: 1;
        }

        #kh-root .kh-score-label {
            display: block;
            font-size: 9px;
            letter-spacing: 1px;
            margin-top: 4px;
        }

        /* Exact Krillion rarity colors */

        #kh-root .kh-answer[data-tier="0"] {
            --tone: #5b87f5;
            --tint: rgba(91, 135, 245, 0.12);
        }

        #kh-root .kh-answer[data-tier="1"] {
            --tone: #4de3ff;
            --tint: rgba(77, 227, 255, 0.12);
        }

        #kh-root .kh-answer[data-tier="2"] {
            --tone: #5ad07a;
            --tint: rgba(90, 208, 122, 0.12);
        }

        #kh-root .kh-answer[data-tier="3"] {
            --tone: #ff9f43;
            --tint: rgba(255, 159, 67, 0.12);
        }

        #kh-root .kh-answer[data-tier="4"] {
            --tone: #ff5252;
            --tint: rgba(255, 82, 82, 0.12);
        }

        #kh-root .kh-answer[data-tier="5"] {
            --tone: #ffd166;
            --tint: rgba(255, 209, 102, 0.12);
        }

        /* Original-style pixel-art icons */

        #kh-root .kh-answer-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 40px;
        }

        #kh-root .kh-tier-icon {
            display: block;
            overflow: visible;
            flex-shrink: 0;
        }

        #kh-root .kh-tier-icon .kr-icon-body {
            fill: var(--tone);
        }

        #kh-root .kh-tier-icon .kr-icon-lit {
            fill: color-mix(in srgb, var(--tone) 65%, white);
        }

        #kh-root .kh-tier-icon .kr-icon-dark {
            fill: color-mix(in srgb, var(--tone) 55%, #00121f);
        }

        #kh-root .kh-tier-icon .kr-icon-white {
            fill: #fff;
        }

        #kh-root .kh-tier-icon .kr-icon-halo {
            fill: color-mix(in srgb, var(--tone) 45%, transparent);
        }
        
        /* Larger, more readable answer cards */

        #kh-root .kh-answer {
            min-height: 76px;
            padding: 13px 14px;
            gap: 14px;
            text-align: left;
            justify-content: flex-start;
        }

        /* Keep the icon on the left */
        #kh-root .kh-answer-icon {
            flex: 0 0 42px;
        }

        /* Answer text occupies available space */
        #kh-root .kh-answer-info {
            display: flex;
            flex: 1 1 auto;
            min-width: 0;
            flex-direction: column;
            align-items: flex-start;
            justify-content: center;
            text-align: left;
        }

        /* Main answer name */
        #kh-root .kh-answer-name {
            width: 100%;
            font-size: 18px;
            font-weight: 700;
            line-height: 1.35;
            text-align: left;
        }

        /* Rarity label */
        #kh-root .kh-answer-tier {
            font-size: 11px;
            letter-spacing: 1px;
            margin-top: 6px;
            text-align: left;
        }

        /* Score stays on the right */
        #kh-root .kh-score {
            flex: 0 0 auto;
            margin-left: auto;
            text-align: right;
        }

        #kh-root .kh-score-number {
            font-size: 25px;
        }

        #kh-root .kh-score-label {
            font-size: 11px;
        }

        /* Improve other popup text */
        #kh-root .kh-title {
            font-size: 21px;
        }

        #kh-root #kh-prompts {
            font-size: 14px;
        }

        #kh-root #kh-status {
            font-size: 13px;
        }

        /* Krillion AUTO-MODE toggle */

        #kh-root .kh-auto-control {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            margin: 12px 0 6px;
            color: #d7f3ff;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 1px;
            cursor: pointer;
        }

        #kh-root .kh-switch {
            position: absolute;
            width: 1px;
            height: 1px;
            opacity: 0;
        }

        #kh-root .kh-auto-track {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 26px;
            border: 1px solid #53849a;
            border-radius: 20px;
            background: #243e50;
            transition: background 150ms ease;
        }

        #kh-root .kh-auto-track::before {
            content: "";
            position: absolute;
            top: 3px;
            left: 3px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #effbff;
            transition: transform 150ms ease;
        }

        #kh-root .kh-switch:checked + .kh-auto-track {
            background: #238c64;
            border-color: #5ad07a;
        }

        #kh-root .kh-switch:checked + .kh-auto-track::before {
            transform: translateX(22px);
        }

        #kh-root .kh-switch:focus-visible + .kh-auto-track {
            outline: 2px solid #ffd166;
            outline-offset: 3px;
        }

        #kh-root #kh-auto-status {
            display: none;
        }
    `;

    root.innerHTML = `
        <div id="kh-panel">
            <h3 style="margin:0 0 12px">
                Krillion Answer Helper
            </h3>
            <label class="kh-auto-control">
                <span>AUTO-MODE</span>

                <input
                    id="kh-auto-switch"
                    class="kh-switch"
                    type="checkbox"
                    role="switch"
                >

                <span class="kh-auto-track"></span>
            </label>
            <label class="kh-auto-control">
                <span>CHAT-BOT</span>

                <input
                    id="kh-chatbot-switch"
                    class="kh-switch"
                    type="checkbox"
                    role="switch"
                >

                <span class="kh-auto-track"></span>
            </label>
            <div id="kh-auto-status">Disabled</div>
            <select id="kh-prompts">
                <option value="">Select a question...</option>
            </select>

            <button id="kh-refresh"
                    style="margin-top:8px">
                Refresh questions
            </button>

            <div id="kh-status">
                Select a question to find answers.
            </div>

            <div id="kh-results"></div>
        </div>

        <button id="kh-toggle">
            Answers
        </button>
    `;

    function mount() {
      if (!style.isConnected) {
        (document.head || document.documentElement).appendChild(style);
      }
      if (!root.isConnected) {
        document.body.appendChild(root);
      }
    }

    mount();

    const panel = root.querySelector("#kh-panel");
    const toggle = root.querySelector("#kh-toggle");
    const select = root.querySelector("#kh-prompts");
    const results = root.querySelector("#kh-results");
    const status = root.querySelector("#kh-status");

    const autoSwitch = root.querySelector("#kh-auto-switch");
    const autoStatus = root.querySelector("#kh-auto-status");
    const chatBotSwitch = root.querySelector("#kh-chatbot-switch");

    const AUTO_DELAY = 5000;
    const RETRY_DELAY = 2500;

    const TIER_NAMES = [
      "Plankton",
      "Too Clever",
      "Schooler",
      "Rare",
      "Deep Cut",
      "One in a Krillion",
    ];

    let autoRound = null;

    const afk = {
      matchKey: null,
      firstRound: null,
      lastRound: null,
      unanswered: 0,
      answeredRounds: new Set(),
    };

    function resetAfkStreak() {
      afk.matchKey = null;
      afk.firstRound = null;
      afk.lastRound = null;
      afk.unanswered = 0;
      afk.answeredRounds.clear();
    }

    function trackAfkRound(matchKey, roundIndex) {
      if (
        !autoSwitch.checked ||
        !Number.isInteger(roundIndex) ||
        roundIndex < 0
      ) {
        return false;
      }

      // A new match starts a fresh streak.
      if (afk.matchKey !== matchKey) {
        resetAfkStreak();
        afk.matchKey = matchKey;
        afk.firstRound = roundIndex;
        afk.lastRound = roundIndex;
        return true;
      }

      // Ignore old cards still visible during animations.
      if (roundIndex < afk.lastRound) {
        return false;
      }

      // Same round, no additional counting.
      if (roundIndex === afk.lastRound) {
        return true;
      }

      const previous = afk.lastRound;

      if (roundIndex === previous + 1) {
        if (afk.answeredRounds.has(previous)) {
          afk.unanswered = 0;
        } else {
          afk.unanswered++;
        }
      } else {
        // Missed round transitions: don't guess.
        afk.unanswered = 0;
      }

      afk.lastRound = roundIndex;

      console.log(
        `[Krillion AFK] Unanswered streak: ` +
          `${afk.unanswered}/${AFK_THRESHOLD}`,
      );

      return true;
    }

    function trackAfkResults(matchKey, rows) {
      if (!autoSwitch.checked || afk.matchKey !== matchKey) {
        return;
      }

      const room = matchKey.slice(0, matchKey.lastIndexOf(":"));

      const clientId = roomClientIds.get(room);

      if (!clientId) {
        return;
      }

      for (const row of rows) {
        const answered =
          row.i === clientId &&
          Number.isInteger(row.r) &&
          row.r >= afk.firstRound &&
          [4, 8, 16, 32, 64, 100].includes(row.p);

        if (!answered || afk.answeredRounds.has(row.r)) {
          continue;
        }

        afk.answeredRounds.add(row.r);

        // Only a confirmed scored answer resets the streak.
        afk.unanswered = 0;

        console.log(
          `[Krillion AFK] Answer confirmed ` +
            `in round ${row.r}. Streak reset.`,
        );
      }
    }

    function setAutoStatus(message) {
      autoStatus.textContent = message;
    }

    function stopAutoRound() {
      if (autoRound?.timer) {
        clearTimeout(autoRound.timer);
      }

      autoRound = null;
    }

    function getGameInput() {
      return [...document.querySelectorAll("input.kr-input")].find(
        (input) =>
          input.getClientRects().length > 0 &&
          !input.disabled &&
          !input.readOnly,
      );
    }

    function getVisibleQuestion() {
      const elements = [
        ...document.querySelectorAll(".kr-card .kr-prompt"),
      ].filter((element) => element.getClientRects().length > 0);

      const element = elements.at(-1);

      return element ? normalizeQuestion(element.textContent || "") : "";
    }

    function isAutoRoundActive(round) {
      return (
        autoSwitch.checked &&
        autoRound === round &&
        !round.accepted &&
        isClassicMatch(round.matchKey) &&
        lastDetectedPrompt === `${round.matchKey}:${round.promptId}` &&
        getVisibleQuestion() === normalizeQuestion(round.question)
      );
    }

    // Shared by manual clicks and AUTO-MODE.
    async function submitGameAnswer(answer, guard = () => true) {
      const input = getGameInput();

      if (!input || !guard()) {
        return false;
      }

      if (input.maxLength >= 0 && answer.length > input.maxLength) {
        return false;
      }

      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;

      input.focus();

      if (setter) {
        setter.call(input, answer);
      } else {
        input.value = answer;
      }

      input.dispatchEvent(
        new Event("input", {
          bubbles: true,
        }),
      );

      // Allow the site's input handler to update.
      await new Promise((resolve) => setTimeout(resolve, 75));

      if (!guard() || !input.isConnected || input.disabled) {
        return false;
      }

      const form = input.closest("form");

      if (form) {
        form.requestSubmit();
      } else {
        // Matches our previous manual Enter approach.
        const options = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        };

        input.dispatchEvent(new KeyboardEvent("keydown", options));

        input.dispatchEvent(new KeyboardEvent("keyup", options));
      }

      return true; // Submission attempted, not confirmed.
    }

    function scheduleAutoAttempt(round, delay) {
      if (!isAutoRoundActive(round)) {
        return;
      }

      clearTimeout(round.timer);

      round.timer = setTimeout(() => {
        attemptAutoAnswer(round).catch((error) => {
          console.error("[Krillion Auto]", error);
          setAutoStatus("Submission error");
        });
      }, delay);
    }

    async function attemptAutoAnswer(round) {
      if (!isAutoRoundActive(round)) {
        return;
      }

      const input = getGameInput();

      if (!input) {
        setAutoStatus("Answer input unavailable");
        return;
      }

      const remaining = round.answers.filter((item) => {
        const key = normalizeQuestion(item.answer);

        return (
          !round.tried.has(key) &&
          (input.maxLength < 0 || item.answer.length <= input.maxLength)
        );
      });

      if (!remaining.length) {
        setAutoStatus("No untried answers remaining");
        return;
      }

      // Highest score among the untried answers.
      const highestScore = Math.max(...remaining.map((item) => item.score));

      // Randomly select among answers with that score.
      const tied = remaining.filter((item) => item.score === highestScore);

      const selected = tied[Math.floor(Math.random() * tied.length)];

      const answerKey = normalizeQuestion(selected.answer);

      const attempted = await submitGameAnswer(selected.answer, () =>
        isAutoRoundActive(round),
      );

      if (!isAutoRoundActive(round)) {
        return;
      }

      if (!attempted) {
        setAutoStatus("Waiting for available input");
        scheduleAutoAttempt(round, 1000);
        return;
      }

      round.tried.add(answerKey);

      console.log(
        `[Krillion Auto] Attempted: ${selected.answer} ` +
          `(${selected.score} pts)`,
      );

      setAutoStatus(`Tried: ${selected.answer} (${selected.score} pts)`);

      // If the game confirms acceptance before this
      // timer fires, onResults() will cancel it.
      scheduleAutoAttempt(round, RETRY_DELAY);
    }

    function scheduleAIFallback(round) {
      if (!isAutoRoundActive(round)) {
        return;
      }

      // No fallback before six unanswered questions.
      if (afk.unanswered < AFK_THRESHOLD) {
        setAutoStatus("No database answers");
        return;
      }

      // Never schedule the same question twice.
      if (round.aiScheduled || round.aiAttempted) {
        return;
      }

      round.aiScheduled = true;

      // Keep the original five-second waiting period.
      const delay = Math.max(0, AUTO_DELAY - (Date.now() - round.startedAt));

      setAutoStatus("AI fallback scheduled");

      round.timer = setTimeout(() => {
        requestAIFallback(round).catch((error) => {
          console.error("[Krillion AI]", error);
        });
      }, delay);
    }

    async function requestAIFallback(round) {
      if (
        !isAutoRoundActive(round) ||
        round.aiAttempted ||
        afk.unanswered < AFK_THRESHOLD
      ) {
        return;
      }

      // Set this BEFORE the API request.
      // A failure must not cause another request
      // for the same question.
      round.aiAttempted = true;

      setAutoStatus("Generating AI answer...");

      try {
        const response = await fetch("http://127.0.0.1:3001/ai-answer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: round.question,
          }),
        });

        if (!isAutoRoundActive(round)) {
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        const answer =
          typeof data.answer === "string" ? data.answer.trim() : "";

        if (!answer || answer.length > 80) {
          throw new Error("No usable AI answer");
        }

        // Prevent a late AI response from submitting
        // to a different question.
        const attempted = await submitGameAnswer(answer, () =>
          isAutoRoundActive(round),
        );

        if (!isAutoRoundActive(round)) {
          return;
        }

        if (attempted) {
          round.tried.add(normalizeQuestion(answer));

          setAutoStatus(`AI attempted: ${answer}`);

          console.log(`[Krillion AI] Attempted: ${answer}`);
        } else {
          setAutoStatus("AI submission unavailable");
        }

        // No retry in this round, whether the
        // answer was accepted or rejected.
      } catch (error) {
        console.warn(
          `[Krillion AI] Failed for ` + `"${round.question}": ${error.message}`,
        );

        if (isAutoRoundActive(round)) {
          setAutoStatus("AI failed. Skipping until next question.");
        }

        // Important:
        // Do not reset the AFK streak.
        // Do not schedule another attempt here.
      }
    }

    async function startAutoRound(matchKey, prompt, roundIndex) {
      // Don't restart a running cycle for the same prompt.
      if (
        autoRound &&
        autoRound.matchKey === matchKey &&
        autoRound.promptId === prompt.id
      ) {
        return;
      }

      stopAutoRound();

      if (!autoSwitch.checked || !isClassicMatch(matchKey)) {
        return;
      }

      const room = matchKey.slice(0, matchKey.lastIndexOf(":"));

      if (!roomClientIds.has(room)) {
        setAutoStatus("Waiting for seat verification");
        return;
      }

      const round = {
        matchKey,
        promptId: prompt.id,
        question: prompt.text,
        roundIndex,
        startedAt: Date.now(),
        answers: [],
        tried: new Set(),
        accepted: false,
        timer: null,
      };

      autoRound = round;
      setAutoStatus("Loading answers...");

      try {
        const response = await fetch(helperUrl(prompt.id, prompt.cat));

        if (!isAutoRoundActive(round)) {
          return;
        }

        if (response.status === 404) {
          scheduleAIFallback(round);
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!isAutoRoundActive(round)) {
          return;
        }

        const unique = new Map();

        for (const item of data.answers || []) {
          if (
            typeof item.answer !== "string" ||
            !item.answer.trim() ||
            !Number.isFinite(item.score)
          ) {
            continue;
          }

          const key = normalizeQuestion(item.answer);
          const old = unique.get(key);

          if (!old || item.score > old.score) {
            unique.set(key, {
              answer: item.answer.trim(),
              score: item.score,
            });
          }
        }

        round.answers = [...unique.values()];

        if (!round.answers.length) {
          scheduleAIFallback(round);
          return;
        }

        // Five seconds from detection, not five
        // additional seconds after the API responds.
        const remainingDelay = Math.max(
          0,
          AUTO_DELAY - (Date.now() - round.startedAt),
        );

        setAutoStatus(
          data.source === "category"
            ? `Ready: ${round.answers.length} answers (category "${data.category}")`
            : `Ready: ${round.answers.length} answers`,
        );

        scheduleAutoAttempt(round, remainingDelay);
      } catch (error) {
        if (autoRound === round) {
          console.error("[Krillion Auto]", error);
          setAutoStatus("Backend unavailable");
        }
      }
    }

    function onAutoResults(key, rows) {
      trackAfkResults(key, rows);

      const round = autoRound;

      if (!round || round.matchKey !== key || !isAutoRoundActive(round)) {
        return;
      }

      const room = key.slice(0, key.lastIndexOf(":"));
      const clientId = roomClientIds.get(room);

      if (!clientId) {
        return;
      }

      // Look for our own successful result
      // in the current round.
      const accepted = rows.find(
        (row) =>
          row.i === clientId &&
          row.r === round.roundIndex &&
          [4, 8, 16, 32, 64, 100].includes(row.p),
      );

      if (!accepted) {
        return;
      }

      round.accepted = true;
      clearTimeout(round.timer);

      setAutoStatus(`Accepted: ${accepted.p} points`);

      console.log(`[Krillion Auto] Answer accepted: ` + `${accepted.p} points`);
    }

    // Expose only the result notification hook.
    window.krillionAuto = {
      onResults: onAutoResults,
      onSeatVerified(room) {
        scheduleWelcome(room);

        if (autoSwitch.checked) {
          detectActivePrompt(true);
        }
      },
    };

    autoSwitch.checked = false;

    autoSwitch.addEventListener("change", () => {
      stopAutoRound();
      resetAfkStreak();

      if (!autoSwitch.checked) {
        setAutoStatus("Disabled");
        return;
      }

      setAutoStatus("Enabled");
      detectActivePrompt(true);
    });

    // ===== CHAT-BOT =====

    const BOT_COMMAND = `/${BOT_PREFIX}`;
    const ESCAPED_PREFIX = [BOT_PREFIX, ...BOT_PREFIX_ALIASES]
      .map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const CHAT_PREFIX = new RegExp(
      `^\\/(?:${ESCAPED_PREFIX})(?:\\s+(\\S+))?(?:\\s|$)`,
      "i",
    );
    const CHAT_SAY = new RegExp(
      `^\\/(?:${ESCAPED_PREFIX})\\s+say\\s+(.+)$`,
      "i",
    );
    const CHAT_COMMANDS = [
      "ans",
      "say",
      "lang",
      "mute",
      "unmute",
      "stats",
      "about",
      "help",
    ];
    // Alternative command words, e.g. "/p answer" works like "/p ans".
    const CHAT_COMMAND_ALIASES = { answer: "ans" };
    const CHAT_LANGUAGES = [
      "english",
      "klingon",
      "mandarin",
      "indian",
      "ido",
      "krillish",
    ];
    const KRILLISH_WORDS = [
      "abulele",
      "assfish",
      "kirk's dik dik",
      "big yahu",
      "john morgan",
      "/p say",
      "dead body",
      "joe mama",
    ];
    const CHAT_TRANSLATIONS = {
      klingon: [
        ["I am not sure...", "jIyajbe'..."],
        ["I know! its", "vISov! 'oH"],
        [" thats for muting me :(", " jIghImmo' 'oH :("],
        ["answers are already muted", "jangmey tlhaplu'taH"],
        [" left).", " mevta'.)"],
        ["I was muted recently, ", "ghorgh jIghImpu'... "],
        ["mute is available again in ", "ghImqa'laHmeH poH: "],
        ["OK, no answers for ", "lu', jangbe' "],
        ["Other commands still work.", "latlh ra' QaptaH."],
        ["answers are not muted.", "jangmey tlhapbe'lu'."],
        ["unmute was used recently, ", "ghoghHa'pu'... "],
        ["try again in ", "qa'laH: "],
        ["OK, answers are back! Try ", "lu', jangmey chegh! "],
        ["cmds for ", "ra'mey: "],
        [" ans - the answer", " ans - jang"],
        [" | say <text> - I repeat it", " | say <text> - vIjatlhqa'"],
        [" | mute - no answers ", " | mute - jangbe' "],
        [
          " | unmute - answers back (every ",
          " | unmute - jangmey chegh (motlh ",
        ],
        [" | stats - bot stats", " | stats - bot mI'"],
        [" | about - who I am", " | about - jIH 'Iv"],
        [
          " | lang <language> - change language",
          " | lang <language> - choH Hol",
        ],
        ["Language changed to ", "choH Hol: "],
        ["Available languages: ", "Holmey: "],
        ["Unknown language. Choose: ", "Hol Sovbe'lu'. yIwIv: "],
        ["uptime ", "poH "],
        [" | answers given ", " | jangmey nobta' "],
        [" | unique users ", " | lo'wI' motlh "],
        [" | interactions ", " | jatlhmey "],
        [
          "I'm an answer bot. I remember answers from past rounds and can give you a top answer for the current question. Ask with ",
          "jIjangbogh bot jIH. pIqmey jangmey vIqaw. DaHjaj QIn jangmeH ",
        ],
        [
          "Hi, I'm an answer bot - I can tell you an answer for the current question. Type ",
          "nuqneH, jIjangbogh bot jIH. DaHjaj QIn janglaH. yIghItlh ",
        ],
        [" to see what I can do", " nuq vIlaH 'e' leghmeH"],
      ],
      mandarin: [
        ["I am not sure...", "我不确定……"],
        ["I know! its", "我知道！答案是"],
        [" thats for muting me :(", " 这是你禁言我的惩罚 :("],
        ["answers are already muted", "答案已经被禁用"],
        [" left).", " 后解除）。"],
        ["I was muted recently, ", "我刚才被禁言过，"],
        ["mute is available again in ", "还需等待才能再次禁言："],
        ["OK, no answers for ", "好的，暂停回答"],
        ["Other commands still work.", "其他命令仍可使用。"],
        ["answers are not muted.", "答案没有被禁用。"],
        ["unmute was used recently, ", "刚才已经解除过禁言，"],
        ["try again in ", "请稍后再试："],
        ["OK, answers are back! Try ", "好的，答案恢复了！试试"],
        ["cmds for ", "命令："],
        [" ans - the answer", " ans - 获取答案"],
        [" | say <text> - I repeat it", " | say <text> - 重复内容"],
        [" | mute - no answers ", " | mute - 暂停回答 "],
        [" | unmute - answers back (every ", " | unmute - 恢复回答（每隔"],
        [" | stats - bot stats", " | stats - 机器人统计"],
        [" | about - who I am", " | about - 关于机器人"],
        [
          " | lang <language> - change language",
          " | lang <language> - 更改语言",
        ],
        ["Language changed to ", "语言已更改为"],
        ["Available languages: ", "可用语言："],
        ["Unknown language. Choose: ", "未知语言。请选择："],
        ["uptime ", "运行时间 "],
        [" | answers given ", " | 已回答 "],
        [" | unique users ", " | 独立用户 "],
        [" | interactions ", " | 互动 "],
        [
          "I'm an answer bot. I remember answers from past rounds and can give you a top answer for the current question. Ask with ",
          "我是答题机器人，会记住之前回合的答案，并为当前问题提供热门答案。使用",
        ],
        [
          "Hi, I'm an answer bot - I can tell you an answer for the current question. Type ",
          "你好，我是答题机器人，可以回答当前问题。输入",
        ],
        [" to see what I can do", " 查看可用命令"],
      ],
      indian: [
        ["I am not sure...", "मुझे यक़ीन नहीं है..."],
        ["I know! its", "मुझे पता है! जवाब है"],
        [" thats for muting me :(", " मुझे म्यूट करने की सज़ा :("],
        ["answers are already muted", "जवाब पहले से म्यूट हैं"],
        [" left).", " बाकी)।"],
        ["I was muted recently, ", "मुझे हाल ही में म्यूट किया गया था, "],
        [
          "mute is available again in ",
          "फिर से म्यूट करने के लिए प्रतीक्षा करें: ",
        ],
        ["OK, no answers for ", "ठीक है, जवाब बंद "],
        ["Other commands still work.", "बाकी कमांड काम करेंगे।"],
        ["answers are not muted.", "जवाब म्यूट नहीं हैं।"],
        ["unmute was used recently, ", "हाल ही में अनम्यूट किया गया था, "],
        ["try again in ", "फिर कोशिश करें: "],
        ["OK, answers are back! Try ", "ठीक है, जवाब फिर शुरू! आज़माएँ "],
        ["cmds for ", "कमांड: "],
        [" ans - the answer", " ans - जवाब"],
        [" | say <text> - I repeat it", " | say <text> - मैं इसे दोहराऊँगा"],
        [" | mute - no answers ", " | mute - जवाब बंद "],
        [" | unmute - answers back (every ", " | unmute - जवाब चालू (हर "],
        [" | stats - bot stats", " | stats - बॉट आँकड़े"],
        [" | about - who I am", " | about - मेरे बारे में"],
        [
          " | lang <language> - change language",
          " | lang <language> - भाषा बदलें",
        ],
        ["Language changed to ", "भाषा बदलकर "],
        ["Available languages: ", "उपलब्ध भाषाएँ: "],
        ["Unknown language. Choose: ", "अज्ञात भाषा। चुनें: "],
        ["uptime ", "चलने का समय "],
        [" | answers given ", " | दिए गए जवाब "],
        [" | unique users ", " | अलग-अलग उपयोगकर्ता "],
        [" | interactions ", " | बातचीत "],
        [
          "I'm an answer bot. I remember answers from past rounds and can give you a top answer for the current question. Ask with ",
          "मैं जवाब देने वाला बॉट हूँ। मुझे पिछले राउंड के जवाब याद रहते हैं और मैं मौजूदा सवाल का लोकप्रिय जवाब दे सकता हूँ। पूछें ",
        ],
        [
          "Hi, I'm an answer bot - I can tell you an answer for the current question. Type ",
          "नमस्ते, मैं जवाब देने वाला बॉट हूँ। मौजूदा सवाल का जवाब देने के लिए लिखें ",
        ],
        [" to see what I can do", " और कमांड देखें"],
      ],
      ido: [
        ["I am not sure...", "Me ne esas certa..."],
        ["I know! its", "Me savas! Lua"],
        [" thats for muting me :(", " to esas pro ke tu mutigis me :("],
        ["answers are already muted", "respondi esas ja mutigita"],
        [" left).", " ankore)."],
        ["I was muted recently, ", "On mutigis me recente, "],
        ["mute is available again in ", "mute itere posiblos pos "],
        ["OK, no answers for ", "Bone, nula respondo dum "],
        ["Other commands still work.", "Altra komandi funcionas ankore."],
        ["answers are not muted.", "respondi ne esas mutigita."],
        ["unmute was used recently, ", "On demutigis recente, "],
        ["try again in ", "probisez itere pos "],
        ["OK, answers are back! Try ", "Bone, respondi retrovenas! Probez "],
        ["cmds for ", "komandi por "],
        [" ans - the answer", " ans - la respondo"],
        [" | say <text> - I repeat it", " | say <text> - me ripetos ol"],
        [" | mute - no answers ", " | mute - nula respondi dum "],
        [
          " | unmute - answers back (every ",
          " | unmute - respondi retrovenas (singla ",
        ],
        [" | stats - bot stats", " | stats - statistiki"],
        [" | about - who I am", " | about - pri me"],
        [
          " | lang <language> - change language",
          " | lang <language> - chanjar la linguo",
        ],
        ["Language changed to ", "La linguo chanjesis a "],
        ["Available languages: ", "Disponebla linguo: "],
        ["Unknown language. Choose: ", "Nekonocata linguo. Elekt ez: "],
        ["uptime ", "dur-tempo "],
        [" | answers given ", " | donita respondi "],
        [" | unique users ", " | diversa uzanti "],
        [" | interactions ", " | interagadi "],
        [
          "I'm an answer bot. I remember answers from past rounds and can give you a top answer for the current question. Ask with ",
          "Me esas respondanta roboto. Me memoras respondi de pasinta rondi e povas donar la maxim populara respondo a la nuna questiono. Demandez per ",
        ],
        [
          "Hi, I'm an answer bot - I can tell you an answer for the current question. Type ",
          "Saluto! Me esas respondanta roboto e povas respondar la nuna questiono. Skribez ",
        ],
        [" to see what I can do", " por vidar mea komandi"],
      ],
    };
    let chatLanguage = "english";
    const KRILLISH_PROTECTED_COMMANDS = new Set([
      "ans",
      "say",
      "lang",
      "mute",
      "unmute",
      "stats",
      "about",
      "help",
      "english",
      "klingon",
      "mandarin",
      "indian",
      "ido",
      "krillish",
    ]);

    function formatChatText(text, translate = true) {
      if (chatLanguage === "krillish") {
        return text.replace(
          /\/(?:portik|p)\b|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/giu,
          (word) =>
            word.startsWith("/") ||
            KRILLISH_PROTECTED_COMMANDS.has(word.toLowerCase())
              ? word
              : KRILLISH_WORDS[
                  Math.floor(Math.random() * KRILLISH_WORDS.length)
                ],
        );
      }

      const translations = translate && CHAT_TRANSLATIONS[chatLanguage];

      if (!translations) {
        return text;
      }

      return translations.reduce(
        (result, [english, translated]) =>
          result.split(english).join(translated),
        text,
      );
    }
    const CHAT_MAX_LENGTH = 200; // Krillion's CHAT_MAX_LENGTH
    const CHAT_GAP = 5000; // Krillion requires at least 2200ms between messages
    const CHAT_REFUSED_TEXT =
      "That message wasn't sent. Keep the chat friendly.";
    // Krillion shows its refusal notice at most once per 4000ms.
    const CHAT_REFUSED_NOTICE_GAP = 4000;
    // Pause before sending anything after a refused message.
    const CHAT_REFUSED_PAUSE = 5000;
    // A mute only blocks the "ans" command.
    const CHAT_MUTE_MS = 3 * 60 * 1000;
    // Nobody can mute again until answers were back this long.
    const CHAT_MUTE_COOLDOWN = 5 * 60 * 1000;
    const CHAT_UNMUTE_COOLDOWN = 10 * 60 * 1000;
    // The player whose mute took effect gets the worst answers until
    // this long after the mute ends (expired or unmuted).
    const CHAT_MUTE_PENALTY_MS = 5 * 60 * 1000;
    const CHAT_MUTE_TAUNT_DELAY = 5000;
    const CHAT_USER_COOLDOWN = 10000;
    // Identical command text from anyone is ignored for this long.
    const CHAT_DUPLICATE_COOLDOWN = 7000;
    const CHAT_QUEUE_LIMIT = 5;
    // More new lines than this in one scan means a history load or re-render.
    const CHAT_BULK_LIMIT = 5;
    // How long the last seen question stays valid after its card is hidden.
    const LAST_PROMPT_MAX_AGE = 2 * 60 * 1000;
    const CHAT_HELP =
      `cmds for ${BOT_COMMAND}` +
      (BOT_PREFIX_ALIASES.length ? ` (or /${BOT_PREFIX_ALIASES[0]}):` : ":") +
      " ans - the answer" +
      " | say <text> - I repeat it" +
      ` | mute - no answers ${formatWait(CHAT_MUTE_MS)}` +
      ` | unmute - answers back (every ${formatWait(CHAT_UNMUTE_COOLDOWN)})` +
      " | stats - bot stats" +
      " | about - who I am" +
      " | lang <language> - change language";
    // No punctuation right after commands: players copy "help!" literally.
    const WELCOME_MESSAGE =
      "Hi, I'm an answer bot - I can tell you an answer for the current " +
      `question. Type ${BOT_COMMAND} help to see what I can do`;
    const CHAT_ABOUT =
      "I'm an answer bot. I remember answers from past rounds and can " +
      "give you a top answer for the current question. " +
      `Ask with ${BOT_COMMAND} ans, all commands: ${BOT_COMMAND} help`;
    const WELCOME_DELAY = 5000;
    const WELCOME_REPEAT = 15 * 60 * 1000;

    const seenChatLines = new WeakSet();
    const knownChatLogs = new WeakSet();
    const chatUserLastCommand = new Map();
    const chatCommandLastAccepted = new Map();
    let chatLastMuter = null;
    const chatQueue = [];
    let chatSending = false;
    let chatMutedUntil = -Infinity;
    let chatLastUnmuteAt = -Infinity;
    let lastChatSentAt = 0;
    let chatPausedUntil = 0;
    let lastChatRefusalAt = -Infinity;
    let chatScanTimer = null;

    // Session statistics for "/<prefix> stats" (reset on page reload).
    const chatStats = {
      enabledAt: null,
      answersGiven: 0,
      interactions: 0,
      users: new Set(),
    };

    function formatUptime(ms) {
      const total = Math.floor(ms / 1000);
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;

      if (days) return `${days}d ${hours}h ${minutes}m`;
      if (hours) return `${hours}h ${minutes}m`;
      if (minutes) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    }

    function describeStats() {
      const uptime = chatStats.enabledAt
        ? formatUptime(Date.now() - chatStats.enabledAt)
        : "0s";

      return (
        `uptime ${uptime}` +
        ` | answers given ${chatStats.answersGiven}` +
        ` | unique users ${chatStats.users.size}` +
        ` | interactions ${chatStats.interactions}`
      );
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function isAnswersMuted() {
      return Date.now() < chatMutedUntil;
    }

    function formatWait(ms) {
      const seconds = Math.max(1, Math.ceil(ms / 1000));

      return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
    }

    function setReactInputValue(input, value) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;

      if (setter) {
        setter.call(input, value);
      } else {
        input.value = value;
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function getChatControls() {
      for (const form of document.querySelectorAll("form.kr-chat-bar")) {
        const field = form.querySelector("input.kr-chat-field");

        if (field && !field.disabled && !field.readOnly) {
          return {
            form,
            field,
            button: form.querySelector(".kr-chat-send"),
          };
        }
      }

      return null;
    }

    function getRefusalNotices() {
      return [...document.querySelectorAll(".kr-chat-sys")].filter(
        (line) => line.textContent.trim() === CHAT_REFUSED_TEXT,
      );
    }

    // Resolves to "sent", "refused" (blocked by Krillion's chat filter)
    // or "failed" (chat unavailable).
    async function sendChatMessage(text) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait =
          Math.max(lastChatSentAt + CHAT_GAP, chatPausedUntil) - Date.now();

        if (wait > 0) {
          await sleep(wait);
        }

        if (!chatBotSwitch.checked) {
          return "failed";
        }

        const controls = getChatControls();

        if (!controls || controls.button?.hasAttribute("data-cooling")) {
          await sleep(1000);
          continue;
        }

        const { form, field } = controls;

        // Preserve anything the user is typing in chat.
        const draft = field.value === text ? "" : field.value;
        const noticesBefore = new Set(getRefusalNotices());

        setReactInputValue(field, text);

        // Allow React to apply the new draft.
        await sleep(50);

        form.requestSubmit();

        await sleep(150);

        // Krillion clears the field only when the send is accepted.
        const sent = field.value !== text;

        if (field.isConnected && (draft || !sent)) {
          setReactInputValue(field, draft);
        }

        if (sent) {
          lastChatSentAt = Date.now();
          return "sent";
        }

        // The notice is skipped when the last refusal was under 4s ago.
        const now = Date.now();
        const refused =
          getRefusalNotices().some((line) => !noticesBefore.has(line)) ||
          now - lastChatRefusalAt < CHAT_REFUSED_NOTICE_GAP;

        if (refused) {
          lastChatRefusalAt = now;
          return "refused";
        }

        // Rejected silently: we sent too soon, so wait and try again.
        lastChatSentAt = now;
      }

      return "failed";
    }

    async function pumpChatQueue() {
      if (chatSending) {
        return;
      }

      chatSending = true;

      try {
        while (chatQueue.length && chatBotSwitch.checked) {
          const { text, kind, fallback, knownAnswer, onSent } =
            chatQueue.shift();

          // Answers queued before a mute are dropped.
          if (kind === "ans" && isAnswersMuted()) {
            continue;
          }

          let result = await sendChatMessage(text);
          let finalText = text;

          // The player's name may be what tripped the filter.
          if (result === "refused" && fallback) {
            console.log(`[Krillion Chat-Bot] Refused, retrying without name`);
            finalText = fallback;
            result = await sendChatMessage(fallback);
          }

          if (result === "refused") {
            chatPausedUntil = Date.now() + CHAT_REFUSED_PAUSE;
          }

          if (result === "sent" && knownAnswer) {
            chatStats.answersGiven++;
          }

          if (result === "sent") {
            onSent?.();
          }

          console.log(`[Krillion Chat-Bot] ${result}: ${finalText}`);
        }
      } finally {
        chatSending = false;
      }
    }

    function enqueueChat(
      text,
      kind = "info",
      {
        fallback = null,
        knownAnswer = false,
        onSent = null,
        translate = true,
      } = {},
    ) {
      if (
        !chatBotSwitch.checked ||
        (kind === "ans" && isAnswersMuted()) ||
        chatQueue.length >= CHAT_QUEUE_LIMIT
      ) {
        return;
      }

      chatQueue.push({
        text: formatChatText(text, translate).slice(0, CHAT_MAX_LENGTH),
        kind,
        fallback:
          fallback &&
          formatChatText(fallback, translate).slice(0, CHAT_MAX_LENGTH),
        knownAnswer,
        onSent,
      });
      pumpChatQueue().catch(console.error);
    }

    // Answers mention the asker, with a nameless fallback for the filter.
    function enqueueAnswer(name, body, options = {}) {
      if (chatLanguage === "krillish") {
        enqueueChat(`${name} ${body}`, "ans", {
          ...options,
          fallback: body,
        });
        return;
      }

      const answerPrefix = "I know! its ";
      const localizedBody = body.startsWith(answerPrefix)
        ? `${formatChatText(answerPrefix)}${body.slice(answerPrefix.length)}`
        : body === "I am not sure..."
          ? formatChatText(body)
          : body;
      enqueueChat(`${name} ${localizedBody}`, "ans", {
        ...options,
        fallback: localizedBody,
        translate: false,
      });
    }

    // Current verified Classic prompt. The question card is hidden once
    // we've answered, so fall back to the last prompt seen this match.
    function findVisiblePrompt() {
      const active = [...matches.entries()]
        .reverse()
        .find(([key]) => isClassicMatch(key));

      if (!active) {
        console.warn("[Krillion Chat-Bot] No verified Classic match", {
          rooms: Object.fromEntries(roomModes),
          matches: [...matches.keys()],
        });
        return null;
      }

      const [matchKey, prompts] = active;
      const question = getVisibleQuestion();

      if (question) {
        const prompt = prompts.find(
          (item) => normalizeQuestion(item.text) === question,
        );

        if (prompt) {
          return prompt;
        }
      }

      if (
        !question &&
        lastSeenPrompt?.matchKey === matchKey &&
        Date.now() - lastSeenPrompt.seenAt < LAST_PROMPT_MAX_AGE
      ) {
        return lastSeenPrompt.prompt;
      }

      console.warn("[Krillion Chat-Bot] Question not recognized", {
        visibleQuestion: question || null,
        matchKey,
        lineup: prompts.map((item) => item.text),
        lastSeen: lastSeenPrompt
          ? {
              matchKey: lastSeenPrompt.matchKey,
              question: lastSeenPrompt.prompt.text,
              ageSeconds: Math.round(
                (Date.now() - lastSeenPrompt.seenAt) / 1000,
              ),
            }
          : null,
      });

      return null;
    }

    // Without a lineup match (e.g. the page loaded mid-match), look the
    // question up in the database by its on-screen text instead.
    async function resolvePrompt() {
      const prompt = findVisiblePrompt();

      if (prompt) {
        return prompt;
      }

      const text =
        getVisibleQuestion() ||
        (lastSeenQuestion &&
        Date.now() - lastSeenQuestion.seenAt < LAST_PROMPT_MAX_AGE
          ? lastSeenQuestion.text
          : "");

      if (!text) {
        return null;
      }

      try {
        const response = await fetch(
          "http://127.0.0.1:3001/prompt-lookup?q=" + encodeURIComponent(text),
        );

        if (!response.ok) {
          console.warn(
            `[Krillion Chat-Bot] Text lookup HTTP ${response.status} for "${text}"`,
          );
          return null;
        }

        const data = await response.json();

        return typeof data.id === "string"
          ? { id: data.id, text: data.text, cat: data.cat }
          : null;
      } catch (error) {
        console.warn("[Krillion Chat-Bot] Text lookup failed:", error);
        return null;
      }
    }

    async function replyWithAnswer(name) {
      const notSure = "I am not sure...";
      // Players who recently used mute get the lowest-scoring answer.
      // chatMutedUntil is when the last mute ended (or will end).
      const worst =
        name === chatLastMuter &&
        Date.now() < chatMutedUntil + CHAT_MUTE_PENALTY_MS;
      const prompt = await resolvePrompt();

      if (!prompt) {
        enqueueAnswer(name, notSure);
        return;
      }

      try {
        const response = await fetch(
          helperUrl(prompt.id, prompt.cat, { worst }),
        );

        if (!response.ok) {
          console.warn(
            `[Krillion Chat-Bot] Helper returned HTTP ${response.status} for "${prompt.text}"`,
          );
          enqueueAnswer(name, notSure);
          return;
        }

        const data = await response.json();

        // Category fallbacks are guesses, not known answers.
        const answers =
          data.source === "prompt"
            ? (data.answers || []).filter(
                (item) =>
                  typeof item.answer === "string" &&
                  item.answer.trim() &&
                  Number.isFinite(item.score),
              )
            : [];

        if (!answers.length) {
          console.warn(
            `[Krillion Chat-Bot] No known answers (source: ${data.source}) for "${prompt.text}"`,
          );
          enqueueAnswer(name, notSure);
          return;
        }

        const target = (worst ? Math.min : Math.max)(
          ...answers.map((item) => item.score),
        );
        const tied = answers.filter((item) => item.score === target);
        const pick = tied[Math.floor(Math.random() * tied.length)];
        const rarity = TIER_NAMES[pick.tier] || `${pick.score} pts`;

        enqueueAnswer(name, `I know! its ${pick.answer.trim()} (${rarity})`, {
          knownAnswer: true,
          // Tell the muter why their answer was bad.
          onSent: worst
            ? () =>
                setTimeout(
                  () => enqueueChat(`${name} thats for muting me :(`),
                  CHAT_MUTE_TAUNT_DELAY,
                )
            : null,
        });
      } catch (error) {
        console.warn("[Krillion Chat-Bot] Lookup failed:", error);
        enqueueAnswer(name, notSure);
      }
    }

    function readChatLine(line) {
      const nameElement = line.querySelector(":scope > b");

      if (!nameElement) {
        return null;
      }

      let body = "";
      let afterName = false;

      for (const node of line.childNodes) {
        if (node === nameElement) {
          afterName = true;
        } else if (afterName) {
          body += node.textContent;
        }
      }

      return {
        name: nameElement.textContent.trim() || "friend",
        body: body.trim(),
      };
    }

    function handleChatLine(line) {
      // Never react to our own messages.
      if (line.closest("[data-mine]")) {
        return;
      }

      const message = readChatLine(line);
      const command = message && CHAT_PREFIX.exec(message.body);

      if (!command) {
        return;
      }

      const word = (command[1] || "help").toLowerCase();
      const action = CHAT_COMMAND_ALIASES[word] || word;

      if (!CHAT_COMMANDS.includes(action)) {
        return;
      }

      // A mute only silences answers; other commands keep working.
      if (action === "ans" && isAnswersMuted()) {
        return;
      }

      const sayText =
        action === "say" ? CHAT_SAY.exec(message.body)?.[1].trim() : null;
      const requestedLanguage =
        action === "lang"
          ? message.body.slice(command[0].length).trim().toLowerCase()
          : "";

      if (action === "say" && !sayText) {
        return;
      }

      const now = Date.now();
      // Prefix and command aliases count as the same command, so
      // "/p answer" and "/portik ans" are identical here.
      const commandText = `${BOT_COMMAND} ${action} ${message.body.slice(
        command[0].length,
      )}`
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

      if (
        now - (chatUserLastCommand.get(message.name) || 0) <
          CHAT_USER_COOLDOWN ||
        now - (chatCommandLastAccepted.get(commandText) || 0) <
          CHAT_DUPLICATE_COOLDOWN
      ) {
        return;
      }

      chatUserLastCommand.set(message.name, now);
      chatCommandLastAccepted.set(commandText, now);
      chatStats.interactions++;
      chatStats.users.add(message.name);

      console.log(
        `[Krillion Chat-Bot] ${message.name}: ${BOT_COMMAND} ${action}`,
      );

      if (action === "ans") {
        replyWithAnswer(message.name).catch(console.error);
      } else if (action === "say") {
        enqueueChat(sayText, "info", { translate: false });
      } else if (action === "lang") {
        if (!requestedLanguage) {
          enqueueChat(
            `${message.name} Available languages: ${CHAT_LANGUAGES.join(", ")}.`,
          );
        } else if (CHAT_LANGUAGES.includes(requestedLanguage)) {
          chatLanguage = requestedLanguage;
          enqueueChat(
            `${message.name} Language changed to ${requestedLanguage}.`,
          );
        } else {
          enqueueChat(
            `${message.name} Unknown language. Choose: ${CHAT_LANGUAGES.join(", ")}.`,
          );
        }
      } else if (action === "stats") {
        enqueueChat(`${message.name} ${describeStats()}`);
      } else if (action === "about") {
        enqueueChat(`${message.name} ${CHAT_ABOUT}`);
      } else if (action === "help") {
        enqueueChat(`${message.name} ${CHAT_HELP}`);
      } else if (action === "mute") {
        handleMute(message.name, now);
      } else {
        handleUnmute(message.name, now);
      }
    }

    function handleMute(name, now) {
      if (now < chatMutedUntil) {
        enqueueChat(
          `${name} answers are already muted ` +
            `(${formatWait(chatMutedUntil - now)} left).`,
        );
        return;
      }

      // chatMutedUntil is also when answers came back after an unmute.
      const remuteAt = chatMutedUntil + CHAT_MUTE_COOLDOWN;

      if (now < remuteAt) {
        enqueueChat(
          `${name} I was muted recently, ` +
            `mute is available again in ${formatWait(remuteAt - now)}.`,
        );
        return;
      }

      chatMutedUntil = now + CHAT_MUTE_MS;
      chatLastMuter = name;

      enqueueChat(
        `${name} OK, no answers for ${formatWait(CHAT_MUTE_MS)}. ` +
          `Other commands still work.`,
      );
    }

    function handleUnmute(name, now) {
      if (now >= chatMutedUntil) {
        enqueueChat(`${name} answers are not muted.`);
        return;
      }

      const unmuteAt = chatLastUnmuteAt + CHAT_UNMUTE_COOLDOWN;

      if (now < unmuteAt) {
        enqueueChat(
          `${name} unmute was used recently, ` +
            `try again in ${formatWait(unmuteAt - now)}.`,
        );
        return;
      }

      chatMutedUntil = now;
      chatLastUnmuteAt = now;

      enqueueChat(`${name} OK, answers are back! Try ${BOT_COMMAND} ans.`);
    }

    function scanChat(handle = chatBotSwitch.checked) {
      const logEntries = [];

      for (const log of document.querySelectorAll(".kr-chat-log")) {
        const fresh = [...log.querySelectorAll("p.kr-chat-said")].filter(
          (line) => !seenChatLines.has(line),
        );

        for (const line of fresh) {
          seenChatLines.add(line);
        }

        // A newly mounted log only contains history.
        if (!knownChatLogs.has(log)) {
          knownChatLogs.add(log);
          continue;
        }

        if (fresh.length > CHAT_BULK_LIMIT) {
          continue;
        }

        const at = new Date().toISOString();

        for (const line of fresh) {
          const message = readChatLine(line);

          if (message?.body) {
            logEntries.push({ at, name: message.name, message: message.body });
          }

          if (handle) {
            handleChatLine(line);
          }
        }
      }

      if (logEntries.length) {
        saveChatLog(logEntries);
      }
    }

    // Only player messages (p.kr-chat-said) are logged, never system lines.
    function saveChatLog(lines) {
      fetch("http://127.0.0.1:3001/chat-log", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ room: currentRoom, lines }),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
        })
        .catch((error) => {
          console.warn("[Krillion Chat-Log] Save failed:", error.message);
        });
    }

    let welcomedRoom = null;
    let welcomeTimer = null;

    // Greet 5 seconds after joining a room, then every 15 minutes
    // while we stay in that room with the CHAT-BOT on.
    function scheduleWelcome(room) {
      if (!chatBotSwitch.checked || !room || welcomedRoom === room) {
        return;
      }

      clearTimeout(welcomeTimer);
      welcomedRoom = room;

      const sendWelcome = () => {
        if (
          !chatBotSwitch.checked ||
          currentRoom !== room ||
          welcomedRoom !== room
        ) {
          welcomedRoom = null;
          return;
        }

        if (getChatControls()) {
          enqueueChat(WELCOME_MESSAGE);
        }

        welcomeTimer = setTimeout(sendWelcome, WELCOME_REPEAT);
      };

      welcomeTimer = setTimeout(sendWelcome, WELCOME_DELAY);
    }

    function isChatMutation(mutation) {
      return (
        mutation.type === "childList" &&
        [...mutation.addedNodes].some(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches?.(".kr-chat-log, .kr-said, .kr-chat-said") ||
              node.querySelector?.(".kr-chat-log, .kr-chat-said")),
        )
      );
    }

    const chatObserver = new MutationObserver((mutations) => {
      if (!mutations.some(isChatMutation)) {
        return;
      }

      clearTimeout(chatScanTimer);
      chatScanTimer = setTimeout(scanChat, 50);
    });

    chatObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Treat everything already in chat as history.
    scanChat(false);

    chatBotSwitch.checked = false;

    chatBotSwitch.addEventListener("change", () => {
      chatQueue.length = 0;
      chatStats.enabledAt = chatBotSwitch.checked ? Date.now() : null;

      // Ignore commands sent while the bot was off.
      scanChat(false);

      console.log(
        `[Krillion Chat-Bot] ${chatBotSwitch.checked ? "Enabled" : "Disabled"}`,
      );
    });

    // ===== END CHAT-BOT =====

    let selectedMatch = null;
    let requestId = 0;

    function refresh() {
      requestId++;

      const active = [...matches.entries()]
        .reverse()
        .find(([key]) => isClassicMatch(key));

      select.replaceChildren(new Option("Select a question...", ""));

      results.replaceChildren();

      if (!active) {
        selectedMatch = null;
        status.textContent = "No verified Classic match found.";
        return;
      }

      const [key, prompts] = active;
      selectedMatch = key;

      for (const prompt of prompts) {
        const option = new Option(prompt.text, prompt.id);

        if (typeof prompt.cat === "string") {
          option.dataset.cat = prompt.cat;
        }

        select.add(option);
      }

      status.textContent = `${prompts.length} questions available`;
    }

    const ICON_PIXELS = {
      0: {
        viewBox: "0 0 12 10",
        size: [36, 30],
        body: "2,0,3 1,1 5,1 0,2 6,2 0,3 6,3 9,3,2 0,4 6,4 8,4 11,4 1,5 5,5 8,5 11,5 2,6,3 9,6,2 10,8 9,9",
        lit: "2,1 1,2 9,4 9,8",
        dark: "5,4 4,5 10,5 10,9",
      },
      1: {
        viewBox: "0 0 12 8",
        size: [36, 24],
        body: "1,1,3 8,3,3 3,6,3",
        lit: "1,0,3 8,2,3 3,5,3",
        dark: "0,1 2,2,2 7,3 9,4,2 2,6 4,7,2",
        white: "4,1 11,3 6,6",
      },
      2: {
        viewBox: "0 0 11 7",
        size: [33, 21],
        body: "0,0 0,1,2 1,2 3,2,6 0,3,10 0,4 4,4,5 6,5",
        lit: "6,0 4,1,5 10,3",
        dark: "3,4 9,4 4,5,2 7,5,2 6,6",
        white: "9,2",
      },
      3: {
        viewBox: "0 0 9 11",
        size: [27, 33],
        lit: "3,0,3 1,1,2 6,1,2 0,2 8,2 0,3 8,3 0,4 8,4",
        halo: "3,1,3 1,2 3,2,5 1,3,7 2,4 4,4 6,4 1,5 4,5 7,5 1,6 4,6 6,6 2,7 4,7 7,7 2,8 5,8 7,8 3,9 5,9 3,10 7,10",
        white: "2,2",
      },
      4: {
        viewBox: "0 0 13 10",
        size: [26, 20],
        body: "4,5,5 2,6,7 10,6 2,7,10 3,8,7 7,9,5",
        lit: "10,1 4,4,4 2,5,2 9,5,2 11,6",
        dark: "9,2 8,3 0,5 0,6,2 0,7,2 0,8 2,8 3,9,4 12,9",
        halo: "10,0 9,1 11,1 10,2",
        white: "9,6 12,7 10,8 12,8",
      },
      5: {
        viewBox: "0 0 11 7",
        size: [33, 21],
        body: "4,0,4 3,1,6 2,2,2 5,2,6 1,3,9 2,4,7 5,5,3",
        lit: "0,4 0,5,2 1,6",
        dark: "1,4 2,5,3 3,6,2 6,6",
        white: "4,2",
      },
    };

    function createTierIcon(tier) {
      const data = ICON_PIXELS[tier];

      if (!data) {
        return document.createTextNode("");
      }

      const namespace = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(namespace, "svg");

      svg.classList.add("kh-tier-icon");
      svg.setAttribute("viewBox", data.viewBox);
      svg.setAttribute("width", data.size[0]);
      svg.setAttribute("height", data.size[1]);
      svg.setAttribute("shape-rendering", "crispEdges");
      svg.setAttribute("aria-hidden", "true");

      for (const type of ["body", "lit", "dark", "white", "halo"]) {
        if (!data[type]) {
          continue;
        }

        for (const pixel of data[type].split(" ")) {
          const [x, y, width = 1, height = 1] = pixel.split(",").map(Number);

          const rect = document.createElementNS(namespace, "rect");

          rect.setAttribute("x", x);
          rect.setAttribute("y", y);
          rect.setAttribute("width", width);
          rect.setAttribute("height", height);
          rect.setAttribute("class", `kr-icon-${type}`);

          svg.appendChild(rect);
        }
      }

      return svg;
    }

    async function loadAnswers() {
      const promptId = select.value;
      const promptCat = select.selectedOptions[0]?.dataset.cat;
      const matchAtStart = selectedMatch;
      const currentRequest = ++requestId;
      if (panel.style.display !== "block") {
        return;
      }

      results.replaceChildren();

      if (!promptId || !matchAtStart || !isClassicMatch(matchAtStart)) {
        status.textContent = "Select a Classic match question.";
        return;
      }

      status.textContent = "Loading answers...";

      try {
        const response = await fetch(helperUrl(promptId, promptCat));

        if (
          currentRequest !== requestId ||
          !isClassicMatch(matchAtStart) ||
          selectedMatch !== matchAtStart
        ) {
          return;
        }

        if (response.status === 404) {
          status.textContent = "This question isn't indexed yet.";
          return;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (currentRequest !== requestId || select.value !== promptId) {
          return;
        }

        // Don't update answers if the panel was closed.
        if (panel.style.display !== "block") {
          return;
        }

        status.textContent =
          data.source === "category"
            ? `Not indexed — ${data.answers.length} answers from category "${data.category}"`
            : `${data.answers.length} answers found`;

        for (const item of data.answers) {
          const button = document.createElement("button");

          button.className = "kh-answer";
          button.dataset.tier = String(item.tier);

          const info = document.createElement("div");
          info.className = "kh-answer-info";

          const name = document.createElement("div");
          name.className = "kh-answer-name";
          name.textContent = item.answer;

          const tierLabel = document.createElement("div");
          tierLabel.className = "kh-answer-tier";
          tierLabel.textContent = TIER_NAMES[item.tier] || "Unknown";

          info.append(name, tierLabel);

          const score = document.createElement("div");
          score.className = "kh-score";

          const scoreNumber = document.createElement("span");
          scoreNumber.className = "kh-score-number";
          scoreNumber.textContent = item.score;

          const scoreLabel = document.createElement("span");
          scoreLabel.className = "kh-score-label";
          scoreLabel.textContent = "PTS";

          score.append(scoreNumber, scoreLabel);

          const icon = document.createElement("div");
          icon.className = "kh-answer-icon";
          icon.appendChild(createTierIcon(item.tier));

          button.append(icon, info, score);

          button.addEventListener("click", async () => {
            const attempted = await submitGameAnswer(item.answer);

            status.textContent = attempted
              ? `Attempted: ${item.answer}`
              : "Could not submit answer.";

            // Intentionally do not close the popup.
          });

          results.appendChild(button);
        }
      } catch (error) {
        console.error("[Krillion Helper]", error);
        status.textContent = "Could not connect to the backend.";
      }
    }

    // ===== AUTOMATIC QUESTION DETECTION V2 =====

    function normalizeQuestion(text) {
      return text.trim().replace(/\s+/g, " ").toLowerCase();
    }

    let lastDetectedPrompt = null;
    let lastSeenPrompt = null;
    let lastSeenQuestion = null;
    let detectionTimer = null;

    function detectActivePrompt(force = false) {
      // Find the latest visible question.
      const elements = [
        ...document.querySelectorAll(".kr-card .kr-prompt"),
      ].filter((element) => element.getClientRects().length > 0);

      if (!elements.length) {
        lastDetectedPrompt = null;
        stopAutoRound();
        return;
      }

      const element = elements[elements.length - 1];
      const questionText = normalizeQuestion(element.textContent || "");

      if (!questionText) {
        return;
      }

      lastSeenQuestion = { text: questionText, seenAt: Date.now() };

      // Find the currently verified Classic match.
      const active = [...matches.entries()]
        .reverse()
        .find(([key]) => isClassicMatch(key));

      if (!active) {
        stopAutoRound();
        return;
      }

      const [matchKey, prompts] = active;

      const prompt = prompts.find(
        (item) => normalizeQuestion(item.text) === questionText,
      );

      if (!prompt) {
        return;
      }

      lastSeenPrompt = { matchKey, prompt, seenAt: Date.now() };

      const detectedKey = `${matchKey}:${prompt.id}`;

      // The same question was already detected.
      if (!force && lastDetectedPrompt === detectedKey) {
        return;
      }

      lastDetectedPrompt = detectedKey;

      // Start AUTO-MODE for the newly detected question.
      // This runs independently of popup visibility.
      const roundIndex = prompts.findIndex((item) => item.id === prompt.id);

      if (roundIndex !== -1 && trackAfkRound(matchKey, roundIndex)) {
        startAutoRound(matchKey, prompt, roundIndex).catch(console.error);
      }

      // Inherit Krillion's font.
      const gameStyle = getComputedStyle(element);
      root.style.setProperty("--kh-font", gameStyle.fontFamily);

      // Never open the helper automatically.
      // Don't even fetch answers while it's closed.
      if (panel.style.display !== "block") {
        return;
      }

      // Refresh options only if necessary.
      const hasOption = [...select.options].some(
        (option) => option.value === prompt.id,
      );

      if (selectedMatch !== matchKey || !hasOption) {
        refresh();
      }

      select.value = prompt.id;

      console.log("[Krillion Helper] New question:", prompt.text);

      loadAnswers();
    }

    // Determine whether a DOM mutation actually
    // affects a question element.
    function isPromptMutation(mutation) {
      const target = mutation.target;

      const element =
        target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;

      // Text inside an existing question changed.
      if (element?.closest?.(".kr-prompt")) {
        return true;
      }

      if (mutation.type !== "childList") {
        return false;
      }

      // A question element was added or removed.
      const nodes = [...mutation.addedNodes, ...mutation.removedNodes];

      return nodes.some((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return false;
        }

        return (
          node.matches?.(".kr-prompt") || node.querySelector?.(".kr-prompt")
        );
      });
    }

    const promptObserver = new MutationObserver((mutations) => {
      // Ignore all mutations unrelated to questions.
      if (!mutations.some(isPromptMutation)) {
        return;
      }

      clearTimeout(detectionTimer);

      // Allow the game's DOM update to finish.
      detectionTimer = setTimeout(() => {
        detectActivePrompt();
      }, 60);
    });

    promptObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Initial detection.
    detectActivePrompt();

    // ===== END AUTOMATIC QUESTION DETECTION V2 =====

    toggle.addEventListener("click", () => {
      const opening = panel.style.display !== "block";

      if (opening) {
        panel.style.display = "block";

        refresh();

        // Force loading the currently visible question
        // when the user manually opens the helper.
        lastDetectedPrompt = null;
        detectActivePrompt(true);
      } else {
        panel.style.display = "none";

        // Invalidate any outstanding answer request.
        requestId++;
      }
    });

    root.querySelector("#kh-refresh").addEventListener("click", refresh);

    select.addEventListener("change", loadAnswers);

    window.krillionHelper = { refresh };
  }

  if (document.reaadyState === "loading") {
    document.addEventListener("DOMContentLoaded", createAnswerHelper, {
      once: true,
    });
  } else {
    createAnswerHelper();
  }

  console.log("[Krillion] Indexer v0.3 active");
})();
