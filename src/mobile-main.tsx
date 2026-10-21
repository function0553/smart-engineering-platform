import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMobileTransport } from './mobile-transport';
import MobileApp from './MobileApp';
import './style.css';
import './workspace.css';
installMobileTransport();
createRoot(document.getElementById('root')!).render(<React.StrictMode><MobileApp/></React.StrictMode>);
