import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type RunningServer = { url: string; close: () => Promise<void> };
type Handler = (request: Request) => Promise<Response>;

function toRequest(incoming: IncomingMessage, origin: string): Request {
  const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
  return new Request(origin + incoming.url, {
    method: incoming.method,
    headers: incoming.headers as Record<string, string>,
    body: hasBody ? (incoming as unknown as BodyInit) : undefined,
    duplex: 'half',
  } as RequestInit);
}

async function writeResponse(outgoing: ServerResponse, response: Response) {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  outgoing.writeHead(response.status, headers);
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

export async function serve(handler: Handler): Promise<RunningServer> {
  const server = http.createServer((incoming, outgoing) => {
    handler(toRequest(incoming, `http://${incoming.headers.host}`))
      .then(response => writeResponse(outgoing, response))
      .catch(() => { outgoing.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
