import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: mockQuery,
	unstable_v2_createSession: vi.fn(),
	unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(() => "{}"),
	};
});

describe("credential isolation in validateCredentials", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.ANTHROPIC_API_KEY;
		// Mock query to succeed (return a complete async iterable)
		mockQuery.mockImplementation(() => {
			return (async function* () {
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "OK" }] },
				};
			})();
		});
	});

	it("passes credential via env option, NOT process.env mutation", async () => {
		const { default: plugin } = await import("../index.js");
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
		};
		await plugin.init(ctx);

		const provider = ctx.registerLLMProvider.mock.calls[0][0] as {
			validateCredentials: (cred: string) => Promise<boolean>;
		};

		const testKey = "sk-ant-test-validation-key";
		await provider.validateCredentials(testKey);

		// Verify query was called with env containing the credential
		expect(mockQuery).toHaveBeenCalledOnce();
		const call = mockQuery.mock.calls[0][0];
		expect(call.options.env).toBeDefined();
		expect(call.options.env.ANTHROPIC_API_KEY).toBe(testKey);

		// Verify process.env was NOT mutated
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("does not leak credentials between concurrent validations", async () => {
		const { default: plugin } = await import("../index.js");
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
		};
		await plugin.init(ctx);

		const provider = ctx.registerLLMProvider.mock.calls[0][0] as {
			validateCredentials: (cred: string) => Promise<boolean>;
		};

		// Run two validations concurrently
		const key1 = "sk-ant-tenant-1-key";
		const key2 = "sk-ant-tenant-2-key";
		await Promise.all([
			provider.validateCredentials(key1),
			provider.validateCredentials(key2),
		]);

		// Each call should have its own env with its own key
		expect(mockQuery).toHaveBeenCalledTimes(2);
		const envs = mockQuery.mock.calls.map(
			(c: any) => c[0].options.env.ANTHROPIC_API_KEY,
		);
		expect(envs).toContain(key1);
		expect(envs).toContain(key2);

		// process.env should remain untouched
		expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("does not restore a stale key on validation failure", async () => {
		// Mock query to throw
		mockQuery.mockImplementation(() => {
			// biome-ignore lint/correctness/useYield: async generator mock that immediately throws
			return (async function* () {
				throw new Error("Invalid API key");
			})();
		});

		const { default: plugin } = await import("../index.js");
		const ctx = {
			log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			registerLLMProvider: vi.fn(),
			registerConfigSchema: vi.fn(),
		};
		await plugin.init(ctx);

		const provider = ctx.registerLLMProvider.mock.calls[0][0] as {
			validateCredentials: (cred: string) => Promise<boolean>;
		};

		try {
			// Set a "daemon" key in process.env
			process.env.ANTHROPIC_API_KEY = "sk-ant-daemon-key";

			const result = await provider.validateCredentials("sk-ant-bad-key");
			expect(result).toBe(false);

			// process.env should still have the daemon key, unmodified
			expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-daemon-key");
		} finally {
			// Clean up — guaranteed to run even if assertions fail
			delete process.env.ANTHROPIC_API_KEY;
		}
	});
});
