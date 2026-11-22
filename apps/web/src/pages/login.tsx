import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  GOOGLE_SIGNIN_START,
  SIGNIN_ERROR_MESSAGE,
  signinErrorSchema,
  type AuthSession,
} from '@hoseidon/shared';
import { LogoMark } from '../components/logo';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/misc';
import { api } from '../lib/api';
import { SESSION_KEY } from '../lib/queries';

/** Reads (and clears) the `?signin=<reason>` the Google callback redirects with. */
function readSigninError(): string | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('signin');
  if (raw === null) return null;
  url.searchParams.delete('signin');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  const parsed = signinErrorSchema.safeParse(raw);
  return parsed.success ? SIGNIN_ERROR_MESSAGE[parsed.data] : SIGNIN_ERROR_MESSAGE.failed;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.5 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

/** Shown instead of the app until the browser has a session. */
export function LoginPage({ session }: { session?: AuthSession }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [signinError] = useState(readSigninError);
  const done = (s: AuthSession) => qc.setQueryData(SESSION_KEY, s);

  const login = useMutation({ mutationFn: () => api.login(password), onSuccess: done });
  const passkey = useMutation({
    mutationFn: async () => {
      const { options, challengeId } = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: options as never });
      return api.passkeyLoginVerify(challengeId, response);
    },
    onSuccess: done,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) login.mutate();
  };
  const google = !!session?.google;
  const showPassword = session ? session.password : true;
  const unconfigured = session && !session.configured;
  const canPasskey = !!session?.passkeys && browserSupportsWebAuthn();
  const error = login.error ?? passkey.error;
  const errorText = error
    ? error instanceof Error
      ? error.message
      : 'Sign-in failed'
    : signinError;

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark className="size-14 rounded-2xl" />
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Hoseidon</h1>
            <p className="text-muted text-sm">God of the garden hose</p>
          </div>
        </div>

        <Card className="p-5">
          {unconfigured ? (
            <p className="text-muted text-sm" role="alert">
              Sign-in isn&apos;t set up yet. Configure Google sign-in (
              <code className="font-mono">ADMIN_EMAIL</code>) or set{' '}
              <code className="font-mono">ADMIN_PASSWORD</code>, then restart the server.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {google && (
                <Button
                  type="button"
                  variant="primary"
                  className="w-full"
                  onClick={() => window.location.assign(GOOGLE_SIGNIN_START)}
                >
                  <GoogleMark /> Sign in with Google
                </Button>
              )}
              {showPassword && (
                <>
                  <Field label="Password" htmlFor="password">
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="primary"
                    className="w-full"
                    loading={login.isPending}
                    disabled={!password}
                  >
                    Sign in
                  </Button>
                </>
              )}
              {errorText && (
                <p className="text-danger text-[13px]" role="alert">
                  {errorText}
                </p>
              )}
              {canPasskey && (
                <Button
                  type="button"
                  className="w-full"
                  loading={passkey.isPending}
                  onClick={() => passkey.mutate()}
                >
                  <Fingerprint className="size-4" /> Use a passkey
                </Button>
              )}
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
