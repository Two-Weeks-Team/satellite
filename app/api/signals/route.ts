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

type SignalsResult = {
  status: "live" | "partial" | "offline";
  fetchedAt: string;
  conjunctions: Conjunction[];
  decays: Decay[];
  spaceWeather: SpaceWeather | null;
  sources: {
    conjunctions: string;
    decays: string;
    spaceWeather: string;
  };
};

const SOCRATES = "https://celestrak.org/SOCRATES/table-socrates.php?NAME=,&ORDER=MINRANGE&MAX=12";
const DECAYING = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=JSON";
const KP = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const TWO_HOURS = 60 * 60 * 2;
const FAILURE_CACHE_SECONDS = 30;
const SOURCE_TIMEOUT_MS = 4_000;

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
  if (!Array.isArray(rows) || rows.length < 1) return null;
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

async function cachedFetchText(url: string, accept: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept },
      signal: controller.signal,
      next: { revalidate: TWO_HOURS },
    } as RequestInit & { next: { revalidate: number } });
    if (!response.ok) throw new Error(`${new URL(url).hostname} ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function cachedFetchJson<T>(url: string) {
  return JSON.parse(await cachedFetchText(url, "application/json")) as T;
}

function isStoredSignals(value: unknown): value is SignalsResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SignalsResult>;
  return typeof candidate.fetchedAt === "string"
    && Array.isArray(candidate.conjunctions)
    && Array.isArray(candidate.decays)
    && typeof candidate.sources === "object";
}

async function loadStoredSignals(): Promise<SignalsResult | null> {
  const baseUrl = process.env.SATELLITE_DATA_API_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/api/signals`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      next: { revalidate: 120 },
    } as RequestInit & { next: { revalidate: number } });
    if (!response.ok) return null;
    const result: unknown = await response.json();
    if (!isStoredSignals(result) || result.status !== "live") return null;
    const age = Date.now() - Date.parse(result.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > 6 * 60 * 60 * 1000) return null;
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadUpstreamSignals(): Promise<SignalsResult> {
  const fetchedAt = new Date().toISOString();
  const [conjunctionResult, decayResult, kpResult] = await Promise.allSettled([
    cachedFetchText(SOCRATES, "text/html").then(parseConjunctions),
    cachedFetchJson<Array<Record<string, string | number>>>(DECAYING).then((data) => {
      return data.slice(0, 20).map((item): Decay => ({
        id: Number(item.NORAD_CAT_ID),
        name: String(item.OBJECT_NAME),
        epoch: String(item.EPOCH),
        meanMotion: Number(item.MEAN_MOTION),
        bstar: Number(item.BSTAR),
      }));
    }),
    cachedFetchJson<unknown>(KP).then(currentKp),
  ]);

  const conjunctions = conjunctionResult.status === "fulfilled" ? conjunctionResult.value : [];
  const decays = decayResult.status === "fulfilled" ? decayResult.value : [];
  const spaceWeather = kpResult.status === "fulfilled" ? kpResult.value : null;
  const liveSources = [conjunctions.length > 0, decays.length > 0, spaceWeather !== null].filter(Boolean).length;

  return {
    status: liveSources === 3 ? "live" as const : liveSources > 0 ? "partial" as const : "offline" as const,
    fetchedAt,
    conjunctions,
    decays,
    spaceWeather,
    sources: {
      conjunctions: "CelesTrak SOCRATES Plus",
      decays: "CelesTrak Potential Decays",
      spaceWeather: "NOAA SWPC",
    },
  };
}

async function loadSignalsOnce(): Promise<SignalsResult> {
  const stored = await loadStoredSignals();
  return stored ?? loadUpstreamSignals();
}

let signalsCache: SignalsResult | null = null;
let signalsPromise: Promise<SignalsResult> | null = null;

function signalsCacheIsFresh(signals: SignalsResult) {
  const age = Date.now() - Date.parse(signals.fetchedAt);
  const maxAge = (signals.status === "live" ? TWO_HOURS : FAILURE_CACHE_SECONDS) * 1000;
  return Number.isFinite(age) && age >= 0 && age < maxAge;
}

export async function loadSignals() {
  if (signalsCache && signalsCacheIsFresh(signalsCache)) return signalsCache;
  if (signalsPromise) return signalsPromise;
  signalsPromise = loadSignalsOnce()
    .then((signals) => {
      signalsCache = signals;
      return signals;
    })
    .finally(() => {
      signalsPromise = null;
    });
  return signalsPromise;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("upstream") === "1") {
    const expected = process.env.SATELLITE_UPSTREAM_PROXY_TOKEN?.trim();
    const authorization = request.headers.get("Authorization");
    if (!expected || authorization !== `Bearer ${expected}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const signals = await loadUpstreamSignals();
    return Response.json(signals, { headers: { "Cache-Control": "private, no-store" } });
  }
  const signals = await loadSignals();
  const cacheSeconds = signals.status === "live" ? TWO_HOURS : FAILURE_CACHE_SECONDS;
  return Response.json(signals, { headers: { "Cache-Control": `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}` } });
}
