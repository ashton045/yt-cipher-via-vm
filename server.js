import http from 'node:http';
import {
  resolveUrl,
  decryptSignature,
  getSts,
  getActivePlayerUrl
} from "./player_vm.js";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {}
}

const port = process.env.PORT || 8001;
const host = process.env.HOST || "0.0.0.0";

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    const body = req.method === "POST" ? await new Response(req).json().catch(() => ({})) : {};

    if (req.method === "POST" && url.pathname === "/resolve_url") {
      const result = await resolveUrl(body);
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/decrypt_signature") {
      const result = await decryptSignature(body);
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/get_sts") {
      const result = await getSts(body);
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: `Endpoint not found: ${req.method} ${url.pathname}` }));
  } catch (err) {
    res.writeHead(400).end(JSON.stringify({ error: err.message }));
  }
});

server.listen(port, host, async () => {
  console.log("server started");

  try {

    const activeUrl = await getActivePlayerUrl();
    console.log(`yt player script url: ${activeUrl}`);

  } catch (err) {
    console.error(err);
  }
});
