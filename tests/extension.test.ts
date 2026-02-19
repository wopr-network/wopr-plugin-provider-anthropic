/**
 * Tests for provider-anthropic extension registration (WOP-268)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK before importing the plugin
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
	unstable_v2_createSession: vi.fn(),
	unstable_v2_resumeSession: vi.fn(),
}));

// Mock fs to avoid reading real credential files
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => "{}"),
	};
});

describe("provider-anthropic extension (WOP-268)", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		// Stub fetch to prevent real network calls from discoverModels()
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error("network disabled in tests"));
		delete process.env.CLAUDE_CODE_USE_BEDROCK;
		delete process.env.CLAUDE_CODE_USE_VERTEX;
		delete process.env.CLAUDE_CODE_USE_FOUNDRY;
		delete process.env.AWS_REGION;
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.CLOUD_ML_REGION;
		delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
		delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("calls ctx.registerExtension with 'provider-anthropic' during init", async () => {
		const { default: plugin } = await import("../index.js");

		const registerExtension = vi.fn();
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
			registerExtension,
		};

		await plugin.init(ctx as any);

		expect(registerExtension).toHaveBeenCalledWith(
			"provider-anthropic",
			expect.objectContaining({ getModelInfo: expect.any(Function) }),
		);
	});

	it("does not call registerExtension when ctx lacks the method", async () => {
		const { default: plugin } = await import("../index.js");

		const ctx = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
			// No registerExtension
		};

		// Should not throw even when registerExtension is absent
		await expect(plugin.init(ctx as any)).resolves.not.toThrow();
	});

	it("extension.getModelInfo returns safe display fields only", async () => {
		const { default: plugin } = await import("../index.js");

		let capturedExtension: any;
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
			registerExtension: vi.fn((_name: string, ext: unknown) => {
				capturedExtension = ext;
			}),
		};

		await plugin.init(ctx as any);

		expect(capturedExtension).toBeDefined();
		expect(capturedExtension.getModelInfo).toBeTypeOf("function");

		const models = await capturedExtension.getModelInfo();
		expect(Array.isArray(models)).toBe(true);
		expect(models.length).toBeGreaterThan(0);

		// Verify safe fields are present
		for (const model of models) {
			expect(model).toHaveProperty("id");
			expect(model).toHaveProperty("name");

			// SECURITY: must NOT expose credentials or auth state
			expect(model).not.toHaveProperty("accessToken");
			expect(model).not.toHaveProperty("refreshToken");
			expect(model).not.toHaveProperty("apiKey");
			expect(model).not.toHaveProperty("credential");
		}
	});

	it("extension.getModelInfo returns models with expected display properties", async () => {
		const { default: plugin } = await import("../index.js");

		let capturedExtension: any;
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
			registerExtension: vi.fn((_name: string, ext: unknown) => {
				capturedExtension = ext;
			}),
		};

		await plugin.init(ctx as any);

		const models = await capturedExtension.getModelInfo();
		// Should have the expected shape fields
		for (const model of models) {
			expect(typeof model.id).toBe("string");
			expect(typeof model.name).toBe("string");
		}
	});
});
