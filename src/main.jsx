import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/manrope';
import './styles.css';
import './collab.css';
import './aero.css';
import App from './App.jsx';
import TermsView from './components/TermsView.jsx';
import StartView from './components/StartView.jsx';
import { setLanguage } from './i18n.js';

// Uma has one look, Windows 7 Aero in blue glass (aero.css), on the dark colours.
document.documentElement.dataset.skin = 'aero';
document.documentElement.dataset.theme = 'dark';
// Lets the stylesheet make room for the Mac's own window buttons.
document.documentElement.dataset.platform = window.uma?.platform || '';
setLanguage(window.uma?.language || 'en');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {window.location.hash === '#terms' ? <TermsView /> : window.location.hash === '#start' ? <StartView /> : <App />}
  </React.StrictMode>,
);
