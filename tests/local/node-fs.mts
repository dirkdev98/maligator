import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";

const results: Array<[string, boolean]> = [];
function check(name: string, ok: boolean): void {
	results.push([name, !!ok]);
}
function eq(name: string, got: unknown, want: unknown): void {
	check(name, got === want);
}
function rejectsNul(name: string, operation: () => unknown): void {
	let rejected = false;
	try {
		operation();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(name, rejected);
}

const root = `/tmp/maligator-node-fs-${Date.now()}`;
const nested = `${root}/a/b`;
const textFile = `${nested}/utf8.txt`;
const byteFile = `${nested}/bytes.bin`;
const copiedFile = `${nested}/copied.txt`;

eq("missing does not exist", existsSync(textFile), false);
mkdirSync(nested, { recursive: true });
eq("recursive mkdir creates parents", existsSync(nested), true);
mkdirSync(nested, { recursive: true });
check("recursive mkdir accepts an existing directory", statSync(nested).isDirectory());

writeFileSync(textFile, "héllo 😀");
eq("readFileSync decodes UTF-8", readFileSync(textFile, "utf8"), "héllo 😀");

const framed = new Uint8Array([9, 65, 0, 66, 9]);
writeFileSync(byteFile, framed.subarray(1, 4));
eq("readFileSync preserves embedded NUL", readFileSync(byteFile, "utf8"), "A\0B");
const binary = new Uint8Array([0, 0xff, 0xc3, 0x28, 65]);
writeFileSync(byteFile, binary);
const binaryRead = readFileSync(byteFile);
check(
	"readFileSync returns Uint8Array without encoding",
	binaryRead instanceof Uint8Array,
);
eq("readFileSync preserves binary length", binaryRead.length, binary.length);
check(
	"readFileSync preserves arbitrary bytes",
	binaryRead.every((byte, index) => byte === binary[index]),
);

const fileStat = statSync(textFile);
check("stat file isFile", fileStat.isFile());
eq("stat file isDirectory", fileStat.isDirectory(), false);
check("stat exposes finite mtimeMs", fileStat.mtimeMs > 0 && fileStat.mtimeMs < Infinity);
check("stat exposes mode", fileStat.mode > 0);
check("stat exposes size", fileStat.size > 0);
check("stat exposes identity", fileStat.dev >= 0 && fileStat.ino > 0);
const dirStat = statSync(nested);
check("stat directory isDirectory", dirStat.isDirectory());
eq("stat directory isFile", dirStat.isFile(), false);

const entries = readdirSync(nested, { withFileTypes: true });
let sawText = false;
let sawBytes = false;
for (const entry of entries) {
	if (entry.name === "utf8.txt") {
		sawText = entry.isFile() && !entry.isDirectory();
	}
	if (entry.name === "bytes.bin") {
		sawBytes = entry.isFile() && !entry.isDirectory();
	}
}
check("readdirSync returns text-file Dirent", sawText);
check("readdirSync returns byte-file Dirent", sawBytes);

copyFileSync(textFile, copiedFile);
eq("copyFileSync copies contents", readFileSync(copiedFile, "utf8"), "héllo 😀");
check(
	"realpathSync resolves an existing path",
	realpathSync(copiedFile).endsWith("/a/b/copied.txt"),
);
const temporary = mkdtempSync(`${root}/temporary-`);
check("mkdtempSync creates a unique directory", statSync(temporary).isDirectory());
rmSync(temporary, { recursive: true, force: true });
eq("rmSync recursively removes a directory", existsSync(temporary), false);
rmSync(`${root}/already-missing`, { recursive: true, force: true });
rmSync(copiedFile);
eq("rmSync removes a file", existsSync(copiedFile), false);

let missingCode = "";
let missingSyscall = "";
let missingPath = "";
try {
	statSync(`${root}/missing`);
} catch (error) {
	const fsError = error as { code?: string; syscall?: string; path?: string };
	missingCode = fsError.code ?? "";
	missingSyscall = fsError.syscall ?? "";
	missingPath = fsError.path ?? "";
}
eq("errno error code", missingCode, "ENOENT");
eq("errno error syscall", missingSyscall, "stat");
eq("errno error path", missingPath, `${root}/missing`);

let rejectedData = false;
try {
	writeFileSync(`${root}/bad`, new Uint16Array([1]) as unknown as Uint8Array);
} catch (error) {
	rejectedData = error instanceof TypeError;
}
check("writeFileSync rejects non-Uint8 typed arrays", rejectedData);

const nulPath = `${root}/nul-prefix\0suffix`;
rejectsNul("existsSync rejects NUL in path", () => existsSync(nulPath));
rejectsNul("readFileSync rejects NUL in path", () => readFileSync(nulPath, "utf8"));
rejectsNul("writeFileSync rejects NUL in path", () => writeFileSync(nulPath, "bad"));
rejectsNul("statSync rejects NUL in path", () => statSync(nulPath));
rejectsNul("readdirSync rejects NUL in path", () => readdirSync(nulPath));
rejectsNul("mkdirSync rejects NUL in path", () => mkdirSync(nulPath));
eq(
	"NUL path did not truncate to a filesystem prefix",
	existsSync(`${root}/nul-prefix`),
	false,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) {
		passed++;
	} else {
		console.log(`FAIL: ${name}`);
	}
}
console.log(`RESULT ${passed}/${results.length}`);
