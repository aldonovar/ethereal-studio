import React from 'react';
import ReactDOM from 'react-dom/client';
import DesktopRoot from './DesktopRoot';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AppErrorBoundary>
      <DesktopRoot />
    </AppErrorBoundary>
  </React.StrictMode>
);
