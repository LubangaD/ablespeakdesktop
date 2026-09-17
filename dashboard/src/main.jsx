import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
// Bundled so the app looks right with no internet connection (DESIGN.md)
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 5000, retry: 1, staleTime: 3000 } }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
