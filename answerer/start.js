
require("dotenv").config();

const readline = require("node:readline/promises");

async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("\n=== Krillion Backend ===\n");
    console.log("[1] Local PostgreSQL");
    console.log("[2] Remote Development PostgreSQL\n");

    let choice;

    try {
        choice = (await rl.question(
            "Select database (1/2): "
        )).trim();
    } finally {
        rl.close();
    }

    if (choice === "1") {
        process.env.DB_TARGET = "local";
    } else if (choice === "2") {
        process.env.DB_TARGET = "remote";
    } else {
        console.error("Invalid selection. Exiting.");
        process.exitCode = 1;
        return;
    }

    const selected = process.env.DB_TARGET.toUpperCase();

    console.log(`\n[DB] Connecting to ${selected}...`);

    const pool = require("./db");

    try {
        // Verify the selected database is reachable.
        await pool.query("SELECT 1");

        console.log("[DB] Connection successful!");
        console.log(`[DB] Active database: ${selected}\n`);

        // Start the existing Express server.
        require("./server");
    } catch (error) {
        console.error(
            "[DB] Connection failed:",
            error.message
        );

        await pool.end();
        process.exitCode = 1;
    }
}

main().catch(error => {
    console.error("[STARTUP]", error.message);
    process.exitCode = 1;
});
