import type { IncomingMessage, ServerResponse } from "node:http";

const maxRequestBytes = Math.floor(4.25 * 1024 * 1024);
const allowedMethods = new Set(["GET", "POST", "PATCH", "DELETE"]);

type AppsScriptResponse = {
  status: number;
  data: unknown;
};

function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(status === 204 ? undefined : JSON.stringify(data));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxRequestBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  if (length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "";
  if (!allowedMethods.has(method)) {
    response.setHeader("Allow", Array.from(allowedMethods).join(", "));
    sendJson(response, 405, { error: "지원하지 않는 요청 방식입니다." });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (!requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "요청한 주소를 찾을 수 없습니다." });
    return;
  }

  const webAppUrl = process.env.APPS_SCRIPT_WEB_APP_URL;
  const proxySecret = process.env.APPS_SCRIPT_PROXY_SECRET;
  if (!webAppUrl || !proxySecret) {
    sendJson(response, 503, { error: "Apps Script 연결 설정이 완료되지 않았습니다." });
    return;
  }

  let body: unknown = null;
  if (method !== "GET") {
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const status = message === "REQUEST_TOO_LARGE" ? 413 : 400;
      const errorText = status === 413
        ? "요청이 너무 큽니다. 사진은 한 번에 총 3MB 이하로 등록해 주세요."
        : "요청 본문이 올바른 JSON이 아닙니다.";
      sendJson(response, status, { error: errorText });
      return;
    }
  }

  const sessionHeader = request.headers["x-admin-session"];
  const sessionToken = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader ?? "";
  try {
    const upstream = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method,
        requestPath: requestUrl.pathname + requestUrl.search,
        body,
        sessionToken,
        proxySecret,
      }),
      redirect: "follow",
    });
    if (!upstream.ok) throw new Error(`Apps Script returned HTTP ${upstream.status}`);

    const result = await upstream.json() as AppsScriptResponse;
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
      throw new Error("Apps Script returned an invalid response.");
    }
    sendJson(response, result.status, result.data);
  } catch (error) {
    console.error("Apps Script API proxy failed.", error);
    sendJson(response, 502, { error: "Apps Script API에 연결하지 못했습니다. 배포 주소와 권한을 확인해 주세요." });
  }
}
