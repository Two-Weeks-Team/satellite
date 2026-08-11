export type StoredHistoryTuple = [
  number,
  number,
  string,
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type StoredHistorySummary = {
  status: "live";
  generatedAt: string;
  snapshotDate: string;
  baselineStartedAt: string;
  sampleDays: number;
  objectCount: number;
  matureObjects: number;
  items: StoredHistoryTuple[];
};

export type HistoryObjectInsight = {
  noradId: number;
  samples: number;
  firstObservedAt: string;
  lastObservedAt: string;
  lastEpoch: string;
  meanMotion: number;
  bstar: number;
  inclination: number;
  meanMotionTrendPerDay: number;
  bstarTrendPerDay: number;
  inclinationTrendPerDay: number;
  stability: number;
  mode: "collecting" | "history-calibrated";
};

export type HistoryOverview = {
  baselineStartedAt: string | null;
  sampleDays: number;
  retentionDays: number;
  orbitalObjects: number;
  matureObjects: number;
  conjunctionEvents: number;
  persistentConjunctions: number;
  decayEvents: number;
  persistentDecayEvents: number;
  weatherObservations: number;
};

export type HistoryIntelligence = {
  status: "active" | "collecting" | "unavailable";
  generatedAt: string;
  history: HistoryOverview;
  objects: HistoryObjectInsight[];
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isStoredHistoryTuple(value: unknown): value is StoredHistoryTuple {
  return Array.isArray(value)
    && value.length === 12
    && isFiniteNumber(value[0])
    && Number.isInteger(value[0])
    && isFiniteNumber(value[1])
    && Number.isInteger(value[1])
    && value[1] > 0
    && isIsoDate(value[2])
    && isIsoDate(value[3])
    && isIsoDate(value[4])
    && value.slice(5).every(isFiniteNumber)
    && value[11] >= 0
    && value[11] <= 1;
}

export function isStoredHistorySummary(value: unknown): value is StoredHistorySummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredHistorySummary>;
  return candidate.status === "live"
    && isIsoDate(candidate.generatedAt)
    && typeof candidate.snapshotDate === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(candidate.snapshotDate)
    && isIsoDate(candidate.baselineStartedAt)
    && isFiniteNumber(candidate.sampleDays)
    && Number.isInteger(candidate.sampleDays)
    && candidate.sampleDays > 0
    && isFiniteNumber(candidate.objectCount)
    && Number.isInteger(candidate.objectCount)
    && candidate.objectCount > 0
    && isFiniteNumber(candidate.matureObjects)
    && Number.isInteger(candidate.matureObjects)
    && candidate.matureObjects >= 0
    && Array.isArray(candidate.items)
    && candidate.items.length === candidate.objectCount
    && candidate.items.every(isStoredHistoryTuple);
}

export function historyTupleToInsight(tuple: StoredHistoryTuple): HistoryObjectInsight {
  return {
    noradId: tuple[0],
    samples: tuple[1],
    firstObservedAt: tuple[2],
    lastObservedAt: tuple[3],
    lastEpoch: tuple[4],
    meanMotion: tuple[5],
    bstar: tuple[6],
    inclination: tuple[7],
    meanMotionTrendPerDay: tuple[8],
    bstarTrendPerDay: tuple[9],
    inclinationTrendPerDay: tuple[10],
    stability: tuple[11],
    mode: tuple[1] >= 2 ? "history-calibrated" : "collecting",
  };
}

function isHistoryOverview(value: unknown): value is HistoryOverview {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HistoryOverview>;
  return (candidate.baselineStartedAt === null || isIsoDate(candidate.baselineStartedAt))
    && [
      candidate.sampleDays,
      candidate.retentionDays,
      candidate.orbitalObjects,
      candidate.matureObjects,
      candidate.conjunctionEvents,
      candidate.persistentConjunctions,
      candidate.decayEvents,
      candidate.persistentDecayEvents,
      candidate.weatherObservations,
    ].every((item) => isFiniteNumber(item) && Number.isInteger(item) && item >= 0);
}

function isHistoryObjectInsight(value: unknown): value is HistoryObjectInsight {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HistoryObjectInsight>;
  const stability = candidate.stability;
  return isFiniteNumber(candidate.noradId)
    && Number.isInteger(candidate.noradId)
    && isFiniteNumber(candidate.samples)
    && Number.isInteger(candidate.samples)
    && candidate.samples > 0
    && isIsoDate(candidate.firstObservedAt)
    && isIsoDate(candidate.lastObservedAt)
    && isIsoDate(candidate.lastEpoch)
    && [
      candidate.meanMotion,
      candidate.bstar,
      candidate.inclination,
      candidate.meanMotionTrendPerDay,
      candidate.bstarTrendPerDay,
      candidate.inclinationTrendPerDay,
      stability,
    ].every(isFiniteNumber)
    && isFiniteNumber(stability)
    && stability >= 0
    && stability <= 1
    && (candidate.mode === "collecting" || candidate.mode === "history-calibrated");
}

export function isHistoryIntelligence(value: unknown): value is HistoryIntelligence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HistoryIntelligence>;
  return ["active", "collecting", "unavailable"].includes(String(candidate.status))
    && isIsoDate(candidate.generatedAt)
    && isHistoryOverview(candidate.history)
    && Array.isArray(candidate.objects)
    && candidate.objects.every(isHistoryObjectInsight);
}
