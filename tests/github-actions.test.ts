import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const githubRoot = path.resolve(import.meta.dirname, "../.github");

function yamlFiles(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return yamlFiles(file);
		return /\.ya?ml$/.test(entry.name) ? [file] : [];
	});
}

function usedActions(value: unknown): Array<string> {
	if (Array.isArray(value)) return value.flatMap(usedActions);
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) => [
		...(key === "uses" && typeof child === "string" ? [child] : []),
		...usedActions(child),
	]);
}

describe("GitHub Actions", () => {
	it("selects the pinned Rust toolchain and prepares cacheable Test262 inputs", () => {
		for (const platform of ["linux", "macos"]) {
			const action = readFileSync(
				path.join(githubRoot, "actions", `setup-${platform}`, "action.yml"),
				"utf8",
			);
			expect(action).toContain('echo "RUSTUP_TOOLCHAIN=$toolchain" >> "$GITHUB_ENV"');
			expect(action).toContain("run: npm run test262:prepare");
		}
	});

	it("isolates macOS from the hosted image's Rustup installation", () => {
		const action = readFileSync(
			path.join(githubRoot, "actions/setup-macos/action.yml"),
			"utf8",
		);
		expect(action).toContain('case "$(uname -m)" in');
		expect(action).toContain("rustup_target=aarch64-apple-darwin");
		expect(action).toContain("rustup_target=x86_64-apple-darwin");
		expect(action).toContain("rustup/archive/1.29.0/$rustup_target/rustup-init");
		expect(action).toContain(
			"aeb4105778ca1bd3c6b0e75768f581c656633cd51368fa61289b6a71696ac7e1",
		);
		expect(action).toContain(
			"33cf85df9142bc6d29cbc62fa5ca1d4c29622cddb55213a4c1a43c457fb9b2d7",
		);
		expect(action).toContain('echo "RUSTUP_HOME=$rustup_home" >> "$GITHUB_ENV"');
	});

	it("keeps every external action dependency immutable", () => {
		const violations: Array<string> = [];
		for (const file of yamlFiles(githubRoot)) {
			const document = parse(readFileSync(file, "utf8")) as unknown;
			for (const action of usedActions(document)) {
				if (!action.startsWith("./") && !/^[^@]+@[0-9a-f]{40}$/.test(action)) {
					violations.push(`${path.relative(githubRoot, file)}: ${action}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("does not execute pull request code in a privileged target workflow", () => {
		for (const file of yamlFiles(path.join(githubRoot, "workflows"))) {
			const workflow = parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			expect(workflow.on).not.toHaveProperty("pull_request_target");
		}
	});
});
