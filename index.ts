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
// every streamed message per the V2 API docs. Extend the type to include it.
interface SDKMessageWithSessionId extends SDKMessage {
  session_id?: string;
}

// =============================================================================
// Type definitions (inline to avoid wopr dependency for builds)
// =============================================================================

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
} = {
  id: "anthropic",
  name: "Anthropic Claude",
  description: "Claude via OAuth, API Key, or cloud providers",
  defaultModel: "claude-sonnet-4-20250514",
  supportedModels: [
    "claude-sonnet-4-20250514",
    "claude-opus-4-5-20251101",
    "claude-haiku-4-5-20251001",
  ],

  // Onboarding helpers
  getAuthMethods,
  getActiveAuthMethod,
  hasCredentials,

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
    return anthropicProvider.supportedModels;
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

// Export client class for type checking (activeSessions is intentionally NOT exported)
export { AnthropicClient };

// =============================================================================
// Plugin Export
// =============================================================================

const plugin: WOPRPlugin = {
  name: "provider-anthropic",
  version: "2.1.0",
  description: "Anthropic Claude with OAuth, API Key, Bedrock, Vertex, Foundry support",

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
