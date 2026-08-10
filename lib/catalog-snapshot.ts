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
