import type { CycleSoak } from './schedule';

/**
 * Natural-language quick add: "every other day 6am front lawn 15m" or
 * "mon wed fri at 5:30 back beds 10 min x3 soak 20" -> a schedule draft.
 *
 * The grammar is deliberately small and forgiving. Each piece (repeat, time, cycles, soak) is
 * found and cut out of the text; whatever is left is "zone duration" pairs. "10 min x3" means three
 * 10-minute cycles, so the zone's total is 30 minutes.
 */

export interface QuickAddDevice {
  id: string;
  name: string;
}

export interface QuickAddOptions {
  /** Devices to match zone names against. Without them, zones stay unresolved. */
  devices?: QuickAddDevice[];
  /** IANA zone used to pick "today" for dtstart. Default UTC. */
  timeZone?: string;
  now?: Date;
}

export interface QuickAddZone {
  /** The text the user typed for this zone. */
  query: string;
  deviceId: string | null;
  deviceName: string | null;
  /** Total seconds per occurrence (all cycles). */
  seconds: number;
}

export interface QuickAddResult {
  ok: boolean;
  draft: {
    name: string;
    rrule: string;
    dtstart: string;
    timezone: string;
    items: { deviceId: string; seconds: number }[];
    cycleSoak: CycleSoak | null;
  };
  /** Human summary, e.g. "Every other day at 6:00 AM". */
  summary: string;
  zones: QuickAddZone[];
  warnings: string[];
  errors: string[];
}

const DAYS: [string, string, RegExp][] = [
  ['MO', 'Mon', /^mon(day)?s?$/],
  ['TU', 'Tue', /^tue?s?(day)?s?$/],
  ['WE', 'Wed', /^wed(nesday)?s?$|^weds$/],
  ['TH', 'Thu', /^thu(rs?)?(day)?s?$/],
  ['FR', 'Fri', /^fri(day)?s?$/],
  ['SA', 'Sat', /^sat(urday)?s?$/],
  ['SU', 'Sun', /^sun(day)?s?$/],
];
const DAY_WORD = String.raw`(?:mon(?:day)?s?|tues?(?:day)?s?|tue?s?|wed(?:nesday)?s?|weds|thu(?:rs?)?(?:day)?s?|fri(?:day)?s?|sat(?:urday)?s?|sun(?:day)?s?)`;
const DAY_LIST = new RegExp(
  String.raw`\b(?:(?:on|every)\s+)?(other\s+)?(${DAY_WORD}(?:\s*(?:,|&|/|\band\b|\s)\s*${DAY_WORD})*)\b`,
  'i',
);

const UNIT_SEC: Record<string, number> = { s: 1, m: 60, h: 3600 };
const DURATION = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/gi;

function unitSec(unit: string): number {
  return UNIT_SEC[unit[0]!.toLowerCase()] ?? 60;
}

/** Cut the first match of `re` out of `text`, returning the match. */
function take(state: { text: string }, re: RegExp): RegExpMatchArray | null {
  const m = state.text.match(re);
  if (!m || m.index === undefined) return null;
  state.text = `${state.text.slice(0, m.index)} ${state.text.slice(m.index + m[0].length)}`;
  return m;
}

function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatTime(h: number, m: number): string {
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Best device for a typed zone name: exact, then prefix/substring, then shared words. */
export function matchDevice(query: string, devices: QuickAddDevice[]): QuickAddDevice | null {
  const q = normalize(query);
  if (!q) return null;
  const qWords = q.split(' ');
  let best: { device: QuickAddDevice; score: number } | null = null;
  for (const device of devices) {
    const n = normalize(device.name);
    let score: number;
    if (n === q) score = 100;
    else if (n.startsWith(q) || q.startsWith(n)) score = 80;
    else if (n.includes(q) || q.includes(n)) score = 60;
    else {
      const nWords = new Set(n.split(' '));
      const shared = qWords.filter(
        (w) => nWords.has(w) || [...nWords].some((x) => x.startsWith(w)),
      );
      score = shared.length ? (40 * shared.length) / Math.max(qWords.length, nWords.size) : 0;
    }
    if (score > (best?.score ?? 0)) best = { device, score };
  }
  return best && best.score >= 20 ? best.device : null;
}

const FIXED_REPEATS: [RegExp, string, string][] = [
  [/\bevery\s+other\s+day\b/i, 'FREQ=DAILY;INTERVAL=2', 'Every other day'],
  [/\b(?:every\s+)?week\s*days\b/i, 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Weekdays'],
  [/\b(?:every\s+)?week\s*ends?\b/i, 'FREQ=WEEKLY;BYDAY=SA,SU', 'Weekends'],
];
/** Checked after day names, so "every other monday" isn't read as "every other week". */
const LATE_REPEATS: [RegExp, string, string][] = [
  [
    /\b(?:every\s+other\s+week|bi-?weekly|fortnightly)\b/i,
    'FREQ=WEEKLY;INTERVAL=2',
    'Every other week',
  ],
  [/\b(?:every\s+week|weekly)\b/i, 'FREQ=WEEKLY', 'Weekly'],
  [
    /\b(?:every\s*day|daily|each\s+day|every\s+morning|every\s+evening)\b/i,
    'FREQ=DAILY',
    'Every day',
  ],
];

function parseRepeat(state: { text: string }, warnings: string[]) {
  for (const [re, rrule, summary] of FIXED_REPEATS) {
    if (take(state, re)) return { rrule, summary };
  }
  const everyN = take(state, /\bevery\s+(\d+)\s*(?:days?|d)\b/i);
  if (everyN) {
    const n = Number(everyN[1]);
    if (n >= 1 && n <= 365) {
      return {
        rrule: n === 1 ? 'FREQ=DAILY' : `FREQ=DAILY;INTERVAL=${n}`,
        summary: n === 1 ? 'Every day' : `Every ${n} days`,
      };
    }
  }
  const oddEven = take(state, /\b(odd|even)\s+days?\b/i);
  if (oddEven) {
    const odd = oddEven[1]!.toLowerCase() === 'odd';
    const days = Array.from({ length: 31 }, (_, i) => i + 1).filter((d) => (d % 2 === 1) === odd);
    return {
      rrule: `FREQ=MONTHLY;BYMONTHDAY=${days.join(',')}`,
      summary: odd ? 'Odd days' : 'Even days',
    };
  }
  const dayList = take(state, DAY_LIST);
  if (dayList) {
    const words = dayList[2]!
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean);
    const picked = DAYS.filter(([, , re]) => words.some((w) => re.test(w)));
    if (picked.length) {
      const other = Boolean(dayList[1]);
      return {
        rrule: `FREQ=WEEKLY;${other ? 'INTERVAL=2;' : ''}BYDAY=${picked.map((d) => d[0]).join(',')}`,
        summary: `${other ? 'Every other ' : ''}${picked.map((d) => d[1]).join(', ')}`,
      };
    }
  }
  for (const [re, rrule, summary] of LATE_REPEATS) {
    if (take(state, re)) return { rrule, summary };
  }
  warnings.push('No repeat found; assuming every day.');
  return { rrule: 'FREQ=DAILY', summary: 'Every day' };
}

function parseTime(state: { text: string }, errors: string[], warnings: string[]) {
  let m = take(state, /\b(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\s|$|,)/i);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const pm = m[3]!.toLowerCase().startsWith('p');
    if (h < 1 || h > 12 || min > 59) {
      errors.push(`Invalid time "${m[0].trim()}".`);
      return { h: 6, m: 0 };
    }
    if (h === 12) h = 0;
    return { h: pm ? h + 12 : h, m: min };
  }
  m =
    take(state, /\b(?:at\s+|@\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/i) ??
    take(state, /\bat\s+(\d{1,2})\b(?!\s*(?:m|min|h|s)\b)/i);
  if (m) {
    const h = Number(m[1]);
    if (h > 23) {
      errors.push(`Invalid time "${m[0].trim()}".`);
      return { h: 6, m: 0 };
    }
    return { h, m: Number(m[2] ?? 0) };
  }
  if (take(state, /\b(?:at\s+)?noon\b/i)) return { h: 12, m: 0 };
  if (take(state, /\b(?:at\s+)?midnight\b/i)) return { h: 0, m: 0 };
  warnings.push('No time found; assuming 6:00 AM.');
  return { h: 6, m: 0 };
}

function parseCycleSoak(state: { text: string }, errors: string[]) {
  const c = take(state, /(?:\bx\s*(\d+)\b|\b(\d+)\s*(?:x|times|cycles?)\b)/i);
  const s = take(
    state,
    /\bsoak(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h)?\b/i,
  );
  if (!c && !s) return { cycles: 1, soakMinutes: 0, given: false };
  const cycles = c ? Number(c[1] ?? c[2]) : 2;
  const soakMinutes = s ? Math.round((Number(s[1]) * unitSec(s[2] ?? 'm')) / 60) : 30;
  if (cycles < 1 || cycles > 10) errors.push('Cycles must be 1 to 10.');
  if (soakMinutes > 240) errors.push('Soak must be at most 240 minutes.');
  return { cycles, soakMinutes, given: true };
}

const SEPARATORS = /\s*(?:,|&|\+|;|\bthen\b|\band\b)\s*/i;
const FILLER = /\b(?:water|run|for|at|on|the)\b/gi;

function parseZones(text: string, cycles: number, errors: string[]) {
  const zones: { query: string; seconds: number }[] = [];
  let last = 0;
  let pending: string[] = [];
  for (const m of text.matchAll(DURATION)) {
    const before = text.slice(last, m.index).replace(FILLER, ' ');
    last = (m.index ?? 0) + m[0].length;
    const names = before
      .split(SEPARATORS)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const seconds = Math.round(Number(m[1]) * unitSec(m[2]!)) * cycles;
    // "front lawn and back beds 10m" -> both get 10m; a bare duration applies to the previous zone.
    const targets = names.length ? [...pending, ...names] : pending;
    if (!targets.length) {
      errors.push(`"${m[0].trim()}" has no zone before it.`);
      continue;
    }
    for (const query of targets) zones.push({ query, seconds });
    pending = [];
  }
  const rest = text.slice(last).replace(FILLER, ' ').split(SEPARATORS);
  pending.push(...rest.map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean));
  for (const query of pending) errors.push(`No duration for "${query}" (try "${query} 10m").`);
  return zones;
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function parseQuickAdd(input: string, opts: QuickAddOptions = {}): QuickAddResult {
  const timeZone = opts.timeZone ?? 'UTC';
  const warnings: string[] = [];
  const errors: string[] = [];
  const state = { text: ` ${input.trim()} ` };

  const cs = parseCycleSoak(state, errors);
  const time = parseTime(state, errors, warnings);
  const repeat = parseRepeat(state, warnings);
  const parsedZones = parseZones(state.text, cs.cycles, errors);
  if (!parsedZones.length && !errors.length)
    errors.push('Add a zone and duration, e.g. "front lawn 15m".');

  const devices = opts.devices ?? [];
  const zones: QuickAddZone[] = parsedZones.map((z) => {
    const device = devices.length ? matchDevice(z.query, devices) : null;
    if (devices.length && !device) errors.push(`No device matches "${z.query}".`);
    return {
      query: z.query,
      deviceId: device?.id ?? null,
      deviceName: device?.name ?? null,
      seconds: z.seconds,
    };
  });
  for (const z of zones) {
    if (z.seconds < 60) errors.push(`"${z.query}" must run at least 1 minute.`);
    else if (z.seconds > 1439 * 60) errors.push(`"${z.query}" can run at most 23 h 59 min.`);
  }

  const cycleSoak =
    cs.given && cs.cycles > 1 ? { cycles: cs.cycles, soakMinutes: cs.soakMinutes } : null;
  if (cs.given && cs.cycles === 1) warnings.push('One cycle means no soak; ignoring soak.');

  const names = [...new Set(zones.map((z) => z.deviceName ?? titleCase(z.query)))];
  const summary =
    `${repeat.summary} at ${formatTime(time.h, time.m)}` +
    (cycleSoak ? `, ${cycleSoak.cycles} cycles with ${cycleSoak.soakMinutes} min soak` : '');

  return {
    ok: errors.length === 0,
    draft: {
      name:
        names.length > 2
          ? `${names[0]} + ${names.length - 1} more`
          : names.join(' + ') || 'New schedule',
      rrule: repeat.rrule,
      dtstart: `${todayIn(timeZone, opts.now ?? new Date())}T${pad(time.h)}:${pad(time.m)}`,
      timezone: timeZone,
      items: zones.flatMap((z) =>
        z.deviceId ? [{ deviceId: z.deviceId, seconds: z.seconds }] : [],
      ),
      cycleSoak,
    },
    summary,
    zones,
    warnings,
    errors,
  };
}
