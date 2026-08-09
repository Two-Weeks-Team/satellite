import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, json2satrec, propagate, type OMMJsonObject } from "satellite.js";
import { loadCatalog, type CompactOmm } from "../catalog/route";
import { loadSignals } from "../signals/route";

type LocalizedText = { en: string; ko: string; ja: string };
type AgentEvent = {
  id: string;
  kind: "risk" | "discovery" | "sky" | "weather" | "decay";
  agent: "SENTINEL" | "SCOUT" | "SKY";
  priority: number;
  title: LocalizedText;
  body: LocalizedText;
  confidence: number;
  evidence: string[];
  createdAt: string;
  action: {
    focusIds?: number[];
    filter?: "all" | "station" | "starlink" | "weather" | "navigation" | "science";
    colorMode?: "type" | "constellation" | "altitude" | "risk";
    panel?: "discover" | "risk" | "sky";
    timeAt?: string;
  };
};

function tupleToOmm(tuple: CompactOmm): OMMJsonObject {
  return {
    OBJECT_NAME: tuple[0], NORAD_CAT_ID: tuple[1], OBJECT_ID: tuple[2], EPOCH: tuple[3], MEAN_MOTION: tuple[4],
    ECCENTRICITY: tuple[5], INCLINATION: tuple[6], RA_OF_ASC_NODE: tuple[7], ARG_OF_PERICENTER: tuple[8],
    MEAN_ANOMALY: tuple[9], EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: tuple[11], ELEMENT_SET_NO: tuple[12],
    REV_AT_EPOCH: tuple[13], BSTAR: tuple[14], MEAN_MOTION_DOT: tuple[15], MEAN_MOTION_DDOT: tuple[16],
  };
}

function nextVisiblePass(tuple: CompactOmm, lat: number, lon: number, start: Date) {
  try {
    const satrec = json2satrec(tupleToOmm(tuple));
    const observer = { latitude: degreesToRadians(lat), longitude: degreesToRadians(lon), height: 0.05 };
    let peak = -90;
    let peakTime = start;
    let inPass = false;
    for (let step = 0; step <= 144; step += 1) {
      const time = new Date(start.getTime() + step * 5 * 60_000);
      const result = propagate(satrec, time);
      if (!result) continue;
      const look = ecfToLookAngles(observer, eciToEcf(result.position, gstime(time)));
      const elevation = look.elevation * 180 / Math.PI;
      if (elevation >= 12) {
        inPass = true;
        if (elevation > peak) {
          peak = elevation;
          peakTime = time;
        }
      } else if (inPass) {
        return { time: peakTime, elevation: peak };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function observerFromRequest(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  return {
    lat: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : 37.5665,
    lon: Number.isFinite(lon) && lon >= -180 && lon <= 180 ? lon : 126.978,
  };
}

export async function GET(request: Request) {
  const cycleStartedAt = new Date();
  const observer = observerFromRequest(request);
  const [catalog, signals] = await Promise.all([loadCatalog(), loadSignals()]);
  const events: AgentEvent[] = [];
  const topConjunction = signals.conjunctions[0];
  if (topConjunction) {
    const distance = topConjunction.rangeKm < 1 ? `${Math.round(topConjunction.rangeKm * 1000)} m` : `${topConjunction.rangeKm.toFixed(2)} km`;
    events.push({
      id: `risk-${topConjunction.id1}-${topConjunction.id2}-${topConjunction.tca}`,
      kind: "risk", agent: "SENTINEL", priority: 96,
      title: { en: "Close-approach candidate detected", ko: "근접 접근 후보를 탐지했습니다", ja: "接近候補を検出しました" },
      body: {
        en: `${topConjunction.name1} and ${topConjunction.name2} have a public-GP screening range of ${distance}. I can isolate the pair and move to the event time.`,
        ko: `${topConjunction.name1}와 ${topConjunction.name2}의 공개 GP 선별 거리는 ${distance}입니다. 두 물체만 분리하고 사건 시각으로 이동할 수 있습니다.`,
        ja: `${topConjunction.name1}と${topConjunction.name2}の公開GPスクリーニング距離は${distance}です。2機を分離し、イベント時刻へ移動できます。`,
      },
      confidence: 0.91,
      evidence: ["CelesTrak SOCRATES Plus", `TCA ${topConjunction.tca}`, `Relative speed ${topConjunction.relativeSpeed.toFixed(2)} km/s`],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [topConjunction.id1, topConjunction.id2], filter: "all", colorMode: "risk", panel: "risk", timeAt: topConjunction.tca },
    });
  }

  const starlinks = catalog.items.filter((tuple) => tuple[0].toUpperCase().includes("STARLINK"));
  if (starlinks.length) {
    const shells = new Set(starlinks.map((tuple) => Math.round(tuple[6] / 5) * 5));
    const focus = starlinks[Math.floor(starlinks.length * 0.37)];
    events.push({
      id: `discovery-starlink-${Math.floor(Date.parse(catalog.fetchedAt) / 3_600_000)}`,
      kind: "discovery", agent: "SCOUT", priority: 82,
      title: { en: "Constellation structure mapped", ko: "스타링크 군집 구조를 분석했습니다", ja: "Starlinkのコンステレーション構造を解析しました" },
      body: {
        en: `I grouped ${starlinks.length.toLocaleString("en-US")} Starlink objects into ${shells.size} inclination families. Switch to constellation color to reveal the orbital shells.`,
        ko: `스타링크 ${starlinks.length.toLocaleString("ko-KR")}개를 ${shells.size}개 경사각 계열로 묶었습니다. 군집 색상으로 전환하면 궤도 셸 구조를 볼 수 있습니다.`,
        ja: `Starlink ${starlinks.length.toLocaleString("ja-JP")}機を${shells.size}つの軌道傾斜角グループに分類しました。コンステレーション色で軌道シェルを確認できます。`,
      },
      confidence: 0.98,
      evidence: ["CelesTrak active catalog", `${shells.size} inclination families`, `Catalog epoch ${catalog.fetchedAt}`],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [focus[1]], filter: "starlink", colorMode: "constellation", panel: "discover" },
    });
  }

  if (signals.spaceWeather) {
    const kp = signals.spaceWeather.kp.toFixed(1);
    events.push({
      id: `weather-${signals.spaceWeather.time}`,
      kind: "weather", agent: "SENTINEL", priority: signals.spaceWeather.kp >= 5 ? 90 : 58,
      title: signals.spaceWeather.kp >= 5
        ? { en: "Geomagnetic storm conditions", ko: "지자기 폭풍 상태를 감지했습니다", ja: "磁気嵐の状態を検出しました" }
        : { en: "Space weather scan complete", ko: "우주기상 점검을 완료했습니다", ja: "宇宙天気のスキャンが完了しました" },
      body: {
        en: `NOAA reports Kp ${kp}. I am watching navigation and low-orbit objects for increased operational relevance.`,
        ko: `NOAA의 현재 지수는 Kp ${kp}입니다. 항법위성과 저궤도 물체의 운용 관련성을 계속 감시합니다.`,
        ja: `NOAAの現在値はKp ${kp}です。測位衛星と低軌道物体への影響を監視します。`,
      },
      confidence: 0.99,
      evidence: ["NOAA SWPC", `Kp ${kp}`, signals.spaceWeather.time],
      createdAt: cycleStartedAt.toISOString(),
      action: { filter: signals.spaceWeather.kp >= 5 ? "navigation" : "all", colorMode: signals.spaceWeather.kp >= 5 ? "risk" : "type", panel: "discover" },
    });
  }

  const skyCandidates = catalog.items.filter((tuple) => /ISS|TIANHE|TIANGONG|HST|HUBBLE/.test(tuple[0].toUpperCase())).slice(0, 8);
  const nextPass = skyCandidates
    .map((tuple) => ({ tuple, pass: nextVisiblePass(tuple, observer.lat, observer.lon, cycleStartedAt) }))
    .filter((candidate): candidate is { tuple: CompactOmm; pass: { time: Date; elevation: number } } => candidate.pass !== null)
    .sort((a, b) => a.pass.time.getTime() - b.pass.time.getTime())[0];
  if (nextPass) {
    const minutes = Math.max(1, Math.round((nextPass.pass.time.getTime() - cycleStartedAt.getTime()) / 60_000));
    events.push({
      id: `sky-${nextPass.tuple[1]}-${Math.floor(nextPass.pass.time.getTime() / 600_000)}`,
      kind: "sky", agent: "SKY", priority: minutes <= 90 ? 88 : 70,
      title: { en: "A visible pass is approaching", ko: "관측 가능한 통과가 다가옵니다", ja: "観測可能な通過が近づいています" },
      body: {
        en: `${nextPass.tuple[0]} reaches about ${Math.round(nextPass.pass.elevation)}° elevation from your observer location in ${minutes} minutes.`,
        ko: `${nextPass.tuple[0]}이(가) 약 ${minutes}분 후 현재 관측 위치에서 최대 고도 ${Math.round(nextPass.pass.elevation)}°에 도달합니다.`,
        ja: `${nextPass.tuple[0]}は約${minutes}分後、現在の観測地点から最大仰角${Math.round(nextPass.pass.elevation)}°に達します。`,
      },
      confidence: 0.87,
      evidence: ["SGP4 public GP prediction", `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°`, `Minimum elevation 12°`],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [nextPass.tuple[1]], filter: "station", colorMode: "type", panel: "sky", timeAt: nextPass.pass.time.toISOString() },
    });
  }

  events.sort((a, b) => b.priority - a.priority);
  return Response.json({
    status: catalog.status === "live" ? "active" : "degraded",
    cycleStartedAt: cycleStartedAt.toISOString(),
    monitoredObjects: catalog.count,
    evaluatedSignals: catalog.count + signals.conjunctions.length + signals.decays.length + (signals.spaceWeather ? 1 : 0),
    agents: [
      { id: "SENTINEL", state: "watching", detail: `${signals.conjunctions.length} conjunctions · ${signals.decays.length} decays` },
      { id: "SCOUT", state: "mapping", detail: `${starlinks.length} Starlink objects` },
      { id: "SKY", state: "predicting", detail: `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°` },
    ],
    events: events.slice(0, 6),
  }, { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } });
}
