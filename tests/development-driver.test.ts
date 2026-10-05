import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { startDevelopmentDriver } from "../scripts/development-driver.ts";

const fixture = path.join(import.meta.dirname, "fixtures/development-driver/driver.mjs");

function harness(mode: string) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-development-driver-"));
	const revision = path.join(directory, "local.mts");
	writeFileSync(revision, "export const localRevision = 0;\n");
	const driver = startDevelopmentDriver(process.execPath, [fixture, mode], {
		cwd: directory,
		readinessTimeoutMs: 1000,
		requestTimeoutMs: 50,
		pollMs: 5,
		shutdownGraceMs: 80,
		shutdownTimeoutMs: 2000,
	});
	return {
		driver,
		edit() {
			writeFileSync(revision, "export const localRevision = 1;\n");
		},
		async close() {
			try {
				await driver.stop();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	};
}

describe("development process verification", () => {
	it("accepts the served revision after an edit and captures final output through stdio close", async () => {
		const current = harness("live");
		try {
			await current.driver.waitForRevision(0);
			current.edit();
			await current.driver.waitForRevision(1);
			const closing = current.driver.stop();
			expect(current.driver.stop()).toBe(closing);
			const outcome = await closing;
			expect(outcome).toMatchObject({ code: 0, signal: null, forced: false });
			expect(outcome.stdout).toContain("FINAL_STDOUT");
			expect(outcome.stderr).toContain("FINAL_STDERR");
		} finally {
			await current.close();
		}
	});

	it("rejects stale served output even when the child reports a successful restart", async () => {
		const current = harness("stale");
		try {
			await current.driver.waitForRevision(0);
			current.edit();
			await expect(current.driver.waitForRevision(1)).rejects.toThrow(
				"timed out waiting for served revision 1",
			);
			expect(current.driver.stderr).toContain("Compiled in 0ms · restarted");
			expect(await current.driver.stop()).toMatchObject({ code: 0, forced: false });
		} finally {
			await current.close();
		}
	});

	it("rejects a child exit immediately instead of waiting for readiness timeout", async () => {
		const current = harness("exit");
		try {
			await expect(current.driver.waitForRevision(0)).rejects.toThrow(
				"development child exited before serving the requested revision (7)",
			);
			const outcome = await current.driver.stop();
			expect(outcome.stderr).toContain("EARLY_EXIT_SENTINEL");
			expect(outcome).toMatchObject({ code: 7, signal: null, forced: false });
		} finally {
			await current.close();
		}
	});

	it("bounds response-body readiness when a child never finishes its HTTP response", async () => {
		const current = harness("body-hang");
		try {
			await expect(current.driver.waitForRevision(0)).rejects.toThrow(
				"timed out waiting for served revision 0",
			);
			expect(await current.driver.stop()).toMatchObject({ code: 0, forced: false });
		} finally {
			await current.close();
		}
	});

	it.skipIf(process.platform === "win32")(
		"forces and joins a real child that ignores SIGTERM",
		async () => {
			const current = harness("ignore-term");
			try {
				await current.driver.waitForRevision(0);
				const outcome = await current.driver.stop();
				expect(outcome).toMatchObject({ code: null, signal: "SIGKILL", forced: true });
				expect(outcome.stderr).toContain("IGNORED_SIGTERM");
				expect(() => process.kill(current.driver.pid!, 0)).toThrow();
			} finally {
				await current.close();
			}
		},
	);
});
