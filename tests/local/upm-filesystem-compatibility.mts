import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { chmod, glob, realpath, rm, rmdir, stat, utimes } from "node:fs/promises";
import { join, matchesGlob, relative } from "node:path";
import { pathToFileURL } from "node:url";

const results: Array<[string, boolean]> = [];
function check(name: string, condition: boolean): void {
	results.push([name, condition]);
}
function same(name: string, actual: string[], expected: string[]): void {
	check(name, actual.sort().join("|") === expected.sort().join("|"));
}

async function run(): Promise<void> {
	const root = mkdtempSync("/tmp/mal-upm-filesystem-");
	try {
		const file = join(root, "source");
		writeFileSync(file, "content");
		check(
			"missing stat returns undefined",
			statSync(join(root, "missing"), { throwIfNoEntry: false }) === undefined,
		);
		check(
			"missing lstat returns undefined",
			lstatSync(join(root, "missing"), { throwIfNoEntry: false }) === undefined,
		);
		check(
			"non-directory parent returns undefined",
			statSync(join(file, "child"), { throwIfNoEntry: false }) === undefined,
		);
		let missingCode = "";
		try {
			statSync(join(root, "missing"));
		} catch (error) {
			missingCode = (error as NodeJS.ErrnoException).code ?? "";
		}
		check("default missing stat still throws", missingCode === "ENOENT");
		check(
			"promise stat supports missing-entry suppression",
			(await stat(join(root, "missing"), { throwIfNoEntry: false } as never)) ===
				undefined,
		);
		await chmod(pathToFileURL(file), 0o640);
		check("promise chmod changes file mode", (statSync(file).mode & 0o777) === 0o640);
		await chmod(file, "600");
		check("promise chmod parses octal strings", (statSync(file).mode & 0o777) === 0o600);
		await utimes(file, "1000.25", new Date(2000500));
		check(
			"promise utimes accepts seconds strings and Date",
			Math.abs(statSync(file).mtimeMs - 2000500) < 1,
		);
		symlinkSync("source", join(root, "file-link"));
		check(
			"promise realpath resolves symlinks",
			(await realpath(join(root, "file-link"))) === realpathSync(file),
		);
		mkdirSync(join(root, "empty"));
		await rmdir(join(root, "empty"));
		check("promise rmdir removes empty directory", !existsSync(join(root, "empty")));
		let rmdirCode = "";
		try {
			await rmdir(file);
		} catch (error) {
			rmdirCode = (error as NodeJS.ErrnoException).code ?? "";
		}
		check(
			"rmdir rejects files without deleting them",
			rmdirCode === "ENOTDIR" && existsSync(file),
		);

		for (const folder of [
			"packages/1",
			"packages/2",
			"packages/3",
			"packages/skip",
			"apps/api",
			".hidden",
		]) {
			mkdirSync(join(root, folder), { recursive: true });
			writeFileSync(join(root, folder, "package.json"), "{}");
		}
		mkdirSync(join(root, "packages/1/nested"));
		writeFileSync(join(root, "packages/1/nested/data.txt"), "data");
		symlinkSync("1", join(root, "packages/alias"));
		const workspacePaths: string[] = [];
		let parentPathsValid = true;
		let symbolicLinkSeen = false;
		for await (const entry of glob("{packages,apps}/*", {
			cwd: root,
			exclude: ["packages/skip"],
			withFileTypes: true,
		})) {
			parentPathsValid &&=
				entry.parentPath === join(root, entry.name === "api" ? "apps" : "packages");
			if (entry.isDirectory() || entry.isSymbolicLink())
				workspacePaths.push(relative(root, join(entry.parentPath, entry.name)));
			if (entry.name === "alias") symbolicLinkSeen = entry.isSymbolicLink();
		}
		same("workspace glob returns directories and symlinks", workspacePaths, [
			"apps/api",
			"packages/1",
			"packages/2",
			"packages/3",
			"packages/alias",
		]);
		check("glob Dirent parentPath is absolute", parentPathsValid);
		check("glob preserves symbolic-link identity", symbolicLinkSeen);
		const descendants: string[] = [];
		for await (const entry of glob("**/package.json", {
			cwd: pathToFileURL(root),
			exclude: ["packages/skip", "apps/**"],
		}))
			descendants.push(entry);
		same("globstar handles root traversal and directory exclusion", descendants, [
			"packages/1/package.json",
			"packages/2/package.json",
			"packages/3/package.json",
		]);
		const throughLink: string[] = [];
		for await (const entry of glob("packages/alias/nested/*", { cwd: root }))
			throughLink.push(entry);
		same("literal symlink prefixes are followed", throughLink, [
			"packages/alias/nested/data.txt",
		]);
		const linkChildren: string[] = [];
		for await (const entry of glob("packages/alias/*", { cwd: root }))
			linkChildren.push(entry);
		same("explicit symlink directories are traversed", linkChildren, [
			"packages/alias/package.json",
			"packages/alias/nested",
		]);
		const excludedParent: string[] = [];
		for await (const entry of glob("packages/1/nested/*", {
			cwd: root,
			exclude: ["packages/1"],
		}))
			excludedParent.push(entry);
		same("excluded ancestors prune literal prefixes", excludedParent, []);
		const ranged: string[] = [];
		for await (const entry of glob(["packages/{1..3}", "packages/2"], { cwd: root }))
			ranged.push(entry);
		same("glob brace ranges deduplicate overlapping patterns", ranged, [
			"packages/1",
			"packages/2",
			"packages/3",
		]);
		const absolute: string[] = [];
		for await (const entry of glob(join(root, "apps/*"))) absolute.push(entry);
		same("glob accepts absolute patterns", absolute, [join(root, "apps/api")]);
		const iterator = glob("**/*", { cwd: root });
		check("glob is an async iterator", iterator[Symbol.asyncIterator]() === iterator);
		await iterator.next();
		await iterator.return(undefined);
		check("early return closes glob traversal", (await iterator.next()).done === true);
		const entries = readdirSync(join(root, "apps"), { withFileTypes: true });
		check(
			"readdir Dirent exposes parentPath",
			entries[0]?.parentPath === join(root, "apps"),
		);

		const matches: Array<[string, string, boolean]> = [
			["packages/1", "packages/*", true],
			["packages/1/nested", "packages/*", false],
			["packages/1/nested", "packages/**", true],
			["packages", "packages/**", false],
			["packages/", "packages/**", true],
			[".hidden", "*", false],
			[".hidden", "[!a]*", false],
			[".hidden", "[.]hidden", true],
			[".hidden", "[.a]*", false],
			[".hidden", "@(.hidden|visible)", true],
			["packages/2", "packages/{1..3}", true],
			["packages/02", "packages/{01..03}", true],
			["apps/b", "apps/{c..a}", true],
			["apps/c", "apps/{a..e..2}", true],
			["apps/api", "{apps,packages}/*", true],
			["file.js", "*.@(js|ts)", true],
			["file.md", "*.!(js|ts)", true],
			["ababc", "+(ab)c", true],
			["é", "?", true],
			["😀", "?", false],
			["a//b/", "a/b", true],
			["", "*", false],
			["foo", "!foo", false],
		];
		for (const [path, pattern, expected] of matches)
			check(`matchesGlob ${path} ${pattern}`, matchesGlob(path, pattern) === expected);
		for (const [subject, pattern] of [
			["a".repeat(100000), "+(a)"],
			[".a", "@(".repeat(1000) + ".a" + ")".repeat(1000)],
		]) {
			let safe = false;
			try {
				safe = matchesGlob(subject, pattern);
			} catch (error) {
				safe = error instanceof RangeError;
			}
			check("large glob subjects and nested patterns are bounded", safe);
		}
		let invalidPattern = false;
		try {
			matchesGlob("x", 1 as unknown as string);
		} catch (error) {
			invalidPattern = error instanceof TypeError;
		}
		check("matchesGlob validates string arguments", invalidPattern);
		let invalidRetry = false;
		try {
			await rm(join(root, "missing"), { recursive: true, maxRetries: -1 });
		} catch (error) {
			invalidRetry = error instanceof RangeError;
		}
		check("rm validates retry options", invalidRetry);
		await rm(join(root, "packages"), { recursive: true, maxRetries: 3, retryDelay: 0 });
		check(
			"promise rm accepts retry options and removes recursively",
			!existsSync(join(root, "packages")),
		);
		check(
			"force rm fulfills for missing paths",
			(await rm(join(root, "missing"), { force: true })) === undefined,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) passed++;
		else console.log(`FAIL: ${name}`);
	}
	console.log(`RESULT ${passed}/${results.length}`);
}

await run();
