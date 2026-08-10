import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);
const host = "127.0.0.1";
let baseUrl;
let server;
let serverOutput = "";

async function availablePort() {
  const probe = createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const address = probe.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready.\n${serverOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js did not become ready in time.\n${serverOutput}`);
}

test.before(async () => {
  const port = await availablePort();
  baseUrl = `http://${host}:${port}`;
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", host, "--port", String(port)],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForServer(baseUrl);
});

test.after(async () => {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
});

test("serves the production application", async () => {
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(html, /satellite\.agentba\.se/i);
  assert.doesNotMatch(html, /codex-preview/i);
});

test("serves live-or-fallback catalog data within Vercel's payload limit", async () => {
  const response = await fetch(`${baseUrl}/api/catalog`, { signal: AbortSignal.timeout(15_000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const catalog = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(response.status, 200);
  assert.ok(["live", "cached-sample"].includes(catalog.status));
  assert.equal(catalog.count, catalog.items.length);
  assert.ok(catalog.count > 0);
  assert.ok(bytes.byteLength < 4_500_000, `catalog payload was ${bytes.byteLength} bytes`);
});

test("serves signal, agent, and binary orbit APIs", async () => {
  const [signalsResponse, agentResponse, orbitResponse] = await Promise.all([
    fetch(`${baseUrl}/api/signals`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/api/agent?lat=37.5665&lon=126.978`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/api/orbits`, { signal: AbortSignal.timeout(15_000) }),
  ]);

  assert.equal(signalsResponse.status, 200);
  const signals = await signalsResponse.json();
  assert.ok(["live", "partial", "offline"].includes(signals.status));

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  assert.ok(["active", "degraded"].includes(agent.status));
  assert.ok(agent.monitoredObjects > 0);
  assert.equal(agent.agents.length, 3);

  assert.equal(orbitResponse.status, 200);
  assert.equal(orbitResponse.headers.get("content-type"), "application/vnd.agentbase.orbit-frame");
  const orbitCount = Number(orbitResponse.headers.get("x-orbit-count"));
  const orbitBytes = await orbitResponse.arrayBuffer();
  assert.ok(orbitCount > 0);
  assert.equal(orbitBytes.byteLength, 48 + orbitCount * 56);
});
