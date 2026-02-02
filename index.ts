/**
 * WOPR Plugin: Anthropic Claude Provider
 *
 * Authentication methods (checked in order):
 * 1. OAuth - Claude Pro/Max subscription via Claude Code credentials
 * 2. API Key - Direct API key (sk-ant-...)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ModelProvider, ModelClient, ModelQueryOptions } from "wopr/dist/types/provider.js";
import type { WOPRPlugin, WOPRPluginContext } from "wopr/dist/types.js";
import winston from "winston";

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
// Client Implementation
// =============================================================================

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

      for await (const msg of q) {
        // Log session init for debugging
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          logger.info(`[anthropic] Session initialized: ${msg.session_id}`);
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

// =============================================================================
// Plugin Export
// =============================================================================

const plugin: WOPRPlugin = {
  name: "provider-anthropic",
  version: "2.0.0",
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
  },
};

export default plugin;
