type UpstreamOmm = Record<string, string | number | null>;

export type CompactOmm = [
  string,
  number,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  "U" | "C",
  number,
  number,
  number,
  number,
  number,
];

const TWO_HOURS = 60 * 60 * 2;
const FAILURE_CACHE_SECONDS = 30;
const SOURCE_TIMEOUT_MS = 4_000;
const sources = [
  {
    url: "https://retlector.eu/csv/active",
    label: "CelesTrak GP via ReTLEctor cache",
  },
  {
    url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=CSV",
    label: "CelesTrak / USSF GP",
  },
] as const;

const fallback: CompactOmm[] = [
  ["STARLINK-1329", 45531, "2020-025A", "2026-08-09T00:00:02.000160", 15.83331187, 0.0000603, 53.0364, 46.501, 126.5123, 117.9607, 0, "U", 999, 565, 0.00053184, 0.0011864, 0],
  ["STARLINK-1338", 45532, "2020-025B", "2026-08-08T22:38:11.554656", 15.78798004, 0.0001724, 53.0399, 55.2053, 226.3243, 133.7634, 0, "U", 999, 34927, 0.00038123, 0.00068326, 0],
  ["STARLINK-1350", 45535, "2020-025E", "2026-08-08T21:20:26.168928", 15.41266899, 0.0000912, 53.0708, 36.004, 135.6971, 224.4106, 0, "U", 999, 34958, 0.00019825, 0.00007976, 0],
  ["STARLINK-1362", 45538, "2020-025H", "2026-08-09T02:24:54.624672", 15.42793262, 0.0004875, 53.1538, 106.6507, 74.6043, 285.5501, 0, "U", 999, 34860, 0.00018739, 0.00007924, 0],
  ["STARLINK-1368", 45540, "2020-025K", "2026-08-09T02:31:02.821728", 15.43067426, 0.0003414, 53.153, 106.8965, 68.6188, 291.5182, 0, "U", 999, 34859, 0.00093653, 0.00041833, 0],
  ["STARLINK-1371", 45542, "2020-025M", "2026-08-08T20:45:13.624992", 15.75060814, 0.00014395, 53.0407, 66.8982, 184.8227, 175.2778, 0, "U", 999, 34910, 0.00037102361, 0.00056178, 0],
  ["GFO", 25157, "1998-007A", "2026-07-31T05:15:58.910112", 16.22906186, 0.0020121, 107.9861, 278.7225, 249.8653, 110.042, 0, "U", 999, 53354, 0.00067175, 0.0168785, 0.0000096357],
  ["IRIDIUM 82", 25467, "1998-051A", "2026-07-31T05:41:24.029952", 16.06307443, 0.001358, 86.3326, 261.5935, 160.0299, 200.1525, 0, "U", 999, 48744, 0.0011469, 0.00847128, 0.0003758],
  ["ODIN", 26702, "2001-007A", "2026-07-31T05:16:25.695840", 16.11001612, 0.0008962, 97.3646, 256.7325, 200.0494, 160.0439, 0, "U", 999, 39638, 0.0014673, 0.01426489, 0.0014355],
  ["STARLINK-1151", 45081, "2020-006AP", "2026-07-31T05:52:51.593376", 16.338126, 0.000334, 53.0298, 237.3614, 333.4539, 26.6333, 0, "U", 999, 35984, 0.00071955, 0.04914774, 0.000012226],
];

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

function numeric(value: string | number | null | undefined, fallbackValue = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallbackValue;
}

function compact(record: UpstreamOmm): CompactOmm | null {
  const name = String(record.OBJECT_NAME ?? "").trim();
  const objectId = String(record.OBJECT_ID ?? "").trim();
  const epoch = String(record.EPOCH ?? "").trim();
  const catalogId = numeric(record.NORAD_CAT_ID, -1);
  const meanMotion = numeric(record.MEAN_MOTION, -1);
  if (!name || !epoch || catalogId < 0 || meanMotion <= 0) return null;

  return [
    name,
    catalogId,
    objectId,
    epoch,
    meanMotion,
    numeric(record.ECCENTRICITY),
    numeric(record.INCLINATION),
    numeric(record.RA_OF_ASC_NODE),
    numeric(record.ARG_OF_PERICENTER),
    numeric(record.MEAN_ANOMALY),
    numeric(record.EPHEMERIS_TYPE),
    String(record.CLASSIFICATION_TYPE ?? "U") === "C" ? "C" : "U",
    numeric(record.ELEMENT_SET_NO),
    numeric(record.REV_AT_EPOCH),
    numeric(record.BSTAR),
    numeric(record.MEAN_MOTION_DOT),
    numeric(record.MEAN_MOTION_DDOT),
  ];
}

async function fetchCatalogSource(source: (typeof sources)[number]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      headers: { accept: "text/csv" },
      signal: controller.signal,
      cf: { cacheEverything: true, cacheTtl: TWO_HOURS },
    } as RequestInit & { cf: { cacheEverything: boolean; cacheTtl: number } });
    if (!response.ok) throw new Error(`${source.label} responded ${response.status}`);
    const csv = await response.text();
    const [header = [], ...rows] = parseCsv(csv);
    const items = rows
      .map((row) => Object.fromEntries(header.map((key, index) => [key.trim(), row[index] ?? ""])))
      .map(compact)
      .filter((item): item is CompactOmm => item !== null);
    if (items.length < 100) throw new Error(`${source.label} catalog was unexpectedly small`);
    return { items, source: source.label };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCatalog() {
  const failures: string[] = [];
  for (const source of sources) {
    try {
      return await fetchCatalogSource(source);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${source.label} unavailable`);
    }
  }
  throw new Error(failures.join("; "));
}

type CatalogResult =
  | { status: "live"; source: string; fetchedAt: string; count: number; items: CompactOmm[] }
  | { status: "cached-sample"; source: string; fetchedAt: string; count: number; items: CompactOmm[]; message: string };

let catalogCache: CatalogResult | null = null;
let catalogPromise: Promise<CatalogResult> | null = null;

function cacheIsFresh(catalog: CatalogResult) {
  const age = Date.now() - Date.parse(catalog.fetchedAt);
  const maxAge = (catalog.status === "live" ? TWO_HOURS : FAILURE_CACHE_SECONDS) * 1000;
  return Number.isFinite(age) && age >= 0 && age < maxAge;
}

async function loadCatalogOnce(): Promise<CatalogResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const result = await fetchCatalog();
    return { status: "live", source: result.source, fetchedAt, count: result.items.length, items: result.items };
  } catch (error) {
    return {
      status: "cached-sample" as const,
      source: "CelesTrak last-known sample",
      fetchedAt,
      count: fallback.length,
      items: fallback,
      message: error instanceof Error ? error.message : "Live catalog unavailable",
    };
  }
}

export async function loadCatalog() {
  if (catalogCache && cacheIsFresh(catalogCache)) return catalogCache;
  if (catalogPromise) return catalogPromise;
  catalogPromise = loadCatalogOnce()
    .then((catalog) => {
      catalogCache = catalog;
      return catalog;
    })
    .finally(() => {
      catalogPromise = null;
    });
  return catalogPromise;
}

export async function GET() {
  const catalog = await loadCatalog();
  const cacheSeconds = catalog.status === "live" ? TWO_HOURS : FAILURE_CACHE_SECONDS;
  return Response.json(catalog, { headers: { "Cache-Control": `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}` } });
}
