// ==UserScript==
// @name         Krillion Answer Indexer
// @namespace    krillion-local-indexer
// @version      0.2
// @description  Index best answers and 50 alternatives
// @match        https://playdaily.org/krillion*
// @icon         https://krillion.io/tiers/krillion-halloween-2026.png
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

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

      if (rpc === "krillion_arena_touch_seat") {
        roomModes.set(room, "classic");
        if (typeof payload.p_client_id === "string") {
          roomClientIds.set(room, payload.p_client_id);
        }
        console.log(`[Krillion] Classic room verified: ${room}`);
        window.krillionAuto?.onSeatVerified();
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

        #kh-root #kh-auto-switch {
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

        #kh-root #kh-auto-switch:checked + .kh-auto-track {
            background: #238c64;
            border-color: #5ad07a;
        }

        #kh-root #kh-auto-switch:checked + .kh-auto-track::before {
            transform: translateX(22px);
        }

        #kh-root #kh-auto-switch:focus-visible + .kh-auto-track {
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

    const AUTO_DELAY = 5000;
    const RETRY_DELAY = 2500;

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
        const response = await fetch(
          "http://127.0.0.1:3001/helper/" + encodeURIComponent(prompt.id),
        );

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

        setAutoStatus(`Ready: ${round.answers.length} answers`);

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
      onSeatVerified() {
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
        select.add(new Option(prompt.text, prompt.id));
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
        const response = await fetch(
          "http://127.0.0.1:3001/helper/" + encodeURIComponent(promptId),
        );

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

        status.textContent = `${data.answers.length} answers found`;

        const tierNames = [
          "Plankton",
          "Too Clever",
          "Schooler",
          "Rare",
          "Deep Cut",
          "One in a Krillion",
        ];

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
          tierLabel.textContent = tierNames[item.tier] || "Unknown";

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

  console.log("[Krillion] Indexer v0.2 active");
})();
