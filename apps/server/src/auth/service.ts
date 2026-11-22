import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { SigninError, UserRole } from '@hoseidon/shared';
import { adminEmails, googleSignInConfigured, normalizeEmail, type Config } from '../config';
import type { Db } from '../db/types';
import { deleteSetting, getSetting, setSetting } from '../db/kv';
import {
  deleteEphemeral,
  listEphemeral,
  pruneEphemeral,
  putEphemeral,
  takeEphemeral,
} from '../db/ephemeral';
import { passkeys, sessions, users, type UserRow } from '../db/schema';
import { pkcePair } from '../gcal/oauth';
import { exchangeSigninCode, Jwks, signinUrl, verifyIdToken } from './google';
import { fingerprint, signToken, hasValidSignature } from './token';
import { hashPassword, schemeOf, verifyPassword, type PasswordScheme } from './password';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const HASH_KEY = 'auth.passwordHash';
/** HMAC of the env password under SESSION_SECRET: when it matches, the slow KDF check is skipped. */
const FP_KEY = 'auth.passwordFp';
const CHALLENGE_TTL_MS = 5 * 60_000;
/** How long a Google sign-in may take between start and callback. */
export const SIGNIN_TTL_MS = 10 * 60_000;
/** After this many wrong passwords from one client in the window, its logins are refused. */
const MAX_FAILURES = 8;
/** Safety cap across all clients, high enough that a few strangers can't lock the owner out. */
const MAX_GLOBAL_FAILURES = 100;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** WebAuthn user handle of the password admin. */
const LEGACY_USER = 'hoseidon-admin';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | {
      ok: false;
      reason: 'invalid' | 'unconfigured' | 'throttled' | 'disabled';
      retryAfterSec?: number;
    };

/** Who a session belongs to. `email: null` is the password admin (Google sign-in off). */
export interface SessionUser {
  email: string | null;
  role: UserRole;
  name: string | null;
  picture: string | null;
}

export type GoogleSigninResult =
  | { ok: true; token: string; expiresAt: Date; next: string; email: string }
  | { ok: false; reason: SigninError };

/** A refused user-management request; `status` is the HTTP status to answer with. */
export class UserError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Only a same-site absolute path survives as the post-sign-in destination. */
export function safeNext(next: string | undefined | null): string {
  if (!next || next.length > 512 || !next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.includes('\\')) return '/';
  // Characters below 0x21 (controls, space) can make a browser read it as another URL.
  for (let i = 0; i < next.length; i++) if (next.charCodeAt(i) < 0x21) return '/';
  return next;
}

export interface AuthOptions {
  db: Db;
  config: Config;
  now?: () => number;
  log?: (msg: string) => void;
  /** How a new password hash is made. Default scrypt; Workers use pbkdf2 (CPU budget). */
  passwordScheme?: PasswordScheme;
  /** Session tokens carry an HMAC under SESSION_SECRET (Workers: the edge checks it). */
  signTokens?: boolean;
  /** For Google's token and JWKS endpoints (tests inject a fake). */
  fetch?: typeof fetch;
}

const FAIL_PREFIX = 'loginfail:';
const CHALLENGE_PREFIX = 'challenge:';
const REG_CHALLENGE_PREFIX = 'regchallenge:';
const SIGNIN_PREFIX = 'gsignin:';

/**
 * Two ways in:
 *
 * - Google sign-in (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + ADMIN_EMAIL): OpenID Connect, and
 *   only emails on the `users` allowlist (ADMIN_EMAIL always) get a session. Password sign-in is
 *   off in this mode.
 * - Otherwise one password admin: ADMIN_PASSWORD (hashed into the settings table, and re-synced
 *   if the env value changes). This is the dev/mock/self-host path.
 *
 * Passkeys are a fast way back in for a user who signed in before; each belongs to one user.
 * Sessions are random cookie tokens; only their hash is stored, with the user's email. Login
 * failures, passkey challenges and sign-in state live in the `ephemeral` table, so a restart (or
 * a Durable Object eviction) doesn't reset them.
 */
export class AuthService {
  private readonly now: () => number;
  private ready: Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly jwks: Jwks;

  constructor(private readonly o: AuthOptions) {
    this.now = o.now ?? Date.now;
    // Wrapped: workerd throws "Illegal invocation" for a detached global fetch.
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.jwks = new Jwks({ fetch: this.fetchImpl, now: this.now });
    this.ensureAdmins();
    if (this.googleEnabled) {
      // Password-admin sessions belong to nobody: they end when Google sign-in is turned on.
      o.db.delete(sessions).where(isNull(sessions.userEmail)).run();
    }
    this.ready = this.syncPassword();
  }

  /** Resolves once the env password has been hashed and stored (tests await it). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Google sign-in is on, and password sign-in is off. */
  get googleEnabled(): boolean {
    return googleSignInConfigured(this.o.config);
  }

  get passwordEnabled(): boolean {
    return !this.googleEnabled;
  }

  /** ADMIN_EMAIL addresses are always present, enabled admins. */
  private ensureAdmins(): void {
    for (const email of adminEmails(this.o.config)) {
      this.o.db
        .insert(users)
        .values({ email, role: 'admin', disabled: false })
        .onConflictDoUpdate({ target: users.email, set: { role: 'admin', disabled: false } })
        .run();
    }
  }

  /** Listed in ADMIN_EMAIL: can't be removed, demoted or disabled through the API. */
  isProtected(email: string): boolean {
    return adminEmails(this.o.config).includes(normalizeEmail(email));
  }

  private async syncPassword(): Promise<void> {
    const { db, config, log } = this.o;
    const stored = getSetting(db, HASH_KEY);
    if (this.googleEnabled) {
      // Password sign-in is off: forget the hash (its sessions were ended in the constructor).
      if (stored) {
        deleteSetting(db, HASH_KEY);
        deleteSetting(db, FP_KEY);
      }
      return;
    }
    if (!config.ADMIN_PASSWORD) {
      if (stored) {
        // Removing the env value revokes the password instead of leaving the old one working.
        deleteSetting(db, HASH_KEY);
        deleteSetting(db, FP_KEY);
        db.delete(sessions).where(isNull(sessions.userEmail)).run();
      }
      log?.('ADMIN_PASSWORD is not set: nobody can sign in until it is.');
      return;
    }
    const scheme = this.o.passwordScheme ?? 'scrypt';
    // Without SESSION_SECRET there is no safe fingerprint (a bare hash would be a fast oracle for
    // the password), so the full check runs.
    const secret = config.SESSION_SECRET;
    const fp = secret ? fingerprint(secret, `${scheme}:${config.ADMIN_PASSWORD}`) : null;
    if (stored && fp && getSetting(db, FP_KEY) === fp && schemeOf(stored) === scheme) return;
    const same = !!stored && (await verifyPassword(config.ADMIN_PASSWORD, stored));
    if (same && schemeOf(stored) === scheme) {
      if (fp) setSetting(db, FP_KEY, fp);
      return;
    }
    setSetting(db, HASH_KEY, await hashPassword(config.ADMIN_PASSWORD, scheme));
    if (fp) setSetting(db, FP_KEY, fp);
    // A changed password signs the password admin out (a re-hash under another scheme doesn't).
    if (stored && !same) db.delete(sessions).where(isNull(sessions.userEmail)).run();
  }

  /** Someone can sign in: Google sign-in is on, or an admin password is set. */
  get configured(): boolean {
    return this.googleEnabled || !!getSetting(this.o.db, HASH_KEY);
  }

  /** A passkey that can sign in exists (so the login page offers it). */
  get hasPasskeys(): boolean {
    return (
      this.o.db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(this.googleEnabled ? isNotNull(passkeys.userEmail) : undefined)
        .limit(1)
        .get() !== undefined
    );
  }

  // ---- sessions -------------------------------------------------------------------------------

  /** `client` identifies who is trying (an IP); failures are counted per client. */
  async login(password: string, client = 'unknown'): Promise<LoginResult> {
    await this.ready;
    if (this.googleEnabled) return { ok: false, reason: 'disabled' };
    const stored = getSetting(this.o.db, HASH_KEY);
    if (!stored) return { ok: false, reason: 'unconfigured' };
    const now = this.now();
    const failures = this.failures(now);
    const mine = failures.get(client) ?? [];
    const all = [...failures.values()].flat().sort((a, b) => a - b);
    const throttledBy =
      mine.length >= MAX_FAILURES ? mine : all.length >= MAX_GLOBAL_FAILURES ? all : null;
    if (throttledBy) {
      const retryAfterSec = Math.ceil((throttledBy[0]! + FAILURE_WINDOW_MS - now) / 1000);
      return { ok: false, reason: 'throttled', retryAfterSec };
    }
    // Count the attempt before the (async) password check, so concurrent attempts each see the
    // ones still in flight and can't slip past the limits together. A success clears it.
    putEphemeral(
      this.o.db,
      FAIL_PREFIX + client,
      JSON.stringify([...mine, now]),
      new Date(now + FAILURE_WINDOW_MS),
    );
    if (!(await verifyPassword(password, stored))) {
      return { ok: false, reason: 'invalid' };
    }
    deleteEphemeral(this.o.db, FAIL_PREFIX + client);
    return { ok: true, ...this.createSession(null) };
  }

  /** Recent wrong-password times per client, oldest first. */
  private failures(now: number): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const row of listEphemeral(this.o.db, FAIL_PREFIX, new Date(now))) {
      let list: number[] = [];
      try {
        list = (JSON.parse(row.value) as number[]).filter((t) => now - t < FAILURE_WINDOW_MS);
      } catch {
        // A corrupt entry just doesn't count.
      }
      if (list.length) out.set(row.key.slice(FAIL_PREFIX.length), list);
    }
    return out;
  }

  /** `email` null = the password admin. */
  createSession(email: string | null = null): { token: string; expiresAt: Date } {
    const { db } = this.o;
    const now = this.now();
    db.delete(sessions)
      .where(lt(sessions.expiresAt, new Date(now)))
      .run();
    pruneEphemeral(db, new Date(now));
    const id = randomBytes(32).toString('base64url');
    const token = this.signing ? signToken(id, this.o.config.SESSION_SECRET) : id;
    const expiresAt = new Date(now + SESSION_TTL_MS);
    db.insert(sessions)
      .values({ id: sha256(token), expiresAt, userEmail: email })
      .run();
    return { token, expiresAt };
  }

  private get signing(): boolean {
    return !!this.o.signTokens && !!this.o.config.SESSION_SECRET;
  }

  isValid(token: string | undefined): boolean {
    return this.sessionUser(token) !== null;
  }

  /** The user behind a live session, read fresh, so a removal, demotion or disable shows at once. */
  sessionUser(token: string | undefined): SessionUser | null {
    if (!token) return null;
    if (this.signing && !hasValidSignature(token, this.o.config.SESSION_SECRET)) return null;
    const row = this.o.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256(token)))
      .get();
    if (!row || row.expiresAt.getTime() <= this.now()) return null;
    if (row.userEmail === null) {
      return this.googleEnabled ? null : { email: null, role: 'admin', name: null, picture: null };
    }
    const user = this.user(row.userEmail);
    if (!user || user.disabled) return null;
    return { email: user.email, role: user.role, name: user.name, picture: user.picture };
  }

  logout(token: string | undefined): void {
    if (token)
      this.o.db
        .delete(sessions)
        .where(eq(sessions.id, sha256(token)))
        .run();
  }

  // ---- passkeys -------------------------------------------------------------------------------

  private get rp() {
    const url = new URL(this.o.config.PUBLIC_URL);
    const origins = [url.origin];
    // The Vite dev server serves the UI from another port on localhost.
    if (url.hostname === 'localhost') origins.push('http://localhost:5173');
    return { id: url.hostname, origins };
  }

  private remember(prefix: string, value: string): string {
    const now = this.now();
    pruneEphemeral(this.o.db, new Date(now));
    const id = randomBytes(16).toString('base64url');
    putEphemeral(this.o.db, prefix + id, value, new Date(now + CHALLENGE_TTL_MS));
    return id;
  }

  /** One use only: a challenge that was tried (even wrongly) can't be tried again. */
  private take(prefix: string, id: string): string | undefined {
    return takeEphemeral(this.o.db, prefix + id, new Date(this.now()));
  }

  private ownedBy(email: string | null) {
    return email === null ? isNull(passkeys.userEmail) : eq(passkeys.userEmail, email);
  }

  /** One user's passkeys (`null` = the password admin's). */
  listPasskeys(email: string | null) {
    return this.o.db.select().from(passkeys).where(this.ownedBy(email)).all();
  }

  removePasskey(id: string, email: string | null): boolean {
    return (
      this.o.db
        .delete(passkeys)
        .where(and(eq(passkeys.id, id), this.ownedBy(email)))
        .returning({ id: passkeys.id })
        .all().length > 0
    );
  }

  /** Registration options for the signed-in `email` (null = the password admin). */
  async registrationOptions(email: string | null) {
    const options = await generateRegistrationOptions({
      rpName: 'Hoseidon',
      rpID: this.rp.id,
      userName: email ?? 'admin',
      userID: new Uint8Array(new TextEncoder().encode(email ?? LEGACY_USER)),
      attestationType: 'none',
      excludeCredentials: this.listPasskeys(email).map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    const challengeId = this.remember(
      REG_CHALLENGE_PREFIX,
      JSON.stringify({ challenge: options.challenge, email }),
    );
    return { options, challengeId };
  }

  /** The challenge must have been issued to the same signed-in user. */
  async registerPasskey(
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
    email: string | null,
  ): Promise<boolean> {
    const raw = this.take(REG_CHALLENGE_PREFIX, challengeId);
    let challenge: string | undefined;
    try {
      const saved = raw
        ? (JSON.parse(raw) as { challenge?: string; email?: string | null })
        : undefined;
      if (saved && saved.email === email) challenge = saved.challenge;
    } catch {
      // a corrupt entry is refused below
    }
    if (!challenge) return false;
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.rp.origins,
      expectedRPID: this.rp.id,
    }).catch(() => undefined);
    if (!result?.verified) return false;
    const { credential } = result.registrationInfo;
    this.o.db
      .insert(passkeys)
      .values({
        id: credential.id,
        userEmail: email,
        name,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports ?? null,
      })
      .run();
    return true;
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({
      rpID: this.rp.id,
      userVerification: 'preferred',
    });
    return { options, challengeId: this.remember(CHALLENGE_PREFIX, options.challenge) };
  }

  /** Is the owner of this passkey still allowed in? */
  private passkeyOwnerAllowed(email: string | null): boolean {
    if (email === null) return !this.googleEnabled;
    const user = this.user(email);
    return !!user && !user.disabled;
  }

  async loginWithPasskey(
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const challenge = this.take(CHALLENGE_PREFIX, challengeId);
    if (!challenge) return null;
    const { db } = this.o;
    const row = db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
    if (!row || !this.passkeyOwnerAllowed(row.userEmail)) return null;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.rp.origins,
      expectedRPID: this.rp.id,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(Buffer.from(row.publicKey, 'base64url')),
        counter: row.counter,
        transports: row.transports as never,
      },
    }).catch(() => undefined);
    if (!result?.verified) return null;
    db.update(passkeys)
      .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(this.now()) })
      .where(eq(passkeys.id, row.id))
      .run();
    return this.createSession(row.userEmail);
  }

  // ---- Google sign-in -------------------------------------------------------------------------

  private get googleClient() {
    return {
      clientId: this.o.config.GOOGLE_CLIENT_ID,
      clientSecret: this.o.config.GOOGLE_CLIENT_SECRET,
      redirectUri: `${this.o.config.PUBLIC_URL.replace(/\/+$/, '')}/api/auth/google/callback`,
    };
  }

  get googleRedirectUri(): string {
    return this.googleClient.redirectUri;
  }

  /** Where to send the browser, and the state to bind to it (a short-lived cookie). */
  startGoogle(next?: string): { url: string; state: string } | null {
    if (!this.googleEnabled) return null;
    const now = this.now();
    pruneEphemeral(this.o.db, new Date(now));
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkcePair();
    putEphemeral(
      this.o.db,
      SIGNIN_PREFIX + state,
      JSON.stringify({ verifier, nonce, next: safeNext(next) }),
      new Date(now + SIGNIN_TTL_MS),
    );
    return { url: signinUrl(this.googleClient, { state, nonce, challenge }), state };
  }

  /**
   * The callback. `browserState` is the state cookie set by start: it must match, so a sign-in
   * started in one browser can't be finished in another (login CSRF).
   */
  async finishGoogle(q: {
    code?: string;
    state?: string;
    error?: string;
    browserState?: string;
  }): Promise<GoogleSigninResult> {
    if (!this.googleEnabled) return { ok: false, reason: 'not_configured' };
    // Single use: taken before anything else, so a replayed state never works twice.
    const raw = q.state ? this.take(SIGNIN_PREFIX, q.state) : undefined;
    if (q.error) return { ok: false, reason: q.error === 'access_denied' ? 'cancelled' : 'failed' };
    if (!raw || !q.state || q.browserState !== q.state) return { ok: false, reason: 'expired' };
    if (!q.code) return { ok: false, reason: 'failed' };
    let saved: { verifier: string; nonce: string; next: string };
    try {
      saved = JSON.parse(raw) as typeof saved;
    } catch {
      return { ok: false, reason: 'expired' };
    }
    let identity;
    try {
      const idToken = await exchangeSigninCode(
        this.fetchImpl,
        this.googleClient,
        q.code,
        saved.verifier,
      );
      identity = await verifyIdToken(idToken, {
        jwks: this.jwks,
        clientId: this.googleClient.clientId,
        nonce: saved.nonce,
        now: this.now(),
      });
    } catch (err) {
      this.o.log?.(`Google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, reason: 'failed' };
    }
    const user = this.user(identity.email);
    if (!user || user.disabled) {
      // No email in the log: it is someone else's address.
      this.o.log?.('Google sign-in refused: the account is not invited');
      return { ok: false, reason: 'not_invited' };
    }
    this.o.db
      .update(users)
      .set({
        name: identity.name ?? user.name,
        picture: identity.picture ?? user.picture,
        lastLoginAt: new Date(this.now()),
      })
      .where(eq(users.email, user.email))
      .run();
    return { ok: true, ...this.createSession(user.email), next: saved.next, email: user.email };
  }

  // ---- users (the allowlist) ------------------------------------------------------------------

  user(email: string): UserRow | undefined {
    return this.o.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .get();
  }

  listUsers(): UserRow[] {
    return this.o.db.select().from(users).orderBy(users.createdAt, users.email).all();
  }

  addUser(email: string, role: UserRole, addedBy: string | null): UserRow {
    const e = normalizeEmail(email);
    if (this.user(e)) throw new UserError(409, 'That email is already on the list');
    this.o.db
      .insert(users)
      .values({ email: e, role, addedBy, createdAt: new Date(this.now()) })
      .run();
    return this.user(e)!;
  }

  /** Disabling a user ends their sessions and deletes their passkeys right away. */
  updateUser(email: string, patch: { role?: UserRole; disabled?: boolean }): UserRow {
    const e = normalizeEmail(email);
    if (!this.user(e)) throw new UserError(404, 'user not found');
    if (this.isProtected(e) && (patch.role === 'member' || patch.disabled === true)) {
      throw new UserError(403, 'ADMIN_EMAIL accounts are always enabled admins');
    }
    this.o.db.transaction((tx) => {
      tx.update(users)
        .set({
          ...(patch.role ? { role: patch.role } : {}),
          ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        })
        .where(eq(users.email, e))
        .run();
      if (patch.disabled) revokeAccess(tx, e);
    });
    return this.user(e)!;
  }

  /** Removing a user ends their sessions and deletes their passkeys right away. */
  removeUser(email: string): void {
    const e = normalizeEmail(email);
    if (this.isProtected(e)) throw new UserError(403, 'ADMIN_EMAIL accounts cannot be removed');
    if (!this.user(e)) throw new UserError(404, 'user not found');
    this.o.db.transaction((tx) => {
      revokeAccess(tx, e);
      tx.delete(users).where(eq(users.email, e)).run();
    });
  }
}

function revokeAccess(tx: Pick<Db, 'delete'>, email: string): void {
  tx.delete(sessions).where(eq(sessions.userEmail, email)).run();
  tx.delete(passkeys).where(eq(passkeys.userEmail, email)).run();
}
