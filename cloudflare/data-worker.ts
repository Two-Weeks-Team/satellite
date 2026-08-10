/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  ENVIRONMENT: "preview" | "production";
  ALLOWED_ORIGINS: string;
  INGESTION_TOKEN?: string;
}

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

type CatalogObject = {
  noradId: number;
  objectName: string;
  objectId: string;
  epoch: number;
  orbitalElements: string;
};

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

function jsonResponse(request: Request, env: Env, value: unknown, status = 200) {
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

function optionsResponse(request: Request, env: Env) {
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

async function fetchText(url: string, accept: string) {
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
    return await response.text();
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
) {
  await db.prepare(
    "UPDATE ingestion_runs SET status = 'completed', completed_at = ?, item_count = ?, archive_key = ? WHERE id = ?",
  ).bind(completedAt, itemCount, archiveKey, id).run();
}

async function failRun(db: D1Database, id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(
    "UPDATE ingestion_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?",
  ).bind(Date.now(), message.slice(0, 1000), id).run();
}

async function ingestSignals(env: Env) {
  const startedAt = Date.now();
  const runId = await createRun(env.DB, "signals", startedAt);
  try {
    const [conjunctionResult, decayResult, kpResult] = await Promise.allSettled([
      fetchText(SOCRATES, "text/html").then(parseConjunctions),
      fetchText(DECAYING, "application/json").then((text) => {
        const data = JSON.parse(text) as Array<Record<string, unknown>>;
        return data.slice(0, 20).map((item): Decay => ({
          id: finiteNumber(item.NORAD_CAT_ID),
          name: String(item.OBJECT_NAME ?? "UNKNOWN"),
          epoch: String(item.EPOCH ?? new Date(startedAt).toISOString()),
          meanMotion: finiteNumber(item.MEAN_MOTION),
          bstar: finiteNumber(item.BSTAR),
        }));
      }),
      fetchText(KP, "application/json").then((text) => currentKp(JSON.parse(text))),
    ]);

    const conjunctions = conjunctionResult.status === "fulfilled" ? conjunctionResult.value : [];
    const decays = decayResult.status === "fulfilled" ? decayResult.value : [];
    const spaceWeather = kpResult.status === "fulfilled" ? kpResult.value : null;
    const failures = [conjunctionResult, decayResult, kpResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (!conjunctions.length && !decays.length && !spaceWeather) {
      throw new Error(failures.join("; ") || "All signal sources returned empty responses");
    }

    const statements: D1PreparedStatement[] = [];
    for (const item of conjunctions) {
      const tca = Date.parse(item.tca);
      if (!Number.isFinite(tca)) continue;
      const eventKey = `${item.id1}:${item.id2}:${tca}`;
      statements.push(env.DB.prepare(`
        INSERT INTO conjunction_events (
          event_key, primary_norad_id, primary_name, secondary_norad_id, secondary_name,
          tca, range_km, relative_speed_km_s, max_probability, dilution_km, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          range_km = excluded.range_km,
          relative_speed_km_s = excluded.relative_speed_km_s,
          max_probability = excluded.max_probability,
          dilution_km = excluded.dilution_km,
          last_seen_at = excluded.last_seen_at
      `).bind(
        eventKey, item.id1, item.name1, item.id2, item.name2, tca, item.rangeKm,
        item.relativeSpeed, item.maxProbability, item.dilutionKm, startedAt, startedAt,
      ));
    }
    for (const item of decays) {
      const epoch = Date.parse(item.epoch);
      if (!Number.isFinite(epoch)) continue;
      const eventKey = `${item.id}:${epoch}`;
      statements.push(env.DB.prepare(`
        INSERT INTO decay_events (
          event_key, norad_id, object_name, epoch, mean_motion, bstar, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_key) DO UPDATE SET
          mean_motion = excluded.mean_motion,
          bstar = excluded.bstar,
          last_seen_at = excluded.last_seen_at
      `).bind(eventKey, item.id, item.name, epoch, item.meanMotion, item.bstar, startedAt, startedAt));
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

    const parts = utcParts(startedAt);
    const archiveKey = `signals/${parts.path}/${parts.time}.json`;
    const payload = {
      status: failures.length ? "partial" : "live",
      fetchedAt: new Date(startedAt).toISOString(),
      conjunctions,
      decays,
      spaceWeather,
      failures,
      sources: {
        conjunctions: "CelesTrak SOCRATES Plus",
        decays: "CelesTrak Potential Decays",
        spaceWeather: "NOAA SWPC",
      },
    };
    await putArchive(env.ARCHIVE, archiveKey, JSON.stringify(payload), "application/json");
    await completeRun(env.DB, runId, Date.now(), conjunctions.length + decays.length + (spaceWeather ? 1 : 0), archiveKey);
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
      const csv = await fetchText(source.url, "text/csv");
      const objects = parseCatalog(csv);
      return { csv, objects, source: source.label };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join("; "));
}

async function upsertCatalog(db: D1Database, objects: CatalogObject[], ingestedAt: number) {
  const statements: D1PreparedStatement[] = [];
  const flush = async () => {
    if (!statements.length) return;
    await db.batch(statements.splice(0));
  };

  for (let offset = 0; offset < objects.length; offset += 20) {
    const group = objects.slice(offset, offset + 20);
    const placeholders = group.map(() => `(?, ?, ?, ?, ?, ${ingestedAt})`).join(", ");
    const values = group.flatMap((item) => [
      item.noradId,
      item.objectName,
      item.objectId,
      item.epoch,
      item.orbitalElements,
    ]);
    statements.push(db.prepare(`
      INSERT INTO satellites (norad_id, object_name, object_id, epoch, orbital_elements, ingested_at)
      VALUES ${placeholders}
      ON CONFLICT(norad_id) DO UPDATE SET
        object_name = excluded.object_name,
        object_id = excluded.object_id,
        epoch = excluded.epoch,
        orbital_elements = excluded.orbital_elements,
        ingested_at = excluded.ingested_at
    `).bind(...values));
    if (statements.length >= 100) await flush();
  }
  await flush();
}

async function ingestCatalog(env: Env, force = false) {
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
    const { csv, objects, source } = await fetchCatalogCsv();
    const archiveKey = `catalog/${parts.path}/active.csv`;
    await putArchive(env.ARCHIVE, archiveKey, csv, "text/csv");
    await upsertCatalog(env.DB, objects, startedAt);
    await env.DB.prepare(`
      INSERT INTO catalog_snapshots (snapshot_date, fetched_at, object_count, archive_key, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_date) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        object_count = excluded.object_count,
        archive_key = excluded.archive_key,
        source = excluded.source
    `).bind(parts.date, startedAt, objects.length, archiveKey, source).run();
    await completeRun(env.DB, runId, Date.now(), objects.length, archiveKey);
    return { runId, archiveKey, count: objects.length, source, fetchedAt: new Date(startedAt).toISOString() };
  } catch (error) {
    await failRun(env.DB, runId, error);
    throw error;
  }
}

async function latestSignals(db: D1Database) {
  const [conjunctionResult, decayResult, weatherResult, runResult] = await db.batch([
    db.prepare(`
      SELECT
        primary_norad_id AS id1, primary_name AS name1,
        secondary_norad_id AS id2, secondary_name AS name2,
        tca, range_km AS rangeKm, relative_speed_km_s AS relativeSpeed,
        max_probability AS maxProbability, dilution_km AS dilutionKm,
        last_seen_at AS lastSeenAt
      FROM conjunction_events
      ORDER BY last_seen_at DESC, range_km ASC
      LIMIT 12
    `),
    db.prepare(`
      SELECT norad_id AS id, object_name AS name, epoch, mean_motion AS meanMotion, bstar,
        last_seen_at AS lastSeenAt
      FROM decay_events
      ORDER BY last_seen_at DESC, epoch DESC
      LIMIT 20
    `),
    db.prepare(`
      SELECT observed_at AS time, kp, level, ingested_at AS ingestedAt
      FROM space_weather
      ORDER BY observed_at DESC
      LIMIT 1
    `),
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
  }));
  const decays = decayRows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    epoch: new Date(Number(row.epoch)).toISOString(),
    meanMotion: Number(row.meanMotion),
    bstar: Number(row.bstar),
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
  const freshnessCutoff = Date.now() - 6 * 60 * 60 * 1000;
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

async function health(db: D1Database) {
  const [satellites, conjunctions, decays, weather, runs] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM satellites"),
    db.prepare("SELECT COUNT(*) AS count FROM conjunction_events"),
    db.prepare("SELECT COUNT(*) AS count FROM decay_events"),
    db.prepare("SELECT COUNT(*) AS count FROM space_weather"),
    db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE status = 'failed' AND started_at > ?").bind(Date.now() - 24 * 60 * 60 * 1000),
  ]);
  const count = (result: D1Result<unknown>) => {
    const row = result.results[0] as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  };
  return {
    satellites: count(satellites),
    conjunctions: count(conjunctions),
    decays: count(decays),
    spaceWeather: count(weather),
    failedRunsLast24h: count(runs),
  };
}

function validManualRequest(request: Request, env: Env) {
  if (!env.INGESTION_TOKEN) return false;
  const expected = env.INGESTION_TOKEN.trim();
  const directToken = request.headers.get("X-Ingestion-Token");
  const authorization = request.headers.get("Authorization");
  return directToken === expected || authorization === `Bearer ${expected}`;
}

async function handleFetch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return optionsResponse(request, env);

  if (request.method === "GET" && url.pathname === "/health") {
    const counts = await health(env.DB);
    return jsonResponse(request, env, {
      status: counts.failedRunsLast24h ? "degraded" : "ok",
      environment: env.ENVIRONMENT,
      database: counts,
      checkedAt: new Date().toISOString(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/signals") {
    return jsonResponse(request, env, await latestSignals(env.DB));
  }

  if (request.method === "GET" && url.pathname === "/api/catalog/latest") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
    const query = url.searchParams.get("q")?.trim();
    const statement = query
      ? env.DB.prepare(`
          SELECT norad_id AS noradId, object_name AS objectName, object_id AS objectId, epoch, orbital_elements AS orbitalElements
          FROM satellites WHERE object_name LIKE ? ESCAPE '\\' ORDER BY object_name LIMIT ?
        `).bind(`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, limit)
      : env.DB.prepare(`
          SELECT norad_id AS noradId, object_name AS objectName, object_id AS objectId, epoch, orbital_elements AS orbitalElements
          FROM satellites ORDER BY object_name LIMIT ?
        `).bind(limit);
    const result = await statement.all();
    return jsonResponse(request, env, {
      count: result.results.length,
      items: result.results.map((row) => ({
        ...row,
        epoch: new Date(Number(row.epoch)).toISOString(),
        orbitalElements: JSON.parse(String(row.orbitalElements)),
      })),
    });
  }

  if (request.method === "POST" && url.pathname === "/internal/ingest") {
    if (!validManualRequest(request, env)) return jsonResponse(request, env, { error: "Unauthorized" }, 401);
    const scope = url.searchParams.get("scope") as IngestionScope | null;
    if (scope === "signals") return jsonResponse(request, env, await ingestSignals(env));
    if (scope === "catalog") return jsonResponse(request, env, await ingestCatalog(env, url.searchParams.get("force") === "true"));
    return jsonResponse(request, env, { error: "scope must be signals or catalog" }, 400);
  }

  return jsonResponse(request, env, { error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      console.error("request failed", error);
      return jsonResponse(request, env, {
        error: "Internal server error",
        requestId: crypto.randomUUID(),
      }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const task = controller.cron === "0 18 * * *" ? ingestCatalog(env) : ingestSignals(env);
    ctx.waitUntil(task.then(
      (result) => console.log("scheduled ingestion completed", { cron: controller.cron, result }),
      (error) => console.error("scheduled ingestion failed", { cron: controller.cron, error }),
    ));
  },
} satisfies ExportedHandler<Env>;
