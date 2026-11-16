import React, { useEffect, useState } from 'react';
import { Check, Coffee, Copy, Mail } from 'lucide-react';
import { api } from '../api.js';
import { Button, CollabCredit, umaLogo } from './ui.jsx';
import adaQr from '../assets/ada-qr.png';
import { t } from '../i18n.js';

export const KOFI_URL = 'https://ko-fi.com/0corexpsx';
export const ADA_ADDRESS = 'addr1qy6m2qmylpmex6jyyvl93ptc9v7lwy2zgqjepvfunxn69uxrha4fzu8e85nxrz6zvkpyz7lypd4dv2ng9vdf37pakx5qnk5apg';
export const SUPPORT_EMAIL = '0corexpsx@gmail.com';

/**
 * The small window shown at every start, before Uma's main window: Uma in her carrot shirt, how to
 * support the project (Ko-fi, or ADA with its QR code), and where to write for help. Continue (or
 * Enter, Esc, or closing it) opens Uma. Texts are in the language chosen in the installer.
 */
export default function StartView() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = t('Uma LLM');
    const onKey = (event) => {
      if (event.key === 'Enter' || event.key === 'Escape') api.startContinue?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const copyAddress = async () => {
    try {
      await api.copyText(ADA_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="start-view">
      <div className="uma-stage start-stage">
        <div className="uma-band" />
        <img className="uma-portrait" src={umaLogo} width={152} height={152} alt={t('Uma, the horse')} draggable={false} />
      </div>
      <h1>{t('Uma LLM')}</h1>
      <CollabCredit className="boot-collab" />

      <p className="start-lead">
        {t('Do you like Uma? If you love the project, you can offer me a coffee. Every donation helps Uma grow and brings many new updates every month.')}
      </p>

      <Button variant="secondary" icon={Coffee} className="start-coffee-btn" onClick={() => api.openExternal(KOFI_URL).catch(() => {})}>
        {t('Buy me a coffee on Ko-fi')}
      </Button>

      <div className="start-ada">
        <img className="start-qr" src={adaQr} width={128} height={128} alt={t('QR code of the ADA address')} draggable={false} />
        <div className="start-ada-text">
          <strong>{t('Or donate in ADA (Cardano)')}</strong>
          <code className="start-ada-address">{ADA_ADDRESS}</code>
          <button type="button" className="start-link" onClick={copyAddress}>
            {copied ? <Check size={12} /> : <Copy size={12} />}{' '}{copied ? t('Copied') : t('Copy address')}
          </button>
        </div>
      </div>

      <p className="start-support">
        {t('Help, bug reports or ideas for new features:')}{' '}
        <button type="button" className="start-link" onClick={() => api.openExternal(`mailto:${SUPPORT_EMAIL}`).catch(() => {})}>
          <Mail size={12} />{' '}{SUPPORT_EMAIL}
        </button>
      </p>

      <Button variant="primary" className="start-continue" autoFocus onClick={() => api.startContinue?.()}>
        {t('Continue')}
      </Button>
    </div>
  );
}
