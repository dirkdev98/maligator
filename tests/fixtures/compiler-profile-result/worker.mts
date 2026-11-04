import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishCompilerResult } from "../../../src/compiler-profile-result.ts";
import { profileCaptureIdentity } from "../../../src/profile-artifact.ts";
import type { PreparedProfile } from "../../../src/profile-artifact.ts";

function makeProfile(): PreparedProfile {
	const functions = Array.from({ length: 512 }, (_, index) => ({
		name: `operation${index}_${"x".repeat(256)}`,
		file: "fictional.mjs",
		identity: { status: "unknown", reason: "no-source-origin" } as const,
	}));
	const profile: PreparedProfile = {
		schema: 8,
		mode: "sampling",
		buildId: "b".repeat(64),
		entrypoint: "fictional.mjs",
		calls: [],
		functions,
		sites: [],
		remarks: [],
	};
	profile.captureIdentity = profileCaptureIdentity(profile);
	return profile;
}

export function raw(_context: unknown) {
	return makeProfile();
}

export function produce(_context: unknown, directory: string) {
	const profile = makeProfile();
	const binaryPath = join(directory, "application");
	writeFileSync(`${binaryPath}.profile.json`, JSON.stringify(profile));
	const value = publishCompilerResult(
		{ binaryPath, profile },
		join(directory, "handoff"),
	);
	writeFileSync(`${binaryPath}.profile.json`, "{}");
	return {
		value,
		count: profile.functions.length,
		lastName: profile.functions.at(-1)!.name,
	};
}
