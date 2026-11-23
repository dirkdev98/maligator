const load = process.on("loader-probe", () => {})[process.argv[2]];
process.stdout.write(typeof load(process.argv[3]) + "\n");
