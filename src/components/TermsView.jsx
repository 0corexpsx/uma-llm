import React, { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { api } from '../api.js';
import { Button, Logo, Spinner } from './ui.jsx';
import { t } from '../i18n.js';

/**
 * The licence window, before Uma starts: on the first start and after every update.
 * Accept continues to Uma; Decline (or closing the window) closes Uma.
 */
export default function TermsView() {
  const [info, setInfo] = useState(null);
  const [answering, setAnswering] = useState('');

  useEffect(() => {
    document.title = t('Uma LLM · Licence');
    api.termsInfo().then(setInfo).catch(() => setInfo({ text: '', version: '', previous: '', theme: 'system' }));
  }, []);

  const answer = async (accepted) => {
    setAnswering(accepted ? 'accept' : 'decline');
    try {
      await api.answerTerms(accepted);
    } catch {
      setAnswering('');
    }
  };

  return (
    <div className="terms-view">
      <header className="terms-head">
        <Logo size={40} />
        <div>
          <h1>{t('Uma LLM licence')}</h1>
          <p>
            {info?.previous
              ? t('Uma LLM was updated to {0}. Please read the licence and accept it again to continue.', [info.version])
              : t('Uma LLM is free and open source under the GNU GPL v3. Please read the licence and accept it to continue.')}
          </p>
        </div>
      </header>
      {info ? (
        <div className="terms-text" tabIndex={0} aria-label={t('Licence')}>
          {info.text || t('The licence file is missing. Download Uma LLM again from the official website.')}
        </div>
      ) : (
        <div className="terms-text"><Spinner size={14} />{' '}{t('Loading…')}</div>
      )}
      <footer className="terms-foot">
        <span className="terms-foot-note">
          {t('Decline closes Uma LLM.')}{' '}
          <button type="button" onClick={() => api.openExternal('https://www.0corexpsx.com/uma')}>www.0corexpsx.com/uma</button>
        </span>
        <Button variant="secondary" icon={X} loading={answering === 'decline'} disabled={Boolean(answering)} onClick={() => answer(false)}>
          {t('Decline')}
        </Button>
        <Button variant="primary" icon={Check} loading={answering === 'accept'} disabled={!info?.text || Boolean(answering)} onClick={() => answer(true)}>
          {t('Accept')}
        </Button>
      </footer>
    </div>
  );
}
