# wopr-plugin-provider-anthropic

[![npm version](https://img.shields.io/npm/v/wopr-plugin-provider-anthropic.svg)](https://www.npmjs.com/package/wopr-plugin-provider-anthropic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)

Anthropic Claude provider plugin for [WOPR](https://github.com/TSavo/wopr).

> Part of the [WOPR](https://github.com/TSavo/wopr) ecosystem - Self-sovereign AI session management over P2P.

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
