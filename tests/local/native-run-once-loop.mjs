console.log("initialized");
while (Number(process.argv[2]) > 0) {
	const value = Number(process.argv[2]);
	process.argv[2] = String(value - 1);
	process.stdout.write(`${value}\n`);
}
