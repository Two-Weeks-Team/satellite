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

const SOCRATES = "https://celestrak.org/SOCRATES/table-socrates.php?NAME=,&ORDER=MINRANGE&MAX=12";
const DECAYING = "https://celestrak.org/NORAD/elements/gp.php?SPECIAL=DECAYING&FORMAT=JSON";
const KP = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const TWO_HOURS = 60 * 60 * 2;

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

function currentKp(rows: unknown) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const header = rows[0] as string[];
  const data = rows[rows.length - 1] as string[];
  const record = Object.fromEntries(header.map((key, index) => [key, data[index]]));
  const kp = Number(record.Kp ?? record.kp_index ?? 0);
  return {
    time: String(record.time_tag ?? new Date().toISOString()),
    kp: Number.isFinite(kp) ? kp : 0,
    level: kp >= 7 ? "severe" : kp >= 5 ? "storm" : kp >= 4 ? "active" : "quiet",
  };
}

async function cachedFetch(url: string, accept: string) {
  return fetch(url, {
    headers: { accept },
    cf: { cacheEverything: true, cacheTtl: TWO_HOURS },
  } as RequestInit & { cf: { cacheEverything: boolean; cacheTtl: number } });
}

export async function GET() {
  const fetchedAt = new Date().toISOString();
  const [conjunctionResult, decayResult, kpResult] = await Promise.allSettled([
    cachedFetch(SOCRATES, "text/html").then(async (response) => {
      if (!response.ok) throw new Error(`SOCRATES ${response.status}`);
      return parseConjunctions(await response.text());
    }),
    cachedFetch(DECAYING, "application/json").then(async (response) => {
      if (!response.ok) throw new Error(`Decays ${response.status}`);
      const data = await response.json() as Array<Record<string, string | number>>;
      return data.slice(0, 20).map((item) => ({
        id: Number(item.NORAD_CAT_ID),
        name: String(item.OBJECT_NAME),
        epoch: String(item.EPOCH),
        meanMotion: Number(item.MEAN_MOTION),
        bstar: Number(item.BSTAR),
      }));
    }),
    cachedFetch(KP, "application/json").then(async (response) => {
      if (!response.ok) throw new Error(`NOAA ${response.status}`);
      return currentKp(await response.json());
    }),
  ]);

  const conjunctions = conjunctionResult.status === "fulfilled" ? conjunctionResult.value : [];
  const decays = decayResult.status === "fulfilled" ? decayResult.value : [];
  const spaceWeather = kpResult.status === "fulfilled" ? kpResult.value : null;
  const liveSources = [conjunctions.length > 0, decays.length > 0, spaceWeather !== null].filter(Boolean).length;

  return Response.json(
    {
      status: liveSources === 3 ? "live" : liveSources > 0 ? "partial" : "offline",
      fetchedAt,
      conjunctions,
      decays,
      spaceWeather,
      sources: {
        conjunctions: "CelesTrak SOCRATES Plus",
        decays: "CelesTrak Potential Decays",
        spaceWeather: "NOAA SWPC",
      },
    },
    { headers: { "Cache-Control": `public, s-maxage=${TWO_HOURS}, stale-while-revalidate=${TWO_HOURS}` } },
  );
}
