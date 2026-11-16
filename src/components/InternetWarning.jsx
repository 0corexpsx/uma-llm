import React, { useEffect, useState } from 'react';
import { Globe, ShieldAlert } from 'lucide-react';
import { Button, Modal } from './ui.jsx';
import { t } from '../i18n.js';

export default function InternetWarning({ open, onClose, onConfirm, busy = false }) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Allow internet access?')}
      eyebrow={t('Network permission')}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger" icon={Globe} onClick={onConfirm} disabled={!checked} loading={busy}>
            {t('I understand — enable internet')}
          </Button>
        </>
      }
    >
      <div className="pc-warning-hero">
        <span className="pc-warning-icon"><ShieldAlert size={28} strokeWidth={1.5} /></span>
        <div>
          <strong>{t('This connects the local AI to the public web.')}</strong>
          <p>{t('Only enable this if you understand that web content is untrusted and can contain prompt-injection attacks.')}</p>
        </div>
      </div>
      <ul className="pc-warning-list">
        <li><strong>{t('Search queries leave this PC.')}</strong>{' '}{t('They are sent to DuckDuckGo; page requests go to the sites you visit.')}</li>
        <li><strong>{t('Web pages are untrusted data.')}</strong>{' '}{t('A page can try to instruct the model to do something else. The agent is told to treat pages as data, not commands.')}</li>
        <li><strong>{t('Private addresses stay blocked.')}</strong>{' '}{t('Uma refuses localhost, LAN addresses, and private IPs for internet tools.')}</li>
        <li><strong>{t('Only public text pages are read.')}</strong>{' '}{t('The fetcher accepts HTML, plain text, JSON, and XML up to 2 MB; binary files and downloads are rejected.')}</li>
        <li><strong>{t('You are responsible')}</strong>{' '}{t('for the queries and pages you ask the AI to access.')}</li>
      </ul>
      <label className="pc-consent">
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>{t('I understand the risk and accept responsibility for allowing the AI to access the internet.')}</span>
      </label>
    </Modal>
  );
}
