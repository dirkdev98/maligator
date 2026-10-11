import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { captureVerificationSource } from "../scripts/verification-source.ts";

function withRepository(run: (directory: string) => void): void {
	const directory = mkdtempSync(path.join(os.tmpdir(), "maligator-verification-source-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: directory });
		writeFileSync(path.join(directory, ".gitignore"), ".cache/\n");
		writeFileSync(
			path.join(directory, "entry with spaces.ts"),
			"export const answer = 1;\n",
		);
		execFileSync("git", ["add", "."], { cwd: directory });
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("verification source identity", () => {
	it("detects unstaged changes, new inputs and deletions without including generated reports", () => {
		withRepository((directory) => {
			const initial = captureVerificationSource(directory);
			mkdirSync(path.join(directory, ".cache"));
			writeFileSync(path.join(directory, ".cache/report.json"), "{}");
			expect(captureVerificationSource(directory).digest).toBe(initial.digest);
			writeFileSync(
				path.join(directory, "entry with spaces.ts"),
				"export const answer = 2;\n",
			);
			const edited = captureVerificationSource(directory);
			expect(edited.digest).not.toBe(initial.digest);
			execFileSync("git", ["add", "."], { cwd: directory });
			expect(captureVerificationSource(directory).digest).toBe(edited.digest);
			writeFileSync(path.join(directory, "new.ts"), "export const added = true;\n");
			const added = captureVerificationSource(directory);
			expect(added.digest).not.toBe(edited.digest);
			rmSync(path.join(directory, "entry with spaces.ts"));
			expect(captureVerificationSource(directory).digest).not.toBe(added.digest);
		});
	});

	it("records the revision and dirty state while preserving content identity across a commit", () => {
		withRepository((directory) => {
			const staged = captureVerificationSource(directory);
			expect(staged.revision).toBeNull();
			expect(staged.dirty).toBe(true);
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Fixture",
					"-c",
					"user.email=fixture@example.invalid",
					"commit",
					"--quiet",
					"--no-gpg-sign",
					"-m",
					"fixture",
				],
				{ cwd: directory },
			);
			const committed = captureVerificationSource(directory);
			expect(committed.revision).toMatch(/^[a-f0-9]{40}$/);
			expect(committed.dirty).toBe(false);
			expect(committed.digest).toBe(staged.digest);
		});
	});

	it("includes executable bits and symlink targets", () => {
		withRepository((directory) => {
			const initial = captureVerificationSource(directory);
			chmodSync(path.join(directory, "entry with spaces.ts"), 0o755);
			const executable = captureVerificationSource(directory);
			expect(executable.digest).not.toBe(initial.digest);
			symlinkSync("entry with spaces.ts", path.join(directory, "link.ts"));
			const linked = captureVerificationSource(directory);
			rmSync(path.join(directory, "link.ts"));
			symlinkSync("absent.ts", path.join(directory, "link.ts"));
			expect(captureVerificationSource(directory).digest).not.toBe(linked.digest);
		});
	});
});
