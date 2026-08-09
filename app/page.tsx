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
  satrec: SatRec;
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

const categoryMeta: Array<{ id: Category; label: string; short: string }> = [
  { id: "all", label: "전체", short: "ALL" },
  { id: "station", label: "우주정거장", short: "STN" },
  { id: "starlink", label: "Starlink", short: "STR" },
  { id: "weather", label: "기상", short: "WX" },
  { id: "navigation", label: "항법", short: "NAV" },
  { id: "science", label: "과학", short: "SCI" },
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
  const result = propagate(entry.satrec, date);
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

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function relativeTime(dateInput: string | Date, now: Date) {
  const date = new Date(dateInput);
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (Math.abs(minutes) < 1) return "지금";
  if (minutes > 0 && minutes < 60) return `${minutes}분 후`;
  if (minutes > 0 && minutes < 1440) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후`;
  if (minutes < 0 && minutes > -60) return `${Math.abs(minutes)}분 전`;
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }).format(date);
}

function sampleEntries(entries: SatelliteEntry[], maximum: number) {
  if (entries.length <= maximum) return entries;
  const step = entries.length / maximum;
  return Array.from({ length: maximum }, (_, index) => entries[Math.floor(index * step)]);
}

function findNextPass(entry: SatelliteEntry, observer: Observer, start: Date): PassPrediction | null {
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
    const result = propagate(entry.satrec, time);
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
  onSelect: (id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef({ yaw: Math.PI / 2 - degreesToRadians(126.98), pitch: degreesToRadians(20), zoom: 1 });
  const focusPositionRef = useRef(focusPosition);
  const pointsRef = useRef<GeoPosition[]>([]);
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

    const refreshPositions = () => {
      const date = simulationDate();
      pointsRef.current = entries.map((entry) => propagateEntry(entry, date)).filter((point): point is GeoPosition => point !== null);
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
        refreshPositions();
        lastPropagation = timestamp;
      } else if (pointsRef.current.length === 0) {
        refreshPositions();
      }

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

    refreshPositions();
    draw(0);

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

  return <canvas ref={canvasRef} className="live-globe" role="img" aria-label="실제 궤도요소를 SGP4로 계산한 현재 위성 위치. 마우스로 지구를 회전하고 위성을 선택할 수 있습니다." />;
}

function SatelliteIcon({ category }: { category: SatelliteEntry["category"] }) {
  return <span className={`sat-icon sat-icon--${category}`} aria-hidden="true"><i /><b /><i /></span>;
}

export default function Home() {
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
  const [clock, setClock] = useState(Date.now());
  const [observer, setObserver] = useState<Observer>({ lat: 37.5665, lon: 126.978, label: "SEOUL" });
  const [locationState, setLocationState] = useState<"idle" | "loading" | "ready" | "denied">("idle");
  const [favorites, setFavorites] = useState<number[]>([]);
  const [storyMode, setStoryMode] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [activeConjunction, setActiveConjunction] = useState<Conjunction | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/catalog").then((response) => {
        if (!response.ok) throw new Error("위성 카탈로그를 불러오지 못했습니다.");
        return response.json() as Promise<CatalogResponse>;
      }),
      fetch("/api/signals").then((response) => {
        if (!response.ok) throw new Error("사건 피드를 불러오지 못했습니다.");
        return response.json() as Promise<SignalsResponse>;
      }),
    ])
      .then(([catalogData, signalData]) => {
        if (cancelled) return;
        setCatalog(catalogData);
        setSignals(signalData);
      })
      .catch((error) => {
        if (!cancelled) setDataError(error instanceof Error ? error.message : "실시간 데이터 연결에 실패했습니다.");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    const saved = window.localStorage.getItem("satellite-agentbase-favorites");
    if (saved) {
      try { setFavorites(JSON.parse(saved)); } catch { /* ignore invalid local state */ }
    }
    return () => window.clearInterval(timer);
  }, []);

  const entries = useMemo(() => {
    if (!catalog) return [];
    return catalog.items.flatMap((tuple) => {
      try {
        return [{
          name: tuple[0],
          id: tuple[1],
          objectId: tuple[2],
          epoch: tuple[3],
          meanMotion: tuple[4],
          inclination: tuple[6],
          bstar: tuple[14],
          category: classify(tuple[0]),
          satrec: json2satrec(tupleToOmm(tuple)),
        } satisfies SatelliteEntry];
      } catch {
        return [];
      }
    });
  }, [catalog]);

  useEffect(() => {
    if (!selectedId && entries.length) {
      const initial = entries.find((entry) => /ISS \(ZARYA\)|^ISS$/.test(entry.name)) ?? entries.find((entry) => entry.category === "station") ?? entries[0];
      setSelectedId(initial.id);
    }
  }, [entries, selectedId]);

  const categoryCounts = useMemo(() => Object.fromEntries(categoryMeta.map((category) => [category.id, category.id === "all" ? entries.length : entries.filter((entry) => entry.category === category.id).length])), [entries]);
  const filteredEntries = useMemo(() => filter === "all" ? entries : entries.filter((entry) => entry.category === filter), [entries, filter]);
  const renderEntries = useMemo(() => {
    const sampled = sampleEntries(filteredEntries, 2400);
    const selected = entries.find((entry) => entry.id === selectedId);
    return selected && !sampled.some((entry) => entry.id === selected.id) ? [...sampled, selected] : sampled;
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

  const passPredictions = useMemo(() => {
    const candidates = [...(selectedEntry ? [selectedEntry] : []), ...featured].filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index).slice(0, 14);
    return candidates.map((entry) => findNextPass(entry, observer, simulationTime)).filter((pass): pass is PassPrediction => Boolean(pass)).sort((a, b) => a.time.getTime() - b.time.getTime()).slice(0, 6);
    // Rounded clock keeps this calculation from running every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featured, selectedEntry, observer.lat, observer.lon, Math.floor(simulationTime.getTime() / 600000)]);

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

  return (
    <div className="app-shell" id="top">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="satellite.agentba.se 홈">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <span>satellite<span>.agentba.se</span></span>
        </a>
        <nav aria-label="주요 메뉴">
          <a href="#mission">MISSION</a>
          <a href="#why">WHY DIFFERENT</a>
          <a href="#sources">SOURCES</a>
        </nav>
        <div className={`source-state source-state--${dataState.toLowerCase()}`}><i /> {dataState} · {catalog ? formatNumber(catalog.count) : "—"} OBJECTS</div>
      </header>

      <main>
        <section className="mission-intro">
          <div>
            <p className="kicker"><span>LIVE ORBITAL INTELLIGENCE</span> / SGP4 PROPAGATION</p>
            <h1>우주는 지금도<br /><em>사건을 만들고 있습니다.</em></h1>
          </div>
          <p>수만 개의 궤도를 직접 뒤지지 마세요. 실제 위치·근접접근·추락 후보·우주기상을 한 화면에서 읽고, 에이전트가 지금 볼 이유를 먼저 설명합니다.</p>
        </section>

        <section className="mission-control" id="mission" aria-label="실시간 위성 관제 화면">
          <div className="mission-topbar">
            <div><span className="live-pulse" /> EARTH ORBIT / {dataState}</div>
            <div className="topbar-metrics">
              <span>SIM TIME <b>{new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Seoul", hour12: false }).format(simulationTime)} KST</b></span>
              <span>OBSERVER <b>{observer.label}</b></span>
              <span>SOURCE <b>{catalog?.source ?? "CONNECTING"}</b></span>
            </div>
          </div>

          <aside className="catalog-panel" aria-label="위성 검색과 필터">
            <div className="panel-title"><span>01</span><div><small>CATALOG</small><strong>찾고, 저장하고, 추적하기</strong></div></div>
            <label className="search-box">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름 또는 NORAD 번호" aria-label="위성 검색" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="검색어 지우기">×</button>}
            </label>
            <div className="category-grid" role="group" aria-label="위성 유형 필터">
              {categoryMeta.map((category) => (
                <button key={category.id} type="button" className={filter === category.id ? "active" : ""} aria-pressed={filter === category.id} onClick={() => setFilter(category.id)}>
                  <span>{category.short}</span><b>{category.label}</b><small>{formatNumber(categoryCounts[category.id] ?? 0)}</small>
                </button>
              ))}
            </div>
            <div className="catalog-list-head"><span>{query ? "SEARCH RESULTS" : favorites.length ? "FAVORITES + SPOTLIGHT" : "SPOTLIGHT"}</span><small>{searchResults.length} SHOWN</small></div>
            <div className="catalog-list" aria-live="polite">
              {!catalog && !dataError && Array.from({ length: 5 }, (_, index) => <div className="catalog-skeleton" key={index} />)}
              {dataError && <div className="empty-state"><span>!</span><p>{dataError}</p></div>}
              {searchResults.map((entry) => (
                <button type="button" key={entry.id} className={selectedId === entry.id ? "catalog-row active" : "catalog-row"} onClick={() => selectAndFocus(entry.id)}>
                  <SatelliteIcon category={entry.category} />
                  <span><strong>{entry.name}</strong><small>NORAD {entry.id} · {entry.category.toUpperCase()}</small></span>
                  {favorites.includes(entry.id) && <b className="favorite-dot">★</b>}
                </button>
              ))}
            </div>
            <button type="button" className="surprise-button" onClick={pickSurprise}><span>✦</span> 지금 흥미로운 위성으로 이동 <b>↗</b></button>
          </aside>

          <div className="globe-stage">
            <OrbitCanvas
              entries={renderEntries}
              selectedId={selectedId}
              displayScale={displayScale}
              timeOffset={timeOffset}
              pausedAt={pausedAt}
              observer={observer}
              focusNonce={focusNonce}
              focusPosition={selectedPosition}
              onSelect={setSelectedId}
            />
            <div className="globe-grid" aria-hidden="true" />
            <div className="globe-help"><span>DRAG</span> 회전 <i /> <span>SCROLL</span> 확대 <i /> <span>CLICK</span> 추적</div>
            <div className="altitude-note">ALTITUDE VISUALLY COMPRESSED · POSITION IS SGP4</div>
            {selectedEntry && selectedPosition && (
              <article className="selected-card" aria-live="polite">
                <div className="selected-card__head">
                  <span className={`category-badge category-badge--${selectedEntry.category}`}>{selectedEntry.category.toUpperCase()}</span>
                  <button type="button" aria-label={favorites.includes(selectedEntry.id) ? "즐겨찾기 해제" : "즐겨찾기 추가"} onClick={() => toggleFavorite(selectedEntry.id)}>{favorites.includes(selectedEntry.id) ? "★" : "☆"}</button>
                </div>
                <h2>{selectedEntry.name}</h2>
                <p>NORAD {selectedEntry.id} · {selectedEntry.objectId || "DESIGNATOR N/A"}</p>
                <dl>
                  <div><dt>고도</dt><dd>{formatNumber(selectedPosition.altitude)} <small>km</small></dd></div>
                  <div><dt>속도</dt><dd>{formatNumber(selectedPosition.velocity, 2)} <small>km/s</small></dd></div>
                  <div><dt>위도</dt><dd>{formatNumber(selectedPosition.lat, 2)}<small>°</small></dd></div>
                  <div><dt>경도</dt><dd>{formatNumber(selectedPosition.lon, 2)}<small>°</small></dd></div>
                </dl>
                <div className="selected-actions">
                  <button type="button" onClick={() => setFocusNonce((value) => value + 1)}>화면 중앙에 놓기</button>
                  <button type="button" className={storyMode ? "active" : ""} aria-pressed={storyMode} onClick={() => setStoryMode((value) => !value)}>{storyMode ? "스토리 정지" : "스토리 투어"}</button>
                </div>
              </article>
            )}
          </div>

          <aside className="agent-panel" aria-label="실시간 에이전트 브리핑">
            <div className="panel-title"><span>02</span><div><small>AGENT BRIEF</small><strong>지금 알아야 할 것</strong></div></div>
            <div className="agent-tabs" role="tablist" aria-label="브리핑 유형">
              {(["discover", "risk", "sky"] as PanelTab[]).map((tab) => (
                <button key={tab} type="button" role="tab" aria-selected={panelTab === tab} className={panelTab === tab ? "active" : ""} onClick={() => setPanelTab(tab)}>
                  {tab === "discover" ? "발견" : tab === "risk" ? "위험" : "내 하늘"}
                  {tab === "risk" && signals?.conjunctions.length ? <i>{signals.conjunctions.length}</i> : null}
                </button>
              ))}
            </div>

            {panelTab === "discover" && (
              <div className="agent-scroll">
                <article className="agent-lead agent-lead--fun">
                  <div><span>✦ LIVE DISCOVERY</span><time>{relativeTime(simulationTime, simulationTime)}</time></div>
                  <h3>{selectedEntry ? `${selectedEntry.name}을(를) 추적 중입니다.` : "실시간 카탈로그 연결 중"}</h3>
                  <p>{selectedPosition ? `현재 ${selectedPosition.altitude.toFixed(0)} km 상공을 ${selectedPosition.velocity.toFixed(2)} km/s로 이동합니다. 궤도선을 따라 다음 96분의 움직임을 확인할 수 있습니다.` : "최신 궤도요소를 내려받아 현재 위치를 계산하고 있습니다."}</p>
                </article>
                <div className="weather-card">
                  <div className="kp-gauge"><span style={{ "--kp": `${Math.min(100, ((signals?.spaceWeather?.kp ?? 0) / 9) * 100)}%` } as React.CSSProperties} /><b>Kp {signals?.spaceWeather ? signals.spaceWeather.kp.toFixed(1) : "—"}</b></div>
                  <div><span>NOAA SPACE WEATHER</span><strong>{signals?.spaceWeather ? ({ quiet: "조용한 우주환경", active: "활동 증가", storm: "지자기 폭풍", severe: "강한 지자기 폭풍" }[signals.spaceWeather.level]) : "연결 확인 중"}</strong><small>{signals?.spaceWeather ? relativeTime(signals.spaceWeather.time, simulationTime) : "NOAA SWPC"}</small></div>
                </div>
                <div className="insight-grid">
                  <article><span>CATALOG</span><strong>{formatNumber(entries.length)}</strong><small>활성 물체</small></article>
                  <article><span>ON SCREEN</span><strong>{formatNumber(renderEntries.length)}</strong><small>실시간 전파</small></article>
                  <article><span>DECAY</span><strong>{signals?.decays.length ?? "—"}</strong><small>추락 후보</small></article>
                  <article><span>PASSES</span><strong>{passPredictions.length}</strong><small>12시간 내</small></article>
                </div>
                <button type="button" className="agent-action" onClick={pickSurprise}>에이전트에게 다음 장면 맡기기 <span>→</span></button>
              </div>
            )}

            {panelTab === "risk" && (
              <div className="agent-scroll risk-list">
                <div className="risk-disclaimer"><span>!</span><p>SOCRATES 공개 GP 기반 선별입니다. 실제 충돌 회피 판단이나 안전 운용에 사용하면 안 됩니다.</p></div>
                {signals?.conjunctions.length ? signals.conjunctions.slice(0, 7).map((event, index) => (
                  <button type="button" key={`${event.id1}-${event.id2}-${event.tca}`} className={activeConjunction === event ? "risk-row active" : "risk-row"} onClick={() => openConjunction(event)}>
                    <span className="risk-index">0{index + 1}</span>
                    <div><small>{relativeTime(event.tca, simulationTime)} · {event.relativeSpeed.toFixed(2)} km/s</small><strong>{event.name1.replace(/\s\[[^\]]+\]$/, "")}</strong><i>×</i><strong>{event.name2.replace(/\s\[[^\]]+\]$/, "")}</strong></div>
                    <b>{event.rangeKm < 1 ? `${Math.round(event.rangeKm * 1000)} m` : `${event.rangeKm.toFixed(2)} km`}</b>
                  </button>
                )) : <div className="empty-state"><span>◌</span><p>{signals ? "현재 SOCRATES 피드를 불러오지 못했습니다." : "근접접근 피드 연결 중"}</p></div>}
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
                  <div><span>OBSERVER</span><strong>{observer.label}</strong><small>{observer.lat.toFixed(3)}°, {observer.lon.toFixed(3)}°</small></div>
                  <button type="button" onClick={locateMe} disabled={locationState === "loading"}>{locationState === "loading" ? "찾는 중" : "내 위치 사용"}</button>
                </div>
                {locationState === "denied" && <p className="location-error">위치 권한을 사용할 수 없어 서울을 기준으로 계산합니다.</p>}
                <div className="pass-note">고도 10° 이상인 기하학적 통과 예측입니다. 밝기·구름·태양광 조건은 포함하지 않습니다.</div>
                {passPredictions.map((pass, index) => (
                  <button type="button" key={`${pass.id}-${pass.time.toISOString()}`} className="pass-row" onClick={() => selectAndFocus(pass.id)}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{pass.name}</strong><small>{relativeTime(pass.time, simulationTime)} · 방위 {Math.round(pass.azimuth)}°</small></div>
                    <b>{Math.round(pass.maxElevation)}°</b>
                  </button>
                ))}
                {!passPredictions.length && <div className="empty-state"><span>◌</span><p>선택한 주요 위성에서 12시간 내 통과를 찾지 못했습니다.</p></div>}
              </div>
            )}
          </aside>

          <div className="mission-controls">
            <div className="time-control">
              <button type="button" aria-label={pausedAt ? "시간 재생" : "시간 일시정지"} onClick={() => setPausedAt((value) => value ? null : Date.now())}>{pausedAt ? "▶" : "Ⅱ"}</button>
              <div><span>TIME TRAVEL</span><strong>{timeOffset === 0 ? "NOW" : timeOffset < 0 ? `${Math.abs(timeOffset)}M AGO` : `+${Math.floor(timeOffset / 60)}H ${timeOffset % 60}M`}</strong></div>
              <input type="range" min="-90" max="1440" step="15" value={timeOffset} aria-label="궤도 시간 이동" aria-valuetext={simulationTime.toLocaleString("ko-KR")} onChange={(event) => setTimeOffset(Number(event.target.value))} />
              <div className="time-presets"><button type="button" onClick={() => setTimeOffset(-60)}>−1H</button><button type="button" className={timeOffset === 0 ? "active" : ""} onClick={() => setTimeOffset(0)}>NOW</button><button type="button" onClick={() => setTimeOffset(360)}>+6H</button><button type="button" onClick={() => setTimeOffset(1440)}>+24H</button></div>
            </div>
            <div className="display-control">
              <div><span>OBJECT DISPLAY</span><strong>{displayScale}×</strong></div>
              <input type="range" min="1" max={Math.log2(1000)} step="0.01" value={Math.log2(displayScale)} aria-label="위성 표시 크기" aria-valuetext={`${displayScale}배`} onChange={(event) => setDisplayScale(Math.round(2 ** Number(event.target.value)))} />
              <div>{scaleStops.map((stop) => <button type="button" key={stop} className={displayScale === stop ? "active" : ""} aria-pressed={displayScale === stop} onClick={() => setDisplayScale(stop)}>{stop}×</button>)}</div>
            </div>
          </div>
        </section>

        <section className="product-proof" id="why">
          <div className="section-heading"><p>03 / WHY DIFFERENT</p><h2>점을 많이 보여주는 경쟁이 아니라,<br /><em>다음 행동을 쉽게 만드는 경험.</em></h2></div>
          <div className="proof-grid">
            <article><span>01</span><div className="proof-visual proof-visual--focus"><i /><i /><i /><b>✦</b></div><h3>사건 중심 탐색</h3><p>위험·추락·우주기상·관측 기회를 데이터 목록이 아니라 “왜 지금 봐야 하는지”로 설명합니다.</p></article>
            <article><span>02</span><div className="proof-visual proof-visual--time"><b>−1H</b><i /><strong>NOW</strong><i /><b>+24H</b></div><h3>한 화면의 시간여행</h3><p>실시간 위치부터 24시간 뒤 궤도까지 화면을 떠나지 않고 비교합니다. 모든 위치는 같은 SGP4 계산을 사용합니다.</p></article>
            <article><span>03</span><div className="proof-visual proof-visual--sky"><i /><b>37°</b><span>MY SKY</span></div><h3>내 하늘과 바로 연결</h3><p>위치 버튼 한 번으로 주요 위성의 다음 통과를 계산하고, 해당 물체로 즉시 지구를 회전합니다.</p></article>
          </div>
        </section>

        <section className="source-section" id="sources">
          <div className="section-heading"><p>04 / DATA TRANSPARENCY</p><h2>실시간이라는 말보다,<br /><em>출처와 한계를 함께 보여줍니다.</em></h2></div>
          <div className="source-table">
            <a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer"><span>ORBITAL ELEMENTS</span><strong>CelesTrak OMM / USSF GP</strong><small>2시간 캐시 · 9자리 카탈로그 대응</small><b>↗</b></a>
            <a href="https://celestrak.org/SOCRATES/socrates-format.php" target="_blank" rel="noreferrer"><span>CONJUNCTIONS</span><strong>SOCRATES Plus</strong><small>공개 GP 기반 7일 근접접근 선별</small><b>↗</b></a>
            <a href="https://services.swpc.noaa.gov/products/" target="_blank" rel="noreferrer"><span>SPACE WEATHER</span><strong>NOAA SWPC</strong><small>Planetary K-index 실시간 제품</small><b>↗</b></a>
            <div><span>PROPAGATION</span><strong>satellite.js / SGP4</strong><small>브라우저에서 현재 위치·통과 계산</small><b>✓</b></div>
          </div>
          <p className="accuracy-note">이 서비스는 교육·탐색용입니다. 공개 GP 궤도요소에는 관측 오차와 갱신 지연이 있으며, 충돌 회피·항법·안전 운용 등 임무 핵심 판단에 사용할 수 없습니다.</p>
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
