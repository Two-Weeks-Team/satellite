"use client";

import {
  degreesLat,
  degreesLong,
  degreesToRadians,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";
import { geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import world50Url from "world-atlas/countries-50m.json?url";
import world110Source from "world-atlas/countries-110m.json";
import { detectLocale, localeFromCoordinates, localeTags, messages, type LanguageMode, type Locale } from "./i18n";

type CompactOmm = [string, number, string, string, number, number, number, number, number, number, number, "U" | "C", number, number, number, number, number];
type Category = "all" | "station" | "starlink" | "weather" | "navigation" | "science" | "other";
type PanelTab = "discover" | "risk" | "sky";
type ColorMode = "type" | "constellation" | "altitude" | "risk";
type AutonomyMode = "manual" | "assist" | "autopilot";

type CatalogResponse = {
  status: "live" | "cached-sample";
  source: string;
  fetchedAt: string;
  count: number;
  items: CompactOmm[];
  message?: string;
};

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

type SignalsResponse = {
  status: "live" | "partial" | "offline";
  fetchedAt: string;
  conjunctions: Conjunction[];
  decays: Array<{ id: number; name: string; epoch: string; meanMotion: number; bstar: number }>;
  spaceWeather: null | { time: string; kp: number; level: "quiet" | "active" | "storm" | "severe" };
  sources: Record<string, string>;
};

type SatelliteEntry = {
  name: string;
  id: number;
  objectId: string;
  epoch: string;
  inclination: number;
  raan: number;
  meanMotion: number;
  bstar: number;
  category: Exclude<Category, "all">;
  satrec?: SatRec;
  omm: CompactOmm;
};

type GeoPosition = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  altitude: number;
  velocity: number;
  category: Exclude<Category, "all">;
};

type Observer = { lat: number; lon: number; label: string };
type PassPrediction = { id: number; name: string; time: Date; maxElevation: number; azimuth: number };
type Vector3 = { x: number; y: number; z: number };
type MotionState = {
  sample: GeoPosition;
  vector: Vector3;
  velocity: Vector3;
  sampleAt: number;
  correction: Vector3;
  correctionAt: number;
};
type OrbitSnapshot = {
  startPositions: Float32Array;
  endPositions: Float32Array;
  startVelocities: Float32Array;
  endVelocities: Float32Array;
  correction: Float32Array;
  startTime: number;
  endTime: number;
  receivedAt: number;
  count: number;
  source: "server" | "browser";
};

type WorkerSnapshot = {
  type: "snapshot";
  generation: number;
  startTime: number;
  endTime: number;
  computeMs: number;
  startPositions: Float32Array;
  endPositions: Float32Array;
  startVelocities: Float32Array;
  endVelocities: Float32Array;
};

type AgentEvent = {
  id: string;
  kind: "risk" | "discovery" | "sky" | "weather" | "decay";
  agent: "SENTINEL" | "SCOUT" | "SKY";
  priority: number;
  title: Record<Locale, string>;
  body: Record<Locale, string>;
  confidence: number;
  evidence: string[];
  createdAt: string;
  action: {
    focusIds?: number[];
    filter?: Exclude<Category, "other">;
    colorMode?: ColorMode;
    panel?: PanelTab;
    timeAt?: string;
  };
};

type AgentResponse = {
  status: "active" | "degraded";
  cycleStartedAt: string;
  monitoredObjects: number;
  evaluatedSignals: number;
  agents: Array<{ id: string; state: string; detail: string }>;
  events: AgentEvent[];
};

const categoryMeta: Array<{ id: Category; labelKey: string; short: string }> = [
  { id: "all", labelKey: "category.all", short: "ALL" },
  { id: "station", labelKey: "category.station", short: "STN" },
  { id: "starlink", labelKey: "category.starlink", short: "STR" },
  { id: "weather", labelKey: "category.weather", short: "WX" },
  { id: "navigation", labelKey: "category.navigation", short: "NAV" },
  { id: "science", labelKey: "category.science", short: "SCI" },
];

const scaleStops = [2, 25, 100, 1000];
const earthRadiusKm = 6378.137;
type WorldTopology = Topology<{ countries: GeometryCollection; land: GeometryCollection }>;

function worldLayers(source: unknown) {
  const topology = source as WorldTopology;
  return {
    land: feature(topology, topology.objects.land),
    coastline: mesh(topology, topology.objects.land),
    borders: mesh(topology, topology.objects.countries, (left, right) => left !== right),
  };
}

const world110 = worldLayers(world110Source);
const worldGraticule = geoGraticule10();
const continentLabels = [
  { label: "NORTH AMERICA", lat: 45, lon: -108 },
  { label: "SOUTH AMERICA", lat: -18, lon: -60 },
  { label: "EUROPE", lat: 52, lon: 18 },
  { label: "AFRICA", lat: 4, lon: 21 },
  { label: "ASIA", lat: 43, lon: 88 },
  { label: "OCEANIA", lat: -25, lon: 134 },
  { label: "ANTARCTICA", lat: -77, lon: 10 },
];

function classify(name: string): Exclude<Category, "all"> {
  const upper = name.toUpperCase();
  if (/ISS|TIANHE|TIANGONG|CSS|SOYUZ|PROGRESS|DRAGON|CYGNUS/.test(upper)) return "station";
  if (upper.includes("STARLINK")) return "starlink";
  if (/NOAA|GOES|METEOR|FENGYUN|HIMAWARI|METOP|WEATHER|ELEKTRO|GEO-KOMPSAT/.test(upper)) return "weather";
  if (/GPS|NAVSTAR|GALILEO|BEIDOU|GLONASS|QZS|NAVIC|IRNSS/.test(upper)) return "navigation";
  if (/HST|HUBBLE|LANDSAT|SENTINEL|TERRA|AQUA|SWARM|ICESAT|JASON|ODIN|GFO|JWST/.test(upper)) return "science";
  return "other";
}

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

function propagateEntry(entry: SatelliteEntry, date: Date): GeoPosition | null {
  const satrec = satrecFor(entry);
  if (!satrec) return null;
  const result = propagate(satrec, date);
  if (!result) return null;
  const geodetic = eciToGeodetic(result.position, gstime(date));
  return {
    id: entry.id,
    name: entry.name,
    lat: degreesLat(geodetic.latitude),
    lon: degreesLong(geodetic.longitude),
    altitude: geodetic.height,
    velocity: Math.hypot(result.velocity.x, result.velocity.y, result.velocity.z),
    category: entry.category,
  };
}

function satrecFor(entry: SatelliteEntry) {
  if (entry.satrec) return entry.satrec;
  try {
    entry.satrec = json2satrec(tupleToOmm(entry.omm));
    return entry.satrec;
  } catch {
    return null;
  }
}

function formatNumber(value: number, locale: Locale, digits = 0) {
  return new Intl.NumberFormat(localeTags[locale], { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function relativeTime(dateInput: string | Date, now: Date, locale: Locale) {
  const date = new Date(dateInput);
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  const formatter = new Intl.RelativeTimeFormat(localeTags[locale], { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  if (Math.abs(minutes) < 1440) return formatter.format(Math.round(minutes / 60), "hour");
  return new Intl.DateTimeFormat(localeTags[locale], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function approximateAltitude(entry: SatelliteEntry) {
  const radiansPerSecond = entry.meanMotion * Math.PI * 2 / 86400;
  return Math.max(0, Math.cbrt(398600.4418 / (radiansPerSecond * radiansPerSecond)) - earthRadiusKm);
}

function satelliteColor(entry: SatelliteEntry, mode: ColorMode, riskIds: Set<number>): [number, number, number] {
  if (mode === "risk") return riskIds.has(entry.id) ? [1, 0.34, 0.25] : [0.23, 0.34, 0.38];
  if (mode === "altitude") {
    const altitude = approximateAltitude(entry);
    if (altitude < 1200) return [0.33, 0.89, 0.93];
    if (altitude < 10000) return [0.45, 0.66, 1];
    if (altitude < 30000) return [0.76, 0.58, 1];
    return [1, 0.78, 0.35];
  }
  if (mode === "constellation" && entry.category === "starlink") {
    const plane = Math.floor((((entry.raan % 360) + 360) % 360) / 30) % 6;
    const shell = entry.inclination < 48 ? 0 : entry.inclination < 60 ? 1 : entry.inclination < 85 ? 2 : 3;
    const palettes: Array<Array<[number, number, number]>> = [
      [[0.24, 0.9, 0.8], [0.2, 0.76, 0.94], [0.34, 0.64, 1], [0.48, 0.55, 1], [0.57, 0.45, 0.95], [0.25, 0.82, 0.72]],
      [[0.29, 0.66, 1], [0.4, 0.78, 1], [0.32, 0.55, 0.95], [0.46, 0.48, 1], [0.28, 0.82, 0.95], [0.52, 0.68, 1]],
      [[0.72, 0.48, 1], [0.62, 0.54, 1], [0.82, 0.55, 0.93], [0.55, 0.68, 1], [0.76, 0.42, 0.86], [0.64, 0.62, 0.98]],
      [[1, 0.48, 0.78], [0.9, 0.56, 1], [0.76, 0.62, 1], [1, 0.6, 0.66], [0.84, 0.48, 0.92], [0.72, 0.7, 1]],
    ];
    return palettes[shell][plane];
  }
  return {
    station: [0.757, 1, 0.447],
    starlink: [0.447, 0.659, 1],
    weather: [0.38, 0.914, 0.929],
    navigation: [0.765, 0.584, 1],
    science: [1, 0.839, 0.42],
    other: [0.667, 0.725, 0.745],
  }[entry.category] as [number, number, number];
}

function parseServerFrame(buffer: ArrayBuffer, entries: SatelliteEntry[]): Omit<OrbitSnapshot, "correction" | "receivedAt"> {
  const view = new DataView(buffer);
  if (view.byteLength < 48 || view.getUint32(0, true) !== 0x5442524f || view.getUint16(4, true) !== 1) throw new Error("Invalid orbit frame");
  const count = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const recordBytes = view.getUint32(44, true);
  if (headerBytes + count * recordBytes > view.byteLength || recordBytes < 56) throw new Error("Truncated orbit frame");
  if (count < entries.length * 0.9) throw new Error("Orbit frame catalog mismatch");
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
  const startPositions = new Float32Array(entries.length * 3).fill(Number.NaN);
  const endPositions = new Float32Array(entries.length * 3).fill(Number.NaN);
  const startVelocities = new Float32Array(entries.length * 3);
  const endVelocities = new Float32Array(entries.length * 3);
  for (let record = 0; record < count; record += 1) {
    const sourceOffset = headerBytes + record * recordBytes;
    if (view.getUint8(sourceOffset + 4) !== 1) continue;
    const targetIndex = indexById.get(view.getUint32(sourceOffset, true));
    if (targetIndex === undefined) continue;
    const targetOffset = targetIndex * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      startPositions[targetOffset + axis] = view.getFloat32(sourceOffset + 8 + axis * 4, true);
      startVelocities[targetOffset + axis] = view.getFloat32(sourceOffset + 20 + axis * 4, true);
      endPositions[targetOffset + axis] = view.getFloat32(sourceOffset + 32 + axis * 4, true);
      endVelocities[targetOffset + axis] = view.getFloat32(sourceOffset + 44 + axis * 4, true);
    }
  }
  return {
    startPositions,
    endPositions,
    startVelocities,
    endVelocities,
    startTime: view.getFloat64(16, true),
    endTime: view.getFloat64(24, true),
    count: entries.length,
    source: "server",
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Orbit shader compile failed", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createOrbitProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
    precision highp float;
    in vec3 aStart;
    in vec3 aEnd;
    in vec3 aStartVelocity;
    in vec3 aEndVelocity;
    in vec3 aCorrection;
    in vec3 aColor;
    in float aSelected;
    uniform float uProgress;
    uniform float uSpanSeconds;
    uniform float uCorrectionWeight;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uDisplayScale;
    uniform float uPixelRatio;
    uniform float uHasSelection;
    uniform float uPulse;
    uniform vec2 uProjectionScale;
    out vec3 vColor;
    out float vSelected;
    out float vAlpha;

    void main() {
      float t = clamp(uProgress, 0.0, 1.08);
      float t2 = t * t;
      float t3 = t2 * t;
      float h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
      float h10 = t3 - 2.0 * t2 + t;
      float h01 = -2.0 * t3 + 3.0 * t2;
      float h11 = t3 - t2;
      vec3 ecf = h00 * aStart + h10 * aStartVelocity * uSpanSeconds + h01 * aEnd + h11 * aEndVelocity * uSpanSeconds + aCorrection * uCorrectionWeight;
      float radiusKm = length(ecf);
      float altitude = max(0.0, radiusKm - 6378.137);
      float radial = 1.0 + min(0.82, log(1.0 + altitude / 350.0) * 0.17);
      vec3 point = vec3(ecf.x, ecf.z, ecf.y) / max(radiusKm, 1.0) * radial;
      float cy = cos(uYaw);
      float sy = sin(uYaw);
      float cp = cos(uPitch);
      float sp = sin(uPitch);
      float x1 = point.x * cy - point.z * sy;
      float z1 = point.x * sy + point.z * cy;
      float y2 = point.y * cp - z1 * sp;
      float z2 = point.y * sp + z1 * cp;
      vec2 projected = vec2(-x1 * uProjectionScale.x, y2 * uProjectionScale.y);
      gl_Position = vec4(projected.x, projected.y + 0.02, 0.0, 1.0);
      float normalSize = 1.35 + log2(max(2.0, uDisplayScale)) * 0.58;
      gl_PointSize = (aSelected > 0.5 ? normalSize + 7.0 + uPulse * 2.0 : normalSize) * uPixelRatio;
      bool earthOccluded = z2 < 0.0 && length(vec2(x1, y2)) < 1.01;
      vAlpha = earthOccluded ? 0.0 : (z2 < 0.0 ? 0.18 : 1.0);
      if (uHasSelection > 0.5 && aSelected < 0.5) vAlpha *= 0.38;
      vColor = aColor;
      vSelected = aSelected;
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec3 vColor;
    in float vSelected;
    in float vAlpha;
    out vec4 outColor;

    void main() {
      if (vAlpha <= 0.0) discard;
      float distanceFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
      if (distanceFromCenter > 1.0) discard;
      vec3 color = vColor;
      float edge = 1.0 - smoothstep(0.72, 1.0, distanceFromCenter);
      if (vSelected > 0.5 && distanceFromCenter > 0.56) {
        outColor = vec4(vec3(0.757, 1.0, 0.447), vAlpha * smoothstep(1.0, 0.76, distanceFromCenter));
      } else {
        vec3 core = vSelected > 0.5 ? mix(color, vec3(1.0), 0.74) : color;
        float glow = vSelected > 0.5 ? 1.18 : 0.78 + edge * 0.22;
        outColor = vec4(core * glow, vAlpha * edge);
      }
    }
  `);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Orbit shader link failed", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function geoToVector(position: GeoPosition): Vector3 {
  const latitude = degreesToRadians(position.lat);
  const longitude = degreesToRadians(position.lon);
  const radius = 1 + position.altitude / earthRadiusKm;
  return {
    x: Math.cos(latitude) * Math.cos(longitude) * radius,
    y: Math.sin(latitude) * radius,
    z: Math.cos(latitude) * Math.sin(longitude) * radius,
  };
}

function vectorToGeo(vector: Vector3, sample: GeoPosition): GeoPosition {
  const radius = Math.hypot(vector.x, vector.y, vector.z);
  return {
    ...sample,
    lat: Math.asin(vector.y / radius) * 180 / Math.PI,
    lon: Math.atan2(vector.z, vector.x) * 180 / Math.PI,
    altitude: (radius - 1) * earthRadiusKm,
  };
}

function addVector(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtractVector(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaleVector(vector: Vector3, amount: number): Vector3 {
  return { x: vector.x * amount, y: vector.y * amount, z: vector.z * amount };
}

function renderedVector(state: MotionState, simulationMs: number, wallTimestamp: number): Vector3 {
  const predicted = addVector(state.vector, scaleVector(state.velocity, simulationMs - state.sampleAt));
  const progress = Math.max(0, Math.min(1, (wallTimestamp - state.correctionAt) / 1200));
  return addVector(predicted, scaleVector(state.correction, (1 - progress) ** 3));
}

function sampleEntries(entries: SatelliteEntry[], maximum: number) {
  if (entries.length <= maximum) return entries;
  const step = entries.length / maximum;
  return Array.from({ length: maximum }, (_, index) => entries[Math.floor(index * step)]);
}

function findNextPass(entry: SatelliteEntry, observer: Observer, start: Date): PassPrediction | null {
  const satrec = satrecFor(entry);
  if (!satrec) return null;
  const observerGd = {
    latitude: degreesToRadians(observer.lat),
    longitude: degreesToRadians(observer.lon),
    height: 0.05,
  };
  let inPass = false;
  let peak = -90;
  let peakAzimuth = 0;
  let peakTime = start;

  for (let step = 0; step <= 240; step += 1) {
    const time = new Date(start.getTime() + step * 3 * 60000);
    const result = propagate(satrec, time);
    if (!result) continue;
    const look = ecfToLookAngles(observerGd, eciToEcf(result.position, gstime(time)));
    const elevation = look.elevation * 180 / Math.PI;
    if (elevation >= 10) {
      inPass = true;
      if (elevation > peak) {
        peak = elevation;
        peakTime = time;
        peakAzimuth = look.azimuth * 180 / Math.PI;
      }
    } else if (inPass) {
      return { id: entry.id, name: entry.name, time: peakTime, maxElevation: peak, azimuth: peakAzimuth };
    }
  }
  return inPass ? { id: entry.id, name: entry.name, time: peakTime, maxElevation: peak, azimuth: peakAzimuth } : null;
}

function categoryColor(category: SatelliteEntry["category"]) {
  return {
    station: "#c1ff72",
    starlink: "#72a8ff",
    weather: "#61e9ed",
    navigation: "#c395ff",
    science: "#ffd66b",
    other: "#aab9be",
  }[category];
}

function OrbitCanvas({
  entries,
  selectedId,
  displayScale,
  timeOffset,
  pausedAt,
  observer,
  focusNonce,
  focusPosition,
  locale,
  onSelect,
}: {
  entries: SatelliteEntry[];
  selectedId: number | null;
  displayScale: number;
  timeOffset: number;
  pausedAt: number | null;
  observer: Observer;
  focusNonce: number;
  focusPosition: GeoPosition | null;
  locale: Locale;
  onSelect: (id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef({ yaw: Math.PI / 2 - degreesToRadians(126.98), pitch: degreesToRadians(20), zoom: 1 });
  const focusPositionRef = useRef(focusPosition);
  const pointsRef = useRef<GeoPosition[]>([]);
  const motionRef = useRef<Map<number, MotionState>>(new Map());
  const hitPointsRef = useRef<Array<{ id: number; x: number; y: number; distance: number }>>([]);
  const pointerRef = useRef({ active: false, moved: false, x: 0, y: 0, yaw: 0, pitch: 0 });

  useEffect(() => {
    focusPositionRef.current = focusPosition;
  }, [focusPosition]);

  useEffect(() => {
    const position = focusPositionRef.current;
    if (!position) return;
    cameraRef.current.yaw = Math.PI / 2 - degreesToRadians(position.lon);
    cameraRef.current.pitch = degreesToRadians(position.lat);
  }, [focusNonce]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animationFrame = 0;
    let lastPropagation = 0;
    let selectedTrail: GeoPosition[] = [];

    const simulationDate = () => new Date((pausedAt ?? Date.now()) + timeOffset * 60000);

    const refreshPositions = (wallTimestamp: number) => {
      const date = simulationDate();
      const simulationMs = date.getTime();
      const nextMotion = new Map<number, MotionState>();

      entries.forEach((entry) => {
        const measured = propagateEntry(entry, date);
        if (!measured) return;
        const vector = geoToVector(measured);
        const prior = motionRef.current.get(entry.id);
        const elapsed = prior ? simulationMs - prior.sampleAt : 0;

        if (prior && elapsed > 16 && Math.abs(elapsed) < 10000) {
          const predictionAtMeasurement = renderedVector(prior, simulationMs, wallTimestamp);
          const observedVelocity = scaleVector(subtractVector(vector, prior.vector), 1 / elapsed);
          const velocity = addVector(scaleVector(observedVelocity, 0.78), scaleVector(prior.velocity, 0.22));
          nextMotion.set(entry.id, {
            sample: measured,
            vector,
            velocity,
            sampleAt: simulationMs,
            correction: subtractVector(predictionAtMeasurement, vector),
            correctionAt: wallTimestamp,
          });
          return;
        }

        const previous = propagateEntry(entry, new Date(simulationMs - 2500));
        const previousVector = previous ? geoToVector(previous) : vector;
        nextMotion.set(entry.id, {
          sample: measured,
          vector,
          velocity: scaleVector(subtractVector(vector, previousVector), 1 / 2500),
          sampleAt: simulationMs,
          correction: { x: 0, y: 0, z: 0 },
          correctionAt: wallTimestamp,
        });
      });

      motionRef.current = nextMotion;
      const selected = entries.find((entry) => entry.id === selectedId);
      selectedTrail = selected
        ? Array.from({ length: 49 }, (_, index) => propagateEntry(selected, new Date(date.getTime() + (index - 16) * 3 * 60000))).filter((point): point is GeoPosition => point !== null)
        : [];
    };

    const rotatePoint = (lat: number, lon: number, radial = 1) => {
      const latitude = degreesToRadians(lat);
      const longitude = degreesToRadians(lon);
      const x = Math.cos(latitude) * Math.cos(longitude) * radial;
      const y = Math.sin(latitude) * radial;
      const z = Math.cos(latitude) * Math.sin(longitude) * radial;
      const { yaw, pitch } = cameraRef.current;
      const x1 = x * Math.cos(yaw) - z * Math.sin(yaw);
      const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
      const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
      return { x: -x1, y: y2, z: z2 };
    };

    const draw = (timestamp: number) => {
      if (!pausedAt && (timestamp - lastPropagation > 2500 || pointsRef.current.length === 0)) {
        refreshPositions(timestamp);
        lastPropagation = timestamp;
      } else if (pointsRef.current.length === 0) {
        refreshPositions(timestamp);
      }

      const simulationMs = simulationDate().getTime();
      pointsRef.current = [...motionRef.current.values()].map((state) => vectorToGeo(renderedVector(state, simulationMs, timestamp), state.sample));

      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const centerX = width * 0.5;
      const centerY = height * 0.49;
      const earthRadius = Math.min(width, height) * 0.31 * cameraRef.current.zoom;
      const project = (point: { x: number; y: number; z: number }) => ({
        x: centerX + point.x * earthRadius,
        y: centerY - point.y * earthRadius,
        z: point.z,
      });

      const sky = context.createRadialGradient(centerX, centerY, earthRadius * 0.4, centerX, centerY, earthRadius * 2.8);
      sky.addColorStop(0, "rgba(20, 117, 121, .15)");
      sky.addColorStop(0.45, "rgba(10, 45, 62, .08)");
      sky.addColorStop(1, "rgba(3, 6, 9, 0)");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);

      const projected = pointsRef.current.map((point) => {
        const compressedAltitude = 1 + Math.min(0.82, Math.log1p(Math.max(0, point.altitude) / 350) * 0.17);
        return { point, screen: project(rotatePoint(point.lat, point.lon, compressedAltitude)) };
      });

      const drawSatellite = (item: typeof projected[number], behind: boolean) => {
        const { point, screen } = item;
        const selected = point.id === selectedId;
        const size = selected ? 4.5 + Math.log10(displayScale) * 1.7 : 1.25 + Math.log10(displayScale) * 0.62;
        const color = categoryColor(point.category);
        context.beginPath();
        context.arc(screen.x, screen.y, size, 0, Math.PI * 2);
        context.fillStyle = behind ? "rgba(141, 168, 177, .16)" : color;
        context.shadowColor = behind ? "transparent" : color;
        context.shadowBlur = selected ? 20 : Math.min(10, size * 2);
        context.fill();
        context.shadowBlur = 0;
        if (selected && !behind) {
          context.beginPath();
          context.arc(screen.x, screen.y, size + 9, 0, Math.PI * 2);
          context.strokeStyle = color;
          context.lineWidth = 1;
          context.stroke();
        }
      };

      projected.filter(({ screen }) => screen.z < 0 && Math.hypot(screen.x - centerX, screen.y - centerY) > earthRadius).forEach((item) => drawSatellite(item, true));

      const earth = context.createRadialGradient(centerX - earthRadius * 0.42, centerY - earthRadius * 0.5, earthRadius * 0.08, centerX, centerY, earthRadius * 1.08);
      earth.addColorStop(0, "#2a7283");
      earth.addColorStop(0.38, "#164b5e");
      earth.addColorStop(0.72, "#0a2838");
      earth.addColorStop(1, "#02070b");
      context.beginPath();
      context.arc(centerX, centerY, earthRadius, 0, Math.PI * 2);
      context.fillStyle = earth;
      context.fill();
      context.strokeStyle = "rgba(107, 238, 218, .46)";
      context.lineWidth = 1.2;
      context.stroke();

      context.save();
      context.beginPath();
      context.arc(centerX, centerY, earthRadius - 1, 0, Math.PI * 2);
      context.clip();
      context.strokeStyle = "rgba(110, 227, 213, .17)";
      context.lineWidth = 0.7;

      const drawGeoLine = (points: Array<{ lat: number; lon: number }>) => {
        let penDown = false;
        context.beginPath();
        points.forEach((point) => {
          const rotated = rotatePoint(point.lat, point.lon, 1.002);
          const screen = project(rotated);
          if (rotated.z <= 0) {
            penDown = false;
            return;
          }
          if (!penDown) context.moveTo(screen.x, screen.y);
          else context.lineTo(screen.x, screen.y);
          penDown = true;
        });
        context.stroke();
      };

      for (let lat = -60; lat <= 60; lat += 30) {
        drawGeoLine(Array.from({ length: 73 }, (_, index) => ({ lat, lon: -180 + index * 5 })));
      }
      for (let lon = -150; lon <= 180; lon += 30) {
        drawGeoLine(Array.from({ length: 37 }, (_, index) => ({ lat: -90 + index * 5, lon })));
      }

      const shade = context.createLinearGradient(centerX - earthRadius, centerY, centerX + earthRadius, centerY);
      shade.addColorStop(0, "rgba(0, 2, 6, .02)");
      shade.addColorStop(0.6, "rgba(0, 2, 6, .14)");
      shade.addColorStop(1, "rgba(0, 2, 6, .85)");
      context.fillStyle = shade;
      context.fillRect(centerX - earthRadius, centerY - earthRadius, earthRadius * 2, earthRadius * 2);
      context.restore();

      if (selectedTrail.length > 1) {
        context.beginPath();
        let penDown = false;
        selectedTrail.forEach((point) => {
          const radial = 1 + Math.min(0.82, Math.log1p(Math.max(0, point.altitude) / 350) * 0.17);
          const rotated = rotatePoint(point.lat, point.lon, radial);
          const screen = project(rotated);
          const occluded = rotated.z < 0 && Math.hypot(screen.x - centerX, screen.y - centerY) < earthRadius;
          if (occluded) {
            penDown = false;
            return;
          }
          if (!penDown) context.moveTo(screen.x, screen.y);
          else context.lineTo(screen.x, screen.y);
          penDown = true;
        });
        context.strokeStyle = "rgba(193, 255, 114, .56)";
        context.lineWidth = 1.25;
        context.stroke();
      }

      const observerSurface = rotatePoint(observer.lat, observer.lon, 1.006);
      if (observerSurface.z > 0) {
        const observerScreen = project(observerSurface);
        context.beginPath();
        context.arc(observerScreen.x, observerScreen.y, 3.2, 0, Math.PI * 2);
        context.fillStyle = "#ffcf72";
        context.shadowColor = "#ffcf72";
        context.shadowBlur = 14;
        context.fill();
        context.shadowBlur = 0;
      }

      const front = projected.filter(({ screen }) => screen.z >= 0 || Math.hypot(screen.x - centerX, screen.y - centerY) > earthRadius);
      front.forEach((item) => drawSatellite(item, false));
      hitPointsRef.current = front.map(({ point, screen }) => ({ id: point.id, x: screen.x, y: screen.y, distance: screen.z }));

      const selectedPoint = projected.find(({ point }) => point.id === selectedId);
      if (selectedPoint && selectedPoint.screen.z >= 0) {
        const label = selectedPoint.point.name;
        context.font = "600 10px var(--font-geist-mono), monospace";
        const labelWidth = Math.min(180, context.measureText(label).width + 18);
        const x = Math.min(width - labelWidth - 10, selectedPoint.screen.x + 17);
        const y = Math.max(24, selectedPoint.screen.y - 14);
        context.fillStyle = "rgba(5, 10, 14, .88)";
        context.fillRect(x, y - 14, labelWidth, 25);
        context.fillStyle = "#dfffc0";
        context.fillText(label.slice(0, 24), x + 9, y + 3);
      }

      if (!reducedMotion) animationFrame = requestAnimationFrame(draw);
    };

    const initialTimestamp = performance.now();
    refreshPositions(initialTimestamp);
    draw(initialTimestamp);

    const pointerDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      pointerRef.current = { active: true, moved: false, x: event.clientX, y: event.clientY, yaw: cameraRef.current.yaw, pitch: cameraRef.current.pitch };
    };
    const pointerMove = (event: PointerEvent) => {
      if (!pointerRef.current.active) return;
      const dx = event.clientX - pointerRef.current.x;
      const dy = event.clientY - pointerRef.current.y;
      if (Math.hypot(dx, dy) > 5) pointerRef.current.moved = true;
      cameraRef.current.yaw = pointerRef.current.yaw + dx * 0.006;
      cameraRef.current.pitch = Math.max(-1.15, Math.min(1.15, pointerRef.current.pitch + dy * 0.005));
      if (reducedMotion) draw(performance.now());
    };
    const pointerUp = (event: PointerEvent) => {
      if (!pointerRef.current.moved) {
        const bounds = canvas.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        const target = hitPointsRef.current
          .map((point) => ({ ...point, clickDistance: Math.hypot(point.x - x, point.y - y) }))
          .filter((point) => point.clickDistance < 24)
          .sort((a, b) => a.clickDistance - b.clickDistance)[0];
        if (target) onSelect(target.id);
      }
      pointerRef.current.active = false;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.72, Math.min(1.35, cameraRef.current.zoom - event.deltaY * 0.0005));
      if (reducedMotion) draw(performance.now());
    };

    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [entries, selectedId, displayScale, timeOffset, pausedAt, observer, onSelect]);

  return <canvas ref={canvasRef} className="live-globe" role="img" aria-label={messages[locale]["globe.aria"]} />;
}

function OrbitCanvasGpu({
  entries,
  selectedId,
  displayScale,
  colorMode,
  riskIds,
  timeOffset,
  pausedAt,
  observer,
  focusNonce,
  focusPosition,
  locale,
  onSelect,
}: {
  entries: SatelliteEntry[];
  selectedId: number | null;
  displayScale: number;
  colorMode: ColorMode;
  riskIds: number[];
  timeOffset: number;
  pausedAt: number | null;
  observer: Observer;
  focusNonce: number;
  focusPosition: GeoPosition | null;
  locale: Locale;
  onSelect: (id: number) => void;
}) {
  const [canvasFallback, setCanvasFallback] = useState(false);
  const [frameSource, setFrameSource] = useState<"connecting" | "resyncing" | "server" | "browser">("connecting");
  const [motionFps, setMotionFps] = useState(0);
  const earthCanvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<OrbitSnapshot | null>(null);
  const cameraRef = useRef({ yaw: Math.PI / 2 - degreesToRadians(126.98), pitch: degreesToRadians(20), zoom: 1 });
  const focusPositionRef = useRef(focusPosition);
  const pointerRef = useRef({ active: false, moved: false, x: 0, y: 0, yaw: 0, pitch: 0 });
  const hardResetRef = useRef(true);
  const refreshFrameRef = useRef<(() => void) | null>(null);
  const selectedIdRef = useRef(selectedId);
  const displayScaleRef = useRef(displayScale);
  const colorModeRef = useRef(colorMode);
  const riskIdsRef = useRef(riskIds);
  const timeOffsetRef = useRef(timeOffset);
  const pausedAtRef = useRef(pausedAt);
  const observerRef = useRef(observer);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    displayScaleRef.current = displayScale;
    colorModeRef.current = colorMode;
    riskIdsRef.current = riskIds;
    timeOffsetRef.current = timeOffset;
    pausedAtRef.current = pausedAt;
    observerRef.current = observer;
    onSelectRef.current = onSelect;
  }, [selectedId, displayScale, colorMode, riskIds, timeOffset, pausedAt, observer, onSelect]);

  useEffect(() => {
    focusPositionRef.current = focusPosition;
  }, [focusPosition]);

  useEffect(() => {
    const position = focusPositionRef.current;
    if (!position) return;
    cameraRef.current.yaw = Math.PI / 2 - degreesToRadians(position.lon);
    cameraRef.current.pitch = degreesToRadians(position.lat);
  }, [focusNonce]);

  useEffect(() => {
    hardResetRef.current = true;
    workerRef.current?.postMessage({ type: "control", offsetMs: timeOffset * 60000, pausedAt });
    refreshFrameRef.current?.();
  }, [timeOffset, pausedAt]);

  useEffect(() => {
    const earthCanvas = earthCanvasRef.current;
    const glCanvas = glCanvasRef.current;
    if (canvasFallback || !earthCanvas || !glCanvas) return;
    const context = earthCanvas.getContext("2d");
    const gl = glCanvas.getContext("webgl2", { alpha: true, antialias: false, depth: false, premultipliedAlpha: true });
    if (!context || !gl) {
      setCanvasFallback(true);
      return;
    }
    const program = createOrbitProgram(gl);
    if (!program) {
      setCanvasFallback(true);
      return;
    }

    const vao = gl.createVertexArray();
    const startBuffer = gl.createBuffer();
    const endBuffer = gl.createBuffer();
    const startVelocityBuffer = gl.createBuffer();
    const endVelocityBuffer = gl.createBuffer();
    const correctionBuffer = gl.createBuffer();
    const colorBuffer = gl.createBuffer();
    const selectedBuffer = gl.createBuffer();
    if (!vao || !startBuffer || !endBuffer || !startVelocityBuffer || !endVelocityBuffer || !correctionBuffer || !colorBuffer || !selectedBuffer) {
      setCanvasFallback(true);
      gl.deleteProgram(program);
      return;
    }

    const selectedFlags = new Float32Array(entries.length);
    const entryIndex = new Map(entries.map((entry, index) => [entry.id, index]));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hidden = document.visibilityState === "hidden";
    let hiddenAt = hidden ? Date.now() : null;
    let lastActiveWallTime = Date.now();
    let animationFrame = 0;
    let lastReducedFrame = 0;
    let lastSelectedId: number | null | undefined;
    let lastColorSignature = "";
    let selectedTrail: GeoPosition[] = [];
    let trailKey = "";
    let mapCache: null | { key: string; land: Path2D; coastline: Path2D; borders: Path2D; graticule: Path2D } = null;
    let detailedWorld: ReturnType<typeof worldLayers> | null = null;
    let mapDataCancelled = false;
    let lastMapBuild = 0;
    let lowDetailUntil = 0;
    let fpsWindowStarted = performance.now();
    let fpsFrames = 0;

    void fetch(world50Url)
      .then((response) => {
        if (!response.ok) throw new Error("Detailed world map unavailable");
        return response.json() as Promise<unknown>;
      })
      .then((source) => {
        if (mapDataCancelled) return;
        detailedWorld = worldLayers(source);
        mapCache = null;
      })
      .catch(() => {
        detailedWorld = null;
      });

    gl.bindVertexArray(vao);
    const bindAttribute = (name: string, size: number, buffer: WebGLBuffer) => {
      const location = gl.getAttribLocation(program, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    };
    bindAttribute("aStart", 3, startBuffer);
    bindAttribute("aEnd", 3, endBuffer);
    bindAttribute("aStartVelocity", 3, startVelocityBuffer);
    bindAttribute("aEndVelocity", 3, endVelocityBuffer);
    bindAttribute("aCorrection", 3, correctionBuffer);
    bindAttribute("aColor", 3, colorBuffer);
    bindAttribute("aSelected", 1, selectedBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, entries.length * 3 * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, selectedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, selectedFlags, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const simulationMs = () => (pausedAtRef.current ?? Date.now()) + timeOffsetRef.current * 60000;

    const rotateGeo = (lat: number, lon: number, radial = 1) => {
      const latitude = degreesToRadians(lat);
      const longitude = degreesToRadians(lon);
      const x = Math.cos(latitude) * Math.cos(longitude) * radial;
      const y = Math.sin(latitude) * radial;
      const z = Math.cos(latitude) * Math.sin(longitude) * radial;
      const { yaw, pitch } = cameraRef.current;
      const x1 = x * Math.cos(yaw) - z * Math.sin(yaw);
      const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
      return {
        x: -x1,
        y: y * Math.cos(pitch) - z1 * Math.sin(pitch),
        z: y * Math.sin(pitch) + z1 * Math.cos(pitch),
      };
    };

    const pointFromSnapshot = (index: number, at: number, timestamp: number) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || index < 0 || index >= snapshot.count) return null;
      const span = snapshot.endTime - snapshot.startTime;
      const progress = span > 0 ? Math.max(0, Math.min(1.08, (at - snapshot.startTime) / span)) : 0;
      const ease = Math.max(0, Math.min(1, (timestamp - snapshot.receivedAt) / 1200));
      const correctionWeight = (1 - ease) ** 3;
      const offset = index * 3;
      const spanSeconds = span / 1000;
      const progress2 = progress * progress;
      const progress3 = progress2 * progress;
      const h00 = 2 * progress3 - 3 * progress2 + 1;
      const h10 = progress3 - 2 * progress2 + progress;
      const h01 = -2 * progress3 + 3 * progress2;
      const h11 = progress3 - progress2;
      const sampleAxis = (axis: number) => h00 * snapshot.startPositions[offset + axis]
        + h10 * snapshot.startVelocities[offset + axis] * spanSeconds
        + h01 * snapshot.endPositions[offset + axis]
        + h11 * snapshot.endVelocities[offset + axis] * spanSeconds
        + snapshot.correction[offset + axis] * correctionWeight;
      const x = sampleAxis(0);
      const y = sampleAxis(1);
      const z = sampleAxis(2);
      const radiusKm = Math.hypot(x, y, z);
      if (!Number.isFinite(radiusKm) || radiusKm < 1) return null;
      const radial = 1 + Math.min(0.82, Math.log1p(Math.max(0, radiusKm - earthRadiusKm) / 350) * 0.17);
      const pointX = x / radiusKm * radial;
      const pointY = z / radiusKm * radial;
      const pointZ = y / radiusKm * radial;
      const { yaw, pitch } = cameraRef.current;
      const x1 = pointX * Math.cos(yaw) - pointZ * Math.sin(yaw);
      const z1 = pointX * Math.sin(yaw) + pointZ * Math.cos(yaw);
      return {
        x: -x1,
        y: pointY * Math.cos(pitch) - z1 * Math.sin(pitch),
        z: pointY * Math.sin(pitch) + z1 * Math.cos(pitch),
      };
    };

    const resize = () => {
      const bounds = earthCanvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (earthCanvas.width !== pixelWidth || earthCanvas.height !== pixelHeight) {
        earthCanvas.width = pixelWidth;
        earthCanvas.height = pixelHeight;
      }
      if (glCanvas.width !== pixelWidth || glCanvas.height !== pixelHeight) {
        glCanvas.width = pixelWidth;
        glCanvas.height = pixelHeight;
      }
      return { width, height, ratio };
    };

    const mapPathsFor = (timestamp: number, centerX: number, centerY: number, radius: number) => {
      const lowDetail = pointerRef.current.active || timestamp < lowDetailUntil || !detailedWorld;
      const detail = lowDetail ? "110m" : "50m";
      const longitude = 90 - cameraRef.current.yaw * 180 / Math.PI;
      const latitude = cameraRef.current.pitch * 180 / Math.PI;
      const key = [
        detail,
        Math.round(centerX),
        Math.round(centerY),
        Math.round(radius * 2) / 2,
        Math.round(longitude * 4) / 4,
        Math.round(latitude * 4) / 4,
      ].join(":");
      if (mapCache?.key === key) return mapCache;
      if (lowDetail && mapCache && timestamp - lastMapBuild < 190) return mapCache;

      const layers = lowDetail ? world110 : detailedWorld;
      const projection = geoOrthographic()
        .translate([centerX, centerY])
        .scale(radius)
        .rotate([-longitude, -latitude])
        .reflectX(false)
        .clipAngle(90)
        .precision(lowDetail ? 0.55 : 0.28);
      const path = geoPath(projection);
      mapCache = {
        key,
        land: new Path2D(path(layers.land) ?? ""),
        coastline: new Path2D(path(layers.coastline) ?? ""),
        borders: new Path2D(path(layers.borders) ?? ""),
        graticule: new Path2D(path(worldGraticule) ?? ""),
      };
      lastMapBuild = timestamp;
      return mapCache;
    };

    const drawEarth = (timestamp: number, at: number, width: number, height: number, ratio: number) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const centerX = width * 0.5;
      const centerY = height * 0.49;
      const radius = Math.min(width, height) * 0.31 * cameraRef.current.zoom;
      const project = (point: { x: number; y: number; z: number }) => ({ x: centerX + point.x * radius, y: centerY - point.y * radius, z: point.z });

      const sky = context.createRadialGradient(centerX, centerY, radius * 0.4, centerX, centerY, radius * 2.8);
      sky.addColorStop(0, "rgba(20, 117, 121, .15)");
      sky.addColorStop(0.45, "rgba(10, 45, 62, .08)");
      sky.addColorStop(1, "rgba(3, 6, 9, 0)");
      context.fillStyle = sky;
      context.fillRect(0, 0, width, height);

      const earth = context.createRadialGradient(centerX - radius * 0.42, centerY - radius * 0.5, radius * 0.08, centerX, centerY, radius * 1.08);
      earth.addColorStop(0, "#2a7283");
      earth.addColorStop(0.38, "#164b5e");
      earth.addColorStop(0.72, "#0a2838");
      earth.addColorStop(1, "#02070b");
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fillStyle = earth;
      context.fill();
      context.strokeStyle = "rgba(107, 238, 218, .46)";
      context.lineWidth = 1.2;
      context.stroke();

      context.save();
      context.beginPath();
      context.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
      context.clip();
      const mapPaths = mapPathsFor(timestamp, centerX, centerY, radius);
      context.strokeStyle = "rgba(110, 227, 213, .17)";
      context.lineWidth = 0.7;
      context.stroke(mapPaths.graticule);
      const land = context.createLinearGradient(centerX - radius, centerY - radius, centerX + radius, centerY + radius);
      land.addColorStop(0, "rgba(72, 132, 114, .96)");
      land.addColorStop(0.5, "rgba(31, 90, 82, .94)");
      land.addColorStop(1, "rgba(12, 48, 55, .94)");
      context.fillStyle = land;
      context.fill(mapPaths.land);
      context.strokeStyle = "rgba(205, 255, 220, .72)";
      context.lineWidth = 1.05;
      context.stroke(mapPaths.coastline);
      context.strokeStyle = "rgba(173, 239, 215, .27)";
      context.lineWidth = 0.55;
      context.stroke(mapPaths.borders);
      const shade = context.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY);
      shade.addColorStop(0, "rgba(0, 2, 6, .02)");
      shade.addColorStop(0.6, "rgba(0, 2, 6, .14)");
      shade.addColorStop(1, "rgba(0, 2, 6, .85)");
      context.fillStyle = shade;
      context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
      context.restore();

      context.save();
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = "600 7px ui-monospace, SFMono-Regular, Menlo, monospace";
      continentLabels.forEach((item) => {
        const rotated = rotateGeo(item.lat, item.lon, 1.004);
        if (rotated.z < 0.34) return;
        const screen = project(rotated);
        const labelWidth = context.measureText(item.label).width + 9;
        context.fillStyle = "rgba(3, 13, 17, .56)";
        context.fillRect(screen.x - labelWidth / 2, screen.y - 6, labelWidth, 12);
        context.fillStyle = "rgba(202, 243, 220, .68)";
        context.fillText(item.label, screen.x, screen.y + 0.5);
      });
      context.restore();

      if (selectedTrail.length > 1) {
        context.beginPath();
        let penDown = false;
        selectedTrail.forEach((position) => {
          const radial = 1 + Math.min(0.82, Math.log1p(Math.max(0, position.altitude) / 350) * 0.17);
          const rotated = rotateGeo(position.lat, position.lon, radial);
          const screen = project(rotated);
          if (rotated.z < 0 && Math.hypot(rotated.x, rotated.y) < 1) {
            penDown = false;
            return;
          }
          if (penDown) context.lineTo(screen.x, screen.y);
          else context.moveTo(screen.x, screen.y);
          penDown = true;
        });
        context.strokeStyle = "rgba(193, 255, 114, .56)";
        context.lineWidth = 1.25;
        context.stroke();
      }

      const currentObserver = observerRef.current;
      const observerPoint = rotateGeo(currentObserver.lat, currentObserver.lon, 1.006);
      if (observerPoint.z > 0) {
        const screen = project(observerPoint);
        context.beginPath();
        context.arc(screen.x, screen.y, 3.2, 0, Math.PI * 2);
        context.fillStyle = "#ffcf72";
        context.shadowColor = "#ffcf72";
        context.shadowBlur = 14;
        context.fill();
        context.shadowBlur = 0;
        context.font = "600 8px ui-monospace, monospace";
        context.fillStyle = "rgba(255, 207, 114, .92)";
        context.fillText(currentObserver.label === "MY LOCATION" ? "YOU" : currentObserver.label.slice(0, 12), screen.x + 8, screen.y - 7);
      }

      const selectedIndex = selectedIdRef.current === null ? undefined : entryIndex.get(selectedIdRef.current);
      const selectedPoint = selectedIndex === undefined ? null : pointFromSnapshot(selectedIndex, at, timestamp);
      if (selectedPoint && selectedPoint.z >= 0) {
        const screen = project(selectedPoint);
        const groundPosition = focusPositionRef.current;
        if (groundPosition) {
          const groundPoint = rotateGeo(groundPosition.lat, groundPosition.lon, 1.008);
          if (groundPoint.z > 0) {
            const groundScreen = project(groundPoint);
            context.save();
            context.setLineDash([3, 4]);
            context.beginPath();
            context.moveTo(groundScreen.x, groundScreen.y);
            context.lineTo(screen.x, screen.y);
            context.strokeStyle = "rgba(193, 255, 114, .45)";
            context.lineWidth = 0.85;
            context.stroke();
            context.restore();
            context.beginPath();
            context.arc(groundScreen.x, groundScreen.y, 2.2, 0, Math.PI * 2);
            context.fillStyle = "#c1ff72";
            context.fill();
          }
        }
        const label = entries[selectedIndex!].name;
        context.font = "600 10px ui-monospace, monospace";
        const labelWidth = Math.min(180, context.measureText(label).width + 18);
        const x = Math.min(width - labelWidth - 10, screen.x + 17);
        const y = Math.max(24, screen.y - 14);
        context.fillStyle = "rgba(5, 10, 14, .88)";
        context.fillRect(x, y - 14, labelWidth, 25);
        context.fillStyle = "#dfffc0";
        context.fillText(label.slice(0, 24), x + 9, y + 3);
      }
    };

    const drawWebGl = (timestamp: number, at: number, width: number, height: number, ratio: number) => {
      gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const snapshot = snapshotRef.current;
      if (!snapshot) return;

      const colorSignature = `${colorModeRef.current}:${riskIdsRef.current.join(",")}`;
      if (colorSignature !== lastColorSignature) {
        const riskSet = new Set(riskIdsRef.current);
        const colors = new Float32Array(entries.length * 3);
        entries.forEach((entry, index) => colors.set(satelliteColor(entry, colorModeRef.current, riskSet), index * 3));
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
        lastColorSignature = colorSignature;
      }

      if (lastSelectedId !== selectedIdRef.current) {
        selectedFlags.fill(0);
        const selectedIndex = selectedIdRef.current === null ? undefined : entryIndex.get(selectedIdRef.current);
        if (selectedIndex !== undefined) selectedFlags[selectedIndex] = 1;
        gl.bindBuffer(gl.ARRAY_BUFFER, selectedBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, selectedFlags);
        lastSelectedId = selectedIdRef.current;
      }

      const span = snapshot.endTime - snapshot.startTime;
      const progress = span > 0 ? Math.max(0, Math.min(1.08, (at - snapshot.startTime) / span)) : 0;
      const ease = Math.max(0, Math.min(1, (timestamp - snapshot.receivedAt) / 1200));
      const radius = Math.min(width, height) * 0.31 * cameraRef.current.zoom;
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform1f(gl.getUniformLocation(program, "uProgress"), progress);
      gl.uniform1f(gl.getUniformLocation(program, "uSpanSeconds"), span / 1000);
      gl.uniform1f(gl.getUniformLocation(program, "uCorrectionWeight"), (1 - ease) ** 3);
      gl.uniform1f(gl.getUniformLocation(program, "uYaw"), cameraRef.current.yaw);
      gl.uniform1f(gl.getUniformLocation(program, "uPitch"), cameraRef.current.pitch);
      gl.uniform1f(gl.getUniformLocation(program, "uDisplayScale"), displayScaleRef.current);
      gl.uniform1f(gl.getUniformLocation(program, "uPixelRatio"), ratio);
      gl.uniform1f(gl.getUniformLocation(program, "uHasSelection"), selectedIdRef.current === null ? 0 : 1);
      gl.uniform1f(gl.getUniformLocation(program, "uPulse"), (Math.sin(timestamp * 0.005) + 1) * 0.5);
      gl.uniform2f(gl.getUniformLocation(program, "uProjectionScale"), radius * 2 / width, radius * 2 / height);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, snapshot.count);
      gl.bindVertexArray(null);
    };

    const uploadSnapshot = (message: Omit<OrbitSnapshot, "correction" | "receivedAt">) => {
      const count = message.startPositions.length / 3;
      if (count !== entries.length || message.endPositions.length !== message.startPositions.length) return;
      const prior = snapshotRef.current;
      const correction = new Float32Array(message.startPositions.length);
      if (!hardResetRef.current && prior && prior.count === count) {
        const oldSpan = prior.endTime - prior.startTime;
        const oldProgress = oldSpan > 0 ? Math.max(0, Math.min(1.08, (message.startTime - prior.startTime) / oldSpan)) : 0;
        const oldProgress2 = oldProgress * oldProgress;
        const oldProgress3 = oldProgress2 * oldProgress;
        const h00 = 2 * oldProgress3 - 3 * oldProgress2 + 1;
        const h10 = oldProgress3 - 2 * oldProgress2 + oldProgress;
        const h01 = -2 * oldProgress3 + 3 * oldProgress2;
        const h11 = oldProgress3 - oldProgress2;
        const oldSpanSeconds = oldSpan / 1000;
        for (let index = 0; index < correction.length; index += 1) {
          const predicted = h00 * prior.startPositions[index]
            + h10 * prior.startVelocities[index] * oldSpanSeconds
            + h01 * prior.endPositions[index]
            + h11 * prior.endVelocities[index] * oldSpanSeconds;
          const delta = predicted - message.startPositions[index];
          correction[index] = Number.isFinite(delta) ? delta : 0;
        }
      }
      hardResetRef.current = false;
      snapshotRef.current = {
        startPositions: message.startPositions,
        endPositions: message.endPositions,
        startVelocities: message.startVelocities,
        endVelocities: message.endVelocities,
        correction,
        startTime: message.startTime,
        endTime: message.endTime,
        receivedAt: performance.now(),
        count,
        source: message.source,
      };
      setFrameSource(message.source);
      gl.bindBuffer(gl.ARRAY_BUFFER, startBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.startPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, endBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.endPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, startVelocityBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.startVelocities, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, endVelocityBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.endVelocities, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, correctionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, correction, gl.DYNAMIC_DRAW);
    };

    const worker = new Worker(new URL("./orbit.worker.ts", import.meta.url), { type: "module", name: "orbit-sgp4" });
    workerRef.current = worker;
    snapshotRef.current = null;
    hardResetRef.current = true;
    let workerStarted = false;
    let serverHealthy = false;
    let requestSequence = 0;
    let serverTimer = 0;
    const abortController = new AbortController();

    const startBrowserFallback = () => {
      if (workerStarted) {
        worker.postMessage({ type: "visibility", active: !hidden });
        return;
      }
      workerStarted = true;
      worker.postMessage({
        type: "init",
        entries: entries.map((entry) => entry.omm),
        offsetMs: timeOffsetRef.current * 60000,
        pausedAt: pausedAtRef.current,
        active: !hidden,
      });
    };

    worker.onmessage = (event: MessageEvent<WorkerSnapshot>) => {
      if (event.data.type === "snapshot" && !serverHealthy) uploadSnapshot({ ...event.data, count: event.data.startPositions.length / 3, source: "browser" });
    };

    // Populate the globe immediately while the authoritative server frame is in flight.
    // The worker is paused as soon as the server succeeds, so it is only a startup safety net.
    startBrowserFallback();

    const refreshServerFrame = async () => {
      if (hidden || entries.length === 0) return;
      const sequence = ++requestSequence;
      try {
        const at = simulationMs();
        const response = await fetch(`/api/orbits?at=${Math.round(at)}`, { signal: abortController.signal });
        if (!response.ok) throw new Error("Orbit frame unavailable");
        const frame = parseServerFrame(await response.arrayBuffer(), entries);
        if (sequence !== requestSequence) return;
        serverHealthy = true;
        if (workerStarted) worker.postMessage({ type: "visibility", active: false });
        uploadSnapshot(frame);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (sequence !== requestSequence) return;
        serverHealthy = false;
        startBrowserFallback();
        if (error instanceof Error) console.warn("Using browser orbit fallback", error.message);
      }
    };
    refreshFrameRef.current = () => void refreshServerFrame();
    void refreshServerFrame();
    serverTimer = window.setInterval(() => void refreshServerFrame(), 25_000);

    const draw = (timestamp: number) => {
      animationFrame = requestAnimationFrame(draw);
      if (hidden || (reducedMotion && timestamp - lastReducedFrame < 100)) return;
      lastReducedFrame = timestamp;
      fpsFrames += 1;
      if (timestamp - fpsWindowStarted >= 1000) {
        setMotionFps(Math.round(fpsFrames * 1000 / (timestamp - fpsWindowStarted)));
        fpsFrames = 0;
        fpsWindowStarted = timestamp;
      }
      const at = simulationMs();
      lastActiveWallTime = Date.now();
      const nextTrailKey = `${selectedIdRef.current ?? "none"}-${Math.floor(at / 600000)}`;
      if (nextTrailKey !== trailKey) {
        trailKey = nextTrailKey;
        const selectedIndex = selectedIdRef.current === null ? undefined : entryIndex.get(selectedIdRef.current);
        const selected = selectedIndex === undefined ? null : entries[selectedIndex];
        selectedTrail = selected
          ? Array.from({ length: 49 }, (_, index) => propagateEntry(selected, new Date(at + (index - 16) * 3 * 60000))).filter((point): point is GeoPosition => point !== null)
          : [];
      }
      const { width, height, ratio } = resize();
      drawEarth(timestamp, at, width, height, ratio);
      drawWebGl(timestamp, at, width, height, ratio);
    };

    const pointerDown = (event: PointerEvent) => {
      glCanvas.setPointerCapture(event.pointerId);
      pointerRef.current = { active: true, moved: false, x: event.clientX, y: event.clientY, yaw: cameraRef.current.yaw, pitch: cameraRef.current.pitch };
    };
    const pointerMove = (event: PointerEvent) => {
      if (!pointerRef.current.active) return;
      const dx = event.clientX - pointerRef.current.x;
      const dy = event.clientY - pointerRef.current.y;
      if (Math.hypot(dx, dy) > 5) pointerRef.current.moved = true;
      cameraRef.current.yaw = pointerRef.current.yaw + dx * 0.006;
      cameraRef.current.pitch = Math.max(-1.15, Math.min(1.15, pointerRef.current.pitch + dy * 0.005));
      lowDetailUntil = performance.now() + 220;
    };
    const pointerUp = (event: PointerEvent) => {
      if (!pointerRef.current.moved) {
        const bounds = glCanvas.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        const centerX = bounds.width * 0.5;
        const centerY = bounds.height * 0.49;
        const radius = Math.min(bounds.width, bounds.height) * 0.31 * cameraRef.current.zoom;
        const at = simulationMs();
        const timestamp = performance.now();
        const snapshot = snapshotRef.current;
        let bestIndex = -1;
        let bestDistance = 24;
        for (let index = 0; snapshot && index < snapshot.count; index += 1) {
          const point = pointFromSnapshot(index, at, timestamp);
          if (!point || (point.z < 0 && Math.hypot(point.x, point.y) < 1.01)) continue;
          const distance = Math.hypot(centerX + point.x * radius - x, centerY - point.y * radius - y);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
        if (bestIndex >= 0) onSelectRef.current(entries[bestIndex].id);
      }
      pointerRef.current.active = false;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(0.72, Math.min(1.35, cameraRef.current.zoom - event.deltaY * 0.0005));
      lowDetailUntil = performance.now() + 220;
    };
    const resumeFromBackground = (forceHardReset = false) => {
      const now = Date.now();
      const inactiveFor = hiddenAt === null ? Math.max(0, now - lastActiveWallTime) : Math.max(0, now - hiddenAt);
      hiddenAt = null;
      hidden = false;
      fpsFrames = 0;
      fpsWindowStarted = performance.now();
      setMotionFps(0);
      if (forceHardReset || inactiveFor >= 3000) {
        requestSequence += 1;
        hardResetRef.current = true;
        trailKey = "";
        selectedTrail = [];
        setFrameSource("resyncing");
      }
      if (workerStarted) worker.postMessage({ type: "visibility", active: !serverHealthy });
      void refreshServerFrame();
    };
    const visibilityChange = () => {
      hidden = document.visibilityState === "hidden";
      if (hidden) {
        hiddenAt = Date.now();
        requestSequence += 1;
        if (workerStarted) worker.postMessage({ type: "visibility", active: false });
        return;
      }
      resumeFromBackground();
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) resumeFromBackground(true);
    };

    glCanvas.addEventListener("pointerdown", pointerDown);
    glCanvas.addEventListener("pointermove", pointerMove);
    glCanvas.addEventListener("pointerup", pointerUp);
    glCanvas.addEventListener("pointercancel", pointerUp);
    glCanvas.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", visibilityChange);
    window.addEventListener("pageshow", pageShow);
    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      mapDataCancelled = true;
      window.clearInterval(serverTimer);
      abortController.abort();
      if (refreshFrameRef.current) refreshFrameRef.current = null;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      glCanvas.removeEventListener("pointerdown", pointerDown);
      glCanvas.removeEventListener("pointermove", pointerMove);
      glCanvas.removeEventListener("pointerup", pointerUp);
      glCanvas.removeEventListener("pointercancel", pointerUp);
      glCanvas.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", visibilityChange);
      window.removeEventListener("pageshow", pageShow);
      gl.deleteBuffer(startBuffer);
      gl.deleteBuffer(endBuffer);
      gl.deleteBuffer(startVelocityBuffer);
      gl.deleteBuffer(endVelocityBuffer);
      gl.deleteBuffer(correctionBuffer);
      gl.deleteBuffer(colorBuffer);
      gl.deleteBuffer(selectedBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    };
  }, [canvasFallback, entries]);

  if (canvasFallback) {
    return <OrbitCanvas entries={sampleEntries(entries, 2400)} selectedId={selectedId} displayScale={displayScale} timeOffset={timeOffset} pausedAt={pausedAt} observer={observer} focusNonce={focusNonce} focusPosition={focusPosition} locale={locale} onSelect={onSelect} />;
  }

  return (
    <div className="orbit-renderer" role="img" aria-label={messages[locale]["globe.aria"]}>
      <canvas ref={earthCanvasRef} className="earth-canvas" aria-hidden="true" />
      <canvas ref={glCanvasRef} className="satellite-gl" aria-hidden="true" />
      <div className={`frame-source frame-source--${frameSource}`}>
        {frameSource === "server" ? "EDGE ORBIT FRAME" : frameSource === "browser" ? "BROWSER BACKUP" : frameSource === "resyncing" ? "RESYNCING NOW" : "SYNCING ORBITS"}
        <b>{motionFps > 0 ? `${motionFps} FPS` : "MOTION SYNC"}</b>
      </div>
    </div>
  );
}

function SatelliteIcon({ category }: { category: SatelliteEntry["category"] }) {
  return <span className={`sat-icon sat-icon--${category}`} aria-hidden="true"><i /><b /><i /></span>;
}

export default function Home() {
  const [locale, setLocale] = useState<Locale>("en");
  const [languageMode, setLanguageMode] = useState<LanguageMode>("auto");
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [signals, setSignals] = useState<SignalsResponse | null>(null);
  const [dataError, setDataError] = useState("");
  const [filter, setFilter] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("discover");
  const [displayScale, setDisplayScale] = useState(25);
  const [colorMode, setColorMode] = useState<ColorMode>("type");
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>("assist");
  const [timeOffset, setTimeOffset] = useState(0);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [observer, setObserver] = useState<Observer>({ lat: 37.5665, lon: 126.978, label: "SEOUL" });
  const [locationState, setLocationState] = useState<"idle" | "loading" | "ready" | "denied">("idle");
  const [favorites, setFavorites] = useState<number[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);
  const [activeConjunction, setActiveConjunction] = useState<Conjunction | null>(null);
  const [agentData, setAgentData] = useState<AgentResponse | null>(null);
  const [activeAgentEventId, setActiveAgentEventId] = useState<string | null>(null);
  const t = messages[locale];

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      const saved = window.localStorage.getItem("satellite-agentbase-language") as LanguageMode | null;
      const mode = saved && ["auto", "en", "ko", "ja"].includes(saved) ? saved : "auto";
      setLanguageMode(mode);
      setLocale(mode === "auto" ? detectLocale() : mode);
      const savedColorMode = window.localStorage.getItem("satellite-agentbase-color-mode") as ColorMode | null;
      if (savedColorMode && ["type", "constellation", "altitude", "risk"].includes(savedColorMode)) setColorMode(savedColorMode);
      const savedAutonomyMode = window.localStorage.getItem("satellite-agentbase-autonomy") as AutonomyMode | null;
      if (savedAutonomyMode && ["manual", "assist", "autopilot"].includes(savedAutonomyMode)) setAutonomyMode(savedAutonomyMode);
    }, 0);
    return () => window.clearTimeout(hydration);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const runAgentCycle = () => fetch(`/api/agent?lat=${observer.lat.toFixed(4)}&lon=${observer.lon.toFixed(4)}`)
      .then((response) => {
        if (!response.ok) throw new Error("Agent cycle unavailable");
        return response.json() as Promise<AgentResponse>;
      })
      .then((data) => {
        if (!cancelled) setAgentData(data);
      })
      .catch(() => {
        if (!cancelled) setAgentData(null);
      });
    void runAgentCycle();
    const timer = window.setInterval(() => void runAgentCycle(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [observer.lat, observer.lon]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    const loadLiveData = () => Promise.all([
        fetch("/api/catalog").then((response) => {
          if (!response.ok) throw new Error(messages.en["error.catalog"]);
          return response.json() as Promise<CatalogResponse>;
        }),
        fetch("/api/signals").then((response) => {
          if (!response.ok) throw new Error(messages.en["error.signals"]);
          return response.json() as Promise<SignalsResponse>;
        }),
      ])
        .then(([catalogData, signalData]) => {
          if (cancelled) return;
          setCatalog(catalogData);
          setSignals(signalData);
          setDataError("");
        })
        .catch((error) => {
          if (!cancelled) setDataError(error instanceof Error ? error.message : messages.en["error.live"]);
        });

    void loadLiveData();
    const refresh = window.setInterval(() => void loadLiveData(), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    const hydration = window.setTimeout(() => {
      setClock(Date.now());
      const saved = window.localStorage.getItem("satellite-agentbase-favorites");
      if (saved) {
        try { setFavorites(JSON.parse(saved)); } catch { /* ignore invalid local state */ }
      }
    }, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(hydration);
    };
  }, []);

  const entries = useMemo(() => {
    if (!catalog) return [];
    return catalog.items.map((tuple) => ({
      name: tuple[0],
      id: tuple[1],
      objectId: tuple[2],
      epoch: tuple[3],
      meanMotion: tuple[4],
      inclination: tuple[6],
      raan: tuple[7],
      bstar: tuple[14],
      category: classify(tuple[0]),
      omm: tuple,
    } satisfies SatelliteEntry));
  }, [catalog]);

  useEffect(() => {
    if (!selectedId && entries.length) {
      const initial = entries.find((entry) => /ISS \(ZARYA\)|^ISS$/.test(entry.name)) ?? entries.find((entry) => entry.category === "station") ?? entries[0];
      const selection = window.setTimeout(() => setSelectedId(initial.id), 0);
      return () => window.clearTimeout(selection);
    }
  }, [entries, selectedId]);

  const categoryCounts = useMemo(() => Object.fromEntries(categoryMeta.map((category) => [category.id, category.id === "all" ? entries.length : entries.filter((entry) => entry.category === category.id).length])), [entries]);
  const filteredEntries = useMemo(() => filter === "all" ? entries : entries.filter((entry) => entry.category === filter), [entries, filter]);
  const renderEntries = useMemo(() => {
    const selected = entries.find((entry) => entry.id === selectedId);
    return selected && !filteredEntries.some((entry) => entry.id === selected.id) ? [...filteredEntries, selected] : filteredEntries;
  }, [filteredEntries, entries, selectedId]);

  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const riskIds = useMemo(() => Array.from(new Set([
    ...(signals?.conjunctions.flatMap((event) => [event.id1, event.id2]) ?? []),
    ...(signals?.decays.map((event) => event.id) ?? []),
  ])), [signals]);
  const simulationTime = new Date((pausedAt ?? clock) + timeOffset * 60000);
  const selectedPosition = selectedEntry ? propagateEntry(selectedEntry, simulationTime) : null;

  const featured = useMemo(() => {
    const patterns = [/ISS \(ZARYA\)|^ISS$/, /HST|HUBBLE/, /TIANHE|TIANGONG/, /NOAA 20/, /LANDSAT 9/, /STARLINK/, /GPS/];
    const found = patterns.map((pattern) => entries.find((entry) => pattern.test(entry.name))).filter((entry): entry is SatelliteEntry => Boolean(entry));
    const fillers = entries.filter((entry) => !found.some((item) => item.id === entry.id)).slice(0, 8 - found.length);
    return [...found, ...fillers];
  }, [entries]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toUpperCase();
    if (normalized) return entries.filter((entry) => entry.name.toUpperCase().includes(normalized) || String(entry.id).includes(normalized)).slice(0, 10);
    const favoriteEntries = favorites.map((id) => entries.find((entry) => entry.id === id)).filter((entry): entry is SatelliteEntry => Boolean(entry));
    return [...favoriteEntries, ...featured.filter((entry) => !favorites.includes(entry.id))].slice(0, 10);
  }, [entries, query, favorites, featured]);

  const passTimeBucket = Math.floor(simulationTime.getTime() / 600000);
  const passPredictions = useMemo(() => {
    const candidates = [...(selectedEntry ? [selectedEntry] : []), ...featured].filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index).slice(0, 14);
    return candidates.map((entry) => findNextPass(entry, observer, simulationTime)).filter((pass): pass is PassPrediction => Boolean(pass)).sort((a, b) => a.time.getTime() - b.time.getTime()).slice(0, 6);
    // Rounded clock keeps this calculation from running every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featured, selectedEntry, observer.lat, observer.lon, passTimeBucket]);

  const selectAndFocus = (id: number) => {
    setSelectedId(id);
    setFocusNonce((value) => value + 1);
  };

  const toggleFavorite = (id: number) => {
    const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
    setFavorites(next);
    window.localStorage.setItem("satellite-agentbase-favorites", JSON.stringify(next));
  };

  const locateMe = () => {
    if (!navigator.geolocation) {
      setLocationState("denied");
      return;
    }
    setLocationState("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setObserver({ lat: position.coords.latitude, lon: position.coords.longitude, label: "MY LOCATION" });
        if (languageMode === "auto") setLocale(localeFromCoordinates(position.coords.latitude, position.coords.longitude) ?? detectLocale());
        setLocationState("ready");
        setPanelTab("sky");
      },
      () => setLocationState("denied"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  };

  const pickSurprise = () => {
    if (!featured.length) return;
    const pool = featured.filter((entry) => entry.id !== selectedId);
    const next = pool[Math.floor(Math.random() * pool.length)] ?? featured[0];
    selectAndFocus(next.id);
  };

  const openConjunction = (conjunction: Conjunction) => {
    setActiveConjunction(conjunction);
    const target = entries.find((entry) => entry.id === conjunction.id1) ?? entries.find((entry) => entry.id === conjunction.id2);
    if (target) selectAndFocus(target.id);
  };

  const applyAgentEvent = (event: AgentEvent) => {
    setActiveAgentEventId(event.id);
    if (event.action.panel) setPanelTab(event.action.panel);
    if (event.action.filter) setFilter(event.action.filter);
    if (event.action.colorMode) setColorMode(event.action.colorMode);
    const focusId = event.action.focusIds?.find((id) => entries.some((entry) => entry.id === id));
    if (focusId) selectAndFocus(focusId);
    if (event.action.timeAt) {
      const targetTime = Date.parse(event.action.timeAt);
      if (Number.isFinite(targetTime)) {
        const minutes = Math.round((targetTime - (pausedAt ?? clock)) / 60_000);
        setTimeOffset(Math.max(-90, Math.min(1440, minutes)));
        setPausedAt(null);
      }
    }
  };

  useEffect(() => {
    if (autonomyMode !== "autopilot" || !agentData?.events.length) return;
    const currentIndex = agentData.events.findIndex((event) => event.id === activeAgentEventId);
    const next = agentData.events[(currentIndex + 1) % agentData.events.length];
    const timer = window.setTimeout(() => {
      setActiveAgentEventId(next.id);
      if (next.action.panel) setPanelTab(next.action.panel);
      if (next.action.filter) setFilter(next.action.filter);
      if (next.action.colorMode) setColorMode(next.action.colorMode);
      const focusId = next.action.focusIds?.find((id) => entries.some((entry) => entry.id === id));
      if (focusId) {
        setSelectedId(focusId);
        setFocusNonce((value) => value + 1);
      }
      if (next.action.timeAt) {
        const targetTime = Date.parse(next.action.timeAt);
        if (Number.isFinite(targetTime)) {
          const minutes = Math.round((targetTime - (pausedAt ?? Date.now())) / 60_000);
          setTimeOffset(Math.max(-90, Math.min(1440, minutes)));
          setPausedAt(null);
        }
      }
    }, activeAgentEventId ? 12_000 : 1400);
    return () => window.clearTimeout(timer);
  }, [agentData, autonomyMode, activeAgentEventId, entries, pausedAt]);

  const dataState = catalog?.status === "live" ? "LIVE" : catalog ? "CACHED" : dataError ? "OFFLINE" : "CONNECTING";
  const trackingTitle = selectedEntry
    ? locale === "ko" ? `${selectedEntry.name}을(를) 추적 중입니다.` : locale === "ja" ? `${selectedEntry.name}を追跡中です。` : `Tracking ${selectedEntry.name}.`
    : t["discover.connecting"];
  const trackingBody = selectedPosition
    ? locale === "ko"
      ? `현재 ${selectedPosition.altitude.toFixed(0)} km 상공을 ${selectedPosition.velocity.toFixed(2)} km/s로 이동합니다. 서버가 공통 SGP4 위치·속도 프레임을 계산하고 GPU가 곡선 보간하며, 에이전트가 의미 있는 변화를 계속 감시합니다.`
      : locale === "ja"
        ? `現在、高度${selectedPosition.altitude.toFixed(0)} kmを${selectedPosition.velocity.toFixed(2)} km/sで移動中です。サーバーが共有SGP4位置・速度フレームを計算し、GPUが曲線補間しながらエージェントが重要な変化を監視します。`
        : `Moving at ${selectedPosition.velocity.toFixed(2)} km/s, ${selectedPosition.altitude.toFixed(0)} km above Earth. The server computes shared SGP4 position and velocity frames, the GPU curves between them, and agents watch for meaningful changes.`
    : t["discover.loading"];
  const changeLanguage = (mode: LanguageMode) => {
    setLanguageMode(mode);
    window.localStorage.setItem("satellite-agentbase-language", mode);
    setLocale(mode === "auto" ? detectLocale() : mode);
  };
  const changeColorMode = (mode: ColorMode) => {
    setColorMode(mode);
    window.localStorage.setItem("satellite-agentbase-color-mode", mode);
  };
  const changeAutonomyMode = (mode: AutonomyMode) => {
    setAutonomyMode(mode);
    window.localStorage.setItem("satellite-agentbase-autonomy", mode);
  };

  return (
    <div className="app-shell" id="top">
      <header className="app-header">
        <a className="brand" href="#top" aria-label={t.home}>
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>satellite<span>.agentba.se</span></span>
        </a>
        <nav aria-label={t.nav}>
          <a href="#mission">MISSION</a>
          <a href="#why">WHY DIFFERENT</a>
          <a href="#sources">SOURCES</a>
        </nav>
        <div className="header-actions">
          <div className={`source-state source-state--${dataState.toLowerCase()}`}><i /> {dataState} · {catalog ? formatNumber(catalog.count, locale) : "—"} OBJECTS</div>
          <label className="language-switcher">
            <span>{t["language.label"]}</span>
            <select value={languageMode} onChange={(event) => changeLanguage(event.target.value as LanguageMode)} aria-label={t["language.label"]}>
              <option value="auto">{t["language.auto"]} · {locale.toUpperCase()}</option>
              <option value="en">EN</option>
              <option value="ko">한국어</option>
              <option value="ja">日本語</option>
            </select>
          </label>
        </div>
      </header>

      <main>
        <section className="mission-intro">
          <div>
            <p className="kicker"><span>AGENTIC ORBITAL INTELLIGENCE</span> / AX ACTIVE</p>
            <h1>{t["hero.line1"]}<br /><em>{t["hero.line2"]}</em></h1>
          </div>
          <p>{t["hero.body"]}</p>
        </section>

        <section className="mission-control" id="mission" aria-label={t["mission.aria"]}>
          <div className="mission-topbar">
            <div><span className="live-pulse" /> EARTH ORBIT / {dataState}</div>
            <div className="topbar-metrics">
              <span>SIM TIME <b>{new Intl.DateTimeFormat(localeTags[locale], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(simulationTime)} LOCAL</b></span>
              <span>OBSERVER <b>{observer.label === "MY LOCATION" ? t["observer.myLocation"] : observer.label}</b></span>
              <span>SOURCE <b>{catalog?.source ?? "CONNECTING"}</b></span>
            </div>
          </div>

          <aside className="catalog-panel" aria-label={t["catalog.aria"]}>
            <div className="panel-title"><span>01</span><div><small>CATALOG</small><strong>{t["catalog.subtitle"]}</strong></div></div>
            <label className="search-box">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t["search.placeholder"]} aria-label={t["search.label"]} />
              {query && <button type="button" onClick={() => setQuery("")} aria-label={t["search.clear"]}>×</button>}
            </label>
            <div className="category-grid" role="group" aria-label={t["category.aria"]}>
              {categoryMeta.map((category) => (
                <button key={category.id} type="button" className={filter === category.id ? "active" : ""} aria-pressed={filter === category.id} onClick={() => setFilter(category.id)}>
                  <span>{category.short}</span><b>{t[category.labelKey]}</b><small>{formatNumber(categoryCounts[category.id] ?? 0, locale)}</small>
                </button>
              ))}
            </div>
            <div className="catalog-list-head"><span>{query ? "SEARCH RESULTS" : favorites.length ? "FAVORITES + SPOTLIGHT" : "SPOTLIGHT"}</span><small>{searchResults.length} SHOWN</small></div>
            <div className="catalog-list" aria-live="polite">
              {!catalog && !dataError && Array.from({ length: 5 }, (_, index) => <div className="catalog-skeleton" key={index} />)}
              {dataError && <div className="empty-state"><span>!</span><p>{t["error.live"]}</p></div>}
              {searchResults.map((entry) => (
                <button type="button" key={entry.id} className={selectedId === entry.id ? "catalog-row active" : "catalog-row"} onClick={() => selectAndFocus(entry.id)}>
                  <SatelliteIcon category={entry.category} />
                  <span><strong>{entry.name}</strong><small>NORAD {entry.id} · {entry.category.toUpperCase()}</small></span>
                  {favorites.includes(entry.id) && <b className="favorite-dot">★</b>}
                </button>
              ))}
            </div>
            <button type="button" className="surprise-button" onClick={pickSurprise}><span>✦</span> {t.surprise} <b>↗</b></button>
          </aside>

          <div className="globe-stage">
            <OrbitCanvasGpu
              entries={renderEntries}
              selectedId={selectedId}
              displayScale={displayScale}
              colorMode={colorMode}
              riskIds={riskIds}
              timeOffset={timeOffset}
              pausedAt={pausedAt}
              observer={observer}
              focusNonce={focusNonce}
              focusPosition={selectedPosition}
              locale={locale}
              onSelect={setSelectedId}
            />
            <div className="globe-grid" aria-hidden="true" />
            <div className="globe-help"><span>DRAG</span> {t["globe.drag"]} <i /> <span>SCROLL</span> {t["globe.scroll"]} <i /> <span>CLICK</span> {t["globe.click"]}</div>
            <div className="prediction-status"><i /><span>{t["prediction.label"]}</span><b>{t["prediction.detail"]}</b></div>
            <div className="altitude-note">ALTITUDE VISUALLY COMPRESSED · POSITION IS SGP4</div>
            <div className="color-console" aria-label={t["color.aria"]}>
              <span>COLOR INTELLIGENCE</span>
              <div>
                {(["type", "constellation", "altitude", "risk"] as ColorMode[]).map((mode) => (
                  <button key={mode} type="button" className={colorMode === mode ? "active" : ""} aria-pressed={colorMode === mode} onClick={() => changeColorMode(mode)}>{t[`color.${mode}`]}</button>
                ))}
              </div>
              <small>{t[`color.${colorMode}.detail`]}</small>
            </div>
            {selectedEntry && selectedPosition && (
              <article className="selected-card" aria-live="polite">
                <div className="selected-card__head">
                  <span className={`category-badge category-badge--${selectedEntry.category}`}>{selectedEntry.category.toUpperCase()}</span>
                  <button type="button" aria-label={favorites.includes(selectedEntry.id) ? t["favorite.remove"] : t["favorite.add"]} onClick={() => toggleFavorite(selectedEntry.id)}>{favorites.includes(selectedEntry.id) ? "★" : "☆"}</button>
                </div>
                <h2>{selectedEntry.name}</h2>
                <p>NORAD {selectedEntry.id} · {selectedEntry.objectId || "DESIGNATOR N/A"}</p>
                <dl>
                  <div><dt>{t["metric.altitude"]}</dt><dd>{formatNumber(selectedPosition.altitude, locale)} <small>km</small></dd></div>
                  <div><dt>{t["metric.speed"]}</dt><dd>{formatNumber(selectedPosition.velocity, locale, 2)} <small>km/s</small></dd></div>
                  <div><dt>{t["metric.latitude"]}</dt><dd>{formatNumber(selectedPosition.lat, locale, 2)}<small>°</small></dd></div>
                  <div><dt>{t["metric.longitude"]}</dt><dd>{formatNumber(selectedPosition.lon, locale, 2)}<small>°</small></dd></div>
                </dl>
                <div className="selected-actions">
                  <button type="button" onClick={() => setFocusNonce((value) => value + 1)}>{t["selected.center"]}</button>
                  <button type="button" className={autonomyMode === "autopilot" ? "active" : ""} aria-pressed={autonomyMode === "autopilot"} onClick={() => changeAutonomyMode(autonomyMode === "autopilot" ? "assist" : "autopilot")}>{autonomyMode === "autopilot" ? t["story.stop"] : t["story.start"]}</button>
                </div>
              </article>
            )}
          </div>

          <aside className="agent-panel" aria-label={t["agent.aria"]}>
            <div className="panel-title"><span>02</span><div><small>AGENT MISSION</small><strong>{t["agent.mission.subtitle"]}</strong></div></div>
            <div className="agent-runtime">
              <div className="agent-runtime__status">
                <span><i /> {agentData ? "AX ACTIVE" : "AGENTS SYNCING"}</span>
                <b>{agentData ? `${formatNumber(agentData.monitoredObjects, locale)} WATCHED` : "CONNECTING"}</b>
              </div>
              <div className="autonomy-switch" role="group" aria-label={t["agent.autonomy.aria"]}>
                {(["manual", "assist", "autopilot"] as AutonomyMode[]).map((mode) => (
                  <button key={mode} type="button" className={autonomyMode === mode ? "active" : ""} aria-pressed={autonomyMode === mode} onClick={() => changeAutonomyMode(mode)}>{t[`agent.autonomy.${mode}`]}</button>
                ))}
              </div>
              <div className="agent-roster">
                {(agentData?.agents ?? [
                  { id: "SENTINEL", state: "syncing", detail: "Risk scan" },
                  { id: "SCOUT", state: "syncing", detail: "Pattern scan" },
                  { id: "SKY", state: "syncing", detail: "Pass scan" },
                ]).map((agent) => <span key={agent.id} title={agent.detail}><i /> <b>{agent.id}</b> {agent.state}</span>)}
              </div>
            </div>
            <div className="agent-tabs" role="tablist" aria-label={t["tabs.aria"]}>
              {(["discover", "risk", "sky"] as PanelTab[]).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={panelTab === tab} className={panelTab === tab ? "active" : ""} onClick={() => setPanelTab(tab)}>
                  {tab === "discover" ? t["tab.discover"] : tab === "risk" ? t["tab.risk"] : t["tab.sky"]}
                  {tab === "risk" && signals?.conjunctions.length ? <i>{signals.conjunctions.length}</i> : null}
                </button>
              ))}
            </div>

            {panelTab === "discover" && (
              <div className="agent-scroll">
                <div className="mission-feed" aria-live="polite">
                  <div className="mission-feed__head"><span>PRIORITY SIGNALS</span><small>{agentData ? `${formatNumber(agentData.evaluatedSignals, locale)} EVALUATED` : "SCANNING"}</small></div>
                  {agentData?.events.slice(0, 3).map((event) => (
                    <article key={event.id} className={`mission-event mission-event--${event.kind}${activeAgentEventId === event.id ? " active" : ""}`}>
                      <div><span>{event.agent}</span><b>P{event.priority}</b></div>
                      <h3>{event.title[locale]}</h3>
                      <p>{event.body[locale]}</p>
                      <div className="mission-event__meta"><span>{Math.round(event.confidence * 100)}% {t["agent.confidence"]}</span><time>{relativeTime(event.createdAt, simulationTime, locale)}</time></div>
                      <details><summary>{t["agent.evidence"]}</summary>{event.evidence.map((item) => <small key={item}>{item}</small>)}</details>
                      <button type="button" onClick={() => applyAgentEvent(event)}>{t["agent.show"]} <span>→</span></button>
                    </article>
                  )) ?? <div className="agent-cycle-skeleton"><i /><i /><i /></div>}
                </div>
                <article className="agent-lead agent-lead--fun">
                  <div><span>✦ AGENT FOCUS</span><time>{relativeTime(simulationTime, simulationTime, locale)}</time></div>
                  <h3>{trackingTitle}</h3>
                  <p>{trackingBody}</p>
                </article>
                <div className="weather-card">
                  <div className="kp-gauge"><span style={{ "--kp": `${Math.min(100, ((signals?.spaceWeather?.kp ?? 0) / 9) * 100)}%` } as React.CSSProperties} /><b>Kp {signals?.spaceWeather ? signals.spaceWeather.kp.toFixed(1) : "—"}</b></div>
                  <div><span>NOAA SPACE WEATHER</span><strong>{signals?.spaceWeather ? t[`weather.${signals.spaceWeather.level}`] : t["weather.connecting"]}</strong><small>{signals?.spaceWeather ? relativeTime(signals.spaceWeather.time, simulationTime, locale) : "NOAA SWPC"}</small></div>
                </div>
                <div className="insight-grid">
                  <article><span>CATALOG</span><strong>{formatNumber(entries.length, locale)}</strong><small>{t["insight.active"]}</small></article>
                  <article><span>ON SCREEN</span><strong>{formatNumber(renderEntries.length, locale)}</strong><small>{t["insight.predicted"]}</small></article>
                  <article><span>DECAY</span><strong>{signals?.decays.length ?? "—"}</strong><small>{t["insight.decay"]}</small></article>
                  <article><span>PASSES</span><strong>{passPredictions.length}</strong><small>{t["insight.passes"]}</small></article>
                </div>
                <button type="button" className="agent-action" onClick={pickSurprise}>{t["agent.action"]} <span>→</span></button>
              </div>
            )}

            {panelTab === "risk" && (
              <div className="agent-scroll risk-list">
                <div className="risk-disclaimer"><span>!</span><p>{t["risk.disclaimer"]}</p></div>
                {signals?.conjunctions.length ? signals.conjunctions.slice(0, 7).map((event, index) => (
                  <button type="button" key={`${event.id1}-${event.id2}-${event.tca}`} className={activeConjunction === event ? "risk-row active" : "risk-row"} onClick={() => openConjunction(event)}>
                    <span className="risk-index">0{index + 1}</span>
                    <div><small>{relativeTime(event.tca, simulationTime, locale)} · {event.relativeSpeed.toFixed(2)} km/s</small><strong>{event.name1.replace(/\s\[[^\]]+\]$/, "")}</strong><i>×</i><strong>{event.name2.replace(/\s\[[^\]]+\]$/, "")}</strong></div>
                    <b>{event.rangeKm < 1 ? `${Math.round(event.rangeKm * 1000)} m` : `${event.rangeKm.toFixed(2)} km`}</b>
                  </button>
                )) : <div className="empty-state"><span>◌</span><p>{signals ? t["risk.unavailable"] : t["risk.connecting"]}</p></div>}
                {signals?.decays.slice(0, 4).map((decay) => (
                  <button type="button" key={decay.id} className="decay-row" onClick={() => { const entry = entries.find((item) => item.id === decay.id); if (entry) selectAndFocus(entry.id); }}>
                    <span>DECAY WATCH</span><strong>{decay.name}</strong><small>NORAD {decay.id} · BSTAR {decay.bstar.toExponential(2)}</small>
                  </button>
                ))}
              </div>
            )}

            {panelTab === "sky" && (
              <div className="agent-scroll sky-list">
                <div className="observer-card">
                  <div><span>OBSERVER</span><strong>{observer.label === "MY LOCATION" ? t["observer.myLocation"] : observer.label}</strong><small>{observer.lat.toFixed(3)}°, {observer.lon.toFixed(3)}°</small></div>
                  <button type="button" onClick={locateMe} disabled={locationState === "loading"}>{locationState === "loading" ? t["observer.loading"] : t["observer.use"]}</button>
                </div>
                {locationState === "denied" && <p className="location-error">{t["observer.denied"]}</p>}
                <div className="pass-note">{t["pass.note"]}</div>
                {passPredictions.map((pass, index) => (
                  <button type="button" key={`${pass.id}-${pass.time.toISOString()}`} className="pass-row" onClick={() => selectAndFocus(pass.id)}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{pass.name}</strong><small>{relativeTime(pass.time, simulationTime, locale)} · {t["pass.azimuth"]} {Math.round(pass.azimuth)}°</small></div>
                    <b>{Math.round(pass.maxElevation)}°</b>
                  </button>
                ))}
                {!passPredictions.length && <div className="empty-state"><span>◌</span><p>{t["pass.none"]}</p></div>}
              </div>
            )}
          </aside>

          <div className="mission-controls">
            <div className="time-control">
              <button type="button" aria-label={pausedAt ? t["time.play"] : t["time.pause"]} onClick={() => setPausedAt((value) => value ? null : Date.now())}>{pausedAt ? "▶" : "Ⅱ"}</button>
              <div><span>TIME TRAVEL</span><strong>{timeOffset === 0 ? "NOW" : timeOffset < 0 ? `${Math.abs(timeOffset)}M AGO` : `+${Math.floor(timeOffset / 60)}H ${timeOffset % 60}M`}</strong></div>
              <input type="range" min="-90" max="1440" step="15" value={timeOffset} aria-label={t["time.slider"]} aria-valuetext={simulationTime.toLocaleString(localeTags[locale])} onChange={(event) => setTimeOffset(Number(event.target.value))} />
              <div className="time-presets"><button type="button" onClick={() => setTimeOffset(-60)}>−1H</button><button type="button" className={timeOffset === 0 ? "active" : ""} onClick={() => setTimeOffset(0)}>NOW</button><button type="button" onClick={() => setTimeOffset(360)}>+6H</button><button type="button" onClick={() => setTimeOffset(1440)}>+24H</button></div>
            </div>
            <div className="display-control">
              <div><span>OBJECT DISPLAY</span><strong>{displayScale}×</strong></div>
              <input type="range" min="1" max={Math.log2(1000)} step="0.01" value={Math.log2(displayScale)} aria-label={t["display.slider"]} aria-valuetext={`${displayScale}×`} onChange={(event) => setDisplayScale(Math.round(2 ** Number(event.target.value)))} />
              <div>{scaleStops.map((stop) => <button type="button" key={stop} className={displayScale === stop ? "active" : ""} aria-pressed={displayScale === stop} onClick={() => setDisplayScale(stop)}>{stop}×</button>)}</div>
            </div>
          </div>
        </section>

        <section className="product-proof" id="why">
          <div className="section-heading"><p>03 / WHY DIFFERENT</p><h2>{t["why.line1"]}<br /><em>{t["why.line2"]}</em></h2></div>
          <div className="proof-grid">
            <article><span>01</span><div className="proof-visual proof-visual--focus"><i /><i /><i /><b>✦</b></div><h3>{t["proof.events.title"]}</h3><p>{t["proof.events.body"]}</p></article>
            <article><span>02</span><div className="proof-visual proof-visual--time"><b>−1H</b><i /><strong>NOW</strong><i /><b>+24H</b></div><h3>{t["proof.time.title"]}</h3><p>{t["proof.time.body"]}</p></article>
            <article><span>03</span><div className="proof-visual proof-visual--sky"><i /><b>37°</b><span>MY SKY</span></div><h3>{t["proof.sky.title"]}</h3><p>{t["proof.sky.body"]}</p></article>
          </div>
        </section>

        <section className="source-section" id="sources">
          <div className="section-heading"><p>04 / DATA TRANSPARENCY</p><h2>{t["sources.line1"]}<br /><em>{t["sources.line2"]}</em></h2></div>
          <div className="source-table">
            <a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer"><span>ORBITAL ELEMENTS</span><strong>CelesTrak OMM / USSF GP</strong><small>{t["source.orbits"]}</small><b>↗</b></a>
            <a href="https://celestrak.org/SOCRATES/socrates-format.php" target="_blank" rel="noreferrer"><span>CONJUNCTIONS</span><strong>SOCRATES Plus</strong><small>{t["source.conjunctions"]}</small><b>↗</b></a>
            <a href="https://services.swpc.noaa.gov/products/" target="_blank" rel="noreferrer"><span>SPACE WEATHER</span><strong>NOAA SWPC</strong><small>{t["source.weather"]}</small><b>↗</b></a>
            <div><span>PROPAGATION</span><strong>satellite.js / SGP4</strong><small>{t["source.propagation"]}</small><b>✓</b></div>
          </div>
          <p className="accuracy-note">{t.accuracy}</p>
        </section>
      </main>

      <footer>
        <a className="brand" href="#top"><span className="brand-mark" aria-hidden="true"><i /></span><span>satellite<span>.agentba.se</span></span></a>
        <p>REAL ORBITS. HUMAN STORIES. PROACTIVE SIGNALS.</p>
        <span>© 2026 AGENTBA.SE</span>
      </footer>
    </div>
  );
}
