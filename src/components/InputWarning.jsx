import React, { useEffect, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { Button, Modal } from './ui.jsx';
import { t } from '../i18n.js';

/** The confirmation before the AI may use the mouse and keyboard in other programs. */
export default function InputWarning({ open, onClose, onConfirm, busy = false }) {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  const mac = window.uma?.platform === 'darwin';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Let the AI control the mouse and keyboard?')}
      eyebrow={t('Security warning')}
      width={560}
      className="pc-access-modal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger" icon={MousePointerClick} onClick={onConfirm} disabled={!checked} loading={busy}>
            {t('I understand — allow control')}
          </Button>
        </>
      }
    >
      <div className="pc-warning-hero">
        <span className="pc-warning-icon"><MousePointerClick size={28} strokeWidth={1.5} /></span>
        <div>
          <strong>{t('The AI will act on your real screen.')}</strong>
          <p>{t('It can click, type and press keys in any program you have open, as if it were you: open a video in Brave and play it, fill in a form, use a menu. Local models make mistakes, and a web page can try to trick them, so stay at the PC while it works.')}</p>
        </div>
      </div>
      <ul className="pc-warning-list">
        <li><strong>{t('To stop it at any moment:')}</strong>{' '}{t('press Ctrl+Alt+Esc, or push the mouse into the top-left corner of the screen. It stays stopped until your next message.')}</li>
        <li><strong>{t('You see when it acts:')}</strong>{' '}{t('a blue notice appears in the bottom-right corner, and every click and key press is listed as a step in the chat.')}</li>
        <li><strong>{t('Clicking needs sight:')}</strong>{' '}{t('turn on "See the screen" and use a model that can see. Without it, the AI can still use the keyboard.')}</li>
        {mac && <li><strong>{t('On a Mac:')}</strong>{' '}{t('allow Uma LLM in System Settings → Privacy & Security → Accessibility the first time.')}</li>}
        <li><strong>{t('You are responsible')}</strong>{' '}{t('for what the AI does with this control. Do not leave it working alone on accounts, payments or important files.')}</li>
      </ul>
      <label className="pc-consent">
        <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <span>{t('I understand that the AI will use my mouse and keyboard, and I will watch it while it works.')}</span>
      </label>
    </Modal>
  );
}
