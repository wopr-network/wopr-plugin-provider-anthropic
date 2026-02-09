/**
 * Standalone test for dynamic model discovery.
 * Tests: fetch page -> strip HTML -> feed to Haiku -> parse JSON
 *
 * Usage: node test-discovery.mjs
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

const MODELS_PAGE_URL = "https://docs.anthropic.com/en/docs/about-claude/models/overview";

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function test() {
  // Step 1: Fetch
  console.log("Step 1: Fetching", MODELS_PAGE_URL);
  const response = await fetch(MODELS_PAGE_URL);
  if (!response.ok) {
    console.error("Fetch failed:", response.status);
    process.exit(1);
  }
  const html = await response.text();
  console.log(`  Got ${html.length} chars of HTML`);

  // Step 2: Strip
  const text = stripHtml(html).slice(0, 60000);
  console.log(`  Stripped to ${text.length} chars of text`);
  console.log(`  Preview: ${text.slice(0, 200)}...`);

  // Step 3: Feed to Haiku
  console.log("\nStep 2: Sending to Haiku for extraction...");
  const extractionPrompt = `Extract ALL Claude model information from this documentation page.

Return ONLY a valid JSON array. Each object must have exactly these fields:
- "id": string - the Claude API model ID (e.g. "claude-opus-4-6")
- "name": string - display name (e.g. "Claude Opus 4.6")
- "contextWindow": string - context window (e.g. "200K / 1M beta")
- "maxOutput": string - max output tokens (e.g. "128K")
- "inputPrice": number - USD per million input tokens (e.g. 5)
- "outputPrice": number - USD per million output tokens (e.g. 25)
- "legacy": boolean - true if listed as legacy or deprecated

Include ALL models: current AND legacy. Return ONLY the JSON array.

Page content:
${text}`;

  const q = query({
    prompt: extractionPrompt,
    options: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let result = "";
  for await (const msg of q) {
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text") result += block.text;
      }
    }
  }

  console.log(`  Got ${result.length} chars from Haiku`);

  // Step 4: Parse
  console.log("\nStep 3: Parsing JSON...");
  const jsonMatch = result.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("No JSON array found in response!");
    console.error("Raw response:", result.slice(0, 500));
    process.exit(1);
  }

  const models = JSON.parse(jsonMatch[0]);
  console.log(`  Parsed ${models.length} models:\n`);

  // Display results
  const current = models.filter((m) => !m.legacy);
  const legacy = models.filter((m) => m.legacy);

  console.log("Current models:");
  for (const m of current) {
    console.log(`  ${m.name} (${m.id})`);
    console.log(`    Context: ${m.contextWindow} | Max output: ${m.maxOutput}`);
    console.log(`    Price: $${m.inputPrice}/MTok in, $${m.outputPrice}/MTok out`);
  }

  if (legacy.length > 0) {
    console.log("\nLegacy models:");
    for (const m of legacy) {
      console.log(`  ${m.name} (${m.id}) - $${m.inputPrice}/$${m.outputPrice}`);
    }
  }

  console.log("\nFull JSON:");
  console.log(JSON.stringify(models, null, 2));
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
