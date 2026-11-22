/** The handful of Google Calendar v3 calls Hoseidon needs, over plain fetch. */
import { randomBytes } from 'node:crypto';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
  /** The thing is gone (deleted by the user in Google Calendar). */
  get gone() {
    return this.status === 404 || this.status === 410;
  }
  /** Quota or rate limit: back off, never treat as "no access". */
  get rateLimited() {
    return (
      this.status === 429 || (this.status === 403 && RATE_LIMIT_REASONS.has(this.reason ?? ''))
    );
  }
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/**
 * A fresh client-side event id (base32hex: 0-9 and a-v, 5-1024 chars; hex is a subset). Knowing
 * the id before the insert lets a retry after a lost response find the event instead of
 * creating a second one.
 */
export const newEventId = () => `h${randomBytes(16).toString('hex')}`;

export interface EventDateTime {
  dateTime: string;
  timeZone?: string;
}

export interface GEvent {
  id?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  originalStartTime?: EventDateTime;
  recurrence?: string[];
  colorId?: string;
  transparency?: 'opaque' | 'transparent';
  reminders?: { useDefault: boolean; overrides?: unknown[] };
  extendedProperties?: { private?: Record<string, string> };
  recurringEventId?: string;
}

export interface GCalendar {
  id: string;
  summary: string;
  timeZone?: string;
}

export class CalendarApi {
  constructor(
    private readonly opts: {
      fetch: typeof fetch;
      /** Access token; `force` asks for a fresh one after a 401. */
      token: (force?: boolean) => Promise<string>;
    },
  ) {}

  createCalendar(body: { summary: string; description?: string; timeZone: string }) {
    return this.call<GCalendar>('POST', '/calendars', body);
  }

  getCalendar(id: string) {
    return this.call<GCalendar>('GET', `/calendars/${enc(id)}`);
  }

  insertEvent(calendarId: string, event: GEvent) {
    return this.call<GEvent>('POST', `/calendars/${enc(calendarId)}/events`, event);
  }

  /** Full replace, so edits made in Google are overwritten (the sync is one-way). */
  updateEvent(calendarId: string, eventId: string, event: GEvent) {
    return this.call<GEvent>('PUT', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, event);
  }

  patchEvent(calendarId: string, eventId: string, patch: GEvent) {
    return this.call<GEvent>(
      'PATCH',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}`,
      patch,
    );
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.call<null>('DELETE', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
  }

  /** Instances of a recurring event that overlap [timeMin, timeMax). */
  async instances(calendarId: string, eventId: string, timeMin: Date, timeMax: Date) {
    const qs = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '10',
    });
    const res = await this.call<{ items?: GEvent[] }>(
      'GET',
      `/calendars/${enc(calendarId)}/events/${enc(eventId)}/instances?${qs}`,
    );
    return res.items ?? [];
  }

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.opts.token(retried);
    const res = await this.opts.fetch(`${CALENDAR_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // An access token can die early (revoked, clock skew): refresh once and retry.
    if (res.status === 401 && !retried) return this.call<T>(method, path, body, true);
    if (res.status === 204) return null as T;
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    } | null;
    if (!res.ok) {
      const reason = json?.error?.errors?.[0]?.reason;
      const msg = json?.error?.message ?? `${res.status} ${res.statusText}`;
      throw new GoogleApiError(`Google Calendar ${method} failed: ${msg}`, res.status, reason);
    }
    return json as T;
  }
}

const enc = encodeURIComponent;
