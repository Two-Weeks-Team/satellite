import {
  isHistoryIntelligence,
  type HistoryIntelligence,
} from "@/lib/history-intelligence";
import { readTextWithinLimit } from "@/lib/read-response";

const SOURCE_TIMEOUT_MS = 4_000;
const MAX_INTELLIGENCE_BYTES = 512_000;

function unavailableHistory(): HistoryIntelligence {
  return {
    status: "unavailable",
    generatedAt: new Date().toISOString(),
    history: {
      baselineStartedAt: null,
      sampleDays: 0,
      retentionDays: 365,
      orbitalObjects: 0,
      matureObjects: 0,
      conjunctionEvents: 0,
      persistentConjunctions: 0,
      decayEvents: 0,
      persistentDecayEvents: 0,
      weatherObservations: 0,
    },
    objects: [],
  };
}

function normalizedNoradIds(values: Iterable<number>) {
  const ids: number[] = [];
  for (const value of values) {
    if (Number.isInteger(value) && value > 0 && !ids.includes(value)) ids.push(value);
    if (ids.length >= 24) break;
  }
  return ids;
}

export async function loadHistoryIntelligence(noradIds: Iterable<number> = []) {
  const baseUrl = process.env.SATELLITE_DATA_API_URL?.replace(/\/$/, "");
  if (!baseUrl) return unavailableHistory();
  const ids = normalizedNoradIds(noradIds);
  const url = new URL(`${baseUrl}/api/intelligence`);
  if (ids.length) url.searchParams.set("norad", ids.join(","));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      next: { revalidate: 120 },
    } as RequestInit & { next: { revalidate: number } });
    if (!response.ok) return unavailableHistory();
    const value: unknown = JSON.parse(await readTextWithinLimit(response, MAX_INTELLIGENCE_BYTES));
    return isHistoryIntelligence(value) ? value : unavailableHistory();
  } catch {
    return unavailableHistory();
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ids = normalizedNoradIds(
    (url.searchParams.get("norad")?.split(",") ?? []).map(Number),
  );
  const intelligence = await loadHistoryIntelligence(ids);
  return Response.json(intelligence, {
    headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
  });
}
