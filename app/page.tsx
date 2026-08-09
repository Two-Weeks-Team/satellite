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
import { useEffect, useMemo, useRef, useState } from "react";
import { detectLocale, localeFromCoordinates, localeTags, messages, type LanguageMode, type Locale } from "./i18n";

type CompactOmm = [string, number, string, string, number, number, number, number, number, number, number, "U" | "C", number, number, number, number, number];
type Category = "all" | "station" | "starlink" | "weather" | "navigation" | "science" | "other";
type PanelTab = "discover" | "risk" | "sky";

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
  correction: Float32Array;
  startTime: number;
  endTime: number;
  receivedAt: number;
  count: number;
};

type WorkerSnapshot = {
  type: "snapshot";
  generation: number;
  startTime: number;
  endTime: number;
  computeMs: number;
  startPositions: Float32Array;
  endPositions: Float32Array;
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

function categoryCode(category: SatelliteEntry["category"]) {
  return { station: 0, starlink: 1, weather: 2, navigation: 3, science: 4, other: 5 }[category];
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
    in vec3 aCorrection;
    in float aCategory;
    in float aSelected;
    uniform float uProgress;
    uniform float uCorrectionWeight;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uDisplayScale;
    uniform float uPixelRatio;
    uniform vec2 uProjectionScale;
    out float vCategory;
    out float vSelected;
    out float vAlpha;

    void main() {
      vec3 ecf = mix(aStart, aEnd, uProgress) + aCorrection * uCorrectionWeight;
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
      vec2 projected = vec2(x1 * uProjectionScale.x, y2 * uProjectionScale.y);
      gl_Position = vec4(projected.x, projected.y + 0.02, 0.0, 1.0);
      float normalSize = 1.35 + log2(max(2.0, uDisplayScale)) * 0.58;
      gl_PointSize = (aSelected > 0.5 ? normalSize + 7.0 : normalSize) * uPixelRatio;
      bool earthOccluded = z2 < 0.0 && length(vec2(x1, y2)) < 1.01;
      vAlpha = earthOccluded ? 0.0 : (z2 < 0.0 ? 0.18 : 1.0);
      vCategory = aCategory;
      vSelected = aSelected;
    }
  `);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in float vCategory;
    in float vSelected;
    in float vAlpha;
    out vec4 outColor;

    vec3 categoryColor(float category) {
      if (category < 0.5) return vec3(0.757, 1.0, 0.447);
      if (category < 1.5) return vec3(0.447, 0.659, 1.0);
      if (category < 2.5) return vec3(0.38, 0.914, 0.929);
      if (category < 3.5) return vec3(0.765, 0.584, 1.0);
      if (category < 4.5) return vec3(1.0, 0.839, 0.42);
      return vec3(0.667, 0.725, 0.745);
    }

    void main() {
      if (vAlpha <= 0.0) discard;
      float distanceFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
      if (distanceFromCenter > 1.0) discard;
      vec3 color = categoryColor(vCategory);
      float edge = 1.0 - smoothstep(0.72, 1.0, distanceFromCenter);
      if (vSelected > 0.5 && distanceFromCenter > 0.56) {
        outColor = vec4(color, vAlpha * smoothstep(1.0, 0.76, distanceFromCenter));
      } else {
        float glow = vSelected > 0.5 ? 1.0 : 0.78 + edge * 0.22;
        outColor = vec4(color * glow, vAlpha * edge);
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
      return { x: x1, y: y2, z: z2 };
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
  const [canvasFallback, setCanvasFallback] = useState(false);
  const earthCanvasRef = useRef<HTMLCanvasElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<OrbitSnapshot | null>(null);
  const cameraRef = useRef({ yaw: Math.PI / 2 - degreesToRadians(126.98), pitch: degreesToRadians(20), zoom: 1 });
  const focusPositionRef = useRef(focusPosition);
  const pointerRef = useRef({ active: false, moved: false, x: 0, y: 0, yaw: 0, pitch: 0 });
  const hardResetRef = useRef(true);
  const selectedIdRef = useRef(selectedId);
  const displayScaleRef = useRef(displayScale);
  const timeOffsetRef = useRef(timeOffset);
  const pausedAtRef = useRef(pausedAt);
  const observerRef = useRef(observer);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    displayScaleRef.current = displayScale;
    timeOffsetRef.current = timeOffset;
    pausedAtRef.current = pausedAt;
    observerRef.current = observer;
    onSelectRef.current = onSelect;
  }, [selectedId, displayScale, timeOffset, pausedAt, observer, onSelect]);

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
    const correctionBuffer = gl.createBuffer();
    const categoryBuffer = gl.createBuffer();
    const selectedBuffer = gl.createBuffer();
    if (!vao || !startBuffer || !endBuffer || !correctionBuffer || !categoryBuffer || !selectedBuffer) {
      setCanvasFallback(true);
      gl.deleteProgram(program);
      return;
    }

    const selectedFlags = new Float32Array(entries.length);
    const entryIndex = new Map(entries.map((entry, index) => [entry.id, index]));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let hidden = document.visibilityState === "hidden";
    let animationFrame = 0;
    let lastReducedFrame = 0;
    let lastSelectedId: number | null | undefined;
    let selectedTrail: GeoPosition[] = [];
    let trailKey = "";

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
    bindAttribute("aCorrection", 3, correctionBuffer);
    bindAttribute("aCategory", 1, categoryBuffer);
    bindAttribute("aSelected", 1, selectedBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, categoryBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(entries, (entry) => categoryCode(entry.category)), gl.STATIC_DRAW);
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
        x: x1,
        y: y * Math.cos(pitch) - z1 * Math.sin(pitch),
        z: y * Math.sin(pitch) + z1 * Math.cos(pitch),
      };
    };

    const pointFromSnapshot = (index: number, at: number, timestamp: number) => {
      const snapshot = snapshotRef.current;
      if (!snapshot || index < 0 || index >= snapshot.count) return null;
      const span = snapshot.endTime - snapshot.startTime;
      const progress = span > 0 ? Math.max(0, Math.min(1.5, (at - snapshot.startTime) / span)) : 0;
      const ease = Math.max(0, Math.min(1, (timestamp - snapshot.receivedAt) / 1200));
      const correctionWeight = (1 - ease) ** 3;
      const offset = index * 3;
      const x = snapshot.startPositions[offset] + (snapshot.endPositions[offset] - snapshot.startPositions[offset]) * progress + snapshot.correction[offset] * correctionWeight;
      const y = snapshot.startPositions[offset + 1] + (snapshot.endPositions[offset + 1] - snapshot.startPositions[offset + 1]) * progress + snapshot.correction[offset + 1] * correctionWeight;
      const z = snapshot.startPositions[offset + 2] + (snapshot.endPositions[offset + 2] - snapshot.startPositions[offset + 2]) * progress + snapshot.correction[offset + 2] * correctionWeight;
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
        x: x1,
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
      context.strokeStyle = "rgba(110, 227, 213, .17)";
      context.lineWidth = 0.7;
      const drawGeoLine = (points: Array<{ lat: number; lon: number }>) => {
        let penDown = false;
        context.beginPath();
        points.forEach((point) => {
          const rotated = rotateGeo(point.lat, point.lon, 1.002);
          const screen = project(rotated);
          if (rotated.z <= 0) {
            penDown = false;
            return;
          }
          if (penDown) context.lineTo(screen.x, screen.y);
          else context.moveTo(screen.x, screen.y);
          penDown = true;
        });
        context.stroke();
      };
      for (let lat = -60; lat <= 60; lat += 30) drawGeoLine(Array.from({ length: 73 }, (_, index) => ({ lat, lon: -180 + index * 5 })));
      for (let lon = -150; lon <= 180; lon += 30) drawGeoLine(Array.from({ length: 37 }, (_, index) => ({ lat: -90 + index * 5, lon })));
      const shade = context.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY);
      shade.addColorStop(0, "rgba(0, 2, 6, .02)");
      shade.addColorStop(0.6, "rgba(0, 2, 6, .14)");
      shade.addColorStop(1, "rgba(0, 2, 6, .85)");
      context.fillStyle = shade;
      context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
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
      }

      const selectedIndex = selectedIdRef.current === null ? undefined : entryIndex.get(selectedIdRef.current);
      const selectedPoint = selectedIndex === undefined ? null : pointFromSnapshot(selectedIndex, at, timestamp);
      if (selectedPoint && selectedPoint.z >= 0) {
        const screen = project(selectedPoint);
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

      if (lastSelectedId !== selectedIdRef.current) {
        selectedFlags.fill(0);
        const selectedIndex = selectedIdRef.current === null ? undefined : entryIndex.get(selectedIdRef.current);
        if (selectedIndex !== undefined) selectedFlags[selectedIndex] = 1;
        gl.bindBuffer(gl.ARRAY_BUFFER, selectedBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, selectedFlags);
        lastSelectedId = selectedIdRef.current;
      }

      const span = snapshot.endTime - snapshot.startTime;
      const progress = span > 0 ? Math.max(0, Math.min(1.5, (at - snapshot.startTime) / span)) : 0;
      const ease = Math.max(0, Math.min(1, (timestamp - snapshot.receivedAt) / 1200));
      const radius = Math.min(width, height) * 0.31 * cameraRef.current.zoom;
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform1f(gl.getUniformLocation(program, "uProgress"), progress);
      gl.uniform1f(gl.getUniformLocation(program, "uCorrectionWeight"), (1 - ease) ** 3);
      gl.uniform1f(gl.getUniformLocation(program, "uYaw"), cameraRef.current.yaw);
      gl.uniform1f(gl.getUniformLocation(program, "uPitch"), cameraRef.current.pitch);
      gl.uniform1f(gl.getUniformLocation(program, "uDisplayScale"), displayScaleRef.current);
      gl.uniform1f(gl.getUniformLocation(program, "uPixelRatio"), ratio);
      gl.uniform2f(gl.getUniformLocation(program, "uProjectionScale"), radius * 2 / width, radius * 2 / height);
      gl.drawArraysInstanced(gl.POINTS, 0, 1, snapshot.count);
      gl.bindVertexArray(null);
    };

    const uploadSnapshot = (message: WorkerSnapshot) => {
      const count = message.startPositions.length / 3;
      if (count !== entries.length || message.endPositions.length !== message.startPositions.length) return;
      const prior = snapshotRef.current;
      const correction = new Float32Array(message.startPositions.length);
      if (!hardResetRef.current && prior && prior.count === count) {
        const oldSpan = prior.endTime - prior.startTime;
        const oldProgress = oldSpan > 0 ? Math.max(0, Math.min(1.5, (message.startTime - prior.startTime) / oldSpan)) : 0;
        for (let index = 0; index < correction.length; index += 1) {
          const predicted = prior.startPositions[index] + (prior.endPositions[index] - prior.startPositions[index]) * oldProgress;
          const delta = predicted - message.startPositions[index];
          correction[index] = Number.isFinite(delta) ? delta : 0;
        }
      }
      hardResetRef.current = false;
      snapshotRef.current = {
        startPositions: message.startPositions,
        endPositions: message.endPositions,
        correction,
        startTime: message.startTime,
        endTime: message.endTime,
        receivedAt: performance.now(),
        count,
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, startBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.startPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, endBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, message.endPositions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, correctionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, correction, gl.DYNAMIC_DRAW);
    };

    const worker = new Worker(new URL("./orbit.worker.ts", import.meta.url), { type: "module", name: "orbit-sgp4" });
    workerRef.current = worker;
    snapshotRef.current = null;
    hardResetRef.current = true;
    worker.onmessage = (event: MessageEvent<WorkerSnapshot>) => {
      if (event.data.type === "snapshot") uploadSnapshot(event.data);
    };
    worker.postMessage({
      type: "init",
      entries: entries.map((entry) => entry.omm),
      offsetMs: timeOffsetRef.current * 60000,
      pausedAt: pausedAtRef.current,
      active: !hidden,
    });

    const draw = (timestamp: number) => {
      animationFrame = requestAnimationFrame(draw);
      if (hidden || (reducedMotion && timestamp - lastReducedFrame < 100)) return;
      lastReducedFrame = timestamp;
      const at = simulationMs();
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
    };
    const visibilityChange = () => {
      hidden = document.visibilityState === "hidden";
      worker.postMessage({ type: "visibility", active: !hidden });
    };

    glCanvas.addEventListener("pointerdown", pointerDown);
    glCanvas.addEventListener("pointermove", pointerMove);
    glCanvas.addEventListener("pointerup", pointerUp);
    glCanvas.addEventListener("pointercancel", pointerUp);
    glCanvas.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("visibilitychange", visibilityChange);
    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      glCanvas.removeEventListener("pointerdown", pointerDown);
      glCanvas.removeEventListener("pointermove", pointerMove);
      glCanvas.removeEventListener("pointerup", pointerUp);
      glCanvas.removeEventListener("pointercancel", pointerUp);
      glCanvas.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", visibilityChange);
      gl.deleteBuffer(startBuffer);
      gl.deleteBuffer(endBuffer);
      gl.deleteBuffer(correctionBuffer);
      gl.deleteBuffer(categoryBuffer);
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
  const [timeOffset, setTimeOffset] = useState(0);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(0);
  const [observer, setObserver] = useState<Observer>({ lat: 37.5665, lon: 126.978, label: "SEOUL" });
  const [locationState, setLocationState] = useState<"idle" | "loading" | "ready" | "denied">("idle");
  const [favorites, setFavorites] = useState<number[]>([]);
  const [storyMode, setStoryMode] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [activeConjunction, setActiveConjunction] = useState<Conjunction | null>(null);
  const t = messages[locale];

  useEffect(() => {
    const hydration = window.setTimeout(() => {
      const saved = window.localStorage.getItem("satellite-agentbase-language") as LanguageMode | null;
      const mode = saved && ["auto", "en", "ko", "ja"].includes(saved) ? saved : "auto";
      setLanguageMode(mode);
      setLocale(mode === "auto" ? detectLocale() : mode);
    }, 0);
    return () => window.clearTimeout(hydration);
  }, []);

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

  useEffect(() => {
    if (!storyMode || featured.length < 2) return;
    const timer = window.setInterval(() => {
      const currentIndex = Math.max(0, featured.findIndex((entry) => entry.id === selectedId));
      const next = featured[(currentIndex + 1) % featured.length];
      setSelectedId(next.id);
      setFocusNonce((value) => value + 1);
    }, 8500);
    return () => window.clearInterval(timer);
  }, [storyMode, featured, selectedId]);

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

  const dataState = catalog?.status === "live" ? "LIVE" : catalog ? "CACHED" : dataError ? "OFFLINE" : "CONNECTING";
  const trackingTitle = selectedEntry
    ? locale === "ko" ? `${selectedEntry.name}을(를) 추적 중입니다.` : locale === "ja" ? `${selectedEntry.name}を追跡中です。` : `Tracking ${selectedEntry.name}.`
    : t["discover.connecting"];
  const trackingBody = selectedPosition
    ? locale === "ko"
      ? `현재 ${selectedPosition.altitude.toFixed(0)} km 상공을 ${selectedPosition.velocity.toFixed(2)} km/s로 이동합니다. Worker가 전체 카탈로그의 SGP4 스냅샷을 계산하고 GPU가 프레임 사이를 보간한 뒤 새 값의 오차를 부드럽게 흡수합니다.`
      : locale === "ja"
        ? `現在、高度${selectedPosition.altitude.toFixed(0)} kmを${selectedPosition.velocity.toFixed(2)} km/sで移動中です。Workerが全カタログのSGP4スナップショットを計算し、GPUがフレーム間を補間して新しい値との差を滑らかに吸収します。`
        : `Moving at ${selectedPosition.velocity.toFixed(2)} km/s, ${selectedPosition.altitude.toFixed(0)} km above Earth. A Worker computes full-catalog SGP4 snapshots while the GPU interpolates every frame and smoothly absorbs each new solution.`
    : t["discover.loading"];
  const changeLanguage = (mode: LanguageMode) => {
    setLanguageMode(mode);
    window.localStorage.setItem("satellite-agentbase-language", mode);
    setLocale(mode === "auto" ? detectLocale() : mode);
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
            <p className="kicker"><span>LIVE ORBITAL INTELLIGENCE</span> / SGP4 PROPAGATION</p>
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
                  <button type="button" className={storyMode ? "active" : ""} aria-pressed={storyMode} onClick={() => setStoryMode((value) => !value)}>{storyMode ? t["story.stop"] : t["story.start"]}</button>
                </div>
              </article>
            )}
          </div>

          <aside className="agent-panel" aria-label={t["agent.aria"]}>
            <div className="panel-title"><span>02</span><div><small>AGENT BRIEF</small><strong>{t["agent.subtitle"]}</strong></div></div>
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
                <article className="agent-lead agent-lead--fun">
                  <div><span>✦ LIVE DISCOVERY</span><time>{relativeTime(simulationTime, simulationTime, locale)}</time></div>
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
