import { hash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	publishCompilerResult,
	restoreCompilerResult,
} from "../src/compiler-profile-result.ts";
import { PreparedProfile } from "../src/profile-artifact.ts";
import type { ProfileMetadata } from "../src/profile-artifact.ts";

it.each([
	"truncated",
	"replaced",
	"different build",
	"different capture",
	"invalid identity",
] as const)("rejects a %s profile snapshot", (change) => {
	const directory = mkdtempSync(join(tmpdir(), "mal-profile-integrity-"));
	try {
		const handoff = join(directory, "handoff");
		mkdirSync(handoff);
		const metadata: ProfileMetadata = {
			schema: 8,
			mode: "sampling",
			buildId: "b".repeat(64),
			entrypoint: "fictional.mjs",
			calls: [],
			functions: [],
			sites: [],
			remarks: [],
		};
		const profile = PreparedProfile.fromMetadata(metadata);
		const binaryPath = join(directory, "application");
		profile.writeMetadata(`${binaryPath}.profile.json`);
		const message = publishCompilerResult({ binaryPath, profile }, handoff);
		const file = join(handoff, "profile.json");
		if (change === "truncated") writeFileSync(file, "{}");
		else if (change === "replaced")
			writeFileSync(file, readFileSync(file, "utf8").replace("fictional", "different"));
		else if (change === "different build")
			message.profileArtifact!.buildId = "c".repeat(64);
		else if (change === "different capture")
			message.profileArtifact!.captureIdentity = "c".repeat(64);
		else {
			const changed = readFileSync(file, "utf8").replace("fictional", "different");
			writeFileSync(file, changed);
			message.profileArtifact!.bytes = Buffer.byteLength(changed);
			message.profileArtifact!.sha256 = hash("sha256", changed, "hex");
		}
		expect(() => restoreCompilerResult(message, handoff)).toThrow();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("retains the prepared snapshot across a binary rebuild and handoff removal", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-profile-handoff-"));
	try {
		const profile = PreparedProfile.fromMetadata({
			schema: 8,
			mode: "sampling",
			buildId: "a".repeat(64),
			entrypoint: "fictional.mjs",
			calls: [],
			functions: [],
			sites: [],
			remarks: [],
		});
		const binaryPath = join(directory, "application");
		writeFileSync(`${binaryPath}.profile.json`, "replaced by a later build");
		const handoff = join(directory, "handoff");
		mkdirSync(handoff);
		const restored = restoreCompilerResult(
			publishCompilerResult({ binaryPath, profile }, handoff),
			handoff,
		);
		rmSync(handoff, { recursive: true });
		const destination = join(directory, "capture-metadata.json");
		restored.profile!.writeMetadata(destination);
		expect(JSON.parse(readFileSync(destination, "utf8"))).toEqual(profile.readMetadata());
		expect(restored.profile!.captureIdentity).toBe(profile.captureIdentity);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
