
require("dotenv").config();

const { Pool } = require("pg");

const target = process.env.DB_TARGET;

let config;

if (target === "remote") {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is not configured");
    }

    config = {
        connectionString: process.env.DATABASE_URL,
        max: 10,
        connectionTimeoutMillis: 5000
    };
} else if (target === "local") {
    config = {
        host: process.env.DB_HOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || "krillion",
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        max: 10,
        connectionTimeoutMillis: 5000
    };
} else {
    throw new Error(
        "Database not selected. Start using: npm start"
    );
}

const pool = new Pool(config);

pool.on("error", (error) => {
    console.error("[DB] Connection error:", error.message);
});

module.exports = pool;
