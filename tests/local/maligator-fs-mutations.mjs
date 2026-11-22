import {
	directory,
	file,
	FileSystemError,
	readlink,
	realpath,
	symlink,
	temporaryDirectory,
} from "maligator:fs";

async function failure(operation) {
	try {
		await operation;
		return "success";
	} catch (error) {
		if (!(error instanceof FileSystemError)) throw error;
		return error.code;
	}
}

async function exclusive(name, atomic) {
	const target = file(name);
	const options = { exclusive: true, atomic, mode: 0o600 };
	const writes = await Promise.allSettled([
		target.write("first", options),
		target.write("second", options),
	]);
	const outcomes = writes.map((write, index) =>
		write.status === "fulfilled" ? ["first", "second"][index] : write.reason.code,
	);
	return { outcomes, contents: await target.text() };
}

const direct = await exclusive("direct.txt", false);
const atomic = await exclusive("atomic.txt", true);
await symlink("absent.txt", "dangling.txt");
const dangling = [
	await failure(file("dangling.txt").write("data", { exclusive: true })),
	await failure(file("dangling.txt").write("data", { exclusive: true, atomic: true })),
];

const staging = directory("staging");
await staging.directory("nested").create({ recursive: true });
await staging.file("nested/report.txt").write("report");
const published = directory("published");
await published.create();
await published.file("previous.txt").write("previous version");
const collision = await failure(staging.moveTo(published));
const previous = await published.file("previous.txt").text();
await published.delete({ recursive: true });
await published.create();
await staging.moveTo(published, { overwrite: true });

await symlink("published/./nested/report.txt", "report-link");
const link = {
	target: await readlink("report-link"),
	resolved: await realpath("report-link"),
};
await file("report-link").chmod(0o640);
await published.chmod(0o750);

await directory("scratch-parent").create();
const scratch = await Promise.all([
	temporaryDirectory({ parent: "scratch-parent", prefix: "report-" }),
	temporaryDirectory({ parent: "scratch-parent", prefix: "report-" }),
	temporaryDirectory(),
]);

const cleanup = directory("cleanup");
await cleanup.create();
await cleanup.file("notes.txt").write("notes");
await cleanup.delete({ recursive: true, missingOk: true });
const deletion = {
	fileMissing: await failure(cleanup.file("notes.txt").delete({ missingOk: true })),
	directoryMissing: await failure(cleanup.delete({ recursive: true, missingOk: true })),
	strictFile: await failure(cleanup.file("notes.txt").delete()),
	strictDirectory: await failure(cleanup.delete()),
	wrongKind: await failure(file("published").delete({ missingOk: true })),
};

console.log(
	JSON.stringify({
		direct,
		atomic,
		dangling,
		collision,
		previous,
		link,
		scratch: scratch.map((entry) => entry.path),
		deletion,
	}),
);
