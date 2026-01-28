/**
 * WOPR Plugin: Anthropic Claude Provider
 * 
 * Provides Anthropic Claude API access via the Agent SDK.
 * Supports vision capabilities for image analysis.
 * Install: wopr plugin install wopr-plugin-provider-anthropic
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelProvider, ModelClient, ModelQueryOptions } from "wopr/dist/types/provider.js";
import type { WOPRPlugin, WOPRPluginContext } from "wopr/dist/types.js";

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
    console.error(`[anthropic] Failed to download image ${url}:`, error);
    return null;
  }
}

/**
 * Anthropic provider implementation
 */
const anthropicProvider: ModelProvider = {
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic Claude API via Agent SDK (Pay-per-use or Claude.ai OAuth). Supports vision.",
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

      // Try a minimal query to validate
      const response = await query({
        prompt: "ping",
        options: {
          max_tokens: 10,
        } as any,
      });

      process.env.ANTHROPIC_API_KEY = oldKey;
      return !!response;
    } catch (error) {
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
 * Anthropic client implementation with vision support
 */
class AnthropicClient implements ModelClient {
  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {
    // Set API key for Claude Agent SDK to use
    process.env.ANTHROPIC_API_KEY = credential;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<any> {
    const model = opts.model || anthropicProvider.defaultModel;

    const queryOptions: any = {
      max_tokens: opts.maxTokens || 4096,
    };

    if (opts.systemPrompt) {
      queryOptions.systemPrompt = opts.systemPrompt;
    }

    if (opts.resume) {
      queryOptions.resume = opts.resume;
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
      // For vision, we need to format the prompt with image content
      // Claude 3 supports vision through the Messages API with image blocks
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
      
      // Store image content in providerOptions for the SDK to use
      if (imageContents.length > 0) {
        queryOptions.imageContents = imageContents;
        // Also add a note to the prompt about the images
        prompt = `[User has shared ${imageContents.length} image(s)]\n\n${prompt}`;
      }
    }

    // Merge provider-specific options
    if (opts.providerOptions) {
      Object.assign(queryOptions, opts.providerOptions);
    }

    try {
      // Use Claude Agent SDK query function - returns async generator
      const q = await query({
        prompt: prompt,
        options: queryOptions,
      });

      // Stream results from agent SDK
      for await (const msg of q) {
        yield msg;
      }
    } catch (error) {
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

      // Try a minimal query
      const response = await query({
        prompt: "test",
        options: {
          max_tokens: 10,
        } as any,
      });

      process.env.ANTHROPIC_API_KEY = oldKey;
      return !!response;
    } catch {
      return false;
    }
  }
}

/**
 * Plugin export
 */
const plugin: WOPRPlugin = {
  name: "provider-anthropic",
  version: "1.0.0",
  description: "Anthropic Claude API provider for WOPR with vision support",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering Anthropic provider...");
    ctx.registerProvider(anthropicProvider);
    ctx.log.info("Anthropic provider registered (supports vision)");

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
    console.log("[provider-anthropic] Shutting down");
  },
};

export default plugin;
