import { file, FileSystemError } from "maligator:fs";

try {
	await file("source.txt").moveTo("destination.txt");
} catch (error) {
	if (!(error instanceof FileSystemError)) throw error;
	console.log(error.code, error.syscall, error.path, error.destination);
}
