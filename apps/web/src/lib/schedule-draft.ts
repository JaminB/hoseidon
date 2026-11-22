import {
  DEFAULT_SKIP_RULES,
  type CycleSoak,
  type Schedule,
  type ScheduleInput,
  type ScheduleItem,
  type SkipRules,
} from '@hoseidon/shared';
import { addDays, dayCode, startOfDay, toLocalDateTime } from './calendar';

/** What the schedule sheet edits. Maps 1:1 onto ScheduleInput. */
export interface ScheduleDraft {
  name: string;
  color: string;
  rrule: string;
  dtstart: string;
  timezone: string;
  enabled: boolean;
  items: ScheduleItem[];
  cycleSoak: CycleSoak | null;
  sequential: boolean;
  skipRules: SkipRules;
  /** Default length for a newly added zone (from a drag or a template). Not sent to the API. */
  zoneSeconds?: number;
}

/** Calm, distinguishable block colors that read in light and dark. */
export const SCHEDULE_COLORS = [
  '#22b8cf',
  '#4c6ef5',
  '#7950f2',
  '#e64980',
  '#f76707',
  '#f59f00',
  '#40c057',
  '#868e96',
] as const;

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function blankDraft(overrides: Partial<ScheduleDraft> = {}): ScheduleDraft {
  const start = startOfDay(addDays(new Date(), 1));
  start.setHours(6);
  return {
    name: '',
    color: SCHEDULE_COLORS[0],
    rrule: 'FREQ=DAILY',
    dtstart: toLocalDateTime(start),
    timezone: browserTimeZone(),
    enabled: true,
    items: [],
    cycleSoak: null,
    sequential: true,
    skipRules: DEFAULT_SKIP_RULES,
    ...overrides,
  };
}

/** A block dragged on the week view: weekly on that weekday, one zone sized to the drag. */
export function draftFromSlot(
  day: Date,
  startMin: number,
  endMin: number,
  deviceId?: string,
): ScheduleDraft {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMin);
  const seconds = Math.max(60, (endMin - startMin) * 60);
  return blankDraft({
    rrule: `FREQ=WEEKLY;BYDAY=${dayCode(start)}`,
    dtstart: toLocalDateTime(start),
    items: deviceId ? [{ deviceId, seconds }] : [],
    zoneSeconds: seconds,
  });
}

export function draftFromSchedule(s: Schedule): ScheduleDraft {
  return {
    name: s.name,
    color: s.color,
    rrule: s.rrule,
    dtstart: s.dtstart,
    timezone: s.timezone,
    enabled: s.enabled,
    items: s.items,
    cycleSoak: s.cycleSoak,
    sequential: s.sequential,
    skipRules: s.skipRules,
  };
}

export function toInput(d: ScheduleDraft): ScheduleInput {
  const { zoneSeconds, ...input } = d;
  void zoneSeconds;
  return { ...input, name: d.name.trim() || 'Untitled schedule' };
}

export interface Template {
  id: string;
  name: string;
  blurb: string;
  /** Wall time [h, m]; the date is picked when the template is used (tomorrow). */
  draft: Partial<ScheduleDraft> & { minutes: number; at: [number, number] };
}

const tomorrowAt = (h: number, m = 0) => {
  const d = startOfDay(addDays(new Date(), 1));
  d.setHours(h, m);
  return toLocalDateTime(d);
};

/** Starting points. Zones are picked in the sheet; `minutes` is the per-zone default. */
export const TEMPLATES: Template[] = [
  {
    id: 'lawn',
    name: 'Lawn',
    blurb: 'Every other day · 6:00 AM · 20 min',
    draft: {
      name: 'Lawn',
      color: '#40c057',
      rrule: 'FREQ=DAILY;INTERVAL=2',
      at: [6, 0],
      minutes: 20,
      skipRules: { ...DEFAULT_SKIP_RULES, rainForecastMm: 5, freezeC: 2 },
    },
  },
  {
    id: 'drip',
    name: 'Garden drip',
    blurb: 'Daily · 7:00 AM · 30 min',
    draft: {
      name: 'Garden drip',
      color: '#22b8cf',
      rrule: 'FREQ=DAILY',
      at: [7, 0],
      minutes: 30,
      skipRules: { ...DEFAULT_SKIP_RULES, rainForecastMm: 10 },
    },
  },
  {
    id: 'soak',
    name: 'Deep soak',
    blurb: 'Mon, Wed, Fri · 5:30 AM · 3 × 10 min',
    draft: {
      name: 'Deep soak',
      color: '#4c6ef5',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      at: [5, 30],
      minutes: 30,
      cycleSoak: { cycles: 3, soakMinutes: 20 },
    },
  },
  {
    id: 'smart',
    name: 'Smart lawn',
    blurb: 'Daily · 5:00 AM · scales with ET₀',
    draft: {
      name: 'Smart lawn',
      color: '#7950f2',
      rrule: 'FREQ=DAILY',
      at: [5, 0],
      minutes: 15,
      skipRules: {
        ...DEFAULT_SKIP_RULES,
        rainForecastMm: 3,
        freezeC: 2,
        windKph: 30,
        etScaling: true,
      },
    },
  },
];

export function draftFromTemplate(t: Template): ScheduleDraft {
  const { minutes, at, ...rest } = t.draft;
  return blankDraft({ ...rest, dtstart: tomorrowAt(...at), zoneSeconds: minutes * 60 });
}
