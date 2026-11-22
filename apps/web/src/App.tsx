import { useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { fetchHealth } from './api';

function Home() {
  const { data, isError, isPending } = useQuery({ queryKey: ['health'], queryFn: fetchHealth });
  const status = isPending
    ? 'Summoning the server…'
    : isError
      ? 'Server unreachable'
      : 'Server online';

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-6xl" aria-hidden>
        🔱
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Hoseidon</h1>
      <p className="text-neutral-500 dark:text-neutral-400">God of the garden hose.</p>
      <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-1 text-sm dark:border-neutral-800">
        <span
          className={`size-2 rounded-full ${isError ? 'bg-red-500' : isPending ? 'bg-neutral-400' : 'bg-aqua-500'}`}
        />
        {status}
        {data?.mock ? ' (mock mode)' : ''}
      </p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
