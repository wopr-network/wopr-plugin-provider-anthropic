/**
 * WOPR Plugin: Anthropic Claude Provider
 * 
 * Provides Anthropic Claude API access via the Agent SDK.
 * Supports vision capabilities for image analysis and session resumption.
 * 
 * Feature parity with Kimi provider:
 * - Session resumption via resume option
 * - yoloMode equivalent (permissionMode: bypassPermissions)
 * - Winston logging
 * - Session ID tracking
 * Install: wopr plugin install wopr-plugin-provider-anthropic
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelProvider, ModelClient, ModelQueryOptions } from "wopr/dist/types/provider.js";
import type { WOPRPlugin, WOPRPluginContext } from "wopr/dist/types.js";
import winston from "winston";

// Setup winston logger (feature parity with Kimi)
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-provider-anthropic" },
  transports: [
    new winston.transports.Console({ level: "warn" })
  ],
});

/**
 * Download image from URL and convert to base64
 */
async function downloadImageAsBase64(url: string): Promise<{ data: string; mediaType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    
    return {
      data: base64,
      mediaType: contentType,
    };
  } catch (error) {
    logger.error(`[anthropic] Failed to download image ${url}:`, error);
    return null;
  }
}

/**
 * Anthropic provider implementation
 */
const anthropicProvider: ModelProvider = {
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic Claude API via Agent SDK with session resumption and vision support",
  defaultModel: "claude-opus-4-5-20251101",
  supportedModels: [
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
  ],

  async validateCredentials(credential: string): Promise<boolean> {
    // API key format: sk-ant-...
    if (!credential.startsWith("sk-ant-")) {
      return false;
    }

    // Try a simple health check with the credential
    try {
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = credential;

      // Try a minimal query to validate with yoloMode (bypass permissions)
      const q = query({
        prompt: "ping",
        options: {
          max_tokens: 10,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });

      // Consume the generator
      for await (const _ of q) {
        // Just wait for completion
      }

      process.env.ANTHROPIC_API_KEY = oldKey;
      return true;
    } catch (error) {
      logger.error("[anthropic] Credential validation failed:", error);
      return false;
    }
  },

  async createClient(
    credential: string,
    options?: Record<string, unknown>
  ): Promise<ModelClient> {
    return new AnthropicClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    return "api-key";
  },
};

/**
 * Extended query options with resume (feature parity with Kimi)
 */
interface ExtendedQueryOptions extends ModelQueryOptions {
  resume?: string;
}

/**
 * Anthropic client implementation with vision support and session tracking
 */
class AnthropicClient implements ModelClient {
  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {
    // Set API key for Claude Agent SDK to use
    process.env.ANTHROPIC_API_KEY = credential;
  }

  async *query(opts: ExtendedQueryOptions): AsyncGenerator<any> {
    const model = opts.model || anthropicProvider.defaultModel;

    const queryOptions: any = {
      max_tokens: opts.maxTokens || 4096,
      model: model,
      // yoloMode equivalent - auto-approve all operations
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };

    if (opts.systemPrompt) {
      queryOptions.systemPrompt = opts.systemPrompt;
    }

    // Session resumption (feature parity with Kimi)
    if (opts.resume) {
      queryOptions.resume = opts.resume;
      logger.info(`[anthropic] Resuming session: ${opts.resume}`);
    }

    if (opts.temperature !== undefined) {
      queryOptions.temperature = opts.temperature;
    }

    if (opts.topP !== undefined) {
      queryOptions.topP = opts.topP;
    }

    // Handle images for vision models
    let prompt = opts.prompt;
    if (opts.images && opts.images.length > 0) {
      const imageContents = [];
      
      for (const imageUrl of opts.images) {
        const imageData = await downloadImageAsBase64(imageUrl);
        if (imageData) {
          imageContents.push({
            type: "image",
            source: {
              type: "base64",
              media_type: imageData.mediaType,
              data: imageData.data,
            },
          });
        }
      }
      
      if (imageContents.length > 0) {
        queryOptions.imageContents = imageContents;
        prompt = `[User has shared ${imageContents.length} image(s)]\n\n${prompt}`;
      }
    }

    // Merge provider-specific options
    if (opts.providerOptions) {
      Object.assign(queryOptions, opts.providerOptions);
    }

    // Merge constructor options
    if (this.options) {
      Object.assign(queryOptions, this.options);
    }

    try {
      // Use Claude Agent SDK query function
      const q = query({
        prompt: prompt,
        options: queryOptions,
      });

      // Track if we've yielded session_id (feature parity with Kimi)
      let sessionIdYielded = false;

      // Stream results from agent SDK
      for await (const msg of q) {
        // Yield session ID from system init message (feature parity with Kimi)
        if (!sessionIdYielded && msg.type === 'system' && msg.subtype === 'init' && (msg as any).session_id) {
          const sessionId = (msg as any).session_id;
          logger.info(`[anthropic] Session initialized: ${sessionId}`);
          yield { 
            type: "system", 
            subtype: "init", 
            session_id: sessionId 
          };
          sessionIdYielded = true;
        }
        
        // Yield the original message
        yield msg;
      }
    } catch (error) {
      logger.error("[anthropic] Query failed:", error);
      throw new Error(
        `Anthropic query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    return anthropicProvider.supportedModels;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = this.credential;

      // Try a minimal query with yoloMode
      const q = query({
        prompt: "test",
        options: {
          max_tokens: 10,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });

      // Consume the generator
      for await (const _ of q) {
        // Just wait for completion
      }

      process.env.ANTHROPIC_API_KEY = oldKey;
      return true;
    } catch (error) {
      logger.error("[anthropic] Health check failed:", error);
      return false;
    }
  }
}

/**
 * Plugin export
 */
const plugin: WOPRPlugin = {
  name: "provider-anthropic",
  version: "1.1.0", // Bumped for feature parity
  description: "Anthropic Claude API provider for WOPR with session resumption, yoloMode, and vision support",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering Anthropic provider...");
    ctx.registerProvider(anthropicProvider);
    ctx.log.info("Anthropic provider registered (supports session resumption, yoloMode, vision)");

    // Register config schema for UI
    ctx.registerConfigSchema("provider-anthropic", {
      title: "Anthropic Claude",
      description: "Configure Anthropic Claude API credentials and settings",
      fields: [
        {
          name: "apiKey",
          type: "password",
          label: "API Key",
          placeholder: "sk-ant-...",
          required: true,
          description: "Your Anthropic API key (starts with sk-ant-)",
        },
        {
          name: "model",
          type: "select",
          label: "Default Model",
          options: [
            { value: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
            { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
            { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
          ],
          default: "claude-opus-4-5-20251101",
          description: "Default model to use for new sessions",
        },
        {
          name: "maxTokens",
          type: "number",
          label: "Max Tokens",
          placeholder: "4096",
          default: 4096,
          description: "Maximum tokens per response",
        },
      ],
    });
    ctx.log.info("Registered Anthropic config schema");
  },

  async shutdown() {
    logger.info("[provider-anthropic] Shutting down");
  },
};

export default plugin;
