/// <reference lib="webworker" />

import { eciToEcf, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from "satellite.js";

type CompactOmm = [string, number, string, string, number, number, number, number, number, number, number, "U" | "C", number, number, number, number, number];

type InitMessage = {
  type: "init";
  entries: CompactOmm[];
  offsetMs: number;
  pausedAt: number | null;
  active: boolean;
};

type ControlMessage = {
  type: "control";
  offsetMs: number;
  pausedAt: number | null;
};

type VisibilityMessage = { type: "visibility"; active: boolean };
type IncomingMessage = InitMessage | ControlMessage | VisibilityMessage;

const cadenceMs = 2500;
const earthRotationRadiansPerSecond = 7.29211514670698e-5;
const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let satrecs: Array<SatRec | null> = [];
let offsetMs = 0;
let pausedAt: number | null = null;
let active = true;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

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

function simulationTime() {
  return (pausedAt ?? Date.now()) + offsetMs;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!active || pausedAt !== null || satrecs.length === 0) return;
  timer = setTimeout(() => {
    sample();
    schedule();
  }, cadenceMs);
}

function sample() {
  if (!active || satrecs.length === 0) return;
  const startedAt = performance.now();
  const startTime = simulationTime();
  const endTime = pausedAt === null ? startTime + cadenceMs : startTime;
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);
  const startGmst = gstime(startDate);
  const endGmst = gstime(endDate);
  const startPositions = new Float32Array(satrecs.length * 3);
  const endPositions = new Float32Array(satrecs.length * 3);
  const startVelocities = new Float32Array(satrecs.length * 3);
  const endVelocities = new Float32Array(satrecs.length * 3);

  for (let index = 0; index < satrecs.length; index += 1) {
    const offset = index * 3;
    const satrec = satrecs[index];
    const first = satrec ? propagate(satrec, startDate) : null;
    const second = satrec && pausedAt === null ? propagate(satrec, endDate) : first;
    if (!first || !second) {
      startPositions[offset] = Number.NaN;
      endPositions[offset] = Number.NaN;
      continue;
    }
    const firstEcf = eciToEcf(first.position, startGmst);
    const secondEcf = pausedAt === null ? eciToEcf(second.position, endGmst) : firstEcf;
    const firstVelocity = eciToEcf(first.velocity, startGmst);
    const secondVelocity = pausedAt === null ? eciToEcf(second.velocity, endGmst) : firstVelocity;
    startPositions[offset] = firstEcf.x;
    startPositions[offset + 1] = firstEcf.y;
    startPositions[offset + 2] = firstEcf.z;
    endPositions[offset] = secondEcf.x;
    endPositions[offset + 1] = secondEcf.y;
    endPositions[offset + 2] = secondEcf.z;
    startVelocities[offset] = firstVelocity.x + earthRotationRadiansPerSecond * firstEcf.y;
    startVelocities[offset + 1] = firstVelocity.y - earthRotationRadiansPerSecond * firstEcf.x;
    startVelocities[offset + 2] = firstVelocity.z;
    endVelocities[offset] = secondVelocity.x + earthRotationRadiansPerSecond * secondEcf.y;
    endVelocities[offset + 1] = secondVelocity.y - earthRotationRadiansPerSecond * secondEcf.x;
    endVelocities[offset + 2] = secondVelocity.z;
  }

  workerScope.postMessage({
    type: "snapshot",
    generation,
    startTime,
    endTime,
    computeMs: performance.now() - startedAt,
    startPositions,
    endPositions,
    startVelocities,
    endVelocities,
  }, [startPositions.buffer, endPositions.buffer, startVelocities.buffer, endVelocities.buffer]);
}

workerScope.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    generation += 1;
    offsetMs = message.offsetMs;
    pausedAt = message.pausedAt;
    active = message.active;
    satrecs = message.entries.map((tuple) => {
      try {
        return json2satrec(tupleToOmm(tuple));
      } catch {
        return null;
      }
    });
    sample();
    schedule();
    return;
  }

  if (message.type === "control") {
    offsetMs = message.offsetMs;
    pausedAt = message.pausedAt;
    sample();
    schedule();
    return;
  }

  active = message.active;
  if (active) sample();
  schedule();
};

export {};
