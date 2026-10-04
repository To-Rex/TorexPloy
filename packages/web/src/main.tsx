import '@fontsource-variable/onest';
import '@fontsource-variable/jetbrains-mono';
import './styles/base.css';
import './styles/tokens.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/features.css';
import './styles/frame.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import { router } from './app/router.tsx';
import { ConfirmProvider } from './components/Dialog.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { I18nProvider, storedLocale } from './i18n/index.tsx';
import { ApiError } from './lib/api.ts';
import { keys } from './lib/queries.ts';
import { ThemeProvider } from './lib/theme.tsx';

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      // An expired session anywhere sends the user back through the gate.
      if (error instanceof ApiError && error.code === 'unauthorized' && query.queryKey[0] !== 'bootstrap') {
        void queryClient.invalidateQueries({ queryKey: keys.bootstrap });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => error instanceof ApiError && (error.code === 'network' || error.status >= 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider initial={storedLocale()}>
          <ToastProvider>
            <ConfirmProvider>
              <RouterProvider router={router} />
            </ConfirmProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
