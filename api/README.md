# API

```bash
./.venv/Scripts/python.exe -m uvicorn api.server:app --port 8000
```

Interactive docs at `http://127.0.0.1:8000/docs`.

## Three layers

| Endpoint | Takes | Returns |
|---|---|---|
| `GET /api/v1/site` | coordinate + timeframe | what *is* true there |
| `POST /api/v1/assess` | that report + constraints | suitable or not, failing checks named |
| `POST /api/v1/plan` | a mission | ranked locations **and** usable windows |

The split is deliberate. `/site` reports measurements and takes no view on
whether they are good; `/assess` applies one mission's limits; `/plan` runs
both across the region. Measurement stays separate from judgement, so the same
numbers can serve a planner, an educator and a student without being quietly
re-interpreted per audience.

## Why /plan is fast

Horizon profiles are **time-independent** -- terrain does not move. All 31,417
are precomputed once (`pipeline/horizon_cache.py`, 41 MB), so a new timeframe
is arithmetic over a Sun/Earth track rather than 31,417 fresh ray-marches.
A 180-day window over the whole grid answers in ~10 s instead of ~200 s.

## Known limits

- **`/plan` searches the 1 km coarse grid.** The optima are ridge crests tens
  of metres wide, so its solar figures understate what a refined point at the
  same spot reaches -- the same effect that took the batch pipeline from 74.2%
  to 87.9%. Treat `/plan` output as a shortlist to refine, not a final answer.
- `/site` and `/assess` compute a fresh horizon at the exact coordinate, so
  they are not subject to that.
- Latitude must be <= -75 (LOLA polar coverage).
- Slope comes from the 20 m DEM: a screening gate, not a touchdown
  certification.

## Examples

```bash
curl "http://127.0.0.1:8000/api/v1/site?lat=-89.00747&lon=265.3881&days=365.25"

curl -X POST http://127.0.0.1:8000/api/v1/assess -H 'Content-Type: application/json' \
  -d '{"lat":-89.00747,"lon":265.3881,
       "constraints":{"max_slope_deg":10,"max_night_h":150,"max_blackout_h":120}}'

curl -X POST http://127.0.0.1:8000/api/v1/plan -H 'Content-Type: application/json' \
  -d '{"timeframe":{"start":"2027-03-01T00:00:00","days":180,"step_hours":3},
       "profile":"robotic","limit":6,"min_separation_km":8}'
```

Profiles `crewed`, `robotic`, `isru` carry their own weights and hard limits;
`custom` takes yours.
