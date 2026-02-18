# wopr-plugin-provider-anthropic

Anthropic Claude provider plugin for WOPR. Wraps the Claude Agent SDK for use as a WOPR LLM provider.

## Commands

```bash
npm run build     # tsc
npm run check     # biome check + tsc --noEmit (run before committing)
npm run lint:fix  # biome check --fix src/
npm run format    # biome format --write src/
npm test          # vitest run
```

## Key Details

- **SDK**: `@anthropic-ai/claude-agent-sdk` — NOT the raw `@anthropic-ai/sdk`
- Implements the `ProviderPlugin` interface from `@wopr-network/plugin-types`
- API key configured via plugin config schema — not hardcoded or from env
- Model selection exposed through config (e.g. claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5)
- **Gotcha**: This uses the Agent SDK, which has a different interface to the base Anthropic SDK. Don't mix them up.

## Plugin Contract

Imports only from `@wopr-network/plugin-types`. Never import from `@wopr-network/wopr` core.

## Issue Tracking

All issues in **Linear** (team: WOPR). Issue descriptions start with `**Repo:** wopr-network/wopr-plugin-provider-anthropic`.
