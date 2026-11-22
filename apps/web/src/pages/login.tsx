import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AuthSession } from '@hoseidon/shared';
import { LogoMark } from '../components/logo';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/misc';
import { api } from '../lib/api';
import { SESSION_KEY } from '../lib/queries';

/** Shown instead of the app until the browser has a session. */
export function LoginPage({ session }: { session?: AuthSession }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
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
  const unconfigured = session && !session.configured;
  const canPasskey = !!session?.passkeys && browserSupportsWebAuthn();
  const error = login.error ?? passkey.error;

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
              No admin password is set yet. Set <code className="font-mono">ADMIN_PASSWORD</code> in
              your <code className="font-mono">.env</code> and restart the server.
            </p>
          ) : (
            <form onSubmit={submit} className="space-y-4">
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
              {error && (
                <p className="text-danger text-[13px]" role="alert">
                  {error instanceof Error ? error.message : 'Sign-in failed'}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                loading={login.isPending}
                disabled={!password}
              >
                Sign in
              </Button>
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
