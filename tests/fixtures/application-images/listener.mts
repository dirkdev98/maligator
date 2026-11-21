import type { FixtureBridge } from "./types.ts";
const bridge = Reflect.get(globalThis, "mal") as FixtureBridge;
import { createServer } from "node:http";
import { serve } from "maligator:http";

const generation = "first";
const { ports } = bridge._applicationData() as { ports: [number, number] };
serve({ hostname: "127.0.0.1", port: ports[0], fetch: () => new Response(generation) });
function rebinds(): boolean {
	try {
		serve({ hostname: "127.0.0.1", port: ports[0], fetch: () => new Response("again") });
		return true;
	} catch {
		return false;
	}
}
if (rebinds()) throw new Error("a retained listener is claimed by one server at a time");
const server = createServer((_request, response) => {
	response.writeHead(200, { "content-length": String(generation.length) });
	response.end(generation);
});
await new Promise<void>((resolve) => {
	server.listen(ports[1], "127.0.0.1", resolve);
});
