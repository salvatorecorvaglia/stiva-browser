// Test-only S3 fault/latency gate, isolated from the application image.
import http from "node:http";

const state = { hold: false, failComplete: false, failAbort: false, connections: 0, requests: 0 };
const waiting = new Set();
const agent = new http.Agent({ keepAlive: true });
const xmlError = (res) => {
  res.writeHead(503, { "Content-Type": "application/xml" });
  res.end(
    "<Error><Code>ServiceUnavailable</Code><Message>Injected fixture failure</Message></Error>",
  );
};
const server = http.createServer((req, res) => {
  state.requests++;
  const query = new URL(req.url, "http://fixture").searchParams;
  if (
    (state.failComplete && req.method === "POST" && query.has("uploadId")) ||
    (state.failAbort && req.method === "DELETE" && query.has("uploadId"))
  ) {
    req.resume();
    xmlError(res);
    return;
  }
  const upstream = http.request(
    { host: "storage", port: 9000, path: req.url, method: req.method, headers: req.headers, agent },
    (response) => {
      const deliver = () => {
        waiting.delete(deliver);
        if (res.destroyed) {
          response.destroy();
          return;
        }
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      };
      if (state.hold && req.method === "PUT" && query.has("partNumber")) {
        waiting.add(deliver);
        res.once("close", () => {
          waiting.delete(deliver);
          if (!res.writableFinished) response.destroy();
        });
      } else deliver();
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});
server.on("connection", () => state.connections++);
server.on("error", (error) => {
  console.error(`storage gate failed to serve 9000: ${error.code ?? error.message}`);
  process.exit(1);
});
server.listen(9000, "0.0.0.0", () => console.log("storage gate listening on 9000"));
const control = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CONTROL_TOKEN}`) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    for (const name of ["hold", "failComplete", "failAbort"])
      if (typeof input[name] === "boolean") state[name] = input[name];
    if (!state.hold) for (const release of [...waiting]) release();
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ...state, pendingParts: waiting.size }));
});
control.on("error", (error) => {
  console.error(`storage gate control failed to serve 9001: ${error.code ?? error.message}`);
  process.exit(1);
});
control.listen(9001, "0.0.0.0", () => console.log("storage gate control listening on 9001"));
