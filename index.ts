/**
 * WOPR Plugin: Anthropic Claude Provider
 *
 * Authentication methods (checked in order):
 * 1. OAuth - Claude Pro/Max subscription via Claude Code credentials
 * 2. API Key - Direct API key (sk-ant-...)
 */

import {
  query,
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import winston from "winston";

// =============================================================================
// SDK Type Extensions
// =============================================================================

// The SDK's SDKMessage type doesn't include session_id, but it's present on
// every streamed message per the V2 API docs. Intersect the type to include it.
type SDKMessageWithSessionId = SDKMessage & { session_id?: string };

// =============================================================================
// Type definitions (inline to avoid wopr dependency for builds)
// =============================================================================

type ThinkingConfig =
  | { type: 'adaptive' }
  | {
      type: 'enabled';
      /** Must be within Anthropic's supported min/max range for the chosen model. */
      budgetTokens: number;
    }
  | { type: 'disabled' };

/**
 * Structured output format using JSON Schema constrained decoding.
 * GA on Claude Opus 4.6, Sonnet 4.5, Opus 4.5, Haiku 4.5.
 */
type ResponseFormat =
  | {
      type: 'json_schema';
      /** A JSON Schema object describing the expected response structure. */
      schema: Record<string, unknown>;
    }
  | { type: 'text' };

interface ModelQueryOptions {
  prompt: string;
  systemPrompt?: string;
  resume?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  images?: string[];
  mcpServers?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
  /** Controls extended thinking / chain-of-thought reasoning. */
  thinking?: ThinkingConfig;
  /** Controls effort level — works with adaptive thinking to guide depth. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Enable beta features, e.g. 'context-1m-2025-08-07' for 1M context. */
  betas?: string[];
  /**
   * Request structured JSON output conforming to a schema.
   * Uses Anthropic's constrained decoding — the model cannot produce tokens
   * that violate the schema. Supported on Opus 4.6, Sonnet 4.5, Opus 4.5, Haiku 4.5.
   */
  responseFormat?: ResponseFormat;
}

interface ModelClient {
  query(options: ModelQueryOptions): AsyncGenerator<unknown>;
  listModels(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
  // V2 Session API - for injecting messages into active sessions
  hasActiveSession?(sessionKey: string): boolean;
  sendToActiveSession?(sessionKey: string, message: string): Promise<void>;
  getActiveSessionStream?(sessionKey: string): AsyncGenerator<unknown> | null;
  closeSession?(sessionKey: string): void;
  // V2 query with session key for active session tracking
  queryV2?(options: ModelQueryOptions & { sessionKey: string }): AsyncGenerator<unknown>;
}

interface ModelProvider {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  supportedModels: string[];
  validateCredentials(credentials: string): Promise<boolean>;
  createClient(credential: string, options?: Record<string, unknown>): Promise<ModelClient>;
  getCredentialType(): "api-key" | "oauth" | "custom";
}

interface ConfigField {
  name: string;
  type: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
}

interface ConfigSchema {
  title: string;
  description: string;
  fields: ConfigField[];
}

interface WOPRPluginContext {
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  registerProvider: (provider: ModelProvider) => void;
  registerConfigSchema: (name: string, schema: ConfigSchema) => void;
}

interface WOPRPlugin {
  name: string;
  version: string;
  description: string;
  init(ctx: WOPRPluginContext): Promise<void>;
  shutdown(): Promise<void>;
}

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-provider-anthropic" },
  transports: [new winston.transports.Console({ level: "warn" })],
});

// =============================================================================
// Auth Detection - exposed for onboarding
// =============================================================================

const CLAUDE_CODE_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");
const WOPR_AUTH_FILE = join(homedir(), ".wopr", "auth.json");

interface AuthState {
  type: "oauth" | "api_key";
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  apiKey?: string;
  email?: string;
}

function loadClaudeCodeCredentials(): AuthState | null {
  if (!existsSync(CLAUDE_CODE_CREDENTIALS)) return null;
  try {
    const data = JSON.parse(readFileSync(CLAUDE_CODE_CREDENTIALS, "utf-8"));
    const oauth = data.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        type: "oauth",
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        email: oauth.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function loadWoprAuth(): AuthState | null {
  if (!existsSync(WOPR_AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(WOPR_AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function getAuth(): AuthState | null {
  const claudeCodeAuth = loadClaudeCodeCredentials();
  if (claudeCodeAuth) return claudeCodeAuth;
  const woprAuth = loadWoprAuth();
  if (woprAuth) return woprAuth;
  return null;
}

// =============================================================================
// Onboarding Info - exposed via provider
// =============================================================================

export interface AuthMethodInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;       // Is this auth method currently usable?
  requiresInput: boolean;   // Does user need to enter something?
  inputType?: "password" | "text";
  inputLabel?: string;
  inputPlaceholder?: string;
  setupInstructions?: string[];
  docsUrl?: string;
}

function getAuthMethods(): AuthMethodInfo[] {
  const oauthCreds = loadClaudeCodeCredentials();

  return [
    {
      id: "oauth",
      name: "Claude Pro/Max (OAuth)",
      description: "Use your Claude subscription - no per-token costs",
      available: !!oauthCreds,
      requiresInput: false,
      setupInstructions: oauthCreds
        ? [`Logged in as: ${oauthCreds.email || "Claude user"}`]
        : ["Run: claude login", "Then restart WOPR"],
      docsUrl: "https://claude.ai/settings",
    },
    {
      id: "api-key",
      name: "API Key (pay-per-use)",
      description: "Direct API access - billed per token",
      available: true,
      requiresInput: true,
      inputType: "password",
      inputLabel: "Anthropic API Key",
      inputPlaceholder: "sk-ant-...",
      docsUrl: "https://console.anthropic.com/",
    },
    {
      id: "bedrock",
      name: "Amazon Bedrock",
      description: "Claude via AWS",
      available: !!process.env.AWS_REGION && !!process.env.AWS_ACCESS_KEY_ID,
      requiresInput: false,
      setupInstructions: [
        "Set environment variables:",
        "  AWS_REGION",
        "  AWS_ACCESS_KEY_ID",
        "  AWS_SECRET_ACCESS_KEY",
      ],
      docsUrl: "https://docs.aws.amazon.com/bedrock/",
    },
    {
      id: "vertex",
      name: "Google Vertex AI",
      description: "Claude via Google Cloud",
      available: !!process.env.CLOUD_ML_REGION && !!process.env.ANTHROPIC_VERTEX_PROJECT_ID,
      requiresInput: false,
      setupInstructions: [
        "Set environment variables:",
        "  CLOUD_ML_REGION",
        "  ANTHROPIC_VERTEX_PROJECT_ID",
      ],
      docsUrl: "https://cloud.google.com/vertex-ai/docs",
    },
    {
      id: "foundry",
      name: "Microsoft Foundry",
      description: "Claude via Azure",
      available: !!process.env.ANTHROPIC_FOUNDRY_RESOURCE,
      requiresInput: false,
      setupInstructions: [
        "Set environment variables:",
        "  ANTHROPIC_FOUNDRY_RESOURCE",
        "  ANTHROPIC_FOUNDRY_API_KEY (optional)",
      ],
      docsUrl: "https://azure.microsoft.com/",
    },
  ];
}

function getActiveAuthMethod(): string {
  const auth = getAuth();
  if (auth?.type === "oauth") return "oauth";
  if (auth?.type === "api_key") return "api-key";
  if (process.env.CLAUDE_CODE_USE_BEDROCK) return "bedrock";
  if (process.env.CLAUDE_CODE_USE_VERTEX) return "vertex";
  if (process.env.CLAUDE_CODE_USE_FOUNDRY) return "foundry";
  // Check if OAuth is available even if not explicitly set
  if (loadClaudeCodeCredentials()) return "oauth";
  return "none";
}

function hasCredentials(): boolean {
  return getActiveAuthMethod() !== "none";
}

// =============================================================================
// Dynamic Model Discovery
// =============================================================================

const MODELS_PAGE_URL = "https://docs.anthropic.com/en/docs/about-claude/models/overview";
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Hardcoded fallback (used only if fetch + cache both fail)
const FALLBACK_MODEL_IDS = [
  "claude-opus-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-20250514",
  "claude-opus-4-5-20251101",
];

interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow: string;
  maxOutput: string;
  inputPrice: number;
  outputPrice: number;
  legacy: boolean;
}

interface ModelCacheEntry {
  models: DiscoveredModel[];
  fetchedAt: number;
}

let modelCache: ModelCacheEntry | null = null;

function stripHtml(html: string): string {
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

/**
 * Fetch the Anthropic models page and use Haiku to extract structured model data.
 * Results are cached for 24 hours. Falls back to hardcoded list on failure.
 */
async function discoverModels(): Promise<DiscoveredModel[]> {
  // Return cache if fresh
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL) {
    return modelCache.models;
  }

  try {
    // Step 1: Fetch the models overview page
    logger.info("[anthropic] Fetching models from Anthropic docs...");
    const response = await fetch(MODELS_PAGE_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const text = stripHtml(html).slice(0, 60000); // Keep under token limits

    // Step 2: Ask Haiku to extract model info
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
      } as any,
    });

    // Collect text from Haiku's response
    let result = "";
    for await (const msg of q) {
      const m = msg as any;
      if (m.type === "assistant" && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === "text") result += block.text;
        }
      }
    }

    // Parse JSON from response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array in Haiku response");

    const models: DiscoveredModel[] = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error("Empty or invalid model array");
    }

    // Validate each model has required fields
    for (const model of models) {
      if (!model.id || typeof model.id !== "string") {
        throw new Error(`Invalid model entry: missing id`);
      }
    }

    // Cache the results
    modelCache = { models, fetchedAt: Date.now() };
    logger.info(`[anthropic] Discovered ${models.length} models from Anthropic docs`);

    // Update the provider's supportedModels list
    anthropicProvider.supportedModels = models.map((m) => m.id);

    // Update defaultModel to latest non-legacy model
    const currentModels = models.filter((m) => !m.legacy);
    if (currentModels.length > 0) {
      anthropicProvider.defaultModel = currentModels[0].id;
    }

    return models;
  } catch (error) {
    logger.warn(`[anthropic] Model discovery failed: ${error instanceof Error ? error.message : String(error)}`);

    // Return stale cache if available
    if (modelCache) {
      logger.info("[anthropic] Using stale model cache");
      return modelCache.models;
    }

    // Ultimate fallback — context windows reflect 1M beta availability
    logger.info("[anthropic] Using hardcoded fallback models");
    return FALLBACK_MODEL_IDS.map((id) => ({
      id,
      name: id,
      contextWindow: (id.includes("sonnet") || id.includes("opus")) ? "200K (1M with beta)" : "200K",
      maxOutput: id.includes("haiku") ? "8K" : "128K",
      inputPrice: 0,
      outputPrice: 0,
      legacy: false,
    }));
  }
}

/**
 * Get discovered models (cached). Non-blocking - returns fallback if not yet fetched.
 */
function getDiscoveredModelIds(): string[] {
  if (modelCache) return modelCache.models.map((m) => m.id);
  return FALLBACK_MODEL_IDS;
}

/**
 * Get full model info for display/selection
 */
async function getModelInfo(): Promise<DiscoveredModel[]> {
  return discoverModels();
}

// =============================================================================
// Image handling
// =============================================================================

async function downloadImageAsBase64(url: string): Promise<{ data: string; mediaType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { data: base64, mediaType: contentType };
  } catch (error) {
    logger.error(`[anthropic] Failed to download image ${url}:`, error);
    return null;
  }
}

// =============================================================================
// Provider Implementation
// =============================================================================

const anthropicProvider: ModelProvider & {
  getAuthMethods: () => AuthMethodInfo[];
  getActiveAuthMethod: () => string;
  hasCredentials: () => boolean;
  getModelInfo: () => Promise<DiscoveredModel[]>;
} = {
  id: "anthropic",
  name: "Anthropic Claude",
  description: "Claude via OAuth, API Key, or cloud providers",
  defaultModel: FALLBACK_MODEL_IDS[0],
  supportedModels: [...FALLBACK_MODEL_IDS],

  // Onboarding helpers
  getAuthMethods,
  getActiveAuthMethod,
  hasCredentials,
  getModelInfo,

  async validateCredentials(credential: string): Promise<boolean> {
    // Empty credential is valid if we have OAuth or env-based auth
    if (!credential || credential === "") {
      return hasCredentials();
    }
    // API key format
    if (!credential.startsWith("sk-ant-")) {
      return false;
    }
    try {
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = credential;
      const q = query({
        prompt: "ping",
        options: {
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        } as any,
      });
      for await (const _ of q) {}
      process.env.ANTHROPIC_API_KEY = oldKey;
      return true;
    } catch (error) {
      logger.error("[anthropic] Credential validation failed:", error);
      return false;
    }
  },

  async createClient(credential: string, options?: Record<string, unknown>): Promise<ModelClient> {
    return new AnthropicClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    const active = getActiveAuthMethod();
    if (active === "oauth") return "oauth";
    if (active === "api-key") return "api-key";
    return "oauth"; // Default to OAuth for env-based methods
  },
};

// =============================================================================
// Client Implementation with V2 Session Support
// =============================================================================

interface ActiveSession {
  session: SDKSession;
  sessionId: string | null;  // SDK session ID (from Claude)
  model: string;
  createdAt: number;
  lastMessageAt: number;
  streaming: boolean;
  streamGenerator: AsyncGenerator<SDKMessage, void> | null;
}

// Global map of active V2 sessions by sessionKey (WOPR's session identifier)
const activeSessions = new Map<string, ActiveSession>();

// Lock map to prevent race conditions on concurrent queryV2 calls
const sessionLocks = new Map<string, Promise<void>>();

// Session timeout: close sessions that haven't been used in 30 minutes
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Default allowed tools for V2 sessions (can be overridden via providerOptions.allowedTools)
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"];

// Store interval ID for cleanup on shutdown
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

// Start cleanup interval
function startCleanupInterval() {
  if (cleanupIntervalId) return; // Already running

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of activeSessions.entries()) {
      if (now - session.lastMessageAt > SESSION_TIMEOUT_MS && !session.streaming) {
        logger.info(`[anthropic] Cleaning up stale V2 session: ${key}`);
        try {
          session.session.close();
        } catch (e) {
          // Ignore close errors
        }
        activeSessions.delete(key);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

// Stop cleanup interval and close all sessions (for shutdown)
function stopCleanupAndCloseSessions() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Close all active sessions
  for (const [key, session] of activeSessions.entries()) {
    logger.info(`[anthropic] Closing V2 session on shutdown: ${key}`);
    try {
      session.session.close();
    } catch (e) {
      // Ignore close errors
    }
  }
  activeSessions.clear();
  sessionLocks.clear();
}

// Helper to acquire session lock (prevents race conditions)
async function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing operation on this session to complete
  const existingLock = sessionLocks.get(sessionKey);
  if (existingLock) {
    await existingLock;
  }

  // Create a new lock for this operation
  let resolve: () => void;
  const lockPromise = new Promise<void>(r => { resolve = r; });
  sessionLocks.set(sessionKey, lockPromise);

  try {
    return await fn();
  } finally {
    resolve!();
    // Only delete if this is still our lock
    if (sessionLocks.get(sessionKey) === lockPromise) {
      sessionLocks.delete(sessionKey);
    }
  }
}

// Start the cleanup interval
startCleanupInterval();

class AnthropicClient implements ModelClient {
  private authType: string;

  constructor(private credential: string, private options?: Record<string, unknown>) {
    if (credential && credential.startsWith("sk-ant-")) {
      this.authType = "api_key";
      process.env.ANTHROPIC_API_KEY = credential;
    } else {
      const auth = getAuth();
      if (auth?.type === "oauth" && auth.accessToken) {
        this.authType = "oauth";
        delete process.env.ANTHROPIC_API_KEY;
      } else if (auth?.type === "api_key" && auth.apiKey) {
        this.authType = "api_key";
        process.env.ANTHROPIC_API_KEY = auth.apiKey;
      } else {
        this.authType = "oauth";
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
    logger.info(`[anthropic] Using auth: ${this.authType}`);
  }

  // Check if there's an active V2 session for a given sessionKey
  hasActiveSession(sessionKey: string): boolean {
    const active = activeSessions.get(sessionKey);
    return !!active && active.streaming;
  }

  // Send a message to an active V2 session (inject into running conversation)
  async sendToActiveSession(sessionKey: string, message: string): Promise<void> {
    const active = activeSessions.get(sessionKey);
    if (!active) {
      throw new Error(`No active session for key: ${sessionKey}`);
    }

    logger.info(`[anthropic] Injecting message into active session: ${sessionKey}`);
    active.lastMessageAt = Date.now();
    await active.session.send(message);
  }

  // Get the stream generator for an active session (to read new responses)
  getActiveSessionStream(sessionKey: string): AsyncGenerator<unknown> | null {
    const active = activeSessions.get(sessionKey);
    if (!active || !active.streamGenerator) {
      return null;
    }
    return active.streamGenerator as AsyncGenerator<unknown>;
  }

  // Close an active session
  closeSession(sessionKey: string): void {
    const active = activeSessions.get(sessionKey);
    if (active) {
      logger.info(`[anthropic] Closing session: ${sessionKey}`);
      try {
        active.session.close();
      } catch (e) {
        // Ignore close errors
      }
      activeSessions.delete(sessionKey);
    }
  }

  // V2 Session-based query - keeps session alive for message injection
  async *queryV2(opts: ModelQueryOptions & { sessionKey: string }): AsyncGenerator<unknown> {
    const model = opts.model || anthropicProvider.defaultModel;
    const sessionKey = opts.sessionKey;

    // Check if we have an existing session
    let active = activeSessions.get(sessionKey);

    // If no session exists, create one with lock to prevent race condition
    // (two concurrent calls both seeing no session and both creating)
    if (!active) {
      active = await withSessionLock(sessionKey, async () => {
        // Double-check after acquiring lock - another call might have created it
        const existingSession = activeSessions.get(sessionKey);
        if (existingSession) {
          logger.info(`[anthropic] Session already created by concurrent call: ${sessionKey}`);
          return existingSession;
        }

        // Create or resume V2 session
        // allowedTools can be overridden via providerOptions.allowedTools
        const allowedTools = (opts.providerOptions?.allowedTools as string[]) || DEFAULT_ALLOWED_TOOLS;
        const sessionOptions: any = {
          model,
          allowedTools,
        };

        // Pass through options from the query
        if (opts.systemPrompt) sessionOptions.systemPrompt = opts.systemPrompt;
        if (opts.temperature !== undefined) sessionOptions.temperature = opts.temperature;
        if (opts.topP !== undefined) sessionOptions.topP = opts.topP;
        if (opts.maxTokens) sessionOptions.max_tokens = opts.maxTokens;
        if (opts.mcpServers) sessionOptions.mcpServers = opts.mcpServers;
        if (opts.thinking) sessionOptions.thinking = opts.thinking;
        if (opts.effort) sessionOptions.effort = opts.effort;
        if (opts.betas) sessionOptions.betas = opts.betas;
        if (opts.responseFormat) {
          sessionOptions.outputFormat = opts.responseFormat;
        }
        if (opts.providerOptions) {
          // Copy providerOptions but don't overwrite allowedTools (already handled above)
          const { allowedTools: _, ...restOptions } = opts.providerOptions;
          Object.assign(sessionOptions, restOptions);
        }

        let session: SDKSession;

        if (opts.resume) {
          logger.info(`[anthropic] Resuming V2 session by ID: ${opts.resume}`);
          session = unstable_v2_resumeSession(opts.resume, sessionOptions);
        } else {
          logger.info(`[anthropic] Creating new V2 session for: ${sessionKey}`);
          session = unstable_v2_createSession(sessionOptions);
        }

        // Track this session
        const newSession: ActiveSession = {
          session,
          sessionId: opts.resume || null,
          model,
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
          streaming: false,  // Will be set true when we start streaming
          streamGenerator: null,
        };
        activeSessions.set(sessionKey, newSession);

        return newSession;
      });
    } else {
      logger.info(`[anthropic] Reusing existing V2 session for: ${sessionKey} (was streaming: ${active.streaming})`);
    }

    // Now we have a session (either existing or newly created)
    // The lock is released - streaming happens without holding the lock
    // This allows sendToActiveSession() to inject messages during streaming
    active.lastMessageAt = Date.now();
    active.streaming = true;

    try {
      // Send the message
      await active.session.send(opts.prompt);

      // Stream and yield responses
      const stream = active.session.stream();
      active.streamGenerator = stream;

      for await (const msg of stream) {
        // Capture session ID (available on every message per V2 API docs)
        const msgWithId = msg as SDKMessageWithSessionId;
        if (msgWithId.session_id && !active.sessionId) {
          active.sessionId = msgWithId.session_id;
          logger.info(`[anthropic] V2 Session initialized: ${active.sessionId}`);
        }
        yield msg;
      }

      // Stream completed
      active.streaming = false;
      active.streamGenerator = null;

    } catch (error) {
      active.streaming = false;
      active.streamGenerator = null;

      // If session is stale/dead, remove it
      const errorStr = String(error);
      if (errorStr.includes("session") || errorStr.includes("closed") || errorStr.includes("No conversation")) {
        logger.warn(`[anthropic] V2 Session stale, removing: ${sessionKey}`);
        activeSessions.delete(sessionKey);
      } else {
        activeSessions.delete(sessionKey);  // Clean up on failure
        logger.error("[anthropic] V2 Query failed:", error);
        throw new Error(`Anthropic V2 query failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Original V1 query method (backward compatible)
  async *query(opts: ModelQueryOptions): AsyncGenerator<unknown> {
    const model = opts.model || anthropicProvider.defaultModel;

    const queryOptions: any = {
      max_tokens: opts.maxTokens || 4096,
      model,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };

    if (opts.systemPrompt) queryOptions.systemPrompt = opts.systemPrompt;
    if (opts.resume) {
      queryOptions.resume = opts.resume;
      logger.info(`[anthropic] Resuming session: ${opts.resume}`);
    }
    if (opts.temperature !== undefined) queryOptions.temperature = opts.temperature;
    if (opts.topP !== undefined) queryOptions.topP = opts.topP;
    if (opts.mcpServers) queryOptions.mcpServers = opts.mcpServers;
    if (opts.thinking) queryOptions.thinking = opts.thinking;
    if (opts.effort) queryOptions.effort = opts.effort;
    if (opts.betas) queryOptions.betas = opts.betas;
    if (opts.responseFormat) {
      queryOptions.outputFormat = opts.responseFormat;
    }

    let prompt = opts.prompt;
    if (opts.images && opts.images.length > 0) {
      const imageContents = [];
      for (const imageUrl of opts.images) {
        const imageData = await downloadImageAsBase64(imageUrl);
        if (imageData) {
          imageContents.push({
            type: "image",
            source: { type: "base64", media_type: imageData.mediaType, data: imageData.data },
          });
        }
      }
      if (imageContents.length > 0) {
        queryOptions.imageContents = imageContents;
        prompt = `[User has shared ${imageContents.length} image(s)]\n\n${prompt}`;
      }
    }

    if (opts.providerOptions) Object.assign(queryOptions, opts.providerOptions);
    if (this.options) Object.assign(queryOptions, this.options);

    try {
      const q = query({ prompt, options: queryOptions });
      let sessionLogged = false;

      for await (const msg of q) {
        // Log session ID once for debugging
        const msgWithId = msg as SDKMessageWithSessionId;
        if (msgWithId.session_id && !sessionLogged) {
          logger.info(`[anthropic] Session initialized: ${msgWithId.session_id}`);
          sessionLogged = true;
        }
        // Pass through all messages unchanged
        yield msg;
      }
    } catch (error) {
      logger.error("[anthropic] Query failed:", error);
      throw new Error(`Anthropic query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listModels(): Promise<string[]> {
    // Trigger async discovery (updates supportedModels as side effect)
    try {
      const models = await discoverModels();
      return models.map((m) => m.id);
    } catch {
      return anthropicProvider.supportedModels;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const q = query({
        prompt: "test",
        options: { max_tokens: 10, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true } as any,
      });
      for await (const _ of q) {}
      return true;
    } catch (error) {
      logger.error("[anthropic] Health check failed:", error);
      return false;
    }
  }
}

// Export client class and model discovery for type checking
export { AnthropicClient, discoverModels, getModelInfo };
export type { DiscoveredModel, ResponseFormat };

// =============================================================================
// Plugin Export
// =============================================================================

const plugin: WOPRPlugin = {
  name: "provider-anthropic",
  version: "2.3.0",
  description: "Anthropic Claude with OAuth, API Key, Bedrock, Vertex, Foundry support + dynamic model discovery + structured outputs",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering Anthropic provider...");

    const activeAuth = getActiveAuthMethod();
    const authMethods = getAuthMethods();
    const activeMethod = authMethods.find(m => m.id === activeAuth);

    if (activeMethod?.available) {
      ctx.log.info(`  Auth: ${activeMethod.name}`);
    } else {
      ctx.log.warn("  Auth: None configured");
      const available = authMethods.filter(m => m.available);
      if (available.length > 0) {
        ctx.log.info(`  Available: ${available.map(m => m.name).join(", ")}`);
      }
    }

    ctx.registerProvider(anthropicProvider);
    ctx.log.info("Anthropic provider registered");

    // Kick off model discovery in background (non-blocking)
    if (activeMethod?.available) {
      discoverModels().then((models) => {
        const current = models.filter((m) => !m.legacy);
        ctx.log.info(`  Models: ${current.map((m) => m.name).join(", ")} (${models.length} total)`);
      }).catch((err) => {
        ctx.log.warn(`  Model discovery deferred: ${err.message || err}`);
      });
    }

    // Config schema uses data from provider
    const methods = getAuthMethods();
    ctx.registerConfigSchema("provider-anthropic", {
      title: "Anthropic Claude",
      description: "Configure Anthropic Claude authentication",
      fields: [
        {
          name: "authMethod",
          type: "select",
          label: "Authentication Method",
          options: methods.map(m => ({
            value: m.id,
            label: `${m.name}${m.available ? " ✓" : ""}`,
          })),
          default: getActiveAuthMethod(),
          description: "Choose how to authenticate with Claude",
        },
        {
          name: "apiKey",
          type: "password",
          label: "API Key",
          placeholder: "sk-ant-...",
          required: false,
          description: "Only needed for API Key auth method",
        },
      ],
    });
  },

  async shutdown() {
    logger.info("[provider-anthropic] Shutting down");
    stopCleanupAndCloseSessions();
  },
};

export default plugin;
