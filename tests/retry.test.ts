import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => "{}") };
});

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns on first success without retrying", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, {}, { warn: vi.fn() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const error429 = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(error429).mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 }, { warn: vi.fn() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const error503 = Object.assign(new Error("unavailable"), { status: 503 });
    const fn = vi.fn().mockRejectedValueOnce(error503).mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 }, { warn: vi.fn() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors (ECONNRESET)", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const fn = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue("ok");
    const result = await retryWithBackoff(fn, { baseDelayMs: 1 }, { warn: vi.fn() });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on non-retryable errors (e.g. 401)", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const error401 = Object.assign(new Error("unauthorized"), { status: 401 });
    const fn = vi.fn().mockRejectedValue(error401);
    await expect(retryWithBackoff(fn, { baseDelayMs: 1 }, { warn: vi.fn() })).rejects.toThrow("unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries and throws", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const error429 = Object.assign(new Error("rate limited"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(error429);
    await expect(retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1 }, { warn: vi.fn() })).rejects.toThrow(
      "rate limited",
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("uses exponential backoff delays", async () => {
    const { retryWithBackoff } = await import("../src/index.js");
    const error429 = Object.assign(new Error("rate limited"), { status: 429 });
    const warnFn = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(error429).mockRejectedValueOnce(error429).mockResolvedValue("ok");
    await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 }, { warn: warnFn });
    expect(warnFn).toHaveBeenCalledTimes(2);
    // Check that delay messages mention increasing delays
    expect(warnFn.mock.calls[0][0]).toContain("1ms");
    expect(warnFn.mock.calls[1][0]).toContain("2ms");
  });
});
