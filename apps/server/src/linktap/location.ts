import { eq } from 'drizzle-orm';
import { OpenLocationCode } from 'open-location-code';
import type { Db } from '../db/types';
import { gateways } from '../db/schema';

/**
 * LinkTap reports a gateway's `location` as a Google Plus Code, usually the short form plus a
 * locality ("XXXX+XX City, ST, USA"), or "Not specified". We turn that into lat/lon + time zone
 * so weather and scheduling work without the user typing a location.
 */

const olc = new OpenLocationCode();

export type ParsedLocation =
  | { kind: 'full'; code: string; locality: string | null }
  | { kind: 'short'; code: string; locality: string };

export function parseLinkTapLocation(raw: string | null | undefined): ParsedLocation | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = /^(\S+)(?:\s+(.+))?$/.exec(s);
  if (!m) return null;
  const code = m[1]!.toUpperCase();
  const locality = m[2]?.trim() || null;
  if (!olc.isValid(code)) return null;
  if (olc.isFull(code)) return { kind: 'full', code, locality };
  if (olc.isShort(code) && locality) return { kind: 'short', code, locality };
  return null;
}

// ---- geocoding ----------------------------------------------------------------------------------

export interface GeoPlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  country_code?: string;
  admin1?: string;
}

export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const US_STATES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const COUNTRY_ALIASES: Record<string, string[]> = {
  US: ['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america'],
  GB: ['uk', 'u.k.', 'gb', 'united kingdom', 'great britain'],
};

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

function countryMatches(hint: string, p: GeoPlace): boolean {
  const h = norm(hint);
  if (!h) return false;
  if (h === norm(p.country) || h === norm(p.country_code)) return true;
  const aliases = COUNTRY_ALIASES[(p.country_code ?? '').toUpperCase()];
  return aliases?.includes(h) ?? false;
}

function adminMatches(hint: string, p: GeoPlace): boolean {
  const h = norm(hint);
  if (!h) return false;
  if (h === norm(p.admin1)) return true;
  // "NC" -> "North Carolina" (only meaningful for US places).
  const full = US_STATES[hint.trim().toUpperCase()];
  return (
    full !== undefined &&
    (p.country_code ?? 'US').toUpperCase() === 'US' &&
    norm(full) === norm(p.admin1)
  );
}

/**
 * Pick the geocoding result that best fits a locality like "City, NC, USA" (city, state,
 * country). With only a city, the API's first (most relevant) result wins. When a state or
 * country is given and nothing matches either, return null rather than guess.
 */
export function pickPlace(locality: string, results: GeoPlace[]): GeoPlace | null {
  if (results.length === 0) return null;
  const parts = locality
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const hints = parts.slice(1);
  if (hints.length === 0) return results[0] ?? null;
  let best: { place: GeoPlace; score: number } | null = null;
  for (const place of results) {
    const score =
      (hints.some((h) => adminMatches(h, place)) ? 2 : 0) +
      (hints.some((h) => countryMatches(h, place)) ? 1 : 0);
    if (score > 0 && (!best || score > best.score)) best = { place, score };
  }
  return best?.place ?? null;
}

export async function geocodeLocality(
  locality: string,
  fetchFn: typeof fetch,
): Promise<GeoPlace | null> {
  const city = locality.split(',')[0]?.trim();
  if (!city) return null;
  const query = new URLSearchParams({ name: city, count: '10', language: 'en', format: 'json' });
  const res = await fetchFn(`${GEOCODE_URL}?${query}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
  const body = (await res.json()) as { results?: GeoPlace[] };
  return pickPlace(locality, body.results ?? []);
}

export interface ResolvedLocation {
  lat: number;
  lon: number;
  timezone: string | null;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

/**
 * Parsed location -> coordinates. Short codes are recovered to the full code nearest the
 * locality's centre. Returns null when it can't be resolved; throws only on network errors so
 * the caller can retry later.
 */
export async function resolveLocation(
  parsed: ParsedLocation,
  fetchFn: typeof fetch,
): Promise<ResolvedLocation | null> {
  let place: GeoPlace | null = null;
  if (parsed.locality) place = await geocodeLocality(parsed.locality, fetchFn);
  let full: string;
  if (parsed.kind === 'full') {
    full = parsed.code;
  } else {
    if (!place) return null;
    full = olc.recoverNearest(parsed.code, place.latitude, place.longitude);
  }
  const area = olc.decode(full);
  return {
    lat: round(area.latitudeCenter),
    lon: round(area.longitudeCenter),
    timezone: place?.timezone ?? null,
  };
}

// ---- applying it to a gateway -------------------------------------------------------------------

export interface LocationDeps {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Resolve one gateway's LinkTap location into lat/lon/timezone, but only when the location
 * string differs from the one we last tried and the user hasn't set a location manually.
 * Returns true when coordinates were written.
 */
export async function resolveGatewayLocation(
  db: Db,
  gatewayId: string,
  deps: LocationDeps = {},
): Promise<boolean> {
  const row = db.select().from(gateways).where(eq(gateways.id, gatewayId)).get();
  if (!row?.locationRaw || row.locationResolvedFor === row.locationRaw) return false;
  const raw = row.locationRaw;
  const markDone = () =>
    db.update(gateways).set({ locationResolvedFor: raw }).where(eq(gateways.id, gatewayId)).run();

  if (row.locationSource === 'manual') {
    markDone();
    return false;
  }
  const parsed = parseLinkTapLocation(raw);
  if (!parsed) {
    deps.log?.(`gateway ${gatewayId}: cannot parse LinkTap location "${raw}"; leaving it unset`);
    markDone();
    return false;
  }
  let resolved: ResolvedLocation | null;
  try {
    resolved = await resolveLocation(parsed, deps.fetch ?? fetch);
  } catch (err) {
    // Network trouble: don't mark as done, so the next poll tries again.
    deps.log?.(`gateway ${gatewayId}: geocoding failed: ${(err as Error).message}`);
    return false;
  }
  if (!resolved) {
    deps.log?.(`gateway ${gatewayId}: no place found for LinkTap location "${raw}"`);
    markDone();
    return false;
  }
  // The user may have set a location while we were waiting on the network.
  const fresh = db.select().from(gateways).where(eq(gateways.id, gatewayId)).get();
  if (fresh?.locationSource === 'manual') {
    markDone();
    return false;
  }
  db.update(gateways)
    .set({
      lat: resolved.lat,
      lon: resolved.lon,
      ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
      locationSource: 'linktap',
      locationResolvedFor: raw,
    })
    .where(eq(gateways.id, gatewayId))
    .run();
  return true;
}

/** Offline stand-in for Open-Meteo geocoding (mock mode and tests). */
export const mockGeocodeFetch: typeof fetch = async (input) => {
  const name = new URL(String(input)).searchParams.get('name') ?? '';
  const results =
    name.toLowerCase() === 'mountain view'
      ? [
          {
            name: 'Mountain View',
            latitude: 21.3,
            longitude: -157.8,
            timezone: 'Pacific/Honolulu',
            country: 'United States',
            country_code: 'US',
            admin1: 'Hawaii',
          },
          {
            name: 'Mountain View',
            latitude: 37.38605,
            longitude: -122.08385,
            timezone: 'America/Los_Angeles',
            country: 'United States',
            country_code: 'US',
            admin1: 'California',
          },
        ]
      : [];
  return new Response(JSON.stringify({ results }), {
    headers: { 'content-type': 'application/json' },
  });
};
