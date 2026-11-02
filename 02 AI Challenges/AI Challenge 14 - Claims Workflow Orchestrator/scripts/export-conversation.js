import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const transcriptPath =
  "/Users/khangphan/.gemini/antigravity/brain/8f2ef736-9fe8-4160-93b4-40b9e1f33284/.system_generated/logs/transcript_full.jsonl";
const outputPath = path.resolve(__dirname, "../docs/AI_CONVERSATION.md");

if (!fs.existsSync(transcriptPath)) {
  console.error(`Error: Transcript file not found at ${transcriptPath}`);
  process.exit(1);
}

const writeStream = fs.createWriteStream(outputPath, { encoding: "utf-8" });

writeStream.write("# AI Conversation Transcript — Claims Workflow Orchestrator\n\n");
writeStream.write(
  "This document contains the full, verbatim, unedited conversation transcript recorded between the User and the AI Assistant (Antigravity) during the end-to-end implementation of **AI Challenge 14 — Claims Workflow Orchestrator**.\n\n"
);
writeStream.write("- **Conversation ID**: `8f2ef736-9fe8-4160-93b4-40b9e1f33284`\n");
writeStream.write(`- **Export Generated At**: ${new Date().toISOString()}\n`);
writeStream.write("- **Workspace**: `02 AI Challenges/AI Challenge 14 - Claims Workflow Orchestrator`\n\n");
writeStream.write("---\n\n");

const rl = readline.createInterface({
  input: fs.createReadStream(transcriptPath),
  crlfDelay: Infinity,
});

let turnIndex = 1;

rl.on("line", (line) => {
  if (!line || line.trim().length === 0) return;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    console.error("Failed to parse JSONL line:", err);
    return;
  }

  if (obj.type === "USER_INPUT") {
    writeStream.write(`## [Turn ${turnIndex}] 👤 User (${obj.created_at})\n\n`);
    writeStream.write(`${obj.content}\n\n`);
    if (obj.media && obj.media.length > 0) {
      writeStream.write(
        `*Attached Media: ${obj.media.map((m) => m.uri).join(", ")}*\n\n`
      );
    }
    writeStream.write("---\n\n");
    turnIndex++;
  } else if (obj.source === "MODEL" && obj.type === "PLANNER_RESPONSE") {
    let hasBody = false;
    let section = `## [Turn ${turnIndex}] 🤖 AI Assistant (${obj.created_at})\n\n`;

    if (obj.thinking) {
      section += "<details>\n<summary>💭 <i>Internal Chain of Thought</i></summary>\n\n";
      section += `${obj.thinking}\n\n</details>\n\n`;
      hasBody = true;
    }

    if (obj.tool_calls && obj.tool_calls.length > 0) {
      section += `<details>\n<summary>🛠️ <i>Tool Calls (${obj.tool_calls.length})</i></summary>\n\n`;
      for (const tc of obj.tool_calls) {
        section += "```json\n" + JSON.stringify(tc, null, 2) + "\n```\n\n";
      }
      section += "</details>\n\n";
      hasBody = true;
    }

    if (obj.content && obj.content.trim().length > 0) {
      section += `${obj.content}\n\n`;
      hasBody = true;
    }

    if (hasBody) {
      writeStream.write(`${section}---\n\n`);
      turnIndex++;
    }
  }
});

rl.on("close", () => {
  writeStream.end(() => {
    const stats = fs.statSync(outputPath);
    console.log(
      `Successfully exported ${turnIndex - 1} turns to ${outputPath} (${(
        stats.size /
        (1024 * 1024)
      ).toFixed(2)} MB)`
    );
  });
});

