const http = require("node:http");

const port = Number(process.env.MAL_HTTP_REUSED_CLOSE_PORT);

http.get({ hostname: "127.0.0.1", port, path: "/first" }, (response) => {
	response.resume();
	// Node's agent pools the socket only after the 'end' listeners return.
	response.on("end", () => setImmediate(requestOnReusedSocket));
});

function requestOnReusedSocket() {
	const request = http.get({ hostname: "127.0.0.1", port, path: "/second" }, () => {
		throw new Error("reused socket response");
	});
	request.on("error", (error) => {
		const { message, code, syscall, errno } = error;
		console.log(JSON.stringify({ message, code, syscall, errno }));
	});
}
