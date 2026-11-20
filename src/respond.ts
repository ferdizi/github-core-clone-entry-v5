// Small response helpers shared by every surface. Every reply is JSON (never
// HTML) and carries a non-empty X-GitHub-Request-Id, per the protocol checks.

export interface ForgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16)}`;
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): ForgeResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': nextRequestId(),
      ...extraHeaders,
    },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

export function jsonError(status: number, message: string): ForgeResponse {
  return jsonResponse(status, { message });
}

export function rawResponse(status: number, contentType: string, body: Buffer): ForgeResponse {
  return {
    status,
    headers: { 'content-type': contentType, 'x-github-request-id': nextRequestId() },
    body,
  };
}
