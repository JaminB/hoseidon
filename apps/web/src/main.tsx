import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { BrowserRouter } from 'react-router';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { Toaster } from './components/ui/toast';
import { CACHE_BUSTER, CACHE_MAX_AGE_MS, createIdbPersister } from './lib/persist';
import { initTheme } from './lib/theme';
import './index.css';

initTheme();
registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: true,
      // Must outlive the persisted cache's maxAge, or restored entries are collected at once.
      gcTime: CACHE_MAX_AGE_MS,
    },
    // Offline, fail a command at once. The default would queue it and water later.
    mutations: { networkMode: 'always' },
  },
});
const persister = createIdbPersister();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE_MS, buster: CACHE_BUSTER }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster />
    </PersistQueryClientProvider>
  </StrictMode>,
);
