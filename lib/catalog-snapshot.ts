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

export type StoredCatalogSnapshot = {
  status: "live";
  source: string;
  fetchedAt: string;
  count: number;
  items: CompactOmm[];
};

export type CatalogLookupItem = {
  noradId: number;
  objectName: string;
  objectId: string;
  epoch: string;
  orbitalElements: {
    meanMotion: number;
    eccentricity: number;
    inclination: number;
    raan: number;
    argumentOfPericenter: number;
    meanAnomaly: number;
    classification: "U" | "C";
    elementSetNumber: number;
    revolutionAtEpoch: number;
    bstar: number;
    meanMotionDot: number;
    meanMotionDdot: number;
  };
};

const catalogNameCollator = new Intl.Collator("en-US", { sensitivity: "base" });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isCompactOmm(value: unknown): value is CompactOmm {
  if (!Array.isArray(value) || value.length !== 17) return false;
  return typeof value[0] === "string"
    && isFiniteNumber(value[1])
    && typeof value[2] === "string"
    && typeof value[3] === "string"
    && Number.isFinite(Date.parse(value[3]))
    && value.slice(4, 11).every(isFiniteNumber)
    && (value[11] === "U" || value[11] === "C")
    && value.slice(12).every(isFiniteNumber);
}

export function isStoredCatalogSnapshot(value: unknown): value is StoredCatalogSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredCatalogSnapshot>;
  return candidate.status === "live"
    && typeof candidate.source === "string"
    && typeof candidate.fetchedAt === "string"
    && Number.isFinite(Date.parse(candidate.fetchedAt))
    && typeof candidate.count === "number"
    && Number.isInteger(candidate.count)
    && candidate.count > 0
    && Array.isArray(candidate.items)
    && candidate.count === candidate.items.length
    && candidate.items.every(isCompactOmm);
}

function catalogLookupItem(item: CompactOmm): CatalogLookupItem {
  return {
    noradId: item[1],
    objectName: item[0],
    objectId: item[2],
    epoch: item[3],
    orbitalElements: {
      meanMotion: item[4],
      eccentricity: item[5],
      inclination: item[6],
      raan: item[7],
      argumentOfPericenter: item[8],
      meanAnomaly: item[9],
      classification: item[11],
      elementSetNumber: item[12],
      revolutionAtEpoch: item[13],
      bstar: item[14],
      meanMotionDot: item[15],
      meanMotionDdot: item[16],
    },
  };
}

export function searchStoredCatalog(
  snapshot: StoredCatalogSnapshot,
  query: string | null | undefined,
  requestedLimit: number,
) {
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 25));
  const normalizedQuery = query?.trim().toLocaleLowerCase("en-US") ?? "";
  const selected: CompactOmm[] = [];
  for (const item of snapshot.items) {
    if (normalizedQuery && !item[0].toLocaleLowerCase("en-US").includes(normalizedQuery)) continue;
    if (selected.length === limit && catalogNameCollator.compare(item[0], selected[selected.length - 1][0]) >= 0) continue;
    let lower = 0;
    let upper = selected.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (catalogNameCollator.compare(selected[middle][0], item[0]) <= 0) lower = middle + 1;
      else upper = middle;
    }
    selected.splice(lower, 0, item);
    if (selected.length > limit) selected.pop();
  }
  const items = selected.map(catalogLookupItem);
  return { count: items.length, items };
}
