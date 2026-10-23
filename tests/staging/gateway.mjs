// Test-only HTTPS authentication proxy. No control endpoint and no outbound notifications.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const agent = new http.Agent({ keepAlive: true });
const expected = Buffer.from(`Bearer ${process.env.AUTH_TOKEN}`);
const server = https.createServer(
  { key: readFileSync("/harness/key.pem"), cert: readFileSync("/harness/cert.pem") },
  (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end('{"error":"authentication required"}');
      return;
    }
    const headers = {
      ...req.headers,
      "x-forwarded-for": req.socket.remoteAddress,
      "x-forwarded-proto": "https",
    };
    delete headers["x-forwarded-host"];
    delete headers.authorization;
    const upstream = http.request(
      { host: "app", port: 3000, path: req.url, method: req.method, headers, agent },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  },
);
server.listen(8443, "0.0.0.0");
