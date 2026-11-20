// Entry point: bind an ephemeral port, tell the trial env where it is, then
// wait until the env says the trial is over and exit 0.
//
// With MAKEFUN_ENV_URL set (a trial): POST {"port": N} to $MAKEFUN_ENV_URL/register
// (the first register wins; a 409 means another entry already registered and
// this process simply waits), then poll GET $MAKEFUN_ENV_URL/done until it
// answers {"done": true}. Never bind 8080: the env owns it.
// Without it (a local run): serve on the ephemeral port and keep running until
// stopped, printing the port so a local grader can dial it.

import { createApp } from './src/app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_START_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_START_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port to the env until it accepts (200) or reports a winner (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until the env answers {"done": true}. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  if (ENV_URL === '') {
    process.stdout.write('[entry] no MAKEFUN_ENV_URL: serving locally until stopped\n');
    return;
  }
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  if (ENV_URL !== '') process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
