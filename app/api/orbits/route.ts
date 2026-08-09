import { eciToEcf, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from "satellite.js";
import { loadCatalog, type CompactOmm } from "../catalog/route";

const frameStepMs = 30_000;
const frameSpanMs = 60_000;
const earthRotationRadiansPerSecond = 7.29211514670698e-5;
const headerBytes = 48;
const recordBytes = 56;
const magic = 0x5442524f;

function tupleToOmm(tuple: CompactOmm): OMMJsonObject {
  return {
    OBJECT_NAME: tuple[0],
    NORAD_CAT_ID: tuple[1],
    OBJECT_ID: tuple[2],
    EPOCH: tuple[3],
    MEAN_MOTION: tuple[4],
    ECCENTRICITY: tuple[5],
    INCLINATION: tuple[6],
    RA_OF_ASC_NODE: tuple[7],
    ARG_OF_PERICENTER: tuple[8],
    MEAN_ANOMALY: tuple[9],
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: tuple[11],
    ELEMENT_SET_NO: tuple[12],
    REV_AT_EPOCH: tuple[13],
    BSTAR: tuple[14],
    MEAN_MOTION_DOT: tuple[15],
    MEAN_MOTION_DDOT: tuple[16],
  };
}

function ecfState(satrec: SatRec, date: Date) {
  const result = propagate(satrec, date);
  if (!result) return null;
  const gmst = gstime(date);
  const position = eciToEcf(result.position, gmst);
  const rotatedVelocity = eciToEcf(result.velocity, gmst);
  return {
    position,
    velocity: {
      x: rotatedVelocity.x + earthRotationRadiansPerSecond * position.y,
      y: rotatedVelocity.y - earthRotationRadiansPerSecond * position.x,
      z: rotatedVelocity.z,
    },
  };
}

function requestedTime(request: Request) {
  const url = new URL(request.url);
  const candidate = Number(url.searchParams.get("at"));
  const now = Date.now();
  const bounded = Number.isFinite(candidate) && Math.abs(candidate - now) <= 48 * 60 * 60 * 1000 ? candidate : now;
  return Math.floor(bounded / frameStepMs) * frameStepMs;
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  const startTime = requestedTime(request);
  const endTime = startTime + frameSpanMs;
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);
  const catalog = await loadCatalog();
  const buffer = new ArrayBuffer(headerBytes + catalog.items.length * recordBytes);
  const view = new DataView(buffer);
  view.setUint32(0, magic, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, catalog.status === "live" ? 1 : 0, true);
  view.setUint32(8, catalog.items.length, true);
  view.setUint32(12, headerBytes, true);
  view.setFloat64(16, startTime, true);
  view.setFloat64(24, endTime, true);
  view.setFloat64(32, Date.parse(catalog.fetchedAt), true);
  view.setUint32(44, recordBytes, true);

  catalog.items.forEach((tuple, index) => {
    const recordOffset = headerBytes + index * recordBytes;
    view.setUint32(recordOffset, tuple[1], true);
    let start: ReturnType<typeof ecfState> = null;
    let end: ReturnType<typeof ecfState> = null;
    try {
      const satrec = json2satrec(tupleToOmm(tuple));
      start = ecfState(satrec, startDate);
      end = ecfState(satrec, endDate);
    } catch {
      // Invalid public GP records remain addressable but are marked unavailable.
    }
    view.setUint8(recordOffset + 4, start && end ? 1 : 0);
    if (!start || !end) return;
    const values = [
      start.position.x, start.position.y, start.position.z,
      start.velocity.x, start.velocity.y, start.velocity.z,
      end.position.x, end.position.y, end.position.z,
      end.velocity.x, end.velocity.y, end.velocity.z,
    ];
    values.forEach((value, valueIndex) => view.setFloat32(recordOffset + 8 + valueIndex * 4, value, true));
  });

  view.setFloat32(40, performance.now() - startedAt, true);
  return new Response(buffer, {
    headers: {
      "Cache-Control": "public, s-maxage=25, stale-while-revalidate=60",
      "Content-Type": "application/vnd.agentbase.orbit-frame",
      "X-Orbit-Count": String(catalog.items.length),
      "X-Orbit-Source": catalog.status,
    },
  });
}
