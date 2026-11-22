import { useSession } from '../../lib/queries';

/** The signed-in user: avatar, name and email. Nothing for the password admin (no identity). */
export function UserChip() {
  const { data } = useSession();
  if (!data?.authenticated || !(data.email || data.name)) return null;
  const label = data.name ?? data.email ?? '';
  return (
    <div
      className="border-line flex items-center gap-3 border-t px-5 py-3 text-sm"
      data-testid="user-chip"
    >
      {data.picture ? (
        <img
          src={data.picture}
          alt=""
          referrerPolicy="no-referrer"
          className="size-8 shrink-0 rounded-full"
        />
      ) : (
        <span
          aria-hidden="true"
          className="bg-accent-soft text-accent-strong grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase"
        >
          {label.charAt(0)}
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate font-medium">{label}</div>
        {data.email && data.name && (
          <div className="text-subtle truncate text-xs">{data.email}</div>
        )}
      </div>
    </div>
  );
}
