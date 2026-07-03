# Solio Reserve Companion — a quick orientation

Hi Callan,

This folder is the complete, working Solio Reserve Companion app — everything
built so far, handed over in full. You don't need to be technical to make
sense of it; this page tells you what's here, how to try it, and the one
thing I need from you.

## Try the app right now

Open this on your phone:

**https://jfwatt87-cmyk.github.io/solio-reserve-companion/**

- It's your georeferenced map — the real poster, GPS-accurate. Stand anywhere
  on the reserve and the blue dot will be on the right drawn feature.
- Tap a destination and hit **Drive** for turn-by-turn directions along the
  tracks (there's a demo drive mode too, so it works from anywhere in the
  world).
- On your phone you can **Add to Home Screen** and it installs like a normal
  app — and keeps working with no signal once you've looked around the map.

## What's in this folder

| Item | What it is |
|---|---|
| The code (`src/`, `tools/`, etc.) | The full app source — map, navigation, drives, bird guide, sightings |
| `README.md` | The technical guide for any developer who works on this in future |
| `public/tiles/` | Your poster, converted into the fast map format phones need |
| `supabase/` | The designed (not yet live) system for Phase 2 live vehicle tracking |
| `tools/roads/GIS_ROADS_SPEC.md` | A one-page spec you can hand straight to your GIS person |

## The rhino rule

Built into everything: **the app never holds or shows rhino locations, and
guests can't log rhino sightings** — so guest phones can never become a
poacher's map. That stays true in every future phase; the Phase 2 design
enforces it at the database level, not just in the app.

## Solio owns all of this

The code, the map work, the data — all of it belongs to Solio Game Reserve.
There's no subscription, no licence fee, no dependence on me or on any paid
service. Any developer (for instance a Marriott-funded team) can pick this
folder up and carry on; the README tells them everything they need.

## What I need from you

**Your GIS data.** The map gets even better the moment I have the
authoritative layers:

1. **Reserve boundary** (also needed for the Phase 2 geofence)
2. **Roads** — the spec for your GIS person is in
   `tools/roads/GIS_ROADS_SPEC.md` (a simple GeoJSON export; road names and
   surface types are a bonus, not a requirement)
3. **Rivers**
4. **Points of interest** — gates, lodge, dams, picnic sites, anything guests
   should be able to navigate to

Whatever format is easiest — GeoJSON is ideal, but shapefiles or a QGIS
project are fine too. Partial is fine; roads first if you have to choose.

## Reaching me

James Watt — **[email removed — contact via WhatsApp]** (or WhatsApp as usual).
Questions, ideas, something on the map in the wrong place — just shout.
