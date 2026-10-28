require("dotenv").config({ path: require("node:path").resolve(__dirname, "../.env") });

const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const pool = require("./db");
const OpenAI = require("openai");
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 10000,
      maxRetries: 0,
    })
  : null;

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SCORE_MAP = {
  4: 0,
  8: 1,
  16: 2,
  32: 3,
  64: 4,
  100: 5,
};

function convertScore(points) {
  const score = SCORE_MAP[points];

  if (score === undefined) {
    throw new Error(`Invalid Krillion score: ${points}`);
  }

  return score;
}

app.use(
  cors({
    origin: "https://playdaily.org",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json({ limit: "256kb" }));

// Verify PostgreSQL connectivity
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error("[HEALTH]", error);
    res.status(503).json({
      status: "error",
      database: "disconnected",
    });
  }
});

// Database statistics
app.get("/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM public.prompt)
          AS total_prompts,
        (SELECT COUNT(*) FROM public.answer)
          AS total_answers,
        (SELECT COUNT(DISTINCT "promptId")
         FROM public.answer)
          AS prompts_with_answers,
        (SELECT COUNT(*)
         FROM public.answer
         WHERE value = 5)
          AS perfect_answers
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("[STATS]", error);
    res.status(500).json({ error: "Database error" });
  }
});

// Index a prompt and its observed answers
app.post("/index", async (req, res) => {
  const { promptId, question, category, answers } = req.body || {};

  if (
    (category != null &&
      (typeof category !== "string" || category.length > 128)) ||
    typeof promptId !== "string" ||
    !promptId.trim() ||
    promptId.length > 128 ||
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2000 ||
    !Array.isArray(answers) ||
    answers.length < 1 ||
    answers.length > 500
  ) {
    return res.status(400).json({
      error: "Invalid prompt or answers",
    });
  }

  // Deduplicate answers in the incoming batch.
  const unique = new Map();

  for (const item of answers) {
    if (
      !item ||
      typeof item.answer !== "string" ||
      !item.answer.trim() ||
      item.answer.length > 500 ||
      !Number.isInteger(item.score) ||
      !Object.hasOwn(SCORE_MAP, item.score)
    ) {
      return res.status(400).json({
        error: "Invalid answer or score",
      });
    }

    const answer = item.answer.trim();
    const existing = unique.get(answer);

    if (!existing || convertScore(item.score) > existing.score) {
      unique.set(answer, {
        answer,
        score: convertScore(item.score),
      });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert question if missing.
    // Preserve the existing question text otherwise,
    // but fill in a missing category.
    await client.query(
      `
      INSERT INTO public.prompt (id, text, cat)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
        SET cat = EXCLUDED.cat
        WHERE public.prompt.cat IS NULL
          AND EXCLUDED.cat IS NOT NULL
    `,
      [promptId.trim(), question.trim(), category?.trim() || null],
    );

    let newAnswers = 0;
    let improvedAnswers = 0;

    for (const entry of unique.values()) {
      // Atomic upsert: never lower a known score.
      const result = await client.query(
        `
        INSERT INTO public.answer
          ("promptId", text, value)
        VALUES ($1, $2, $3)
        ON CONFLICT ("promptId", text)
        DO UPDATE SET
          value = GREATEST(
            public.answer.value,
            EXCLUDED.value
          )
        WHERE public.answer.value < EXCLUDED.value
        RETURNING (xmax = 0) AS inserted
      `,
        [promptId.trim(), entry.answer, entry.score],
      );

      if (result.rowCount > 0) {
        if (result.rows[0].inserted) {
          newAnswers++;
        } else {
          improvedAnswers++;
        }
      }
    }

    await client.query("COMMIT");

    console.log(
      `[INDEX] ${question} | ` +
        `${newAnswers} new | ` +
        `${improvedAnswers} improved`,
    );

    res.json({
      success: true,
      promptId,
      received: unique.size,
      newAnswers,
      improvedAnswers,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[INDEX]", error);

    res.status(500).json({
      error: "Failed to index answers",
    });
  } finally {
    client.release();
  }
});

const POINTS = [4, 8, 16, 32, 64, 100];

app.get("/helper/:promptId", async (req, res) => {
  const { promptId } = req.params;
  const category =
    typeof req.query.cat === "string" ? req.query.cat.trim() : "";
  // ?worst=1 lists the lowest-scoring answers first.
  const order = req.query.worst === "1" ? "ASC" : "DESC";

  if (!promptId || promptId.length > 128 || category.length > 128) {
    return res.status(400).json({
      error: "Invalid prompt ID",
    });
  }

  try {
    const questionResult = await pool.query(
      `SELECT id, text, cat
             FROM public.prompt
             WHERE id = $1`,
      [promptId],
    );

    const prompt = questionResult.rows[0];

    if (prompt) {
      const answerResult = await pool.query(
        `SELECT text, value
               FROM public.answer
               WHERE "promptId" = $1
               ORDER BY value ${order}, text ASC
               LIMIT 51`,
        [promptId],
      );

      if (answerResult.rows.length > 0) {
        return res.json({
          promptId,
          question: prompt.text,
          source: "prompt",
          count: answerResult.rows.length,
          answers: answerResult.rows.map((row) => ({
            answer: row.text,
            score: POINTS[row.value],
            tier: row.value,
          })),
        });
      }
    }

    // Unknown prompt: fall back to the best answer of
    // each other prompt in the same category.
    const fallbackCategory = prompt?.cat || category;

    if (fallbackCategory) {
      const categoryResult = await pool.query(
        `SELECT best.text,
                MAX(best.value) AS value,
                COUNT(*) AS prompts
               FROM (
                 SELECT DISTINCT ON (a."promptId")
                        a.text, a.value
                   FROM public.answer a
                   JOIN public.prompt p ON p.id = a."promptId"
                  WHERE p.cat = $1
                    AND p.id <> $2
                  ORDER BY a."promptId", a.value DESC, a.text ASC
               ) best
              GROUP BY best.text
              ORDER BY value DESC, prompts DESC, best.text ASC
              LIMIT 51`,
        [fallbackCategory, promptId],
      );

      if (categoryResult.rows.length > 0) {
        return res.json({
          promptId,
          question: prompt?.text ?? null,
          category: fallbackCategory,
          source: "category",
          count: categoryResult.rows.length,
          answers: categoryResult.rows.map((row) => ({
            answer: row.text,
            score: POINTS[row.value],
            tier: row.value,
          })),
        });
      }
    }

    return res.status(404).json({
      error: "Question not indexed",
    });
  } catch (error) {
    console.error("[HELPER]", error);

    res.status(500).json({
      error: "Failed to retrieve answers",
    });
  }
});

// Find a prompt by its question text (whitespace/case-insensitive).
app.get("/prompt-lookup", async (req, res) => {
  const text =
    typeof req.query.q === "string"
      ? req.query.q.trim().replace(/\s+/g, " ").toLowerCase()
      : "";

  if (!text || text.length > 2000) {
    return res.status(400).json({ error: "Invalid question" });
  }

  try {
    const result = await pool.query(
      `SELECT id, text, cat
         FROM public.prompt
        WHERE lower(regexp_replace(btrim(text), '\\s+', ' ', 'g')) = $1
        LIMIT 1`,
      [text],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Question not indexed" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("[PROMPT-LOOKUP]", error);
    res.status(500).json({ error: "Failed to look up question" });
  }
});

const aiRequestTimes = [];

app.post("/ai-answer", async (req, res) => {
  if (process.env.AI_FALLBACK_ENABLED !== "true" || !openai) {
    return res.status(503).json({
      error: "AI fallback is disabled",
    });
  }

  const { question } = req.body || {};

  if (
    typeof question !== "string" ||
    question.trim().length < 5 ||
    question.length > 500
  ) {
    return res.status(400).json({
      error: "Invalid question",
    });
  }

  // Reject requests from unrelated browser origins.
  const origin = req.get("Origin");

  if (origin && origin !== "https://playdaily.org") {
    return res.status(403).json({
      error: "Origin not allowed",
    });
  }

  // Cost safeguard: at most 4 AI requests per minute.
  const now = Date.now();

  while (aiRequestTimes.length && now - aiRequestTimes[0] >= 60000) {
    aiRequestTimes.shift();
  }

  if (aiRequestTimes.length >= 4) {
    return res.status(429).json({
      error: "AI rate limit reached",
    });
  }

  aiRequestTimes.push(now);

  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",

      instructions: [
        "You are answering a short word game question.",
        "Give exactly ONE ordinary, common answer.",
        "Prioritize an obviously valid answer",
        "over cleverness or rarity.",
        "Return only the answer itself.",
        "No explanation, quotation marks,",
        "numbering, or punctuation around it.",
        "Keep the answer under 80 characters.",
      ].join(" "),

      input: question.trim(),
      max_output_tokens: 512,
      store: false,
    });

    const answer = (response.output_text || "")
      .trim()
      .split(/\r?\n/)[0]
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();

    if (!answer || answer.length > 80) {
      return res.status(502).json({
        error: "No usable AI answer",
      });
    }

    console.log(`[AI] ${question} => ${answer}`);

    return res.json({
      answer,
      source: "openai",
    });
  } catch (error) {
    console.error("[AI]", error.message);

    return res.status(502).json({
      error: "AI request failed",
    });
  }
});

const CHAT_LOG_DIR = path.resolve(__dirname, "logs");

// Collapse whitespace so player text can't forge extra log lines.
function cleanLogText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

// Append player chat messages to logs/chat-YYYY-MM-DD.log
app.post("/chat-log", async (req, res) => {
  const { room, lines } = req.body || {};

  if (
    (room != null && (typeof room !== "string" || room.length > 128)) ||
    !Array.isArray(lines) ||
    lines.length < 1 ||
    lines.length > 100
  ) {
    return res.status(400).json({ error: "Invalid chat log" });
  }

  const byFile = new Map();

  for (const line of lines) {
    const at = new Date(line?.at);

    if (
      Number.isNaN(at.getTime()) ||
      typeof line.name !== "string" ||
      line.name.length > 100 ||
      typeof line.message !== "string" ||
      !line.message.trim() ||
      line.message.length > 500
    ) {
      return res.status(400).json({ error: "Invalid chat line" });
    }

    const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
    const roomLabel = room ? ` [${cleanLogText(room)}]` : "";
    const text =
      `[${date} ${time}]${roomLabel} ` +
      `${cleanLogText(line.name) || "?"}: ${cleanLogText(line.message)}\n`;

    const file = path.join(CHAT_LOG_DIR, `chat-${date}.log`);
    byFile.set(file, (byFile.get(file) || "") + text);
  }

  try {
    await fs.mkdir(CHAT_LOG_DIR, { recursive: true });

    for (const [file, text] of byFile) {
      await fs.appendFile(file, text, "utf8");
    }

    res.json({ success: true, logged: lines.length });
  } catch (error) {
    console.error("[CHAT-LOG]", error);
    res.status(500).json({ error: "Failed to write chat log" });
  }
});

// Only listen on this computer.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[Krillion API] http://127.0.0.1:${PORT}`);
});
