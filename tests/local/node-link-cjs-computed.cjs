const id = JSON.parse('"node:os"');
try {
	require(id);
} catch (error) {
	console.log(String(error));
}
