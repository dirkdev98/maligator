const load = eval("require");
const id = process.argv[2];
try {
	load(id);
} catch (error) {
	console.log(String(error));
}
