import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { User, UserRole } from '@hoseidon/shared';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { USERS_KEY, useSession, useUsers } from '../../lib/queries';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { ConfirmDialog } from '../ui/dialog';
import { Input, inputClass } from '../ui/misc';
import { toast } from '../ui/toast';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings > Access: who may sign in. Admins only. */
export function AccessCard() {
  const session = useSession();
  const isAdmin = session.data?.role === 'admin';
  const users = useUsers(isAdmin);
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [removing, setRemoving] = useState<User | null>(null);

  const add = useMutation({
    mutationFn: () => api.addUser({ email, role }),
    onSuccess: (u) => {
      setEmail('');
      setRole('member');
      void qc.invalidateQueries({ queryKey: USERS_KEY });
      toast.success('Invited', `${u.email} can now sign in with Google.`);
    },
    onError: (e) => toast.error('Could not add', msg(e)),
  });
  const patch = useMutation({
    mutationFn: (v: { email: string; role: UserRole }) => api.patchUser(v.email, { role: v.role }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (e) => toast.error('Could not change role', msg(e)),
  });
  const remove = useMutation({
    mutationFn: (u: User) => api.removeUser(u.email),
    onSuccess: () => void qc.invalidateQueries({ queryKey: USERS_KEY }),
    onError: (e) => toast.error('Could not remove', msg(e)),
  });

  if (!isAdmin) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) add.mutate();
  };

  return (
    <Card data-testid="access-card">
      <CardHeader
        title="Access"
        description="Only these Google accounts can sign in. Removing someone signs them out right away."
      />
      <ul className="divide-line border-line divide-y border-t">
        {users.data?.map((u) => (
          <li key={u.email} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate">{u.email}</span>
                {u.protected && <Badge tone="accent">Owner</Badge>}
                {u.disabled && <Badge tone="warn">Disabled</Badge>}
              </div>
              <div className="text-subtle truncate text-xs">
                {u.name ? `${u.name} · ` : ''}
                {u.lastLoginAt ? `Signed in ${formatRelative(u.lastLoginAt)}` : 'Never signed in'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <select
                aria-label={`Role for ${u.email}`}
                className={`${inputClass} h-8 w-auto py-0 text-xs`}
                value={u.role}
                disabled={u.protected || patch.isPending}
                onChange={(e) => patch.mutate({ email: u.email, role: e.target.value as UserRole })}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${u.email}`}
                disabled={u.protected}
                onClick={() => setRemoving(u)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
        {users.isError && (
          <li className="text-danger px-5 py-3 text-sm" role="alert">
            Could not load users: {msg(users.error)}
          </li>
        )}
        <li className="px-5 py-3">
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <Input
              type="email"
              aria-label="Email to invite"
              placeholder="name@example.com"
              autoComplete="off"
              className="min-w-0 flex-1 basis-48"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              aria-label="Role for new user"
              className={`${inputClass} h-9 w-auto`}
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button type="submit" size="sm" loading={add.isPending} disabled={!email.trim()}>
              Invite
            </Button>
          </form>
        </li>
      </ul>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this person?"
        description={`${removing?.email ?? ''} will be signed out immediately and their passkeys deleted.`}
        confirmLabel="Remove"
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Card>
  );
}
