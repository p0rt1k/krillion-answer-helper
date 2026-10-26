// ==UserScript==
// @name         Krillion Answer Indexer
// @namespace    krillion-local-indexer
// @version      0.2
// @description  Index best answers and 50 alternatives
// @match        https://playdaily.org/krillion*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const DB_NAME = "krillion-answer-index";
  const STORE = "answers";
  const MAX_ARCHIVE = 50;

  const matches = new Map();
  const pending = new Map();
  const submittedAnswers = new Map();

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

  const inFlightAnswers = new Set();

  async function savePrompt(prompt, candidates) {
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

      savePrompt(prompt, candidates).catch((error) => {
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

  console.log("[Krillion] Indexer v0.2 active");
})();
