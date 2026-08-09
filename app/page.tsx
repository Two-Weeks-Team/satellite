"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type EventKind = "risk" | "fun";

type SatelliteEvent = {
  id: number;
  kind: EventKind;
  label: string;
  object: string;
  timing: string;
  summary: string;
  detail: string;
};

type Satellite = {
  name: string;
  type: string;
  altitude: string;
  velocity: string;
  inclination: string;
  x: number;
  y: number;
  tone: "lime" | "cyan" | "amber";
};

const satellites: Satellite[] = [
  {
    name: "ISS (ZARYA)",
    type: "CREWED STATION",
    altitude: "419 km",
    velocity: "7.66 km/s",
    inclination: "51.64°",
    x: 63,
    y: 31,
    tone: "lime",
  },
  {
    name: "NOAA 20",
    type: "WEATHER",
    altitude: "824 km",
    velocity: "7.45 km/s",
    inclination: "98.72°",
    x: 35,
    y: 23,
    tone: "cyan",
  },
  {
    name: "STARLINK-32145",
    type: "COMMUNICATION",
    altitude: "551 km",
    velocity: "7.59 km/s",
    inclination: "53.21°",
    x: 72,
    y: 57,
    tone: "lime",
  },
  {
    name: "COSMOS 1408 DEB",
    type: "DEBRIS",
    altitude: "467 km",
    velocity: "7.63 km/s",
    inclination: "82.56°",
    x: 25,
    y: 62,
    tone: "amber",
  },
  {
    name: "OBJECT 59218",
    type: "DECAY WATCH",
    altitude: "189 km",
    velocity: "7.81 km/s",
    inclination: "44.03°",
    x: 49,
    y: 72,
    tone: "amber",
  },
];

const events: SatelliteEvent[] = [
  {
    id: 0,
    kind: "risk",
    label: "NEAR MISS",
    object: "COSMOS 1408 DEB",
    timing: "T−01:42:18",
    summary: "예상 최소 거리 0.8 km",
    detail: "두 궤도의 교차 가능성이 평소 임계치를 넘었습니다. 다음 갱신에서 오차 범위를 다시 계산합니다.",
  },
  {
    id: 1,
    kind: "fun",
    label: "VISIBLE PASS",
    object: "ISS (ZARYA)",
    timing: "20:41 KST",
    summary: "서울 상공에서 6분간 관측",
    detail: "북서쪽 낮은 하늘에서 나타나 남동쪽으로 이동합니다. 최대 고도각은 58°입니다.",
  },
  {
    id: 2,
    kind: "fun",
    label: "TRAIN SPOTTED",
    object: "STARLINK-32145",
    timing: "21:07 KST",
    summary: "일렬 편대 18기 포착",
    detail: "해가 진 직후 같은 궤도를 따라가는 밝은 위성군을 볼 수 있는 조건입니다.",
  },
  {
    id: 3,
    kind: "risk",
    label: "DECAY WATCH",
    object: "OBJECT 59218",
    timing: "NEXT 06H",
    summary: "고도 하락 패턴 감지",
    detail: "최근 궤도 갱신에서 예상보다 빠른 고도 저하가 나타났습니다. 대기권 재진입 구간을 추적합니다.",
  },
];

const scaleStops = [2, 25, 100, 1000];

function OrbitCanvas({ scale, mode }: { scale: number; mode: "all" | EventKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let animationFrame = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const seeded = Array.from({ length: 104 }, (_, index) => ({
      orbit: 0.37 + ((index * 37) % 100) / 310,
      phase: ((index * 83) % 360) * (Math.PI / 180),
      speed: 0.00012 + ((index * 19) % 13) * 0.000013,
      tilt: -0.55 + ((index * 29) % 100) / 90,
      importance: index % 21 === 0,
    }));

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(bounds.width, 1);
      const height = Math.max(bounds.height, 1);

      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const centerX = width * 0.49;
      const centerY = height * 0.47;
      const radius = Math.min(width, height) * (width < 700 ? 0.245 : 0.285);
      const time = reduceMotion ? 0 : frame;

      const halo = context.createRadialGradient(centerX, centerY, radius * 0.7, centerX, centerY, radius * 1.8);
      halo.addColorStop(0, "rgba(55, 232, 181, 0.13)");
      halo.addColorStop(0.52, "rgba(58, 155, 255, 0.05)");
      halo.addColorStop(1, "rgba(4, 7, 11, 0)");
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);

      context.save();
      context.strokeStyle = "rgba(148, 174, 191, 0.16)";
      context.lineWidth = 1;
      [1.28, 1.57, 1.91].forEach((ring, index) => {
        context.save();
        context.translate(centerX, centerY);
        context.rotate([-0.28, 0.38, -0.68][index]);
        context.beginPath();
        context.ellipse(0, 0, radius * ring, radius * ring * 0.37, 0, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      });
      context.restore();

      const earth = context.createRadialGradient(
        centerX - radius * 0.38,
        centerY - radius * 0.46,
        radius * 0.08,
        centerX,
        centerY,
        radius * 1.08,
      );
      earth.addColorStop(0, "#245b75");
      earth.addColorStop(0.42, "#12384b");
      earth.addColorStop(0.76, "#0a2130");
      earth.addColorStop(1, "#03070c");
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fillStyle = earth;
      context.fill();
      context.strokeStyle = "rgba(126, 239, 218, 0.36)";
      context.lineWidth = 1.2;
      context.stroke();

      context.save();
      context.beginPath();
      context.arc(centerX, centerY, radius - 1, 0, Math.PI * 2);
      context.clip();

      context.strokeStyle = "rgba(96, 211, 201, 0.16)";
      context.lineWidth = 0.7;
      [-0.58, -0.29, 0, 0.29, 0.58].forEach((latitude) => {
        const y = centerY + Math.sin(latitude) * radius;
        const widthAtLatitude = Math.cos(latitude) * radius;
        context.beginPath();
        context.ellipse(centerX, y, widthAtLatitude, radius * 0.1, 0, 0, Math.PI * 2);
        context.stroke();
      });

      for (let longitude = -2; longitude <= 2; longitude += 1) {
        context.beginPath();
        context.ellipse(centerX, centerY, radius * (0.18 + Math.abs(longitude) * 0.14), radius, 0, 0, Math.PI * 2);
        context.stroke();
      }

      context.fillStyle = "rgba(75, 137, 110, 0.4)";
      context.beginPath();
      context.moveTo(centerX - radius * 0.73, centerY - radius * 0.43);
      context.bezierCurveTo(centerX - radius * 0.4, centerY - radius * 0.72, centerX - radius * 0.2, centerY - radius * 0.44, centerX - radius * 0.3, centerY - radius * 0.14);
      context.bezierCurveTo(centerX - radius * 0.44, centerY + radius * 0.05, centerX - radius * 0.17, centerY + radius * 0.37, centerX - radius * 0.33, centerY + radius * 0.63);
      context.bezierCurveTo(centerX - radius * 0.65, centerY + radius * 0.43, centerX - radius * 0.81, centerY + radius * 0.02, centerX - radius * 0.73, centerY - radius * 0.43);
      context.fill();

      context.beginPath();
      context.moveTo(centerX + radius * 0.08, centerY - radius * 0.58);
      context.bezierCurveTo(centerX + radius * 0.38, centerY - radius * 0.65, centerX + radius * 0.74, centerY - radius * 0.35, centerX + radius * 0.65, centerY - radius * 0.05);
      context.bezierCurveTo(centerX + radius * 0.52, centerY + radius * 0.21, centerX + radius * 0.64, centerY + radius * 0.44, centerX + radius * 0.32, centerY + radius * 0.58);
      context.bezierCurveTo(centerX + radius * 0.11, centerY + radius * 0.31, centerX - radius * 0.05, centerY - radius * 0.11, centerX + radius * 0.08, centerY - radius * 0.58);
      context.fill();

      const night = context.createLinearGradient(centerX - radius, centerY, centerX + radius, centerY);
      night.addColorStop(0, "rgba(1, 3, 8, 0.08)");
      night.addColorStop(0.58, "rgba(1, 3, 8, 0.22)");
      night.addColorStop(1, "rgba(1, 3, 8, 0.86)");
      context.fillStyle = night;
      context.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
      context.restore();

      const dotSize = 0.75 + Math.log10(scale) * 0.52;
      seeded.forEach((point, index) => {
        const angle = point.phase + time * point.speed;
        const orbitRadius = radius * (1.08 + point.orbit);
        const x = centerX + Math.cos(angle) * orbitRadius;
        const y = centerY + Math.sin(angle) * orbitRadius * (0.34 + Math.abs(point.tilt) * 0.18) + Math.sin(point.tilt) * radius * 0.18;
        const visible = mode === "all" || (mode === "risk" ? index % 17 === 0 : index % 9 === 0);
        if (!visible) return;
        context.beginPath();
        context.arc(x, y, point.importance ? dotSize * 1.5 : dotSize, 0, Math.PI * 2);
        context.fillStyle = point.importance
          ? mode === "risk"
            ? "rgba(255, 136, 98, 0.9)"
            : "rgba(190, 255, 104, 0.95)"
          : "rgba(199, 224, 228, 0.46)";
        context.fill();
      });

      frame += 1;
      animationFrame = window.requestAnimationFrame(draw);
    };

    draw();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [scale, mode]);

  return <canvas ref={canvasRef} className="orbit-canvas" aria-hidden="true" />;
}

function SatelliteGlyph({ size = "medium" }: { size?: "small" | "medium" | "large" }) {
  return (
    <span className={`satellite-glyph satellite-glyph--${size}`} aria-hidden="true">
      <span className="satellite-glyph__panel satellite-glyph__panel--left" />
      <span className="satellite-glyph__body" />
      <span className="satellite-glyph__panel satellite-glyph__panel--right" />
      <span className="satellite-glyph__dish" />
    </span>
  );
}

export default function Home() {
  const [scale, setScale] = useState(25);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"all" | EventKind>("all");
  const [activeEvent, setActiveEvent] = useState(0);
  const [clock, setClock] = useState("--:--:--");
  const [menuOpen, setMenuOpen] = useState(false);

  const markerSize = useMemo(() => Math.round(10 + Math.log10(scale / 2 + 1) * 10), [scale]);
  const visibleEvents = mode === "all" ? events : events.filter((event) => event.kind === mode);
  const chosenSatellite = satellites[selected];
  const chosenEvent = events[activeEvent];

  useEffect(() => {
    const tick = () => {
      setClock(
        new Intl.DateTimeFormat("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: "Asia/Seoul",
        }).format(new Date()),
      );
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const selectEvent = (event: SatelliteEvent) => {
    setActiveEvent(event.id);
    const nextSelected = satellites.findIndex((satellite) => satellite.name === event.object);
    if (nextSelected >= 0) setSelected(nextSelected);
  };

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="satellite.agentba.se 홈">
          <span className="brand-orbit" aria-hidden="true"><span /></span>
          <span>satellite<span className="brand-dim">.agentba.se</span></span>
        </a>
        <nav className={menuOpen ? "site-nav site-nav--open" : "site-nav"} aria-label="주요 메뉴">
          <a href="#orbit" onClick={() => setMenuOpen(false)}>Orbit</a>
          <a href="#agent" onClick={() => setMenuOpen(false)}>Agent</a>
          <a href="#use-cases" onClick={() => setMenuOpen(false)}>Use cases</a>
        </nav>
        <div className="header-status">
          <span className="live-dot" />
          DEMO TELEMETRY
        </div>
        <button
          className="menu-button"
          type="button"
          aria-label="메뉴 열기"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span /><span />
        </button>
      </header>

      <main id="top">
        <section className="hero" id="orbit">
          <div className="hero-copy">
            <p className="eyebrow"><span>01</span> ORBIT, WITH A POINT OF VIEW</p>
            <h1>
              점을 보던 시대에서,<br />
              <em>사건을 먼저 아는 시대</em>로.
            </h1>
            <p className="hero-description">
              위성을 실체로 보여주고, AI가 위험과 흥미로운 순간을 먼저 발견합니다.
              수만 개의 궤도가 이제 하나의 이야기로 읽힙니다.
            </p>
            <div className="hero-actions">
              <a className="primary-button" href="#scale-lab">스케일을 바꿔보기 <span>↘</span></a>
              <a className="text-button" href="#agent">에이전트 브리핑 보기 <span>→</span></a>
            </div>
            <dl className="hero-metrics">
              <div><dt>VISUAL SCALE</dt><dd>2×—1000×</dd></div>
              <div><dt>AGENT MODES</dt><dd>RISK + FUN</dd></div>
              <div><dt>VIEW</dt><dd>EARTH / LOCAL</dd></div>
            </dl>
          </div>

          <div className="mission-panel" aria-label="인터랙티브 위성 궤도 데모">
            <div className="mission-toolbar">
              <div className="mission-title"><span className="crosshair">＋</span> EARTH ORBIT / LIVE VIEW</div>
              <div className="mission-clock"><span>SEOUL</span> {clock} KST</div>
            </div>

            <div className="orbit-stage">
              <OrbitCanvas scale={scale} mode={mode} />
              <div className="stage-grid" aria-hidden="true" />
              <div className="coordinate coordinate--top">45°N</div>
              <div className="coordinate coordinate--bottom">120°E</div>
              {satellites.map((satellite, index) => (
                <button
                  key={satellite.name}
                  type="button"
                  className={`satellite-marker satellite-marker--${satellite.tone}${selected === index ? " satellite-marker--selected" : ""}`}
                  style={{ left: `${satellite.x}%`, top: `${satellite.y}%`, width: markerSize, height: markerSize }}
                  aria-label={`${satellite.name} 선택`}
                  aria-pressed={selected === index}
                  onClick={() => setSelected(index)}
                >
                  <span className="marker-core" />
                  {selected === index && <span className="marker-label">{satellite.name}</span>}
                </button>
              ))}

              <aside className="object-card" aria-live="polite">
                <div className="object-card__topline">
                  <span>SELECTED OBJECT</span>
                  <span className={`tone-dot tone-dot--${chosenSatellite.tone}`} />
                </div>
                <div className="object-card__identity">
                  <SatelliteGlyph size="medium" />
                  <div><strong>{chosenSatellite.name}</strong><span>{chosenSatellite.type}</span></div>
                </div>
                <dl className="object-data">
                  <div><dt>ALT</dt><dd>{chosenSatellite.altitude}</dd></div>
                  <div><dt>VEL</dt><dd>{chosenSatellite.velocity}</dd></div>
                  <div><dt>INC</dt><dd>{chosenSatellite.inclination}</dd></div>
                </dl>
              </aside>

              <aside className="agent-feed">
                <div className="agent-feed__head">
                  <div><span className="agent-spark">✦</span> AGENT SIGNALS</div>
                  <span>{visibleEvents.length} ACTIVE</span>
                </div>
                <div className="mode-tabs" role="group" aria-label="이벤트 유형 필터">
                  {(["all", "risk", "fun"] as const).map((filter) => (
                    <button
                      type="button"
                      key={filter}
                      className={mode === filter ? "active" : ""}
                      aria-pressed={mode === filter}
                      onClick={() => setMode(filter)}
                    >
                      {filter === "all" ? "ALL" : filter.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="signal-list">
                  {visibleEvents.slice(0, 3).map((event) => (
                    <button
                      type="button"
                      key={event.id}
                      className={`signal signal--${event.kind}${activeEvent === event.id ? " signal--active" : ""}`}
                      onClick={() => selectEvent(event)}
                    >
                      <span className="signal__rail" />
                      <span className="signal__meta"><b>{event.label}</b><time>{event.timing}</time></span>
                      <strong>{event.object}</strong>
                      <span className="signal__summary">{event.summary}</span>
                    </button>
                  ))}
                </div>
              </aside>
            </div>

            <div className="scale-control">
              <div className="scale-reading">
                <span>OBJECT SCALE</span>
                <strong>{scale}×</strong>
              </div>
              <input
                type="range"
                min="2"
                max="1000"
                step="1"
                value={scale}
                aria-label="위성 시각화 배율"
                onChange={(event) => setScale(Number(event.target.value))}
                style={{ "--range-progress": `${((scale - 2) / 998) * 100}%` } as React.CSSProperties}
              />
              <div className="scale-stops">
                {scaleStops.map((stop) => (
                  <button type="button" key={stop} className={scale === stop ? "active" : ""} onClick={() => setScale(stop)}>{stop}×</button>
                ))}
              </div>
              <div className="simulation-note"><span>SIM</span> 시뮬레이션 데이터 · 실제 경보가 아닙니다</div>
            </div>
          </div>
        </section>

        <section className="ticker" aria-label="제품 핵심 기능">
          <div>
            <span>◇ DYNAMIC SCALING 2×—1000×</span>
            <span>✦ PROACTIVE AI BRIEFING</span>
            <span>△ NEAR-MISS DETECTION</span>
            <span>◎ LOCAL SKY PASS</span>
            <span>◇ DYNAMIC SCALING 2×—1000×</span>
          </div>
        </section>

        <section className="scale-lab section" id="scale-lab">
          <div className="section-heading">
            <p className="eyebrow"><span>02</span> DYNAMIC SCALING</p>
            <h2>멀리서는 흐름을.<br /><em>가까이서는 실체를.</em></h2>
          </div>
          <div className="scale-story">
            <div className="scale-demo">
              <div className="scale-demo__grid" aria-hidden="true" />
              <div className="scale-demo__orbit" aria-hidden="true" />
              <div className="scale-object" style={{ "--model-scale": `${0.55 + Math.log10(scale) * 0.36}` } as React.CSSProperties}>
                <div className="model-halo" />
                <SatelliteGlyph size="large" />
              </div>
              <div className="scale-demo__label"><span>ISS (ZARYA)</span><strong>{scale}×</strong></div>
              <div className="scale-demo__hint">SLIDE TO REVEAL THE OBJECT</div>
            </div>
            <div className="scale-narrative">
              <span className="chapter-number">02—A</span>
              <h3>크기를 키우는 건 장식이 아니라,<br />이해의 해상도를 높이는 일입니다.</h3>
              <p>
                2×에서는 궤도 군집과 흐름을 읽고, 1000×에서는 위성의 구조와 정체를 확인합니다.
                하나의 화면에서 거시적 상황과 개별 물체를 자연스럽게 오갑니다.
              </p>
              <div className="scale-presets" role="group" aria-label="위성 배율 프리셋">
                {scaleStops.map((stop, index) => (
                  <button type="button" key={stop} className={scale === stop ? "active" : ""} onClick={() => setScale(stop)}>
                    <span>0{index + 1}</span><strong>{stop}×</strong><small>{["FLOW", "CLUSTER", "IDENTITY", "STRUCTURE"][index]}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="agent-section section" id="agent">
          <div className="section-heading section-heading--wide">
            <p className="eyebrow"><span>03</span> PROACTIVE AGENT</p>
            <h2>질문을 기다리지 않는<br /><em>우주 관제 에이전트.</em></h2>
            <p>모든 데이터를 보여주는 대신, 지금 알아야 할 사건을 골라 맥락과 함께 브리핑합니다.</p>
          </div>

          <div className="agent-console">
            <div className="agent-core" aria-hidden="true">
              <div className="agent-core__ring agent-core__ring--one" />
              <div className="agent-core__ring agent-core__ring--two" />
              <div className="agent-core__center">A<span>agentba.se</span></div>
              <div className="agent-core__scan" />
            </div>

            <article className="mode-card mode-card--risk">
              <div className="mode-card__header"><span>R</span><div><small>AGENT MODE 01</small><h3>Risk / 위험</h3></div><i>02 ACTIVE</i></div>
              <p>가까워지는 두 궤도, 비정상적인 고도 저하, 우주 환경 변화를 먼저 포착합니다.</p>
              <ul>
                <li><span>01</span><b>근접 충돌</b><small>Conjunction watch</small></li>
                <li><span>02</span><b>대기권 추락</b><small>Orbital decay</small></li>
                <li><span>03</span><b>태양풍 영향</b><small>Space weather</small></li>
              </ul>
            </article>

            <article className="mode-card mode-card--fun">
              <div className="mode-card__header"><span>F</span><div><small>AGENT MODE 02</small><h3>Fun / 발견</h3></div><i>02 FOUND</i></div>
              <p>내 머리 위를 지나는 위성, 보기 드문 편대와 관측하기 좋은 순간을 놓치지 않습니다.</p>
              <ul>
                <li><span>01</span><b>상공 통과</b><small>Local sky pass</small></li>
                <li><span>02</span><b>위성 열차</b><small>Train spotted</small></li>
                <li><span>03</span><b>희귀 이벤트</b><small>Storyworthy orbit</small></li>
              </ul>
            </article>
          </div>

          <div className={`briefing briefing--${chosenEvent.kind}`} aria-live="polite">
            <div className="briefing-label"><span>✦</span> AGENT BRIEFING / {chosenEvent.kind.toUpperCase()}</div>
            <div className="briefing-copy">
              <div><span>{chosenEvent.timing}</span><h3>{chosenEvent.summary}</h3></div>
              <p>{chosenEvent.detail}</p>
            </div>
            <div className="briefing-events">
              {events.map((event) => (
                <button type="button" key={event.id} className={activeEvent === event.id ? "active" : ""} onClick={() => selectEvent(event)}>
                  <span className={`event-kind event-kind--${event.kind}`} />
                  <b>{event.label}</b><small>{event.timing}</small>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="prg-section section">
          <div className="section-heading">
            <p className="eyebrow"><span>04</span> FROM DATA TO MEANING</p>
            <h2>더 많은 점이 아니라,<br /><em>더 선명한 의미.</em></h2>
          </div>
          <div className="prg-grid">
            <article className="prg-card prg-card--problem">
              <div className="prg-index">P <span>PROBLEM</span></div>
              <div className="dot-cloud" aria-hidden="true">{Array.from({ length: 44 }, (_, index) => <i key={index} />)}</div>
              <h3>수만 개의 점.<br />중요한 건 보이지 않습니다.</h3>
              <p>정보는 넘치지만 사용자가 직접 찾고 해석해야 합니다. 데이터가 많을수록 피로도 함께 늘어납니다.</p>
            </article>
            <article className="prg-card prg-card--remedy">
              <div className="prg-index">R <span>REMEDY</span></div>
              <div className="remedy-visual" aria-hidden="true"><SatelliteGlyph size="large" /><span>✦</span></div>
              <h3>실체로 확대하고,<br />AI가 먼저 선별합니다.</h3>
              <p>다이내믹 스케일링과 능동형 에이전트가 궤도의 움직임을 이해할 수 있는 사건으로 바꿉니다.</p>
            </article>
            <article className="prg-card prg-card--gain">
              <div className="prg-index">G <span>GAIN</span></div>
              <div className="gain-visual" aria-hidden="true"><span>01</span><span>02</span><span>03</span><i /></div>
              <h3>한 번 보는 지도가<br />다시 찾는 경험이 됩니다.</h3>
              <p>다음 사건에 대한 기대가 반복 방문을 만들고, 교육·관측·전문 데이터 서비스로 확장됩니다.</p>
            </article>
          </div>
        </section>

        <section className="use-cases section" id="use-cases">
          <div className="section-heading section-heading--wide">
            <p className="eyebrow"><span>05</span> ONE ORBIT, THREE WORLDS</p>
            <h2>하나의 지구에서 시작해,<br /><em>세 개의 시장으로.</em></h2>
          </div>
          <div className="use-case-list">
            <article>
              <span className="use-case-number">01</span>
              <div className="use-case-icon">◉</div>
              <div><small>B2C / EXPLORERS</small><h3>오늘 밤, 내 머리 위의 우주</h3><p>우주 마니아와 관측가를 위한 개인화된 통과 알림과 발견 피드.</p></div>
              <span className="use-case-arrow">↗</span>
            </article>
            <article>
              <span className="use-case-number">02</span>
              <div className="use-case-icon">◇</div>
              <div><small>EDTECH / INSTITUTIONS</small><h3>살아 움직이는 교실과 과학관</h3><p>지금 일어나는 궤도 사건을 수업과 전시의 이야기로 바꾸는 실시간 교육 화면.</p></div>
              <span className="use-case-arrow">↗</span>
            </article>
            <article>
              <span className="use-case-number">03</span>
              <div className="use-case-icon">△</div>
              <div><small>DATA / PROFESSIONAL</small><h3>보여주는 지도를 넘어 판단 도구로</h3><p>위험 신호와 변화 추세를 선별해 전달하는 전문 상황 인지 데이터 레이어.</p></div>
              <span className="use-case-arrow">↗</span>
            </article>
          </div>
        </section>

        <section className="final-cta section">
          <div className="final-orbit" aria-hidden="true"><span /><i /><b /></div>
          <p className="eyebrow"><span>06</span> THE NEXT SIGNAL IS ALREADY MOVING</p>
          <h2>보이지 않던 것을 보게 만들고,<br /><em>모르던 것을 먼저 알려줍니다.</em></h2>
          <p>Space Situational Awareness, told as a living story.</p>
          <a className="primary-button primary-button--large" href="#orbit">위성 관제 데모 열기 <span>↑</span></a>
        </section>
      </main>

      <footer>
        <a className="brand" href="#top"><span className="brand-orbit" aria-hidden="true"><span /></span><span>satellite<span className="brand-dim">.agentba.se</span></span></a>
        <p>INTELLIGENT SATELLITE TRACKING / CONCEPT DEMO</p>
        <span>© 2026 AGENTBA.SE</span>
      </footer>
    </div>
  );
}
