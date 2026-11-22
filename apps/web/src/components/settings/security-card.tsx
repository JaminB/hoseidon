import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, LogOut, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { SESSION_KEY, usePasskeys } from '../../lib/queries';
import { UserChip } from './user-chip';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { toast } from '../ui/toast';

const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac/.test(ua)
        ? 'Mac'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Device';
  return `${os} passkey`;
};

/** Settings > Security: passkeys and sign out. */
export function SecurityCard() {
  const qc = useQueryClient();
  const passkeys = usePasskeys();
  const supported = browserSupportsWebAuthn();

  const setList = (list: unknown) => {
    qc.setQueryData(['auth', 'passkeys'], list);
    void qc.invalidateQueries({ queryKey: SESSION_KEY });
  };
  const add = useMutation({
    mutationFn: async () => {
      const { options, challengeId } = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      return api.passkeyRegisterVerify(challengeId, response, deviceName());
    },
    onSuccess: (list) => {
      setList(list);
      toast.success('Passkey added', 'You can use it on the sign-in page.');
    },
    onError: (err) => {
      // Cancelling the browser prompt is not an error worth shouting about.
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      toast.error('Could not add a passkey', err instanceof Error ? err.message : String(err));
    },
  });
  const remove = useMutation({
    mutationFn: api.deletePasskey,
    onSuccess: setList,
    onError: (err) =>
      toast.error('Could not remove', err instanceof Error ? err.message : String(err)),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: (s) => qc.setQueryData(SESSION_KEY, s),
  });

  return (
    <Card data-testid="security-card">
      <CardHeader
        title="Security"
        description="Add a passkey to sign in with Face ID, Touch ID or a security key."
      />
      <UserChip />
      <ul className="divide-line border-line divide-y border-t">
        {passkeys.data?.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="flex min-w-0 items-center gap-2.5">
              <Fingerprint className="text-muted size-4 shrink-0" />
              <div className="min-w-0">
                <div className="truncate">{p.name}</div>
                <div className="text-subtle text-xs">
                  {p.lastUsedAt ? `Used ${formatRelative(p.lastUsedAt)}` : 'Never used'}
                </div>
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${p.name}`}
              onClick={() => remove.mutate(p.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          </li>
        ))}
        <li className="flex items-center justify-between gap-3 px-5 py-3">
          <p className="text-subtle text-xs">
            {supported
              ? passkeys.data?.length
                ? 'Passkeys need Hoseidon to be served from your PUBLIC_URL.'
                : 'No passkeys yet.'
              : 'This browser doesn’t support passkeys.'}
          </p>
          <Button
            size="sm"
            disabled={!supported}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            <Fingerprint className="size-3.5" /> Add passkey
          </Button>
        </li>
      </ul>
      <div className="border-line border-t px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          loading={logout.isPending}
          onClick={() => logout.mutate()}
        >
          <LogOut className="size-3.5" /> Sign out
        </Button>
      </div>
    </Card>
  );
}
