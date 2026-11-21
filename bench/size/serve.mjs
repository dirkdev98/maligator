import { serve } from "maligator:http";

serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch() {
		return new Response("Hello, world!");
	},
});
