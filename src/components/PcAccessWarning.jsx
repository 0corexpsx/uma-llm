import React, { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button, Modal, OS } from './ui.jsx';
import { t } from '../i18n.js';

export default function PcAccessWarning({ open, onClose, onConfirm, busy = false }) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Allow full PC access?')}
      eyebrow={t('Security warning')}
      width={560}
      className="pc-access-modal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger" icon={ShieldAlert} onClick={onConfirm} disabled={!checked} loading={busy}>
            {t('I understand — enable full access')}
          </Button>
        </>
      }
    >
      <div className="pc-warning-hero">
        <span className="pc-warning-icon"><ShieldAlert size={28} strokeWidth={1.5} /></span>
        <div>
          <strong>{t('This removes the folder boundary.')}</strong>
          <p>{t('Only continue on a computer you own and trust, with a model you trust. The local AI can be manipulated by files or prompts it reads.')}</p>
        </div>
      </div>
      <ul className="pc-warning-list">
        <li><strong>{t('Read anything')}</strong>{' '}{t('your {0} can read — documents, browser data, app data, other drives.', [OS.account])}</li>
        <li><strong>{t('Write and modify anything')}</strong>{' '}{t('if file edits are enabled — including system and configuration files.')}</li>
        <li><strong>{t('Terminal commands are still separate.')}</strong>{' '}{t('Enabling full PC access does not enable them automatically.')}</li>
        <li><strong>{t('Deleting is still separate.')}</strong>{' '}{t('It stays off unless you turn it on, and files go to the {0}.', [OS.trash])}</li>
        <li><strong>{t('You are responsible')}</strong>{' '}{t('for what the agent does with this access. There is no sandbox and no cloud safety net.')}</li>
      </ul>
      <label className="pc-consent">
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>{t('I understand the risk and accept responsibility for allowing the AI to access my PC outside the workspace.')}</span>
      </label>
    </Modal>
  );
}
