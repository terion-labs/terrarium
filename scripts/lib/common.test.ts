import { describe, expect, test } from "bun:test";
import { runText, runAllowFailure } from "./common";

describe("command runner", () => {
  test("passes stdin to subprocesses", async () => {
    await expect(runText(["cat"], "test", { stdin: "terrarium-stdin" })).resolves.toBe("terrarium-stdin");
  });
  test("bounds probes even when a descendant holds the output pipe", async () => {
    const start = Date.now();
    const result = await runAllowFailure(["sh", "-c", "sleep 30 & wait"], { timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(Date.now() - start).toBeLessThan(3000);
  });
  test("bounded commands receive stdin and preserve failures without retrying", async () => {
    expect(await runAllowFailure(["sh", "-c", "cat; exit 7"], { stdin: "one execution", timeoutMs: 2000 })).toEqual({ exitCode: 7, stdout: "one execution", stderr: "" });
  });
});
