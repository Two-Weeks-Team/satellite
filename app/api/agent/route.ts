import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, json2satrec, propagate, type OMMJsonObject } from "satellite.js";
import type { HistoryObjectInsight } from "@/lib/history-intelligence";
import { loadCatalog, type CompactOmm } from "../catalog/route";
import { loadHistoryIntelligence } from "../intelligence/route";
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
  evidence: LocalizedText[];
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function predictionConfidence(insight: HistoryObjectInsight | undefined) {
  if (!insight) return 0.5;
  return clamp(0.5 + insight.stability * 0.4 + Math.min(0.08, insight.samples * 0.02), 0.5, 0.96);
}

function localized(en: string, ko: string, ja: string): LocalizedText {
  return { en, ko, ja };
}

function historyEvidence(insight: HistoryObjectInsight | undefined): LocalizedText {
  if (!insight) {
    return localized(
      "Historical orbital baseline unavailable",
      "과거 궤도 기준선을 사용할 수 없음",
      "過去の軌道ベースラインを利用できません",
    );
  }
  if (insight.samples < 2) {
    return localized(
      "Historical baseline: 1 daily sample · calibration collecting",
      "과거 기준선: 일별 표본 1개 · 보정 데이터 수집 중",
      "過去ベースライン: 日次サンプル1件 · 較正データ収集中",
    );
  }
  const stability = Math.round(insight.stability * 100);
  return localized(
    `Historical baseline: ${insight.samples} daily samples · ${stability}% stability`,
    `과거 기준선: 일별 표본 ${insight.samples}개 · 안정도 ${stability}%`,
    `過去ベースライン: 日次サンプル${insight.samples}件 · 安定度${stability}%`,
  );
}

export async function GET(request: Request) {
  const cycleStartedAt = new Date();
  const observer = observerFromRequest(request);
  const [catalog, signals] = await Promise.all([loadCatalog(), loadSignals()]);
  const url = new URL(request.url);
  const requestedNorad = Number(url.searchParams.get("norad"));
  const requestedId = Number.isInteger(requestedNorad) && requestedNorad > 0 ? requestedNorad : null;
  const topConjunction = signals.conjunctions[0];
  const starlinks = catalog.items.filter((tuple) => tuple[0].toUpperCase().includes("STARLINK"));
  const scoutFocus = starlinks.length ? starlinks[Math.floor(starlinks.length * 0.37)] : null;
  const skyCandidates = catalog.items.filter((tuple) => /ISS|TIANHE|TIANGONG|HST|HUBBLE/.test(tuple[0].toUpperCase())).slice(0, 8);
  const nextPass = skyCandidates
    .map((tuple) => ({ tuple, pass: nextVisiblePass(tuple, observer.lat, observer.lon, cycleStartedAt) }))
    .filter((candidate): candidate is { tuple: CompactOmm; pass: { time: Date; elevation: number } } => candidate.pass !== null)
    .sort((a, b) => a.pass.time.getTime() - b.pass.time.getTime())[0];
  const intelligenceIds = new Set<number>();
  if (topConjunction) {
    intelligenceIds.add(topConjunction.id1);
    intelligenceIds.add(topConjunction.id2);
  }
  if (scoutFocus) intelligenceIds.add(scoutFocus[1]);
  if (nextPass) intelligenceIds.add(nextPass.tuple[1]);
  if (requestedId) intelligenceIds.add(requestedId);
  const intelligence = await loadHistoryIntelligence(intelligenceIds);
  const insightByNorad = new Map(intelligence.objects.map((item) => [item.noradId, item]));
  const events: AgentEvent[] = [];
  if (topConjunction) {
    const distance = topConjunction.rangeKm < 1 ? `${Math.round(topConjunction.rangeKm * 1000)} m` : `${topConjunction.rangeKm.toFixed(2)} km`;
    const observations = topConjunction.history?.observations ?? 1;
    const persistenceBoost = Math.min(8, Math.max(0, observations - 1) * 2);
    const severityBoost = topConjunction.rangeKm < 0.1 ? 4 : topConjunction.rangeKm < 1 ? 2 : 0;
    events.push({
      id: `risk-${topConjunction.id1}-${topConjunction.id2}-${topConjunction.tca}`,
      kind: "risk", agent: "SENTINEL", priority: Math.round(clamp(86 + persistenceBoost + severityBoost, 86, 98)),
      title: { en: "Close-approach candidate detected", ko: "근접 접근 후보를 탐지했습니다", ja: "接近候補を検出しました" },
      body: {
        en: `${topConjunction.name1} and ${topConjunction.name2} have a public-GP screening range of ${distance}. I can isolate the pair and move to the event time.`,
        ko: `${topConjunction.name1}와 ${topConjunction.name2}의 공개 GP 선별 거리는 ${distance}입니다. 두 물체만 분리하고 사건 시각으로 이동할 수 있습니다.`,
        ja: `${topConjunction.name1}と${topConjunction.name2}の公開GPスクリーニング距離は${distance}です。2機を分離し、イベント時刻へ移動できます。`,
      },
      confidence: clamp(0.72 + Math.min(0.16, observations * 0.02) + (topConjunction.history ? 0.03 : 0), 0.72, 0.93),
      evidence: [
        localized("CelesTrak SOCRATES Plus", "CelesTrak SOCRATES Plus", "CelesTrak SOCRATES Plus"),
        localized(
          `Observed in ${observations} ingestion cycle${observations === 1 ? "" : "s"}`,
          `${observations}회 수집 주기에서 관측`,
          `${observations}回の収集サイクルで観測`,
        ),
        localized(
          `Minimum recorded range ${((topConjunction.history?.minRangeKm ?? topConjunction.rangeKm) * 1000).toFixed(0)} m`,
          `기록된 최소 거리 ${((topConjunction.history?.minRangeKm ?? topConjunction.rangeKm) * 1000).toFixed(0)} m`,
          `記録された最小距離 ${((topConjunction.history?.minRangeKm ?? topConjunction.rangeKm) * 1000).toFixed(0)} m`,
        ),
        localized(
          `TCA ${topConjunction.tca} · ${topConjunction.relativeSpeed.toFixed(2)} km/s`,
          `최근접 시각 ${topConjunction.tca} · ${topConjunction.relativeSpeed.toFixed(2)} km/s`,
          `最接近時刻 ${topConjunction.tca} · ${topConjunction.relativeSpeed.toFixed(2)} km/s`,
        ),
      ],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [topConjunction.id1, topConjunction.id2], filter: "all", colorMode: "risk", panel: "risk", timeAt: topConjunction.tca },
    });
  }

  if (scoutFocus) {
    const shells = new Set(starlinks.map((tuple) => Math.round(tuple[6] / 5) * 5));
    const focusInsight = insightByNorad.get(scoutFocus[1]);
    const baselineDays = intelligence.history.sampleDays;
    events.push({
      id: `discovery-starlink-${Math.floor(Date.parse(catalog.fetchedAt) / 3_600_000)}`,
      kind: "discovery", agent: "SCOUT", priority: Math.round(clamp(76 + Math.min(8, baselineDays), 76, 86)),
      title: { en: "Constellation structure mapped", ko: "스타링크 군집 구조를 분석했습니다", ja: "Starlinkのコンステレーション構造を解析しました" },
      body: {
        en: `I grouped ${starlinks.length.toLocaleString("en-US")} Starlink objects into ${shells.size} inclination families. Switch to constellation color to reveal the orbital shells.`,
        ko: `스타링크 ${starlinks.length.toLocaleString("ko-KR")}개를 ${shells.size}개 경사각 계열로 묶었습니다. 군집 색상으로 전환하면 궤도 셸 구조를 볼 수 있습니다.`,
        ja: `Starlink ${starlinks.length.toLocaleString("ja-JP")}機を${shells.size}つの軌道傾斜角グループに分類しました。コンステレーション色で軌道シェルを確認できます。`,
      },
      confidence: clamp(0.58 + Math.min(0.24, baselineDays * 0.04) + (focusInsight?.stability ?? 0) * 0.12, 0.58, 0.94),
      evidence: [
        localized("CelesTrak active catalog", "CelesTrak 활성 카탈로그", "CelesTrakアクティブカタログ"),
        localized(`${shells.size} inclination families`, `${shells.size}개 경사각 계열`, `${shells.size}つの軌道傾斜角グループ`),
        historyEvidence(focusInsight),
        localized(`Catalog epoch ${catalog.fetchedAt}`, `카탈로그 기준 시각 ${catalog.fetchedAt}`, `カタログ基準時刻 ${catalog.fetchedAt}`),
      ],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [scoutFocus[1]], filter: "starlink", colorMode: "constellation", panel: "discover" },
    });
  }

  const topDecay = [...signals.decays].sort((a, b) => {
    const observationDelta = (b.history?.observations ?? 1) - (a.history?.observations ?? 1);
    return observationDelta || Math.abs(b.history?.bstarDelta ?? 0) - Math.abs(a.history?.bstarDelta ?? 0);
  })[0];
  if (topDecay) {
    const observations = topDecay.history?.observations ?? 1;
    const bstarDirection = (topDecay.history?.bstarDelta ?? 0) > 0 ? "rising" : "stable or falling";
    events.push({
      id: `decay-${topDecay.id}-${topDecay.epoch}`,
      kind: "decay", agent: "SENTINEL", priority: Math.round(clamp(62 + Math.min(12, observations * 2), 64, 78)),
      title: { en: "Decay trend remains active", ko: "추락 추세가 계속 관측됩니다", ja: "減衰傾向を継続観測しています" },
      body: {
        en: `${topDecay.name} remains in the potential-decay feed after ${observations} ingestion cycle${observations === 1 ? "" : "s"}. Its BSTAR trend is ${bstarDirection}.`,
        ko: `${topDecay.name}이(가) ${observations}회 수집 주기 동안 추락 후보 피드에서 관측됐습니다. BSTAR 추세는 ${bstarDirection === "rising" ? "상승" : "안정 또는 하락"}입니다.`,
        ja: `${topDecay.name}は${observations}回の収集サイクルで減衰候補として観測されています。BSTAR傾向は${bstarDirection === "rising" ? "上昇" : "安定または低下"}です。`,
      },
      confidence: clamp(0.58 + Math.min(0.28, observations * 0.035), 0.58, 0.88),
      evidence: [
        localized("CelesTrak Potential Decays", "CelesTrak 추락 후보", "CelesTrak落下候補"),
        localized(
          `Observed in ${observations} ingestion cycle${observations === 1 ? "" : "s"}`,
          `${observations}회 수집 주기에서 관측`,
          `${observations}回の収集サイクルで観測`,
        ),
        localized(
          `BSTAR change ${(topDecay.history?.bstarDelta ?? 0).toExponential(2)}`,
          `BSTAR 변화 ${(topDecay.history?.bstarDelta ?? 0).toExponential(2)}`,
          `BSTAR変化 ${(topDecay.history?.bstarDelta ?? 0).toExponential(2)}`,
        ),
      ],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [topDecay.id], filter: "all", colorMode: "risk", panel: "risk" },
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
      confidence: clamp(0.9 + Math.min(0.09, intelligence.history.weatherObservations * 0.005), 0.9, 0.99),
      evidence: [
        localized("NOAA SWPC", "NOAA SWPC", "NOAA SWPC"),
        localized(`Kp ${kp}`, `Kp ${kp}`, `Kp ${kp}`),
        localized(
          `${intelligence.history.weatherObservations} retained observations`,
          `관측 기록 ${intelligence.history.weatherObservations}개 보존`,
          `観測記録${intelligence.history.weatherObservations}件を保持`,
        ),
        localized(signals.spaceWeather.time, signals.spaceWeather.time, signals.spaceWeather.time),
      ],
      createdAt: cycleStartedAt.toISOString(),
      action: { filter: signals.spaceWeather.kp >= 5 ? "navigation" : "all", colorMode: signals.spaceWeather.kp >= 5 ? "risk" : "type", panel: "discover" },
    });
  }

  if (nextPass) {
    const minutes = Math.max(1, Math.round((nextPass.pass.time.getTime() - cycleStartedAt.getTime()) / 60_000));
    const passInsight = insightByNorad.get(nextPass.tuple[1]);
    events.push({
      id: `sky-${nextPass.tuple[1]}-${Math.floor(nextPass.pass.time.getTime() / 600_000)}`,
      kind: "sky", agent: "SKY", priority: (minutes <= 90 ? 88 : 70) + (passInsight?.samples && passInsight.samples >= 2 ? 1 : 0),
      title: { en: "A visible pass is approaching", ko: "관측 가능한 통과가 다가옵니다", ja: "観測可能な通過が近づいています" },
      body: {
        en: `${nextPass.tuple[0]} reaches about ${Math.round(nextPass.pass.elevation)}° elevation from your observer location in ${minutes} minutes.`,
        ko: `${nextPass.tuple[0]}이(가) 약 ${minutes}분 후 현재 관측 위치에서 최대 고도 ${Math.round(nextPass.pass.elevation)}°에 도달합니다.`,
        ja: `${nextPass.tuple[0]}は約${minutes}分後、現在の観測地点から最大仰角${Math.round(nextPass.pass.elevation)}°に達します。`,
      },
      confidence: predictionConfidence(passInsight),
      evidence: [
        localized("SGP4 public GP prediction", "SGP4 공개 GP 예측", "SGP4公開GP予測"),
        historyEvidence(passInsight),
        passInsight
          ? localized(
            `Mean-motion trend ${passInsight.meanMotionTrendPerDay.toExponential(2)} rev/day²`,
            `평균 운동 추세 ${passInsight.meanMotionTrendPerDay.toExponential(2)} rev/day²`,
            `平均運動トレンド ${passInsight.meanMotionTrendPerDay.toExponential(2)} rev/day²`,
          )
          : localized("Calibration pending", "보정 대기 중", "較正待機中"),
        localized(
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}° · minimum elevation 12°`,
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}° · 최소 고도 12°`,
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}° · 最小仰角12°`,
        ),
      ],
      createdAt: cycleStartedAt.toISOString(),
      action: { focusIds: [nextPass.tuple[1]], filter: "station", colorMode: "type", panel: "sky", timeAt: nextPass.pass.time.toISOString() },
    });
  }

  events.sort((a, b) => b.priority - a.priority);
  const predictionTargetId = requestedId ?? nextPass?.tuple[1] ?? null;
  const predictionInsight = predictionTargetId ? insightByNorad.get(predictionTargetId) : undefined;
  return Response.json({
    status: catalog.status === "live" ? "active" : "degraded",
    cycleStartedAt: cycleStartedAt.toISOString(),
    monitoredObjects: catalog.count,
    evaluatedSignals: catalog.count + signals.conjunctions.length + signals.decays.length + (signals.spaceWeather ? 1 : 0),
    history: intelligence.history,
    prediction: {
      method: "SGP4 with historical orbital-element stability calibration",
      mode: predictionInsight?.mode ?? "collecting",
      noradId: predictionTargetId,
      samples: predictionInsight?.samples ?? 0,
      stability: predictionInsight?.stability ?? 0,
      confidence: predictionConfidence(predictionInsight),
      meanMotionTrendPerDay: predictionInsight?.meanMotionTrendPerDay ?? 0,
    },
    agents: [
      {
        id: "SENTINEL",
        state: localized("watching history", "이력 감시 중", "履歴を監視中"),
        detail: localized(
          `${intelligence.history.persistentConjunctions} persistent conjunctions · ${intelligence.history.persistentDecayEvents} persistent decays`,
          `지속 근접접근 ${intelligence.history.persistentConjunctions}건 · 지속 추락 후보 ${intelligence.history.persistentDecayEvents}건`,
          `継続接近${intelligence.history.persistentConjunctions}件 · 継続落下候補${intelligence.history.persistentDecayEvents}件`,
        ),
      },
      {
        id: "SCOUT",
        state: localized("mapping change", "변화 지도화 중", "変化をマッピング中"),
        detail: localized(
          `${starlinks.length} Starlink objects · ${intelligence.history.sampleDays} history days`,
          `Starlink ${starlinks.length}개 · 이력 ${intelligence.history.sampleDays}일`,
          `Starlink ${starlinks.length}機 · 履歴${intelligence.history.sampleDays}日`,
        ),
      },
      {
        id: "SKY",
        state: predictionInsight?.mode === "history-calibrated"
          ? localized("history-calibrated", "이력 보정 완료", "履歴による較正済み")
          : localized("collecting baseline", "기준선 수집 중", "ベースライン収集中"),
        detail: localized(
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°`,
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°`,
          `${observer.lat.toFixed(2)}°, ${observer.lon.toFixed(2)}°`,
        ),
      },
    ],
    events: events.slice(0, 6),
  }, { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } });
}
