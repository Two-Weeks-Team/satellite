# satellite.agentba.se

An agentic orbital-intelligence experience that turns live public space data into an interactive Earth view, close-approach signals, decay monitoring, space-weather context, and local pass predictions.

Production: [satellite.agentba.se](https://satellite.agentba.se)

Vercel fallback hostname: [satellite-rho.vercel.app](https://satellite-rho.vercel.app)

## Highlights

- Live active-satellite catalog with SGP4 propagation and smooth GPU-assisted motion
- Interactive 3D Earth with filtering, search, favorites, time controls, and multiple color modes
- Sentinel, Scout, and Sky agent briefings with manual, assist, and autopilot modes
- Close-approach, potential-decay, and NOAA space-weather signals
- Observer-location pass predictions for featured satellites
- English, Korean, and Japanese interfaces
- Cached sample data when an upstream public source is temporarily unavailable

## Data sources

- [CelesTrak GP data](https://celestrak.org/NORAD/documentation/gp-data-formats.php)
- [CelesTrak SOCRATES Plus](https://celestrak.org/SOCRATES/socrates-format.php)
- [NOAA Space Weather Prediction Center](https://services.swpc.noaa.gov/products/)

Pass predictions are geometric calculations above 10 degrees elevation. They do not account for brightness, clouds, or sunlight conditions.

## Tech stack

- React 19 and Next.js 16 application APIs
- Native Next.js frontend and application APIs on Vercel
- Cloudflare Worker ingestion API with D1 operational history and R2 raw archives
- Vinext and Vite scripts retained for the original Cloudflare Worker-compatible Sites build
- `satellite.js` for orbital propagation
- D3 Geo, TopoJSON, and Natural Earth-derived world geometry
- TypeScript and ESLint

## Local development

Requirements: Node.js 24 and npm.

```bash
npm ci
npm run dev
```

The development server prints the local URL when it starts.

## Validation

```bash
npm run lint
npm run build
npm test
```

`npm test` creates a production Next.js build and exercises the rendered application plus its live/fallback catalog, signals, agent, and binary orbit endpoints.

## Project structure

- `app/page.tsx` — interactive orbital experience
- `app/api/` — catalog, signal, orbit-frame, and agent endpoints
- `cloudflare/data-worker.ts` — scheduled ingestion and history API
- `cloudflare/migrations/` — versioned D1 schema migrations
- `cloudflare/wrangler.jsonc` — separate Preview and Production D1/R2 bindings
- `app/orbit.worker.ts` — background orbital propagation
- `app/i18n.ts` — English, Korean, and Japanese copy
- `vercel.json` — Vercel framework and reproducible install/build settings
- `worker/index.ts` — retained Cloudflare Worker entry point for the Sites build
- `.openai/hosting.json` — retained OpenAI Sites hosting metadata

## Deployment

The public GitHub repository is connected to the `2weeks-team/satellite` Vercel project. Pushes to `main` automatically create production deployments with the settings in `vercel.json`.

The frontend reads recent complete signal snapshots from `https://satellite-api.agentba.se`. If the stored snapshot is partial, unavailable, or more than six hours old, the Vercel API falls back to the public upstream feeds. Cloudflare Cron refreshes signals every two hours and the active catalog daily; D1 keeps queryable state and R2 retains the raw source payloads.

When CelesTrak rejects a Worker-origin request, the Worker retries those feeds through a token-protected Vercel upstream relay. Configure the same secret as `SATELLITE_UPSTREAM_PROXY_TOKEN` in Vercel and `UPSTREAM_PROXY_TOKEN` in the Worker; neither value belongs in the repository.

Set `SATELLITE_DATA_API_URL=https://satellite-api.agentba.se` in Vercel so the application reads stored snapshots. `INGESTION_TOKEN` is an optional Worker secret for temporary server-to-server maintenance calls; leave it unset to keep manual ingestion disabled. Raw source responses and a derived snapshot are archived under each signal run's R2 prefix.

Cloudflare deployment and migration commands use the `cloudflare/wrangler.jsonc` configuration so they do not collide with the retained Sites build:

```bash
npm run cf:check
npm run cf:migrate:preview
npm run cf:deploy:preview
npm run cf:migrate:production
npm run cf:deploy:production
```

Production and Preview have distinct D1 databases and R2 buckets. Never point either binding at the pre-existing `tiktok-avatars` bucket.

The original OpenAI Sites-compatible build remains available as a rollback path:

```bash
npm run build:sites
npm run start:sites
```
