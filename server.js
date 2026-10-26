
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SCORE_MAP = {
  4: 0,
  8: 1,
  16: 2,
  32: 3,
  64: 4,
  100: 5
};

function convertScore(points) {
  const score = SCORE_MAP[points];

  if (score === undefined) {
    throw new Error(`Invalid Krillion score: ${points}`);
  }

  return score;
}

app.use(cors({
  origin: "https://playdaily.org",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "256kb" }));

// Verify PostgreSQL connectivity
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch (error) {
    console.error("[HEALTH]", error);
    res.status(503).json({
      status: "error",
      database: "disconnected"
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
  const { promptId, question, answers } = req.body || {};

  if (
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
      error: "Invalid prompt or answers"
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
        error: "Invalid answer or score"
      });
    }

    const answer = item.answer.trim();
    const existing = unique.get(answer);

    if (!existing || convertScore(item.score) > existing.score) {
      unique.set(answer, {
        answer,
        score: convertScore(item.score)
        });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Insert question if missing.
    // Preserve the existing question text otherwise.
    await client.query(`
      INSERT INTO public.prompt (id, text)
      VALUES ($1, $2)
      ON CONFLICT (id) DO NOTHING
    `, [promptId.trim(), question.trim()]);

    let newAnswers = 0;
    let improvedAnswers = 0;

    for (const entry of unique.values()) {
      // Atomic upsert: never lower a known score.
      const result = await client.query(`
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
      `, [promptId.trim(), entry.answer, entry.score]);

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
      `${improvedAnswers} improved`
    );

    res.json({
      success: true,
      promptId,
      received: unique.size,
      newAnswers,
      improvedAnswers
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[INDEX]", error);

    res.status(500).json({
      error: "Failed to index answers"
    });
  } finally {
    client.release();
  }
});

// Only listen on this computer.
app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[Krillion API] http://127.0.0.1:${PORT}`
  );
});
