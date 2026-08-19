import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { hostInstallerSymbol } from "../src/compiler/frontend/host-modules.ts";
import { cEscapeString } from "../src/compiler/target/emit-vm.ts";
import { resolvePathExecutable } from "../src/rust-build.ts";

const roots: Array<string> = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("self-host native prerequisites", () => {
	test("emits the exact UTF-8 octal C escaping without Buffer", () => {
		expect(cEscapeString('ascii " \\ \n\t\0 é 😀 \ud800')).toBe(
			'ascii \\" \\\\ \\n\\t\\000 \\303\\251 \\360\\237\\230\\200 \\357\\277\\275',
		);
	});

	test("derives installer symbols without requiring RegExp behavior", () => {
		expect(hostInstallerSymbol("node:child_process")).toBe(
			"mal_host_install_node_child_process",
		);
		expect(hostInstallerSymbol("node::odd---name!")).toBe(
			"mal_host_install_node_odd_name_",
		);
		expect(hostInstallerSymbol(":node:path")).toBe("mal_host_install__node_path");
	});

	test("resolves tools only from the explicit PATH", () => {
		const root = mkdtempSync(path.join(tmpdir(), "maligator-path-"));
		roots.push(root);
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		mkdirSync(first);
		mkdirSync(second);
		const cargo = path.join(second, "cargo");
		writeFileSync(cargo, "placeholder", { mode: 0o755 });
		expect(resolvePathExecutable("cargo", `${first}${path.delimiter}${second}`)).toBe(
			cargo,
		);
		expect(() => resolvePathExecutable("node", first)).toThrow(/not found on PATH/);
	});

	test("rejects PATH entries that are not regular executable files", () => {
		const root = mkdtempSync(path.join(tmpdir(), "maligator-path-"));
		roots.push(root);
		const nonExecutable = path.join(root, "non-executable");
		writeFileSync(nonExecutable, "placeholder");
		chmodSync(nonExecutable, 0o644);
		mkdirSync(path.join(root, "directory"));

		expect(() => resolvePathExecutable("non-executable", root)).toThrow(
			/not found on PATH/,
		);
		expect(() => resolvePathExecutable("directory", root)).toThrow(/not found on PATH/);
	});

	test("treats an empty PATH component as the current directory", () => {
		const name = `.maligator-path-${process.pid}-${Date.now()}`;
		const executable = path.join(process.cwd(), name);
		writeFileSync(executable, "placeholder", { mode: 0o755 });
		try {
			expect(resolvePathExecutable(name, path.delimiter)).toBe(name);
		} finally {
			rmSync(executable);
		}
	});
});
