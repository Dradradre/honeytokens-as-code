/** POST JSON to a webhook with a timeout. `fetchImpl` is injectable for tests. */
export async function postJson(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
}
