import fsDefault, {
	Stats,
	accessSync,
	appendFileSync,
	chmodSync,
	closeSync,
	copyFileSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFile,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import fsPromises, {
	appendFile,
	copyFile,
	lstat,
	mkdir,
	readFile as readFilePromise,
	readdir,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
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

let closeError: NodeJS.ErrnoException | undefined;
try {
	closeSync(0x7fffffff);
} catch (error) {
	closeError = error as NodeJS.ErrnoException;
}
check(
	"closeSync exposes descriptor errors without a fake path",
	closeError?.code === "EBADF" &&
		closeError.syscall === "close" &&
		!("path" in closeError),
);

const root = `/tmp/maligator-node-fs-${Date.now()}`;
const nested = `${root}/a/b`;
const textFile = `${nested}/utf8.txt`;
const byteFile = `${nested}/bytes.bin`;
const copiedFile = `${nested}/copied.txt`;
const renameSource = `${nested}/rename-source.txt`;
const renameDestination = `${nested}/rename-destination.txt`;
const openedFile = `${nested}/opened.txt`;
const persistedDatabase = `${nested}/persisted.sqlite`;

eq("missing does not exist", existsSync(textFile), false);
mkdirSync(nested, { recursive: true });
eq("recursive mkdir creates parents", existsSync(nested), true);
mkdirSync(nested, { recursive: true });
check("recursive mkdir accepts an existing directory", statSync(nested).isDirectory());
check("node:fs default shares constants", fsDefault.constants === constants);
eq("fs constants expose F_OK", constants.F_OK, 0);
eq("fs constants expose R_OK", constants.R_OK, 4);
check("fs constants expose native open flags", constants.O_CREAT > 0);
eq(
	"fs constants use null-prototype immutable entries",
	Object.getPrototypeOf(constants) === null &&
		Object.getOwnPropertyDescriptor(constants, "F_OK")?.writable,
	false,
);

const openedDescriptor = openSync(openedFile, "w", 0o640);
check("openSync returns a file descriptor", Number.isInteger(openedDescriptor));
closeSync(openedDescriptor);
eq(
	"openSync creates a file with the requested mode",
	statSync(openedFile).mode & 0o777,
	0o640,
);
writeFileSync(openedFile, "abcdef");
accessSync(openedFile);
accessSync(openedFile, constants.R_OK | constants.W_OK);
accessSync(openedFile, 0.9);
let accessCode = "";
let accessSyscall = "";
let accessPath = "";
try {
	accessSync(`${root}/access-missing`, constants.F_OK);
} catch (error) {
	const fsError = error as NodeJS.ErrnoException;
	accessCode = fsError.code ?? "";
	accessSyscall = fsError.syscall ?? "";
	accessPath = fsError.path ?? "";
}
eq("accessSync missing path code", accessCode, "ENOENT");
eq("accessSync missing path syscall", accessSyscall, "access");
eq("accessSync missing path", accessPath, `${root}/access-missing`);

const truncateDescriptor = openSync(openedFile, "r+");
ftruncateSync(truncateDescriptor, 3);
eq("ftruncateSync shrinks an open file", fstatSync(truncateDescriptor).size, 3);
ftruncateSync(truncateDescriptor, 8);
eq("ftruncateSync grows an open file", fstatSync(truncateDescriptor).size, 8);
fsyncSync(truncateDescriptor);
ftruncateSync(truncateDescriptor, -1);
eq(
	"ftruncateSync clamps negative lengths to zero",
	fstatSync(truncateDescriptor).size,
	0,
);
closeSync(truncateDescriptor);

let fsyncDescriptorCode = "";
let fsyncDescriptorPath = false;
try {
	fsyncSync(truncateDescriptor);
} catch (error) {
	const fsError = error as NodeJS.ErrnoException;
	fsyncDescriptorCode = fsError.code ?? "";
	fsyncDescriptorPath = "path" in fsError;
}
eq("fsyncSync exposes descriptor errno", fsyncDescriptorCode, "EBADF");
eq("fsyncSync descriptor errors omit path", fsyncDescriptorPath, false);

writeFileSync(openedFile, "abcdef");
const readDescriptor = openSync(openedFile, "r");
const positionedRead = Buffer.alloc(6);
eq(
	"readSync positional overload returns bytes read",
	readSync(readDescriptor, positionedRead, 1, 3, 1),
	3,
);
eq(
	"readSync positional overload writes at the byte offset",
	positionedRead.toString(),
	"\0bcd\0\0",
);
const sequentialRead = Buffer.alloc(4);
eq(
	"readSync options overload defaults to the descriptor position",
	readSync(readDescriptor, sequentialRead, { offset: 1, length: 2, position: null }),
	2,
);
eq(
	"positioned read leaves the descriptor offset unchanged",
	sequentialRead.toString(),
	"\0ab\0",
);
const dataViewBytes = new Uint8Array(4);
eq(
	"readSync accepts DataView destinations",
	readSync(readDescriptor, new DataView(dataViewBytes.buffer), 1, 2, null),
	2,
);
eq(
	"readSync advances sequential descriptor reads",
	dataViewBytes.join(","),
	"0,99,100,0",
);
const descriptorStat = fstatSync(readDescriptor);
check("fstatSync returns a Stats instance", descriptorStat instanceof Stats);
eq("fstatSync observes descriptor size", descriptorStat.size, 6);
closeSync(readDescriptor);

let readDescriptorCode = "";
let readDescriptorPath = false;
try {
	readSync(readDescriptor, Buffer.alloc(1), 0, 1, null);
} catch (error) {
	const fsError = error as NodeJS.ErrnoException;
	readDescriptorCode = fsError.code ?? "";
	readDescriptorPath = "path" in fsError;
}
eq("readSync exposes descriptor errno", readDescriptorCode, "EBADF");
eq("readSync descriptor errors omit path", readDescriptorPath, false);

let stringDescriptorRejected = false;
try {
	fstatSync(String(readDescriptor) as unknown as number);
} catch (error) {
	stringDescriptorRejected = error instanceof TypeError;
}
check("descriptor APIs reject numeric strings", stringDescriptorRejected);

writeFileSync(textFile, "héllo 😀");
chmodSync(textFile, 0o640);
eq("chmodSync updates mode bits", statSync(textFile).mode & 0o777, 0o640);
writeFileSync(persistedDatabase, "persisted credential");
writeFileSync(persistedDatabase, "", { flag: "a", mode: 0o600 });
eq(
	"writeFileSync append-create options preserve an existing database",
	readFileSync(persistedDatabase, "utf8"),
	"persisted credential",
);
const touchedAt = new Date(1_600_000_000_123);
utimesSync(textFile, touchedAt, touchedAt);
check(
	"utimesSync accepts Date timestamps",
	Math.abs(statSync(textFile).mtimeMs - touchedAt.getTime()) < 1,
);
const touchedSeconds = 1_600_000_000.25;
utimesSync(textFile, touchedSeconds, touchedSeconds);
check(
	"utimesSync accepts numeric seconds",
	Math.abs(statSync(textFile).mtimeMs - touchedSeconds * 1000) < 1,
);
appendFileSync(textFile, " + sync");
eq("appendFileSync appends text", readFileSync(textFile, "utf8"), "héllo 😀 + sync");
await appendFile(textFile, " + promise");
eq(
	"promise appendFile appends text",
	readFileSync(textFile, "utf8"),
	"héllo 😀 + sync + promise",
);
eq(
	"readFileSync decodes UTF-8",
	readFileSync(textFile, "utf8"),
	"héllo 😀 + sync + promise",
);
const textBuffer = readFileSync(textFile);
check("readFileSync returns Buffer without encoding", Buffer.isBuffer(textBuffer));
eq(
	"readFileSync Buffer decodes UTF-8 by default",
	textBuffer.toString(),
	"héllo 😀 + sync + promise",
);

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
eq("readFile decodes UTF-8", asyncText, "héllo 😀 + sync + promise");
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
eq(
	"Stats exposes Node numeric fields in property order",
	Object.keys(fileStat).join(","),
	"dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks,atimeMs,mtimeMs,ctimeMs,birthtimeMs",
);
check("stat file isFile", fileStat.isFile());
eq("stat file isDirectory", fileStat.isDirectory(), false);
eq("stat file isBlockDevice", fileStat.isBlockDevice(), false);
eq("stat file isCharacterDevice", fileStat.isCharacterDevice(), false);
eq("stat file isFIFO", fileStat.isFIFO(), false);
eq("stat file isSocket", fileStat.isSocket(), false);
eq("stat file isSymbolicLink", fileStat.isSymbolicLink(), false);
check("stat exposes finite mtimeMs", fileStat.mtimeMs > 0 && fileStat.mtimeMs < Infinity);
check(
	"stat exposes four finite millisecond timestamps",
	[fileStat.atimeMs, fileStat.mtimeMs, fileStat.ctimeMs, fileStat.birthtimeMs].every(
		(value) => Number.isFinite(value),
	),
);
eq("Stats dates are lazy", Object.hasOwn(fileStat, "mtime"), false);
const materializedMtime = fileStat.mtime;
check(
	"stat exposes lazy Date timestamps",
	fileStat.atime instanceof Date &&
		materializedMtime instanceof Date &&
		fileStat.ctime instanceof Date &&
		fileStat.birthtime instanceof Date,
);
check("Stats date getter caches identity", fileStat.mtime === materializedMtime);
check("Stats date getter materializes an own property", Object.hasOwn(fileStat, "mtime"));
eq(
	"stat mtime Date rounds sub-millisecond timestamps",
	fileStat.mtime.getTime(),
	Math.round(fileStat.mtimeMs),
);
check("stat exposes mode", fileStat.mode > 0);
check("stat exposes size", fileStat.size > 0);
check("stat exposes identity", fileStat.dev >= 0 && fileStat.ino > 0);
check(
	"stat exposes ownership and allocation metadata",
	[
		fileStat.nlink,
		fileStat.uid,
		fileStat.gid,
		fileStat.rdev,
		fileStat.blksize,
		fileStat.blocks,
	].every((value) => Number.isFinite(value) && value >= 0),
);
eq(
	"stat mode agrees with fs constants",
	fileStat.mode & constants.S_IFMT,
	constants.S_IFREG,
);
const dirStat = statSync(nested);
check("stat directory isDirectory", dirStat.isDirectory());
eq("stat directory isFile", dirStat.isFile(), false);
check("stat character device classification", statSync("/dev/null").isCharacterDevice());

const emptyStats = new Stats();
eq("Stats constructor leaves numeric metadata undefined", emptyStats.size, undefined);
check(
	"Stats constructor timestamps are invalid Dates",
	Number.isNaN(emptyStats.mtime.getTime()),
);

const entries = readdirSync(nested, { withFileTypes: true });
let sawText = false;
let sawBytes = false;
for (const entry of entries) {
	if (entry.name === "utf8.txt") {
		sawText =
			entry.isFile() &&
			!entry.isDirectory() &&
			!entry.isBlockDevice() &&
			!entry.isCharacterDevice() &&
			!entry.isFIFO() &&
			!entry.isSocket() &&
			!entry.isSymbolicLink();
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
eq(
	"promise readFile decodes UTF-8",
	await readFilePromise(textFile, "utf8"),
	"héllo 😀 + sync + promise",
);
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
const promiseDir = `${root}/promise-dir`;
const promiseSource = `${promiseDir}/source.txt`;
const promiseCopy = `${promiseDir}/copy.txt`;
const promiseRenamed = `${promiseDir}/renamed.txt`;
await mkdir(promiseDir, { recursive: true });
await writeFile(promiseSource, "promise data");
await copyFile(promiseSource, promiseCopy);
eq(
	"promise copyFile copies contents",
	await readFilePromise(promiseCopy, "utf8"),
	"promise data",
);
await rename(promiseCopy, promiseRenamed);
check("promise stat returns Stats", (await stat(promiseRenamed)).isFile());
await rm(promiseRenamed);
eq("promise rm removes files", existsSync(promiseRenamed), false);
let promisedMissingCode = "";
try {
	await readdir(`${root}/promise-missing`);
} catch (error) {
	promisedMissingCode = (error as NodeJS.ErrnoException).code ?? "";
}
eq("promise readdir rejects with errno", promisedMissingCode, "ENOENT");

copyFileSync(textFile, copiedFile);
eq(
	"copyFileSync copies contents",
	readFileSync(copiedFile, "utf8"),
	"héllo 😀 + sync + promise",
);
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
unlinkSync(copiedFile);
eq("unlinkSync removes a file", existsSync(copiedFile), false);
writeFileSync(copiedFile, "delete me");
await unlink(copiedFile);
eq("promise unlink removes a file", existsSync(copiedFile), false);

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

const typedArrayData = new Uint16Array([0x1234, 0xabcd]);
writeFileSync(`${root}/typed-array`, typedArrayData);
const typedArrayBytes = new Uint8Array(typedArrayData.buffer);
check(
	"writeFileSync accepts every TypedArray byte view",
	readFileSync(`${root}/typed-array`).every(
		(byte, index) => byte === typedArrayBytes[index],
	),
);
const dataViewSource = new Uint8Array([9, 8, 7, 6]);
writeFileSync(`${root}/data-view`, new DataView(dataViewSource.buffer, 1, 2));
eq(
	"writeFileSync honors DataView bounds",
	readFileSync(`${root}/data-view`).join(","),
	"8,7",
);

const bufferedTextPath = Buffer.from(textFile);
check(
	"filesystem PathLike accepts Uint8Array paths",
	statSync(bufferedTextPath).isFile(),
);
eq("existsSync accepts Uint8Array paths", existsSync(bufferedTextPath), true);
eq(
	"existsSync returns false for invalid types",
	existsSync(42 as unknown as string),
	false,
);
let numericPathRejected = false;
try {
	statSync(42 as unknown as string);
} catch (error) {
	numericPathRejected = error instanceof TypeError;
}
check("filesystem operations reject coerced numeric paths", numericPathRejected);

const nulPath = `${root}/nul-prefix\0suffix`;
eq("existsSync returns false for NUL paths", existsSync(nulPath), false);
rejectsNul("readFileSync rejects NUL in path", () => readFileSync(nulPath, "utf8"));
rejectsNul("writeFileSync rejects NUL in path", () => writeFileSync(nulPath, "bad"));
rejectsNul("chmodSync rejects NUL in path", () => chmodSync(nulPath, 0o600));
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
