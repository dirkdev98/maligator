import {
	Stats,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFile,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import fsPromises, {
	lstat,
	readFile as readFilePromise,
	readdir,
} from "node:fs/promises";

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
const renameSource = `${nested}/rename-source.txt`;
const renameDestination = `${nested}/rename-destination.txt`;

eq("missing does not exist", existsSync(textFile), false);
mkdirSync(nested, { recursive: true });
eq("recursive mkdir creates parents", existsSync(nested), true);
mkdirSync(nested, { recursive: true });
check("recursive mkdir accepts an existing directory", statSync(nested).isDirectory());

writeFileSync(textFile, "héllo 😀");
eq("readFileSync decodes UTF-8", readFileSync(textFile, "utf8"), "héllo 😀");
const textBuffer = readFileSync(textFile);
check("readFileSync returns Buffer without encoding", Buffer.isBuffer(textBuffer));
eq("readFileSync Buffer decodes UTF-8 by default", textBuffer.toString(), "héllo 😀");

const framed = new Uint8Array([9, 65, 0, 66, 9]);
writeFileSync(byteFile, framed.subarray(1, 4));
eq("readFileSync preserves embedded NUL", readFileSync(byteFile, "utf8"), "A\0B");
const binary = new Uint8Array([0, 0xff, 0xc3, 0x28, 65]);
writeFileSync(byteFile, binary);
const binaryRead = readFileSync(byteFile);
check("readFileSync Buffer inherits from Uint8Array", binaryRead instanceof Uint8Array);
eq("readFileSync preserves binary length", binaryRead.length, binary.length);
check(
	"readFileSync preserves arbitrary bytes",
	binaryRead.every((byte, index) => byte === binary[index]),
);

const callbackOrder = ["before"];
const asyncText = await new Promise<string>((resolve, reject) => {
	readFile(textFile, "utf8", (error, value) => {
		callbackOrder.push("callback");
		if (error) reject(error);
		else resolve(value);
	});
	callbackOrder.push("after");
});
eq("readFile decodes UTF-8", asyncText, "héllo 😀");
eq("readFile callback is deferred", callbackOrder.join(","), "before,after,callback");
const asyncBuffer = await new Promise<Buffer>((resolve, reject) => {
	readFile(byteFile, (error, value) => {
		if (error) reject(error);
		else resolve(value);
	});
});
check("readFile returns Buffer without encoding", Buffer.isBuffer(asyncBuffer));
check(
	"readFile Buffer preserves arbitrary bytes",
	asyncBuffer.every((byte, index) => byte === binary[index]),
);
const asyncMissingCode = await new Promise<string>((resolve) => {
	readFile(`${root}/async-missing`, "utf8", (error) => {
		resolve((error as NodeJS.ErrnoException).code ?? "");
	});
});
eq("readFile reports asynchronous errno", asyncMissingCode, "ENOENT");

const fileStat = statSync(textFile);
check("lstatSync returns a Stats instance", lstatSync(textFile) instanceof Stats);
check("stat returns a Stats instance", fileStat instanceof Stats);
check("stat file isFile", fileStat.isFile());
eq("stat file isDirectory", fileStat.isDirectory(), false);
check("stat exposes finite mtimeMs", fileStat.mtimeMs > 0 && fileStat.mtimeMs < Infinity);
check(
	"stat exposes Date timestamps",
	fileStat.ctime instanceof Date && fileStat.mtime instanceof Date,
);
eq(
	"stat mtime Date uses integral milliseconds",
	fileStat.mtime.getTime(),
	Math.trunc(fileStat.mtimeMs),
);
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

check(
	"node:fs/promises default exposes methods",
	fsPromises.lstat === lstat && fsPromises.readdir === readdir,
);
check("promise lstat returns Stats", (await lstat(textFile)).isFile());
eq("promise readFile decodes UTF-8", await readFilePromise(textFile, "utf8"), "héllo 😀");
const promiseOrder = ["before"];
const promisedEntries = readdir(nested, { withFileTypes: true }).then((value) => {
	promiseOrder.push("fulfilled");
	return value;
});
promiseOrder.push("after");
const promiseEntries = await promisedEntries;
eq(
	"promise readdir defers fulfillment",
	promiseOrder.join(","),
	"before,after,fulfilled",
);
check(
	"promise readdir preserves Dirent results",
	promiseEntries.some((entry) => entry.name === "utf8.txt" && entry.isFile()),
);
let promisedMissingCode = "";
try {
	await readdir(`${root}/promise-missing`);
} catch (error) {
	promisedMissingCode = (error as NodeJS.ErrnoException).code ?? "";
}
eq("promise readdir rejects with errno", promisedMissingCode, "ENOENT");

copyFileSync(textFile, copiedFile);
eq("copyFileSync copies contents", readFileSync(copiedFile, "utf8"), "héllo 😀");
check(
	"realpathSync resolves an existing path",
	realpathSync(copiedFile).endsWith("/a/b/copied.txt"),
);
const temporary = mkdtempSync(`${root}/temporary-`);
check("mkdtempSync creates a unique directory", statSync(temporary).isDirectory());

writeFileSync(renameSource, "replacement");
writeFileSync(renameDestination, "old");
renameSync(renameSource, renameDestination);
eq("renameSync removes source", existsSync(renameSource), false);
eq(
	"renameSync overwrites destination",
	readFileSync(renameDestination, "utf8"),
	"replacement",
);

let renameCode = "";
let renameSyscall = "";
let renamePath = "";
let renameDest = "";
let renameMessage = "";
try {
	renameSync(renameSource, renameDestination);
} catch (error) {
	const fsError = error as Error & {
		code?: string;
		syscall?: string;
		path?: string;
		dest?: string;
	};
	renameCode = fsError.code ?? "";
	renameSyscall = fsError.syscall ?? "";
	renamePath = fsError.path ?? "";
	renameDest = fsError.dest ?? "";
	renameMessage = fsError.message;
}
eq("renameSync missing source code", renameCode, "ENOENT");
eq("renameSync missing source syscall", renameSyscall, "rename");
eq("renameSync missing source path", renamePath, renameSource);
eq("renameSync missing source dest", renameDest, renameDestination);
check(
	"renameSync missing source message includes both paths",
	renameMessage.includes(renameSource) && renameMessage.includes(renameDestination),
);

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
