import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Config } from '../config';
import type { Db } from '../db/types';
import { deleteSetting, getSetting, setSetting } from '../db/kv';
import {
  deleteEphemeral,
  listEphemeral,
  pruneEphemeral,
  putEphemeral,
  takeEphemeral,
} from '../db/ephemeral';
import { passkeys, sessions } from '../db/schema';
import { fingerprint, signToken, hasValidSignature } from './token';
import { hashPassword, schemeOf, verifyPassword, type PasswordScheme } from './password';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const HASH_KEY = 'auth.passwordHash';
/** HMAC of the env password under SESSION_SECRET: when it matches, the slow KDF check is skipped. */
const FP_KEY = 'auth.passwordFp';
const CHALLENGE_TTL_MS = 5 * 60_000;
/** After this many wrong passwords from one client in the window, its logins are refused. */
const MAX_FAILURES = 8;
/** Safety cap across all clients, high enough that a few strangers can't lock the owner out. */
const MAX_GLOBAL_FAILURES = 100;
const FAILURE_WINDOW_MS = 15 * 60_000;
const USER_ID = new Uint8Array(new TextEncoder().encode('hoseidon-admin'));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'unconfigured' | 'throttled'; retryAfterSec?: number };

export interface AuthOptions {
  db: Db;
  config: Config;
  now?: () => number;
  log?: (msg: string) => void;
  /** How a new password hash is made. Default scrypt; Workers use pbkdf2 (CPU budget). */
  passwordScheme?: PasswordScheme;
  /** Session tokens carry an HMAC under SESSION_SECRET (Workers: the edge checks it). */
  signTokens?: boolean;
}

const FAIL_PREFIX = 'loginfail:';
const CHALLENGE_PREFIX = 'challenge:';

/**
 * One admin. The password comes from ADMIN_PASSWORD (hashed into the settings table, and re-synced
 * if the env value changes). A passkey can be added from Settings once signed in. Sessions are
 * random cookie tokens; only their hash is stored. Login failures and passkey challenges live in
 * the `ephemeral` table, so a restart (or a Durable Object eviction) doesn't reset them.
 */
export class AuthService {
  private readonly now: () => number;
  private ready: Promise<void>;

  constructor(private readonly o: AuthOptions) {
    this.now = o.now ?? Date.now;
    this.ready = this.syncPassword();
  }

  /** Resolves once the env password has been hashed and stored (tests await it). */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async syncPassword(): Promise<void> {
    const { db, config, log } = this.o;
    const stored = getSetting(db, HASH_KEY);
    if (!config.ADMIN_PASSWORD) {
      if (stored) {
        // Removing the env value revokes the password instead of leaving the old one working.
        deleteSetting(db, HASH_KEY);
        deleteSetting(db, FP_KEY);
        db.delete(sessions).run();
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
    // A changed password signs everyone out (a re-hash of the same one under another scheme doesn't).
    if (stored && !same) db.delete(sessions).run();
  }

  get configured(): boolean {
    return !!getSetting(this.o.db, HASH_KEY);
  }

  get hasPasskeys(): boolean {
    return this.o.db.select({ id: passkeys.id }).from(passkeys).limit(1).get() !== undefined;
  }

  // ---- sessions -------------------------------------------------------------------------------

  /** `client` identifies who is trying (an IP); failures are counted per client. */
  async login(password: string, client = 'unknown'): Promise<LoginResult> {
    await this.ready;
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
    return { ok: true, ...this.createSession() };
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

  createSession(): { token: string; expiresAt: Date } {
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
      .values({ id: sha256(token), expiresAt })
      .run();
    return { token, expiresAt };
  }

  private get signing(): boolean {
    return !!this.o.signTokens && !!this.o.config.SESSION_SECRET;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    if (this.signing && !hasValidSignature(token, this.o.config.SESSION_SECRET)) return false;
    const row = this.o.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256(token)))
      .get();
    return !!row && row.expiresAt.getTime() > this.now();
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

  private remember(challenge: string): string {
    const now = this.now();
    pruneEphemeral(this.o.db, new Date(now));
    const id = randomBytes(16).toString('base64url');
    putEphemeral(this.o.db, CHALLENGE_PREFIX + id, challenge, new Date(now + CHALLENGE_TTL_MS));
    return id;
  }

  /** One use only: a challenge that was tried (even wrongly) can't be tried again. */
  private take(id: string): string | undefined {
    return takeEphemeral(this.o.db, CHALLENGE_PREFIX + id, new Date(this.now()));
  }

  listPasskeys() {
    return this.o.db.select().from(passkeys).all();
  }

  removePasskey(id: string): boolean {
    return (
      this.o.db.delete(passkeys).where(eq(passkeys.id, id)).returning({ id: passkeys.id }).all()
        .length > 0
    );
  }

  async registrationOptions() {
    const options = await generateRegistrationOptions({
      rpName: 'Hoseidon',
      rpID: this.rp.id,
      userName: 'admin',
      userID: USER_ID,
      attestationType: 'none',
      excludeCredentials: this.listPasskeys().map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { options, challengeId: this.remember(options.challenge) };
  }

  async registerPasskey(
    challengeId: string,
    response: RegistrationResponseJSON,
    name: string,
  ): Promise<boolean> {
    const challenge = this.take(challengeId);
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
    return { options, challengeId: this.remember(options.challenge) };
  }

  async loginWithPasskey(
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const challenge = this.take(challengeId);
    if (!challenge) return null;
    const { db } = this.o;
    const row = db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
    if (!row) return null;
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
    return this.createSession();
  }
}
