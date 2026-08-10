# satellite.agentba.se

An agentic orbital-intelligence experience that turns live public space data into an interactive Earth view, close-approach signals, decay monitoring, space-weather context, and local pass predictions.

Vercel production: [satellite-rho.vercel.app](https://satellite-rho.vercel.app)

Original Sites deployment: [satellite.agentba.se](https://satellite.agentba.se)

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
- Native Next.js deployment on Vercel
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
- `app/orbit.worker.ts` — background orbital propagation
- `app/i18n.ts` — English, Korean, and Japanese copy
- `vercel.json` — Vercel framework and reproducible install/build settings
- `worker/index.ts` — retained Cloudflare Worker entry point for the Sites build
- `.openai/hosting.json` — retained OpenAI Sites hosting metadata

## Deployment

The public GitHub repository is connected to the `2weeks-team/satellite` Vercel project. Pushes to `main` automatically create production deployments with the settings in `vercel.json`.

The original OpenAI Sites-compatible build remains available as a rollback path:

```bash
npm run build:sites
npm run start:sites
```
