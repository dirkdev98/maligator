import { serve } from "maligator:http";

const server = serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() {
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([111, 107]));
					controller.close();
				},
			}),
		);
	},
});
try {
	const response = await fetch(server.url);
	console.log(`${response.status} ${await response.text()}`);
} finally {
	await server.close();
}
