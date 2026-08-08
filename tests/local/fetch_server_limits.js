// Fixture for the Mal.serve transport-limit regressions
// (tests/native/fetch-hardening.test.ts). The option-validation results are served
// back so every assertion can live in the runner next to the wire-level ones.
function attempt(options) {
	options.port = 0;
	options.fetch = () => new Response("unused");
	try {
		Mal.serve(options);
		return "accepted";
	} catch (error) {
		return error instanceof TypeError ? "TypeError" : "other";
	}
}

const validation = [
	attempt({ headersTimeout: -1 }),
	attempt({ requestTimeout: 1.5 }),
	attempt({ keepAliveTimeout: "100" }),
	attempt({ maxConnections: Number.NaN }),
	attempt({ headersTimeout: 2147483648 }),
	attempt({ requestTimeout: Number.POSITIVE_INFINITY }),
].join(",");

const server = Mal.serve({
	port: 0,
	headersTimeout: 400,
	requestTimeout: 400,
	keepAliveTimeout: 400,
	maxConnections: 1,
	fetch: () => new Response(validation),
});
console.log("PORT " + server.port);
