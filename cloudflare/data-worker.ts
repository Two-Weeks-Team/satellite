/// <reference types="@cloudflare/workers-types" />

import {
  isStoredCatalogSnapshot,
  searchStoredCatalog,
  type CompactOmm,
  type StoredCatalogSnapshot,
} from "../lib/catalog-snapshot";
import {
  historyTupleToInsight,
  isStoredHistorySummary,
  type StoredHistorySummary,
  type StoredHistoryTuple,
} from "../lib/history-intelligence";
import { readTextWithinLimit } from "../lib/read-response";

type WorkerSecrets = {
  INGESTION_TOKEN?: string;
  UPSTREAM_PROXY_TOKEN?: string;
};

type WorkerEnv = Env & WorkerSecrets;

type IngestionScope = "signals" | "catalog";

type Conjunction = {
  id1: number;
  name1: string;
  id2: number;
  name2: string;
  tca: string;
  rangeKm: number;
  relativeSpeed: number;
  maxProbability: number;
  dilutionKm: number;
};

type Decay = {
  id: number;
  name: string;
  epoch: string;
  meanMotion: number;
  bstar: number;
};

type SpaceWeather = {
  time: string;
  kp: number;
  level: "quiet" | "active" | "storm" | "severe";
};

type RawSignalSources = {
  conjunctions: string | null;
  decays: string | null;
  spaceWeather: string | null;
};

type CatalogObject = {
  noradId: number;
  objectName: string;
  objectId: string;
  epoch: number;
  orbitalElements: string;
};

// The product is named SOCRATES Plus, but CelesTrak serves it from the legacy /SOCRATES/ path.
const SOCRATES = "https://celestrak.org/SOCRATES/table-socrates.php?NAME=,&ORDER=MINRANGE&MAX=12";
const DECAYING = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=JSON";
const KP = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const CATALOG_SOURCES = [
  {
    url: "https://retlector.eu/csv/active",
    label: "CelesTrak GP via ReTLEctor cache",
  },
  {
    url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=CSV",
    label: "CelesTrak / USSF GP",
  },
] as const;
const SOURCE_TIMEOUT_MS = 20_000;
const HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_SIGNAL_SOURCE_BYTES = 2_000_000;
const MAX_CATALOG_SOURCE_BYTES = 10_000_000;
const MAX_RELAY_BYTES = 12_000_000;
const MAX_COMPACT_CATALOG_BYTES = 4_400_000;
const MAX_HISTORY_SUMMARY_BYTES = 4_400_000;
const CATALOG_FRESHNESS_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONJUNCTION_REVISION_WINDOW_MS = 30 * 60 * 1000;

function jsonResponse(request: Request, env: WorkerEnv, value: unknown, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": status >= 400 ? "no-store" : "public, max-age=30",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return Response.json(value, { status, headers });
}

function optionsResponse(request: Request, env: WorkerEnv) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

async function fetchText(url: string, accept: string, maxBytes = MAX_SIGNAL_SOURCE_BYTES) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept,
        "user-agent": "satellite.agentba.se/1.0 (+https://satellite.agentba.se)",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${new URL(url).hostname} responded ${response.status}`);
    return await readTextWithinLimit(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUpstreamProxy(env: WorkerEnv) {
  const url = env.UPSTREAM_PROXY_URL?.trim();
  const token = env.UPSTREAM_PROXY_TOKEN?.trim();
  if (!url || !token) throw new Error("Upstream proxy is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Upstream proxy responded ${response.status}`);
    const relayResponse = await readTextWithinLimit(response, MAX_RELAY_BYTES);
    const value = JSON.parse(relayResponse) as {
      conjunctions?: unknown[];
      decays?: unknown[];
      spaceWeather?: unknown;
      rawSources?: Partial<RawSignalSources>;
    };
    if (!Array.isArray(value.conjunctions) || !Array.isArray(value.decays)) {
      throw new Error("Upstream proxy returned an invalid payload");
    }
    const isConjunction = (item: unknown): item is Conjunction => {
      const candidate = item as Partial<Conjunction> | null;
      return !!candidate && typeof candidate === "object"
        && Number.isFinite(candidate.id1) && Number.isFinite(candidate.id2)
        && typeof candidate.name1 === "string" && typeof candidate.name2 === "string"
        && typeof candidate.tca === "string" && Number.isFinite(Date.parse(candidate.tca))
        && [candidate.rangeKm, candidate.relativeSpeed, candidate.maxProbability, candidate.dilutionKm]
          .every((number) => Number.isFinite(number));
    };
    const isDecay = (item: unknown): item is Decay => {
      const candidate = item as Partial<Decay> | null;
      return !!candidate && typeof candidate === "object"
        && Number.isFinite(candidate.id) && typeof candidate.name === "string"
        && typeof candidate.epoch === "string" && Number.isFinite(Date.parse(candidate.epoch))
        && Number.isFinite(candidate.meanMotion) && Number.isFinite(candidate.bstar);
    };
    const isSpaceWeather = (item: unknown): item is SpaceWeather => {
      const candidate = item as Partial<SpaceWeather> | null;
      return !!candidate && typeof candidate === "object"
        && typeof candidate.time === "string" && Number.isFinite(Date.parse(candidate.time))
        && Number.isFinite(candidate.kp)
        && ["quiet", "active", "storm", "severe"].includes(String(candidate.level));
    };
    const rawSource = (value: unknown) => typeof value === "string" && value.length <= 10_000_000 ? value : null;
    return {
      conjunctions: value.conjunctions.filter(isConjunction),
      decays: value.decays.filter(isDecay),
      spaceWeather: isSpaceWeather(value.spaceWeather) ? value.spaceWeather : null,
      rawSources: {
        conjunctions: rawSource(value.rawSources?.conjunctions),
        decays: rawSource(value.rawSources?.decays),
        spaceWeather: rawSource(value.rawSources?.spaceWeather),
      },
      relayResponse,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cellsFromRow(row: string) {
  return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cleanHtml(match[1]));
}

function parseConjunctions(html: string) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => cellsFromRow(match[1]));
  const conjunctions: Conjunction[] = [];

  for (let index = 0; index < rows.length - 1; index += 1) {
    const primary = rows[index];
    const dateIndex = primary.findIndex((cell) => /^\d{4}-\d{2}-\d{2}\s/.test(cell));
    const idIndex = primary.findIndex((cell) => /^\d{4,9}$/.test(cell));
    if (dateIndex < 0 || idIndex < 0) continue;
    const secondary = rows[index + 1];
    const secondIdIndex = secondary.findIndex((cell) => /^\d{4,9}$/.test(cell));
    if (secondIdIndex < 0) continue;

    const rangeKm = Number(primary[dateIndex + 1]);
    const relativeSpeed = Number(primary[dateIndex + 2]);
    const maxProbability = Number(secondary[secondIdIndex + 3]);
    const dilutionKm = Number(secondary[secondIdIndex + 4]);
    if (![rangeKm, relativeSpeed, maxProbability].every(Number.isFinite)) continue;

    conjunctions.push({
      id1: Number(primary[idIndex]),
      name1: primary[idIndex + 1] ?? "UNKNOWN",
      id2: Number(secondary[secondIdIndex]),
      name2: secondary[secondIdIndex + 1] ?? "UNKNOWN",
      tca: `${primary[dateIndex].replace(" ", "T")}Z`,
      rangeKm,
      relativeSpeed,
      maxProbability,
      dilutionKm: Number.isFinite(dilutionKm) ? dilutionKm : 0,
    });
    index += 1;
  }
  return conjunctions.slice(0, 12);
}

function currentKp(rows: unknown): SpaceWeather | null {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const record = Array.isArray(latest) && Array.isArray(rows[0])
    ? Object.fromEntries((rows[0] as string[]).map((key, index) => [key, latest[index]]))
    : latest as Record<string, unknown>;
  if (!record || typeof record !== "object") return null;
  const kp = Number(record.Kp ?? record.estimated_kp ?? record.kp_index);
  if (!Number.isFinite(kp)) return null;
  return {
    time: String(record.time_tag ?? new Date().toISOString()),
    kp,
    level: kp >= 7 ? "severe" : kp >= 5 ? "storm" : kp >= 4 ? "active" : "quiet",
  };
}

function parseDecays(raw: string) {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("Decay source returned an invalid payload");
  const decays: Decay[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const decay = {
      id: finiteNumber(record.NORAD_CAT_ID, -1),
      name: String(record.OBJECT_NAME ?? "").trim(),
      epoch: String(record.EPOCH ?? ""),
      meanMotion: finiteNumber(record.MEAN_MOTION, -1),
      bstar: finiteNumber(record.BSTAR),
    };
    if (decay.id < 0 || !decay.name || !Number.isFinite(Date.parse(decay.epoch)) || decay.meanMotion <= 0) continue;
    decays.push(decay);
  }
  return decays;
}

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseCatalog(csv: string) {
  const [header = [], ...rows] = parseCsv(csv);
  const objects: CatalogObject[] = [];
  for (const row of rows) {
    const record = Object.fromEntries(header.map((key, index) => [key.trim(), row[index] ?? ""]));
    const noradId = finiteNumber(record.NORAD_CAT_ID, -1);
    const objectName = String(record.OBJECT_NAME ?? "").trim();
    const epoch = Date.parse(String(record.EPOCH ?? ""));
    if (noradId < 0 || !objectName || !Number.isFinite(epoch)) continue;
    objects.push({
      noradId,
      objectName,
      objectId: String(record.OBJECT_ID ?? "").trim(),
      epoch,
      orbitalElements: JSON.stringify({
        meanMotion: finiteNumber(record.MEAN_MOTION),
        eccentricity: finiteNumber(record.ECCENTRICITY),
        inclination: finiteNumber(record.INCLINATION),
        raan: finiteNumber(record.RA_OF_ASC_NODE),
        argumentOfPericenter: finiteNumber(record.ARG_OF_PERICENTER),
        meanAnomaly: finiteNumber(record.MEAN_ANOMALY),
        classification: String(record.CLASSIFICATION_TYPE ?? "U"),
        elementSetNumber: finiteNumber(record.ELEMENT_SET_NO),
        revolutionAtEpoch: finiteNumber(record.REV_AT_EPOCH),
        bstar: finiteNumber(record.BSTAR),
        meanMotionDot: finiteNumber(record.MEAN_MOTION_DOT),
        meanMotionDdot: finiteNumber(record.MEAN_MOTION_DDOT),
      }),
    });
  }
  if (objects.length < 100) throw new Error("Active catalog was unexpectedly small");
  return objects;
}

function compactCatalogObject(item: CatalogObject): CompactOmm {
  const orbital = JSON.parse(item.orbitalElements) as Record<string, unknown>;
  return [
    item.objectName,
    item.noradId,
    item.objectId,
    new Date(item.epoch).toISOString(),
    finiteNumber(orbital.meanMotion),
    finiteNumber(orbital.eccentricity),
    finiteNumber(orbital.inclination),
    finiteNumber(orbital.raan),
    finiteNumber(orbital.argumentOfPericenter),
    finiteNumber(orbital.meanAnomaly),
    0,
    String(orbital.classification) === "C" ? "C" : "U",
    finiteNumber(orbital.elementSetNumber),
    finiteNumber(orbital.revolutionAtEpoch),
    finiteNumber(orbital.bstar),
    finiteNumber(orbital.meanMotionDot),
    finiteNumber(orbital.meanMotionDdot),
  ];
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundForStorage(value: number, decimalPlaces: number) {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function historyStability(
  samples: number,
  meanMotionTrend: number,
  bstarTrend: number,
  inclinationTrend: number,
  bstar: number,
) {
  if (samples < 2) return 0.35;
  const maturity = Math.min(1, (samples - 1) / 6);
  const meanMotionPenalty = Math.min(1, Math.abs(meanMotionTrend) / 0.02);
  const inclinationPenalty = Math.min(1, Math.abs(inclinationTrend) / 0.1);
  const normalizedBstarTrend = Math.abs(bstarTrend) / Math.max(Math.abs(bstar), 0.00001);
  const bstarPenalty = Math.min(1, normalizedBstarTrend / 2);
  return clamp(
    0.58 + maturity * 0.35
      - meanMotionPenalty * 0.22
      - inclinationPenalty * 0.12
      - bstarPenalty * 0.08,
    0.12,
    0.98,
  );
}

function buildHistorySummary(
  objects: CatalogObject[],
  previous: StoredHistorySummary | null,
  snapshotDate: string,
  generatedAtMs: number,
): StoredHistorySummary {
  const generatedAt = new Date(generatedAtMs).toISOString();
  const previousByNorad = new Map(previous?.items.map((item) => [item[0], item]) ?? []);
  const sameSnapshotDay = previous?.snapshotDate === snapshotDate;
  const items = objects.map((item): StoredHistoryTuple => {
    const orbital = JSON.parse(item.orbitalElements) as Record<string, unknown>;
    const meanMotion = roundForStorage(finiteNumber(orbital.meanMotion), 8);
    const bstar = roundForStorage(finiteNumber(orbital.bstar), 12);
    const inclination = roundForStorage(finiteNumber(orbital.inclination), 6);
    const prior = previousByNorad.get(item.noradId);
    if (!prior) {
      return [
        item.noradId,
        1,
        generatedAt,
        generatedAt,
        new Date(item.epoch).toISOString(),
        meanMotion,
        bstar,
        inclination,
        0,
        0,
        0,
        roundForStorage(historyStability(1, 0, 0, 0, bstar), 4),
      ];
    }

    const elapsedDays = Math.max(0.25, (generatedAtMs - Date.parse(prior[3])) / DAY_MS);
    const meanMotionDelta = (meanMotion - prior[5]) / elapsedDays;
    const bstarDelta = (bstar - prior[6]) / elapsedDays;
    const inclinationDelta = (inclination - prior[7]) / elapsedDays;
    const samples = sameSnapshotDay ? prior[1] : prior[1] + 1;
    const meanMotionTrend = roundForStorage(sameSnapshotDay ? prior[8] : prior[8] * 0.7 + meanMotionDelta * 0.3, 10);
    const bstarTrend = roundForStorage(sameSnapshotDay ? prior[9] : prior[9] * 0.7 + bstarDelta * 0.3, 12);
    const inclinationTrend = roundForStorage(sameSnapshotDay ? prior[10] : prior[10] * 0.7 + inclinationDelta * 0.3, 8);
    return [
      item.noradId,
      samples,
      prior[2],
      generatedAt,
      new Date(item.epoch).toISOString(),
      meanMotion,
      bstar,
      inclination,
      meanMotionTrend,
      bstarTrend,
      inclinationTrend,
      roundForStorage(historyStability(samples, meanMotionTrend, bstarTrend, inclinationTrend, bstar), 4),
    ];
  });
  return {
    status: "live",
    generatedAt,
    snapshotDate,
    baselineStartedAt: previous?.baselineStartedAt ?? generatedAt,
    sampleDays: previous ? sameSnapshotDay ? previous.sampleDays : previous.sampleDays + 1 : 1,
    objectCount: items.length,
    matureObjects: items.filter((item) => item[1] >= 2).length,
    items,
  };
}

function parsedHistorySummary(raw: string) {
  const parsed: unknown = JSON.parse(raw);
  return isStoredHistorySummary(parsed) ? parsed : null;
}

let inMemoryHistory: {
  archiveKey: string;
  generatedAt: number;
  summary: StoredHistorySummary;
} | null = null;

async function historySummaryFromArchive(env: WorkerEnv, archiveKey: string, generatedAt: number) {
  if (inMemoryHistory?.archiveKey === archiveKey && inMemoryHistory.generatedAt === generatedAt) {
    return inMemoryHistory.summary;
  }
  const cacheKey = new Request(
    `https://satellite-api.agentba.se/__history-cache/${env.ENVIRONMENT}/${encodeURIComponent(archiveKey)}?generatedAt=${generatedAt}`,
  );
  const historyCache = await caches.open(`satellite-history-${env.ENVIRONMENT}`);
  try {
    const cached = await historyCache.match(cacheKey);
    if (cached) {
      const raw = await readTextWithinLimit(cached, MAX_HISTORY_SUMMARY_BYTES);
      const summary = parsedHistorySummary(raw);
      if (summary) {
        inMemoryHistory = { archiveKey, generatedAt, summary };
        return summary;
      }
    }
  } catch (error) {
    console.warn(JSON.stringify({
      message: "history cache read failed",
      archiveKey,
      error: errorMessage(error),
    }));
  }

  const object = await env.ARCHIVE.get(archiveKey);
  if (!object) return null;
  if (object.size > MAX_HISTORY_SUMMARY_BYTES) {
    console.error(JSON.stringify({
      message: "history summary exceeds read limit",
      archiveKey,
      bytes: object.size,
      limit: MAX_HISTORY_SUMMARY_BYTES,
    }));
    return null;
  }
  const headers = new Headers({ "Content-Length": String(object.size) });
  const raw = await readTextWithinLimit(new Response(object.body, { headers }), MAX_HISTORY_SUMMARY_BYTES);
  const summary = parsedHistorySummary(raw);
  if (!summary) return null;
  inMemoryHistory = { archiveKey, generatedAt, summary };
  try {
    await historyCache.put(cacheKey, new Response(raw, {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(object.size),
        "Content-Type": "application/json; charset=utf-8",
      },
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      message: "history cache write failed",
      archiveKey,
      error: errorMessage(error),
    }));
  }
  return summary;
}

async function latestHistorySummary(env: WorkerEnv) {
  const row = await env.DB.prepare(`
    SELECT archive_key AS archiveKey, generated_at AS generatedAt
    FROM history_snapshots
    ORDER BY generated_at DESC
    LIMIT 1
  `).first<Record<string, unknown>>();
  if (!row?.archiveKey) return null;
  return historySummaryFromArchive(env, String(row.archiveKey), Number(row.generatedAt));
}

function utcParts(timestamp: number) {
  const iso = new Date(timestamp).toISOString();
  return {
    date: iso.slice(0, 10),
    path: `${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`,
    time: iso.slice(11, 19).replaceAll(":", ""),
  };
}

async function putArchive(bucket: R2Bucket, key: string, contents: string, contentType: string) {
  await bucket.put(key, contents, {
    httpMetadata: { contentType },
    customMetadata: { generatedBy: "satellite-data-api" },
  });
}

async function createRun(db: D1Database, scope: IngestionScope, startedAt: number) {
  const id = `${scope}-${startedAt}-${crypto.randomUUID()}`;
  await db.prepare(
    "INSERT INTO ingestion_runs (id, scope, status, started_at) VALUES (?, ?, 'running', ?)",
  ).bind(id, scope, startedAt).run();
  return id;
}

async function completeRun(
  db: D1Database,
  id: string,
  completedAt: number,
  itemCount: number,
  archiveKey: string,
  warning: string | null = null,
) {
  await db.prepare(
    "UPDATE ingestion_runs SET status = 'completed', completed_at = ?, item_count = ?, archive_key = ?, error_message = ? WHERE id = ?",
  ).bind(completedAt, itemCount, archiveKey, warning, id).run();
}

async function failRun(db: D1Database, id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    "UPDATE ingestion_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?",
  ).bind(Date.now(), message.slice(0, 1000), id).run();
}

async function pruneRuns(db: D1Database, now: number) {
  await db.prepare("DELETE FROM ingestion_runs WHERE started_at < ?")
    .bind(now - HISTORY_RETENTION_MS)
    .run();
}

async function conjunctionEventKeys(db: D1Database, items: Conjunction[]) {
  const candidates = items.map((item, index) => [
    index,
    Math.min(item.id1, item.id2),
    Math.max(item.id1, item.id2),
    Date.parse(item.tca),
  ]).filter((item) => Number.isFinite(item[3]));
  if (!candidates.length) return new Map<number, string>();
  const result = await db.prepare(`
    WITH candidates AS (
      SELECT
        CAST(json_extract(value, '$[0]') AS INTEGER) AS candidate_index,
        CAST(json_extract(value, '$[1]') AS INTEGER) AS lower_norad_id,
        CAST(json_extract(value, '$[2]') AS INTEGER) AS upper_norad_id,
        CAST(json_extract(value, '$[3]') AS INTEGER) AS candidate_tca
      FROM json_each(?)
    ), matches AS (
      SELECT
        candidates.candidate_index,
        existing.event_key,
        ROW_NUMBER() OVER (
          PARTITION BY candidates.candidate_index
          ORDER BY ABS(existing.tca - candidates.candidate_tca)
        ) AS match_rank
      FROM candidates
      LEFT JOIN conjunction_events AS existing
        ON MIN(existing.primary_norad_id, existing.secondary_norad_id) = candidates.lower_norad_id
        AND MAX(existing.primary_norad_id, existing.secondary_norad_id) = candidates.upper_norad_id
        AND ABS(existing.tca - candidates.candidate_tca) <= ?
    )
    SELECT
      candidate_index AS candidateIndex,
      event_key AS eventKey
    FROM matches
    WHERE match_rank = 1
  `).bind(JSON.stringify(candidates), CONJUNCTION_REVISION_WINDOW_MS).all<Record<string, unknown>>();
  return new Map(result.results.flatMap((row) => (
    typeof row.eventKey === "string" ? [[Number(row.candidateIndex), row.eventKey] as const] : []
  )));
}

async function ingestSignals(env: WorkerEnv) {
  const startedAt = Date.now();
  const parts = utcParts(startedAt);
  const archiveBase = `signals/${parts.path}/${parts.time}`;
  const runId = await createRun(env.DB, "signals", startedAt);
  try {
    const [conjunctionResult, decayResult, kpResult] = await Promise.allSettled([
      fetchText(SOCRATES, "text/html").then(async (raw) => {
        const archiveKey = `${archiveBase}/socrates.html`;
        await putArchive(env.ARCHIVE, archiveKey, raw, "text/html");
        return { archiveKey, value: parseConjunctions(raw) };
      }),
      fetchText(DECAYING, "application/json").then(async (raw) => {
        const archiveKey = `${archiveBase}/decays.json`;
        await putArchive(env.ARCHIVE, archiveKey, raw, "application/json");
        return { archiveKey, value: parseDecays(raw) };
      }),
      fetchText(KP, "application/json").then(async (raw) => {
        const archiveKey = `${archiveBase}/space-weather.json`;
        await putArchive(env.ARCHIVE, archiveKey, raw, "application/json");
        return { archiveKey, value: currentKp(JSON.parse(raw)) };
      }),
    ]);

    let conjunctions = conjunctionResult.status === "fulfilled" ? conjunctionResult.value.value : [];
    let decays = decayResult.status === "fulfilled" ? decayResult.value.value : [];
    let spaceWeather = kpResult.status === "fulfilled" ? kpResult.value.value : null;
    const rawArchiveKeys: Record<string, string> = {};
    if (conjunctionResult.status === "fulfilled") rawArchiveKeys.conjunctions = conjunctionResult.value.archiveKey;
    if (decayResult.status === "fulfilled") rawArchiveKeys.decays = decayResult.value.archiveKey;
    if (kpResult.status === "fulfilled") rawArchiveKeys.spaceWeather = kpResult.value.archiveKey;
    const reason = (result: PromiseSettledResult<unknown>, fallback: string) => result.status === "rejected"
      ? result.reason instanceof Error ? result.reason.message : String(result.reason)
      : fallback;
    const warnings: string[] = [];
    let conjunctionSource = "CelesTrak SOCRATES Plus";
    let decaySource = "CelesTrak Potential Decays";

    if (!conjunctions.length || !decays.length) {
      try {
        const proxy = await fetchUpstreamProxy(env);
        const relayArchiveKey = `${archiveBase}/relay-response.json`;
        await putArchive(env.ARCHIVE, relayArchiveKey, proxy.relayResponse, "application/json");
        rawArchiveKeys.relay = relayArchiveKey;
        const proxyRawArchives: Array<Promise<void>> = [];
        if (!rawArchiveKeys.conjunctions && proxy.rawSources.conjunctions) {
          const key = `${archiveBase}/socrates.html`;
          rawArchiveKeys.conjunctions = key;
          proxyRawArchives.push(putArchive(env.ARCHIVE, key, proxy.rawSources.conjunctions, "text/html"));
        }
        if (!rawArchiveKeys.decays && proxy.rawSources.decays) {
          const key = `${archiveBase}/decays.json`;
          rawArchiveKeys.decays = key;
          proxyRawArchives.push(putArchive(env.ARCHIVE, key, proxy.rawSources.decays, "application/json"));
        }
        if (!rawArchiveKeys.spaceWeather && proxy.rawSources.spaceWeather) {
          const key = `${archiveBase}/space-weather.json`;
          rawArchiveKeys.spaceWeather = key;
          proxyRawArchives.push(putArchive(env.ARCHIVE, key, proxy.rawSources.spaceWeather, "application/json"));
        }
        await Promise.all(proxyRawArchives);
        if (!conjunctions.length && proxy.conjunctions.length) {
          conjunctions = proxy.conjunctions.slice(0, 12);
          conjunctionSource = "CelesTrak SOCRATES Plus via protected Vercel relay";
          warnings.push(reason(conjunctionResult, "Direct conjunction source returned no records"));
        }
        if (!decays.length && proxy.decays.length) {
          decays = proxy.decays.slice(0, 20);
          decaySource = "CelesTrak Potential Decays via protected Vercel relay";
          warnings.push(reason(decayResult, "Direct decay source returned no records"));
        }
        if (!spaceWeather && proxy.spaceWeather) spaceWeather = proxy.spaceWeather;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    const failures: string[] = [];
    if (!conjunctions.length) failures.push(reason(conjunctionResult, "Conjunction source returned no records"));
    if (!decays.length) failures.push(reason(decayResult, "Decay source returned no records"));
    if (!spaceWeather) failures.push(reason(kpResult, "Space-weather source returned no records"));
    if (!conjunctions.length && !decays.length && !spaceWeather) {
      throw new Error(failures.join("; ") || "All signal sources returned empty responses");
    }

    const statements: D1PreparedStatement[] = [];
    const matchedConjunctionKeys = await conjunctionEventKeys(env.DB, conjunctions);
    for (const [index, item] of conjunctions.entries()) {
      const tca = Date.parse(item.tca);
      if (!Number.isFinite(tca)) continue;
      const lowerNoradId = Math.min(item.id1, item.id2);
      const upperNoradId = Math.max(item.id1, item.id2);
      const eventKey = matchedConjunctionKeys.get(index) ?? `conjunction:${lowerNoradId}:${upperNoradId}:${tca}`;
      statements.push(env.DB.prepare(`
        INSERT INTO conjunction_events (
          event_key, primary_norad_id, primary_name, secondary_norad_id, secondary_name,
          tca, range_km, relative_speed_km_s, max_probability, dilution_km, first_seen_at, last_seen_at,
          observation_count, min_range_km, peak_probability
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          primary_norad_id = excluded.primary_norad_id,
          primary_name = excluded.primary_name,
          secondary_norad_id = excluded.secondary_norad_id,
          secondary_name = excluded.secondary_name,
          tca = excluded.tca,
          range_km = excluded.range_km,
          relative_speed_km_s = excluded.relative_speed_km_s,
          max_probability = excluded.max_probability,
          dilution_km = excluded.dilution_km,
          last_seen_at = excluded.last_seen_at,
          observation_count = conjunction_events.observation_count + 1,
          min_range_km = MIN(conjunction_events.min_range_km, excluded.range_km),
          peak_probability = MAX(conjunction_events.peak_probability, excluded.max_probability)
      `).bind(
        eventKey, item.id1, item.name1, item.id2, item.name2, tca, item.rangeKm,
        item.relativeSpeed, item.maxProbability, item.dilutionKm, startedAt, startedAt,
        item.rangeKm, item.maxProbability,
      ));
    }
    for (const item of decays) {
      const epoch = Date.parse(item.epoch);
      if (!Number.isFinite(epoch)) continue;
      const eventKey = `decay:${item.id}`;
      statements.push(env.DB.prepare(`
        INSERT INTO decay_events (
          event_key, norad_id, object_name, epoch, mean_motion, bstar, first_seen_at, last_seen_at,
          observation_count, first_mean_motion, first_bstar
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          object_name = excluded.object_name,
          epoch = excluded.epoch,
          mean_motion = excluded.mean_motion,
          bstar = excluded.bstar,
          last_seen_at = excluded.last_seen_at,
          observation_count = decay_events.observation_count + 1
      `).bind(
        eventKey, item.id, item.name, epoch, item.meanMotion, item.bstar, startedAt, startedAt,
        item.meanMotion, item.bstar,
      ));
    }
    if (spaceWeather) {
      const observedAt = Date.parse(spaceWeather.time);
      if (Number.isFinite(observedAt)) {
        statements.push(env.DB.prepare(`
          INSERT INTO space_weather (observed_at, kp, level, ingested_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(observed_at) DO UPDATE SET
            kp = excluded.kp,
            level = excluded.level,
            ingested_at = excluded.ingested_at
        `).bind(observedAt, spaceWeather.kp, spaceWeather.level, startedAt));
      }
    }
    const cutoff = startedAt - HISTORY_RETENTION_MS;
    statements.push(env.DB.prepare("DELETE FROM conjunction_events WHERE last_seen_at < ?").bind(cutoff));
    statements.push(env.DB.prepare("DELETE FROM decay_events WHERE last_seen_at < ?").bind(cutoff));
    statements.push(env.DB.prepare("DELETE FROM space_weather WHERE observed_at < ?").bind(cutoff));
    await env.DB.batch(statements);

    const archiveKey = `${archiveBase}/snapshot.json`;
    const payload = {
      status: failures.length ? "partial" : "live",
      fetchedAt: new Date(startedAt).toISOString(),
      conjunctions,
      decays,
      spaceWeather,
      failures,
      warnings,
      rawArchiveKeys,
      sources: {
        conjunctions: conjunctionSource,
        decays: decaySource,
        spaceWeather: "NOAA SWPC",
      },
    };
    await putArchive(env.ARCHIVE, archiveKey, JSON.stringify(payload), "application/json");
    await completeRun(
      env.DB,
      runId,
      Date.now(),
      conjunctions.length + decays.length + (spaceWeather ? 1 : 0),
      archiveKey,
      failures.length ? failures.join("; ").slice(0, 1000) : null,
    );
    await pruneRuns(env.DB, startedAt);
    return { runId, archiveKey, ...payload };
  } catch (error) {
    await failRun(env.DB, runId, error);
    throw error;
  }
}

async function fetchCatalogCsv() {
  const failures: string[] = [];
  for (const source of CATALOG_SOURCES) {
    try {
      const csv = await fetchText(source.url, "text/csv", MAX_CATALOG_SOURCE_BYTES);
      const objects = parseCatalog(csv);
      return { csv, objects, source: source.label };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join("; "));
}

async function ingestCatalog(env: WorkerEnv, force = false) {
  const startedAt = Date.now();
  const parts = utcParts(startedAt);
  if (!force) {
    const existing = await env.DB.prepare(
      "SELECT snapshot_date AS snapshotDate, object_count AS objectCount, archive_key AS archiveKey FROM catalog_snapshots WHERE snapshot_date = ?",
    ).bind(parts.date).first();
    if (existing) return { skipped: true, reason: "Daily catalog snapshot already exists", snapshot: existing };
  }

  const runId = await createRun(env.DB, "catalog", startedAt);
  try {
    const [{ csv, objects, source }, previousHistory] = await Promise.all([
      fetchCatalogCsv(),
      latestHistorySummary(env).catch(() => null),
    ]);
    const archiveKey = `catalog/${parts.path}/active.csv`;
    const compactArchiveKey = `catalog/${parts.path}/active.compact.json`;
    const historyArchiveKey = `catalog/${parts.path}/history.summary.json`;
    const compactSnapshot: StoredCatalogSnapshot = {
      status: "live",
      source: `${source} via Cloudflare R2`,
      fetchedAt: new Date(startedAt).toISOString(),
      count: objects.length,
      items: objects.map(compactCatalogObject),
    };
    const historySummary = buildHistorySummary(objects, previousHistory, parts.date, startedAt);
    const historyPayload = JSON.stringify(historySummary);
    const historyBytes = new TextEncoder().encode(historyPayload).byteLength;
    if (historyBytes > MAX_HISTORY_SUMMARY_BYTES) {
      console.error(JSON.stringify({
        message: "history summary exceeds storage limit",
        bytes: historyBytes,
        limit: MAX_HISTORY_SUMMARY_BYTES,
        objects: historySummary.objectCount,
      }));
      throw new Error(`History summary is ${historyBytes} bytes; limit is ${MAX_HISTORY_SUMMARY_BYTES}`);
    }
    await Promise.all([
      putArchive(env.ARCHIVE, archiveKey, csv, "text/csv"),
      putArchive(env.ARCHIVE, compactArchiveKey, JSON.stringify(compactSnapshot), "application/json"),
      putArchive(env.ARCHIVE, historyArchiveKey, historyPayload, "application/json"),
    ]);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO catalog_snapshots (snapshot_date, fetched_at, object_count, archive_key, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_date) DO UPDATE SET
          fetched_at = excluded.fetched_at,
          object_count = excluded.object_count,
          archive_key = excluded.archive_key,
          source = excluded.source
      `).bind(parts.date, startedAt, objects.length, archiveKey, source),
      env.DB.prepare(`
        INSERT INTO history_snapshots (
          snapshot_date, generated_at, baseline_started_at, sample_days,
          object_count, mature_objects, archive_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_date) DO UPDATE SET
          generated_at = excluded.generated_at,
          baseline_started_at = excluded.baseline_started_at,
          sample_days = excluded.sample_days,
          object_count = excluded.object_count,
          mature_objects = excluded.mature_objects,
          archive_key = excluded.archive_key
      `).bind(
        parts.date,
        startedAt,
        Date.parse(historySummary.baselineStartedAt),
        historySummary.sampleDays,
        historySummary.objectCount,
        historySummary.matureObjects,
        historyArchiveKey,
      ),
      env.DB.prepare("DELETE FROM history_snapshots WHERE generated_at < ?")
        .bind(startedAt - HISTORY_RETENTION_MS),
    ]);
    await completeRun(env.DB, runId, Date.now(), objects.length, archiveKey);
    await pruneRuns(env.DB, startedAt);
    return {
      runId,
      archiveKey,
      compactArchiveKey,
      historyArchiveKey,
      historySampleDays: historySummary.sampleDays,
      historyMatureObjects: historySummary.matureObjects,
      count: objects.length,
      source,
      fetchedAt: new Date(startedAt).toISOString(),
    };
  } catch (error) {
    await failRun(env.DB, runId, error);
    throw error;
  }
}

async function latestSignals(db: D1Database) {
  const freshnessCutoff = Date.now() - 6 * 60 * 60 * 1000;
  const [conjunctionResult, decayResult, weatherResult, runResult] = await db.batch([
    db.prepare(`
      SELECT
        primary_norad_id AS id1, primary_name AS name1,
        secondary_norad_id AS id2, secondary_name AS name2,
        tca, range_km AS rangeKm, relative_speed_km_s AS relativeSpeed,
        max_probability AS maxProbability, dilution_km AS dilutionKm,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
        observation_count AS observationCount, min_range_km AS minRangeKm,
        peak_probability AS peakProbability
      FROM conjunction_events
      WHERE last_seen_at >= ?
      ORDER BY last_seen_at DESC, range_km ASC
      LIMIT 12
    `).bind(freshnessCutoff),
    db.prepare(`
      SELECT norad_id AS id, object_name AS name, epoch, mean_motion AS meanMotion, bstar,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
        observation_count AS observationCount, first_mean_motion AS firstMeanMotion,
        first_bstar AS firstBstar
      FROM decay_events
      WHERE last_seen_at >= ?
      ORDER BY last_seen_at DESC, epoch DESC
      LIMIT 20
    `).bind(freshnessCutoff),
    db.prepare(`
      SELECT observed_at AS time, kp, level, ingested_at AS ingestedAt
      FROM space_weather
      WHERE ingested_at >= ?
      ORDER BY observed_at DESC
      LIMIT 1
    `).bind(freshnessCutoff),
    db.prepare(`
      SELECT completed_at AS completedAt
      FROM ingestion_runs
      WHERE scope = 'signals' AND status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `),
  ]);
  const conjunctionRows = conjunctionResult.results as Array<Record<string, unknown>>;
  const decayRows = decayResult.results as Array<Record<string, unknown>>;
  const weatherRows = weatherResult.results as Array<Record<string, unknown>>;
  const runRows = runResult.results as Array<Record<string, unknown>>;
  const conjunctions = conjunctionRows.map((row) => ({
    id1: Number(row.id1),
    name1: String(row.name1),
    id2: Number(row.id2),
    name2: String(row.name2),
    tca: new Date(Number(row.tca)).toISOString(),
    rangeKm: Number(row.rangeKm),
    relativeSpeed: Number(row.relativeSpeed),
    maxProbability: Number(row.maxProbability),
    dilutionKm: Number(row.dilutionKm),
    history: {
      observations: Number(row.observationCount),
      firstSeenAt: new Date(Number(row.firstSeenAt)).toISOString(),
      lastSeenAt: new Date(Number(row.lastSeenAt)).toISOString(),
      minRangeKm: Number(row.minRangeKm),
      peakProbability: Number(row.peakProbability),
    },
  }));
  const decays = decayRows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    epoch: new Date(Number(row.epoch)).toISOString(),
    meanMotion: Number(row.meanMotion),
    bstar: Number(row.bstar),
    history: {
      observations: Number(row.observationCount),
      firstSeenAt: new Date(Number(row.firstSeenAt)).toISOString(),
      lastSeenAt: new Date(Number(row.lastSeenAt)).toISOString(),
      meanMotionDelta: Number(row.meanMotion) - Number(row.firstMeanMotion),
      bstarDelta: Number(row.bstar) - Number(row.firstBstar),
    },
  }));
  const weatherRow = weatherRows[0];
  const spaceWeather = weatherRow ? {
    time: new Date(Number(weatherRow.time)).toISOString(),
    kp: Number(weatherRow.kp),
    level: String(weatherRow.level),
  } : null;
  const completedAt = runRows[0]?.completedAt;
  const conjunctionSeenAt = Math.max(0, ...conjunctionRows.map((row) => Number(row.lastSeenAt) || 0));
  const decaySeenAt = Math.max(0, ...decayRows.map((row) => Number(row.lastSeenAt) || 0));
  const weatherSeenAt = Number(weatherRow?.ingestedAt) || 0;
  const freshness = {
    conjunctions: conjunctionSeenAt >= freshnessCutoff,
    decays: decaySeenAt >= freshnessCutoff,
    spaceWeather: weatherSeenAt >= freshnessCutoff,
  };
  const hasAnyData = conjunctions.length > 0 || decays.length > 0 || spaceWeather !== null;
  const allSourcesFresh = freshness.conjunctions && freshness.decays && freshness.spaceWeather;
  return {
    status: allSourcesFresh ? "live" : hasAnyData ? "partial" : "offline",
    fetchedAt: completedAt ? new Date(Number(completedAt)).toISOString() : new Date(0).toISOString(),
    conjunctions,
    decays,
    spaceWeather,
    freshness,
    sources: {
      conjunctions: "CelesTrak SOCRATES Plus via Cloudflare D1",
      decays: "CelesTrak Potential Decays via Cloudflare D1",
      spaceWeather: "NOAA SWPC via Cloudflare D1",
    },
  };
}

async function latestCatalogObject(env: WorkerEnv) {
  const snapshot = await env.DB.prepare(`
    SELECT fetched_at AS fetchedAt, object_count AS objectCount, archive_key AS archiveKey, source
    FROM catalog_snapshots
    ORDER BY fetched_at DESC
    LIMIT 1
  `).first<Record<string, unknown>>();
  if (!snapshot) return null;

  const archiveKey = String(snapshot.archiveKey);
  const compactArchiveKey = archiveKey.endsWith("/active.csv")
    ? archiveKey.replace(/\/active\.csv$/, "/active.compact.json")
    : `${archiveKey}.compact.json`;
  const object = await env.ARCHIVE.get(compactArchiveKey);
  if (!object) return null;
  return { snapshot, object };
}

async function catalogSnapshotResponse(request: Request, env: WorkerEnv) {
  const latest = await latestCatalogObject(env);
  if (!latest) return jsonResponse(request, env, { error: "Compact catalog snapshot unavailable" }, 404);
  const { snapshot, object } = latest;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Catalog-Fetched-At", new Date(Number(snapshot.fetchedAt)).toISOString());
  headers.set("X-Catalog-Object-Count", String(snapshot.objectCount));
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(object.body, { headers });
}

async function catalogLatestResponse(request: Request, env: WorkerEnv) {
  const latest = await latestCatalogObject(env);
  if (!latest) return jsonResponse(request, env, { error: "Compact catalog snapshot unavailable" }, 404);
  const { object } = latest;
  if (object.size > MAX_COMPACT_CATALOG_BYTES) {
    console.error(JSON.stringify({
      message: "compact catalog exceeds lookup read limit",
      bytes: object.size,
      limit: MAX_COMPACT_CATALOG_BYTES,
    }));
    return jsonResponse(request, env, { error: "Compact catalog snapshot exceeds lookup limit" }, 503);
  }
  const headers = new Headers({ "Content-Length": String(object.size) });
  const raw = await readTextWithinLimit(new Response(object.body, { headers }), MAX_COMPACT_CATALOG_BYTES);
  const parsed: unknown = JSON.parse(raw);
  if (!isStoredCatalogSnapshot(parsed)) {
    return jsonResponse(request, env, { error: "Compact catalog snapshot is invalid" }, 503);
  }
  const url = new URL(request.url);
  return jsonResponse(
    request,
    env,
    searchStoredCatalog(parsed, url.searchParams.get("q"), Number(url.searchParams.get("limit")) || 25),
  );
}

function requestedNoradIds(url: URL) {
  const ids: number[] = [];
  for (const value of url.searchParams.get("norad")?.split(",") ?? []) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    if (ids.length >= 24) break;
  }
  return ids;
}

async function historyIntelligence(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  const ids = requestedNoradIds(url);
  const [summary, counts] = await Promise.all([
    latestHistorySummary(env).catch(() => null),
    env.DB.batch([
      env.DB.prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN observation_count >= 2 THEN 1 ELSE 0 END), 0) AS persistent
        FROM conjunction_events
      `),
      env.DB.prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN observation_count >= 2 THEN 1 ELSE 0 END), 0) AS persistent
        FROM decay_events
      `),
      env.DB.prepare("SELECT COUNT(*) AS total FROM space_weather"),
    ]),
  ]);
  const countRow = (result: D1Result<unknown>) => (
    result.results[0] as Record<string, unknown> | undefined
  ) ?? {};
  const conjunctions = countRow(counts[0]);
  const decays = countRow(counts[1]);
  const weather = countRow(counts[2]);
  const requested = new Set(ids);
  const objects = summary
    ? summary.items.filter((item) => requested.has(item[0])).map(historyTupleToInsight)
    : [];
  return jsonResponse(request, env, {
    status: summary ? summary.sampleDays >= 2 ? "active" : "collecting" : "unavailable",
    generatedAt: summary?.generatedAt ?? new Date().toISOString(),
    history: {
      baselineStartedAt: summary?.baselineStartedAt ?? null,
      sampleDays: summary?.sampleDays ?? 0,
      retentionDays: Math.round(HISTORY_RETENTION_MS / DAY_MS),
      orbitalObjects: summary?.objectCount ?? 0,
      matureObjects: summary?.matureObjects ?? 0,
      conjunctionEvents: Number(conjunctions.total ?? 0),
      persistentConjunctions: Number(conjunctions.persistent ?? 0),
      decayEvents: Number(decays.total ?? 0),
      persistentDecayEvents: Number(decays.persistent ?? 0),
      weatherObservations: Number(weather.total ?? 0),
    },
    objects,
  });
}

async function health(db: D1Database) {
  const now = Date.now();
  const [conjunctions, decays, weather, failedRuns, partialRuns, latestSignalRun, latestCatalog, latestHistory] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM conjunction_events"),
    db.prepare("SELECT COUNT(*) AS count FROM decay_events"),
    db.prepare("SELECT COUNT(*) AS count FROM space_weather"),
    db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE status = 'failed' AND started_at > ?").bind(now - 24 * 60 * 60 * 1000),
    db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE status = 'completed' AND error_message IS NOT NULL AND started_at > ?").bind(now - 24 * 60 * 60 * 1000),
    db.prepare(`
      SELECT status, started_at AS startedAt, completed_at AS completedAt,
        item_count AS itemCount, error_message AS errorMessage
      FROM ingestion_runs
      WHERE scope = 'signals'
      ORDER BY started_at DESC
      LIMIT 1
    `),
    db.prepare(`
      SELECT snapshot_date AS snapshotDate, fetched_at AS fetchedAt,
        object_count AS objectCount, archive_key AS archiveKey, source
      FROM catalog_snapshots
      ORDER BY fetched_at DESC
      LIMIT 1
    `),
    db.prepare(`
      SELECT snapshot_date AS snapshotDate, generated_at AS generatedAt,
        baseline_started_at AS baselineStartedAt, sample_days AS sampleDays,
        object_count AS objectCount, mature_objects AS matureObjects, archive_key AS archiveKey
      FROM history_snapshots
      ORDER BY generated_at DESC
      LIMIT 1
    `),
  ]);
  const count = (result: D1Result<unknown>) => {
    const row = result.results[0] as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  };
  const first = (result: D1Result<unknown>) => result.results[0] as Record<string, unknown> | undefined;
  const signalRun = first(latestSignalRun) ?? null;
  const catalog = first(latestCatalog) ?? null;
  const history = first(latestHistory) ?? null;
  const catalogFetchedAt = Number(catalog?.fetchedAt) || 0;
  const historyGeneratedAt = Number(history?.generatedAt) || 0;
  return {
    database: {
      satellites: Number(catalog?.objectCount ?? 0),
      conjunctions: count(conjunctions),
      decays: count(decays),
      spaceWeather: count(weather),
    },
    incidents: {
      failedRunsLast24h: count(failedRuns),
      partialRunsLast24h: count(partialRuns),
    },
    latestSignalRun: signalRun,
    latestCatalog: catalog,
    latestHistory: history,
    catalogFresh: catalogFetchedAt > 0 && now - catalogFetchedAt <= CATALOG_FRESHNESS_MS,
    historyFresh: historyGeneratedAt > 0 && now - historyGeneratedAt <= CATALOG_FRESHNESS_MS,
  };
}

async function validManualRequest(request: Request, env: WorkerEnv) {
  if (!env.INGESTION_TOKEN) return false;
  const expected = env.INGESTION_TOKEN.trim();
  const encoder = new TextEncoder();
  const compare = async (provided: string | null, target: string) => {
    const [providedHash, targetHash] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(provided ?? "")),
      crypto.subtle.digest("SHA-256", encoder.encode(target)),
    ]);
    const subtle = crypto.subtle as SubtleCrypto & {
      timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
    };
    return subtle.timingSafeEqual(providedHash, targetHash);
  };
  const [directMatch, authorizationMatch] = await Promise.all([
    compare(request.headers.get("X-Ingestion-Token"), expected),
    compare(request.headers.get("Authorization"), `Bearer ${expected}`),
  ]);
  return directMatch || authorizationMatch;
}

async function handleFetch(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(request, env);

  if (request.method === "GET" && url.pathname === "/health") {
    const [state, signals] = await Promise.all([health(env.DB), latestSignals(env.DB)]);
    const latestRun = state.latestSignalRun;
    const latestSignalRunClean = latestRun?.status === "completed" && latestRun.errorMessage == null;
    return jsonResponse(request, env, {
      status: signals.status === "live" && state.catalogFresh && state.historyFresh && latestSignalRunClean ? "ok" : "degraded",
      environment: env.ENVIRONMENT,
      database: state.database,
      freshness: {
        signals: signals.freshness,
        catalog: state.catalogFresh,
        history: state.historyFresh,
      },
      latestRuns: {
        signals: state.latestSignalRun,
        catalog: state.latestCatalog,
        history: state.latestHistory,
      },
      storage: {
        catalog: "r2",
        operational: "d1",
      },
      incidents: state.incidents,
      checkedAt: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/signals") {
    return jsonResponse(request, env, await latestSignals(env.DB));
  }

  if (request.method === "GET" && url.pathname === "/api/catalog/snapshot") {
    return catalogSnapshotResponse(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/intelligence") {
    return historyIntelligence(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/catalog/latest") {
    return catalogLatestResponse(request, env);
  }

  if (request.method === "POST" && url.pathname === "/internal/ingest") {
    if (!await validManualRequest(request, env)) return jsonResponse(request, env, { error: "Unauthorized" }, 401);
    const scope = url.searchParams.get("scope") as IngestionScope | null;
    if (scope === "signals") return jsonResponse(request, env, await ingestSignals(env));
    if (scope === "catalog") return jsonResponse(request, env, await ingestCatalog(env, url.searchParams.get("force") === "true"));
    return jsonResponse(request, env, { error: "scope must be signals or catalog" }, 400);
  }

  return jsonResponse(request, env, { error: "Not found" }, 404);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ingestionLogFields(result: unknown) {
  if (!result || typeof result !== "object") return {};
  const value = result as Record<string, unknown>;
  return {
    runId: value.runId,
    archiveKey: value.archiveKey,
    status: value.status,
    itemCount: value.count ?? (
      (Array.isArray(value.conjunctions) ? value.conjunctions.length : 0)
      + (Array.isArray(value.decays) ? value.decays.length : 0)
      + (value.spaceWeather ? 1 : 0)
    ),
    warningCount: Array.isArray(value.warnings) ? value.warnings.length : 0,
    failureCount: Array.isArray(value.failures) ? value.failures.length : 0,
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      const url = new URL(request.url);
      console.error(JSON.stringify({
        message: "request failed",
        method: request.method,
        path: url.pathname,
        error: errorMessage(error),
      }));
      return jsonResponse(request, env, {
        error: "Internal server error",
        requestId: crypto.randomUUID(),
      }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    const scope = controller.cron === "0 18 * * *" ? "catalog" : "signals";
    const task = scope === "catalog" ? ingestCatalog(env) : ingestSignals(env);
    ctx.waitUntil(task.then(
      (result) => console.log(JSON.stringify({
        message: "scheduled ingestion completed",
        cron: controller.cron,
        scope,
        ...ingestionLogFields(result),
      })),
      (error) => console.error(JSON.stringify({
        message: "scheduled ingestion failed",
        cron: controller.cron,
        scope,
        error: errorMessage(error),
      })),
    ));
  },
} satisfies ExportedHandler<WorkerEnv>;
