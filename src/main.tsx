import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './workspace.css';
import './apple.css';
import './studio.css';
import './motion.css';
import './motion';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
