import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { searchStoredCatalog } from "../lib/catalog-snapshot.ts";

const projectRoot = new URL("../", import.meta.url);
const host = "127.0.0.1";
let baseUrl;
let server;
let dataApiStub;
let serverOutput = "";

test("searches the R2 compact catalog without a D1 satellite index", () => {
  const snapshot = {
    status: "live",
    source: "Test catalog via Cloudflare R2",
    fetchedAt: "2026-08-11T00:00:00.000Z",
    count: 2,
    items: [
      ["STARLINK-1", 10001, "2026-001A", "2026-08-11T00:00:00.000Z", 15, 0.001, 53, 1, 2, 3, 0, "U", 1, 1, 0.0001, 0, 0],
      ["ISS (ZARYA)", 25544, "1998-067A", "2026-08-11T00:00:00.000Z", 15.5, 0.0004, 51.6, 120, 30, 45, 0, "U", 999, 12345, 0.0001, 0, 0],
    ],
  };
  const result = searchStoredCatalog(snapshot, "iss", 25);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].noradId, 25544);
  assert.equal(result.items[0].objectName, "ISS (ZARYA)");
  assert.equal(result.items[0].orbitalElements.inclination, 51.6);
  assert.equal(searchStoredCatalog(snapshot, null, 0).count, 1);
});

async function availablePort() {
  const probe = createTcpServer();
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
  const dataApiPort = await availablePort();
  const dataApiUrl = `http://${host}:${dataApiPort}`;
  const compactItem = ["ISS (ZARYA)", 25544, "1998-067A", "2026-08-10T12:00:00.000Z", 15.5, 0.0004, 51.6, 120, 30, 45, 0, "U", 999, 12345, 0.0001, 0, 0];
  dataApiStub = createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? "/", dataApiUrl).pathname;
    const fetchedAt = new Date().toISOString();
    let payload;
    if (pathname === "/api/catalog/snapshot") {
      payload = { status: "live", source: "Test catalog via Cloudflare R2", fetchedAt, count: 1, items: [compactItem] };
    } else if (pathname === "/api/signals") {
      payload = {
        status: "live",
        fetchedAt,
        conjunctions: [{ id1: 25544, name1: "ISS (ZARYA)", id2: 20580, name2: "HST", tca: fetchedAt, rangeKm: 1, relativeSpeed: 7.5, maxProbability: 0.01, dilutionKm: 0, history: { observations: 4, firstSeenAt: fetchedAt, lastSeenAt: fetchedAt, minRangeKm: 0.8, peakProbability: 0.02 } }],
        decays: [{ id: 12345, name: "TEST OBJECT", epoch: fetchedAt, meanMotion: 16, bstar: 0.001, history: { observations: 3, firstSeenAt: fetchedAt, lastSeenAt: fetchedAt, meanMotionDelta: 0.02, bstarDelta: 0.0001 } }],
        spaceWeather: { time: fetchedAt, kp: 2, level: "quiet" },
        sources: { conjunctions: "Test D1", decays: "Test D1", spaceWeather: "Test D1" },
      };
    } else if (pathname === "/api/intelligence") {
      const requestedIds = (new URL(request.url ?? "/", dataApiUrl).searchParams.get("norad") ?? "")
        .split(",")
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, 24);
      payload = {
        status: "active",
        generatedAt: fetchedAt,
        history: {
          baselineStartedAt: "2026-08-08T00:00:00.000Z",
          sampleDays: 3,
          retentionDays: 365,
          orbitalObjects: 16323,
          matureObjects: 16000,
          conjunctionEvents: 24,
          persistentConjunctions: 8,
          decayEvents: 40,
          persistentDecayEvents: 12,
          weatherObservations: 4,
        },
        objects: requestedIds.map((noradId) => ({
          noradId,
          samples: 3,
          firstObservedAt: "2026-08-08T00:00:00.000Z",
          lastObservedAt: fetchedAt,
          lastEpoch: fetchedAt,
          meanMotion: 15.5,
          bstar: 0.0004,
          inclination: 51.6,
          meanMotionTrendPerDay: 0.00002,
          bstarTrendPerDay: 0.000001,
          inclinationTrendPerDay: 0.0001,
          stability: 0.94,
          mode: "history-calibrated",
        })),
      };
    } else {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.stringify(payload);
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  dataApiStub.listen(dataApiPort, host);
  await once(dataApiStub, "listening");

  const port = await availablePort();
  baseUrl = `http://${host}:${port}`;
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", host, "--port", String(port)],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        SATELLITE_DATA_API_URL: dataApiUrl,
        SATELLITE_UPSTREAM_PROXY_TOKEN: "runtime-test-proxy-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  await waitForServer(baseUrl);
});

test.after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (dataApiStub) {
    dataApiStub.close();
    await once(dataApiStub, "close");
  }
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
  assert.match(catalog.source, /Cloudflare R2/);
  assert.ok(bytes.byteLength < 4_500_000, `catalog payload was ${bytes.byteLength} bytes`);
});

test("serves signal, history-aware agent, intelligence, and binary orbit APIs", async () => {
  const [signalsResponse, agentResponse, intelligenceResponse, orbitResponse] = await Promise.all([
    fetch(`${baseUrl}/api/signals`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/api/agent?lat=37.5665&lon=126.978&norad=25544`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/api/intelligence?norad=25544`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/api/orbits`, { signal: AbortSignal.timeout(15_000) }),
  ]);

  assert.equal(signalsResponse.status, 200);
  const signals = await signalsResponse.json();
  assert.equal(signals.status, "live");
  assert.equal(signals.sources.conjunctions, "Test D1");
  assert.equal(signals.conjunctions[0].history.observations, 4);

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  assert.ok(["active", "degraded"].includes(agent.status));
  assert.ok(agent.monitoredObjects > 0);
  assert.equal(agent.agents.length, 3);
  assert.equal(agent.history.sampleDays, 3);
  assert.equal(agent.prediction.noradId, 25544);
  assert.equal(agent.prediction.mode, "history-calibrated");
  const historicalEvidence = agent.events
    .flatMap((event) => event.evidence)
    .find((item) => /ingestion cycle|Historical baseline/.test(item.en));
  assert.ok(historicalEvidence);
  assert.ok(historicalEvidence.ko.length > 0);
  assert.ok(historicalEvidence.ja.length > 0);
  assert.equal(typeof agent.agents[0].state.ko, "string");

  assert.equal(intelligenceResponse.status, 200);
  const intelligence = await intelligenceResponse.json();
  assert.equal(intelligence.status, "active");
  assert.equal(intelligence.history.sampleDays, 3);
  assert.equal(intelligence.objects[0].mode, "history-calibrated");

  assert.equal(orbitResponse.status, 200);
  assert.equal(orbitResponse.headers.get("content-type"), "application/vnd.agentbase.orbit-frame");
  const orbitCount = Number(orbitResponse.headers.get("x-orbit-count"));
  const orbitBytes = await orbitResponse.arrayBuffer();
  assert.ok(orbitCount > 0);
  assert.equal(orbitBytes.byteLength, 48 + orbitCount * 56);
});

test("rejects unauthorized access to the protected upstream relay", async () => {
  const response = await fetch(`${baseUrl}/api/signals?upstream=1`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});
