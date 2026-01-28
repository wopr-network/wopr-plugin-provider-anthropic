# wopr-plugin-provider-anthropic

Anthropic Claude provider plugin for WOPR.

## Installation

```bash
wopr plugin install wopr-plugin-provider-anthropic
```

## Configuration

Add your Anthropic API key:

```bash
wopr providers add anthropic sk-ant-...
```

## Usage

Create a session with Anthropic provider:

```bash
wopr session create my-session --provider anthropic
```

Or set provider on existing session:

```bash
wopr session set-provider my-session anthropic
```

## Supported Models

- `claude-opus-4-5-20251101` (default)
- `claude-sonnet-4-20250514`
- `claude-haiku-4-5-20251001`

## Development

```bash
npm install
npm run build
```
