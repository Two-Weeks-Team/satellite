# satellite.agentba.se

An agentic orbital-intelligence experience that turns live public space data into an interactive Earth view, close-approach signals, decay monitoring, space-weather context, and local pass predictions.

Live site: [satellite.agentba.se](https://satellite.agentba.se)

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
- Vinext and Vite for a Cloudflare Worker-compatible build
- `satellite.js` for orbital propagation
- D3 Geo, TopoJSON, and Natural Earth-derived world geometry
- TypeScript and ESLint

## Local development

Requirements: Node.js 22.13 or newer and npm.

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

The bounded build and test scripts require GNU `timeout` (available by default on Linux; provided by GNU coreutils on macOS). To validate an existing build artifact separately, run `npm run validate:artifact`.

## Project structure

- `app/page.tsx` — interactive orbital experience
- `app/api/` — catalog, signal, orbit-frame, and agent endpoints
- `app/orbit.worker.ts` — background orbital propagation
- `app/i18n.ts` — English, Korean, and Japanese copy
- `worker/index.ts` — Cloudflare Worker entry point
- `.openai/hosting.json` — OpenAI Sites hosting metadata

## Deployment

The repository is configured for OpenAI Sites. The production build emits a Worker-compatible artifact under `dist/` and validates its entry point and hosting manifest before deployment.
