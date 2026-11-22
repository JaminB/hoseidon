import { createHash } from 'node:crypto';
import { GCAL_SCOPE } from '@hoseidon/shared';
import type { GCalendar, GEvent } from './calendar';
import { CALENDAR_API } from './calendar';
import { REVOKE_URL, TOKEN_URL } from './oauth';

/**
 * An in-memory stand-in for Google's OAuth and Calendar endpoints, for tests. It checks PKCE, the
 * redirect URI and bearer tokens, keeps calendars and events, and can be told to fail.
 */

interface Failure {
  match: (method: string, path: string) => boolean;
  status: number;
  reason?: string;
  times: number;
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const apiError = (status: number, message: string, reason?: string) =>
  json(status, { error: { code: status, message, errors: reason ? [{ reason }] : [] } });

function basicUtc(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export class FakeGoogle {
  readonly calendars = new Map<string, GCalendar & { events: Map<string, GEvent> }>();
  readonly calls: FakeCall[] = [];
  readonly revoked: string[] = [];
  /** Scope granted on the consent screen (a user can untick it). */
  grantScope = GCAL_SCOPE;
  issueRefreshToken = true;
  /** Access token lifetime handed out. */
  expiresIn = 3600;
  /** No recurring event has instances (e.g. the occurrence isn't in the series). */
  noInstances = false;

  private codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  private refreshTokens = new Set<string>();
  private accessTokens = new Map<string, number>();
  private failures: Failure[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The bound fetch to hand to the code under test. */
  readonly fetch: typeof fetch = async (input, init) => this.handle(String(input), init ?? {});

  /** Pretend the user clicked "Allow" on the consent screen for this auth URL. */
  consent(authUrl: string): { code: string; state: string } {
    const url = new URL(authUrl);
    const p = url.searchParams;
    const code = `code-${++this.seq}`;
    this.codes.set(code, {
      challenge: p.get('code_challenge') ?? '',
      redirectUri: p.get('redirect_uri') ?? '',
      clientId: p.get('client_id') ?? '',
    });
    return { code, state: p.get('state') ?? '' };
  }

  /** Make every stored refresh token dead (revoked, or a Testing-mode 7-day expiry). */
  expireGrants() {
    this.refreshTokens.clear();
    this.accessTokens.clear();
  }

  /** Kill current access tokens only (forces a refresh). */
  expireAccessTokens() {
    this.accessTokens.clear();
  }

  failNext(match: Failure['match'], status: number, times = 1, reason?: string) {
    this.failures.push({ match, status, times, reason });
  }

  /** All events across calendars, cancelled ones excluded. */
  events(calendarId?: string): GEvent[] {
    const cals = calendarId ? [this.calendars.get(calendarId)!] : [...this.calendars.values()];
    return cals.flatMap((c) => [...c.events.values()]).filter((e) => e.status !== 'cancelled');
  }

  count(method: string, pathPart = '') {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart)).length;
  }

  private handle(url: string, init: RequestInit): Response {
    const method = (init.method ?? 'GET').toUpperCase();
    const bodyText = typeof init.body === 'string' ? init.body : '';
    if (url === TOKEN_URL) return this.token(new URLSearchParams(bodyText));
    if (url === REVOKE_URL) {
      const token = new URLSearchParams(bodyText).get('token') ?? '';
      this.revoked.push(token);
      this.refreshTokens.delete(token);
      return json(200, {});
    }
    if (!url.startsWith(CALENDAR_API)) return json(404, { error: 'unknown host' });

    const u = new URL(url);
    const path = u.pathname.replace(new URL(CALENDAR_API).pathname, '');
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    this.calls.push({ method, path: decodeURIComponent(path), body });

    const auth = new Headers(init.headers).get('authorization') ?? '';
    const exp = this.accessTokens.get(auth.replace(/^Bearer /, ''));
    if (!exp || exp <= this.now()) return apiError(401, 'Invalid Credentials', 'authError');

    const failure = this.failures.find(
      (f) => f.times > 0 && f.match(method, decodeURIComponent(path)),
    );
    if (failure) {
      failure.times--;
      return apiError(failure.status, `injected ${failure.status}`, failure.reason);
    }
    return this.calendar(method, path.split('/').filter(Boolean).map(decodeURIComponent), body, u);
  }

  private token(p: URLSearchParams): Response {
    const grant = p.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = this.codes.get(p.get('code') ?? '');
      this.codes.delete(p.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(p.get('code_verifier') ?? '')
        .digest('base64url');
      if (!entry || entry.challenge !== challenge || entry.redirectUri !== p.get('redirect_uri')) {
        return json(400, { error: 'invalid_grant', error_description: 'Bad code or verifier' });
      }
      const refresh = `refresh-${++this.seq}`;
      if (this.issueRefreshToken) this.refreshTokens.add(refresh);
      return json(200, {
        access_token: this.access(),
        expires_in: this.expiresIn,
        scope: this.grantScope,
        token_type: 'Bearer',
        ...(this.issueRefreshToken ? { refresh_token: refresh } : {}),
      });
    }
    if (grant === 'refresh_token') {
      if (!this.refreshTokens.has(p.get('refresh_token') ?? '')) {
        return json(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
      }
      return json(200, {
        access_token: this.access(),
        expires_in: this.expiresIn,
        scope: this.grantScope,
      });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private access() {
    const t = `access-${++this.seq}`;
    this.accessTokens.set(t, this.now() + this.expiresIn * 1000);
    return t;
  }

  private calendar(method: string, parts: string[], body: unknown, url: URL): Response {
    // parts: ['calendars', id?, 'events'?, eventId?, 'instances'?]
    const [root, calId, sub, eventId, extra] = parts;
    if (root !== 'calendars') return apiError(404, 'Not Found', 'notFound');
    if (!calId && method === 'POST') {
      const id = `cal${++this.seq}@group.calendar.google.com`;
      const b = body as GCalendar;
      this.calendars.set(id, { id, summary: b.summary, timeZone: b.timeZone, events: new Map() });
      return json(200, { id, summary: b.summary, timeZone: b.timeZone });
    }
    const cal = calId ? this.calendars.get(calId) : undefined;
    if (!cal) return apiError(404, 'Not Found', 'notFound');
    if (!sub) {
      if (method === 'GET')
        return json(200, { id: cal.id, summary: cal.summary, timeZone: cal.timeZone });
      if (method === 'DELETE') {
        this.calendars.delete(cal.id);
        return json(204, null);
      }
    }
    if (sub !== 'events') return apiError(404, 'Not Found', 'notFound');
    if (!eventId && method === 'POST') {
      const id = `ev${++this.seq}`;
      const ev = { ...(body as GEvent), id, status: (body as GEvent).status ?? 'confirmed' };
      cal.events.set(id, ev);
      return json(200, ev);
    }
    if (!eventId) return apiError(405, 'Method not allowed');

    if (extra === 'instances') {
      const parent = cal.events.get(eventId);
      if (!parent || parent.status === 'cancelled') return apiError(410, 'Deleted', 'deleted');
      if (this.noInstances || !parent.recurrence) return json(200, { items: [] });
      const at = new Date(Date.parse(url.searchParams.get('timeMin') ?? '') + 60_000);
      const id = `${eventId}_${basicUtc(at)}`;
      const existing = cal.events.get(id);
      const instance = existing ?? {
        ...parent,
        id,
        recurrence: undefined,
        recurringEventId: eventId,
        originalStartTime: { dateTime: at.toISOString() },
      };
      return json(200, { items: [instance] });
    }

    const ev = cal.events.get(eventId);
    const isInstance = eventId.includes('_');
    if (method === 'DELETE') {
      if (!ev || ev.status === 'cancelled')
        return apiError(410, 'Resource has been deleted', 'deleted');
      ev.status = 'cancelled';
      // Deleting a series takes its exceptions with it.
      for (const e of cal.events.values())
        if (e.recurringEventId === eventId) e.status = 'cancelled';
      return json(204, null);
    }
    if (method === 'PATCH' && isInstance) {
      const [parentId, stamp = ''] = eventId.split('_');
      const parent = cal.events.get(parentId ?? '');
      if (!parent || parent.status === 'cancelled') return apiError(404, 'Not Found', 'notFound');
      const at = stamp.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
        '$1-$2-$3T$4:$5:$6Z',
      );
      const base = ev ?? {
        ...parent,
        id: eventId,
        recurrence: undefined,
        recurringEventId: parentId,
        originalStartTime: { dateTime: at },
      };
      const next = { ...base, ...(body as GEvent) };
      cal.events.set(eventId, next);
      return json(200, next);
    }
    if (!ev) return apiError(404, 'Not Found', 'notFound');
    if (method === 'GET') return json(200, ev);
    if (method === 'PUT') {
      const next = { ...(body as GEvent), id: eventId };
      cal.events.set(eventId, next);
      return json(200, next);
    }
    if (method === 'PATCH') {
      const next = { ...ev, ...(body as GEvent) };
      cal.events.set(eventId, next);
      return json(200, next);
    }
    return apiError(405, 'Method not allowed');
  }
}
