import { addDays, dateRange, diffDays } from './dates';

/** Small deterministic hash -> [0, 1), so mock weather is stable for a place and day. */
function rand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function day(lat: number, lon: number, date: string) {
  const r = (k: string) => rand(`${lat.toFixed(2)},${lon.toFixed(2)}|${date}|${k}`);
  const doy = diffDays(date, `${date.slice(0, 4)}-01-01`);
  // Summer-ish peak, mirrored for the southern hemisphere.
  const season = Math.sin(((doy - 80) / 365) * 2 * Math.PI) * (lat >= 0 ? 1 : -1);
  const wet = r('wet') < 0.28;
  const cloud = wet ? 0.6 : r('cloud') * 0.5;
  const tMax = 17 + season * 9 + r('t') * 5 - cloud * 4;
  return {
    rain: wet ? r1(1 + r('rain') * 17) : 0,
    prob: wet ? Math.round(55 + r('p') * 40) : Math.round(r('p') * 25),
    et0: Math.max(0.3, r1(3.6 + season * 2.2 + r('et') * 1.2 - cloud * 1.8)),
    tMax: r1(tMax),
    tMin: r1(tMax - 8 - r('tn') * 4),
    wind: r1(8 + r('w') * 22),
    soil: Math.round((0.18 + (wet ? 0.1 : 0) + r('s') * 0.06) * 1000) / 1000,
  };
}

/**
 * An offline stand-in for the Open-Meteo forecast and archive APIs, used when LINKTAP_MOCK=true.
 * It speaks the same URL and JSON shape, so the real cache and parsing code run unchanged.
 */
export const createMockOpenMeteo =
  (now: () => Date = () => new Date()): typeof fetch =>
  async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const p = url.searchParams;
    const lat = Number(p.get('latitude'));
    const lon = Number(p.get('longitude'));
    const tz = p.get('timezone');
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz && tz !== 'auto' ? tz : 'UTC',
    }).format(now());

    const isArchive = url.hostname.startsWith('archive');
    const from = isArchive
      ? (p.get('start_date') ?? today)
      : addDays(today, -(Number(p.get('past_days')) || 0));
    const to = isArchive
      ? (p.get('end_date') ?? today)
      : addDays(today, Number(p.get('forecast_days') || 7) - 1);
    const dates = dateRange(from, to);
    const days = dates.map((d) => day(lat, lon, d));
    const wantsProb = (p.get('daily') ?? '').includes('precipitation_probability_max');

    const hourlyTime: string[] = [];
    const hourlySoil: number[] = [];
    dates.forEach((d, i) => {
      for (let h = 0; h < 24; h++) {
        hourlyTime.push(`${d}T${String(h).padStart(2, '0')}:00`);
        hourlySoil.push(Math.round((days[i]!.soil + Math.sin(h / 4) * 0.005) * 1000) / 1000);
      }
    });

    return Response.json({
      latitude: lat,
      longitude: lon,
      daily: {
        time: dates,
        precipitation_sum: days.map((d) => d.rain),
        ...(wantsProb ? { precipitation_probability_max: days.map((d) => d.prob) } : {}),
        et0_fao_evapotranspiration: days.map((d) => d.et0),
        temperature_2m_max: days.map((d) => d.tMax),
        temperature_2m_min: days.map((d) => d.tMin),
        wind_speed_10m_max: days.map((d) => d.wind),
      },
      hourly: { time: hourlyTime, soil_moisture_0_to_7cm: hourlySoil },
    });
  };

export const mockOpenMeteoFetch = createMockOpenMeteo();
