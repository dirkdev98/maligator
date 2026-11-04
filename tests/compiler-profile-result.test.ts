import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	publishCompilerResult,
	restoreCompilerResult,
} from "../src/compiler-profile-result.ts";
import { profileCaptureIdentity } from "../src/profile-artifact.ts";
import type { PreparedProfile } from "../src/profile-artifact.ts";

it.each(["truncated", "replaced", "different build", "different capture"] as const)(
	"rejects a %s profile snapshot",
	(change) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-profile-integrity-"));
		try {
			const handoff = join(directory, "handoff");
			mkdirSync(handoff);
			const profile: PreparedProfile = {
				schema: 8,
				mode: "sampling",
				buildId: "b".repeat(64),
				entrypoint: "fictional.mjs",
				calls: [],
				functions: [],
				sites: [],
				remarks: [],
			};
			profile.captureIdentity = profileCaptureIdentity(profile);
			const binaryPath = join(directory, "application");
			writeFileSync(`${binaryPath}.profile.json`, JSON.stringify(profile));
			const message = publishCompilerResult({ binaryPath, profile }, handoff);
			const file = join(handoff, "profile.json");
			if (change === "truncated") writeFileSync(file, "{}");
			else if (change === "replaced")
				writeFileSync(file, readFileSync(file, "utf8").replace("fictional", "different"));
			else if (change === "different build")
				message.profileArtifact!.buildId = "c".repeat(64);
			else message.profileArtifact!.captureIdentity = "c".repeat(64);
			expect(() => restoreCompilerResult(message, handoff)).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
