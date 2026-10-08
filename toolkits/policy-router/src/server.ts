import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const dotSegmentPattern = /\/(?:\.{1,2})(?:\/|$)/;

type PublicAsset = { file: string; contentType: string };

// Paths are intentionally enumerated: requests are never joined to the package root.
const publicAssets: Readonly<Record<string, PublicAsset>> = {
  "/": { file: resolve(packageRoot, "web/index.html"), contentType: "text/html; charset=utf-8" },
  "/app.js": { file: resolve(packageRoot, "web/app.js"), contentType: "text/javascript; charset=utf-8" },
  "/style.css": { file: resolve(packageRoot, "web/style.css"), contentType: "text/css; charset=utf-8" },
  "/dist/index.js": { file: resolve(packageRoot, "dist/index.js"), contentType: "text/javascript; charset=utf-8" },
  "/dist/validate.js": { file: resolve(packageRoot, "dist/validate.js"), contentType: "text/javascript; charset=utf-8" },
  "/dist/types.js": { file: resolve(packageRoot, "dist/types.js"), contentType: "text/javascript; charset=utf-8" },
  "/examples/baseline.json": { file: resolve(packageRoot, "examples/baseline.json"), contentType: "application/json; charset=utf-8" },
  "/examples/candidate.json": { file: resolve(packageRoot, "examples/candidate.json"), contentType: "application/json; charset=utf-8" },
  "/examples/request.json": { file: resolve(packageRoot, "examples/request.json"), contentType: "application/json; charset=utf-8" },
  "/examples/requests.jsonl": { file: resolve(packageRoot, "examples/requests.jsonl"), contentType: "application/x-ndjson; charset=utf-8" },
};

const commonHeaders: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": contentSecurityPolicy,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendText(request: IncomingMessage, response: ServerResponse, status: number, text: string, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(text, "utf8");
  response.writeHead(status, {
    ...commonHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.byteLength),
    ...extraHeaders,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function requestPath(requestTarget: string | undefined): string | null {
  if (requestTarget === undefined || !requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
    return null;
  }
  const queryAt = requestTarget.indexOf("?");
  const rawPath = queryAt < 0 ? requestTarget : requestTarget.slice(0, queryAt);
  if (rawPath.includes("%") || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.includes("#") || rawPath.includes("//")) {
    return null;
  }
  if (dotSegmentPattern.test(rawPath)) {
    return null;
  }
  return rawPath;
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(request, response, 405, "Method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const path = requestPath(request.url);
  const asset = path === null ? undefined : publicAssets[path];
  if (asset === undefined) {
    sendText(request, response, 404, "Not found\n");
    return;
  }

  try {
    const body = await readFile(asset.file);
    response.writeHead(200, {
      ...commonHeaders,
      "Content-Type": asset.contentType,
      "Content-Length": String(body.byteLength),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    // Missing optional build outputs are not exposed as filesystem errors.
    sendText(request, response, 404, "Not found\n");
  }
}

/** Start the local workbench on IPv4 loopback. Port 0 is supported for isolated callers/tests. */
export async function startDemoServer(port = 4317): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer from 0 to 65535");
  }
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (!response.headersSent) {
        sendText(request, response, 500, "Internal server error\n");
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return server;
}
