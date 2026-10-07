import type { ApiVersion } from '@solventa/contracts';

const versionedPath = /^\/api\/(v[1-9][0-9]*)(\/.*)?$/;
// Colombia has no DST, so a business day starts at a fixed offset.
const startOfDay = (day: string) => Date.parse(`${day}T00:00:00-05:00`);

export type VersionGate = { response?: Response; headers: Record<string, string> };

export function gateApiVersion(pathname: string, now: Date, versions: readonly ApiVersion[]): VersionGate {
  const match = versionedPath.exec(pathname);
  const version = match && versions.find(v => v.id === match[1]);
  if (!match || !version?.sunset) return { headers: {} };
  const successor = versions.find(v => Number(v.id.slice(1)) > Number(version.id.slice(1)));
  const link: Record<string, string> = successor ? { Link: `<${pathname.replace(`/api/${version.id}`, `/api/${successor.id}`)}>; rel="successor-version"` } : {};
  if (now.getTime() >= startOfDay(version.sunset)) {
    return { headers: link, response: Response.json({ error: 'version_retired' }, { status: 410, headers: { 'cache-control': 'no-store', ...link } }) };
  }
  const deprecation: Record<string, string> = version.deprecatedAt ? { Deprecation: `@${Math.floor(startOfDay(version.deprecatedAt) / 1000)}` } : {};
  return { headers: { ...deprecation, Sunset: new Date(startOfDay(version.sunset)).toUTCString(), ...link } };
}

// Service Binding responses are immutable, so headers are added on a copy.
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}
