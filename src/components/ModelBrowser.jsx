import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, Download, ExternalLink, Heart, Lock, Search } from 'lucide-react';
import { api } from '../api.js';
import { Button, Empty, Modal, SectionLabel, Spinner, formatBytes } from './ui.jsx';
import { MemoryEstimate } from './ModelSettings.jsx';
import { t } from '../i18n.js';

function compactNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

/** A quick guide from file size alone. The exact estimate appears once a version is selected. */
function sizeFit(bytes, hardware) {
  const gb = bytes / 1024 ** 3;
  if (hardware?.vramGB && gb + 1.5 <= hardware.vramGB - 1) return { label: t('Should fit GPU'), tone: 'good' };
  if (hardware?.ramGB && gb + 2 <= hardware.ramGB - 3) return { label: hardware.vramGB ? t('Partly on CPU') : t('Runs on CPU'), tone: 'warm' };
  return { label: t('Too large'), tone: 'bad' };
}

export function VersionPicker({ repo, installed, download, hardware, onClose, onStarted }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [memory, setMemory] = useState(null);
  const [memoryLoading, setMemoryLoading] = useState(false);

  useEffect(() => {
    setDetail(null);
    setSelected(null);
    setMemory(null);
    setError('');
    if (!repo) return;
    api.hubVariants(repo).then((data) => {
      setDetail(data);
      const fitting = data.variants.filter((item) => sizeFit(item.sizeBytes, hardware).tone !== 'bad');
      setSelected(fitting[fitting.length - 1]?.key || data.variants[0]?.key || null);
    }).catch((err) => setError(err.message));
  }, [repo]);

  useEffect(() => {
    if (!repo || !selected) return undefined;
    let current = true;
    setMemoryLoading(true);
    setMemory(null);
    api.hubEstimate(repo, selected)
      .then((result) => { if (current) setMemory(result); })
      .catch(() => { if (current) setMemory({ failed: true }); })
      .finally(() => { if (current) setMemoryLoading(false); });
    return () => { current = false; };
  }, [repo, selected]);

  const variant = detail?.variants.find((item) => item.key === selected);
  const owned = (key) => installed.some((entry) => entry.id === `hub:${repo}:${key}`);

  const start = async () => {
    setError('');
    try {
      await api.downloadFromHub(repo, selected);
      onStarted?.();
      onClose();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal
      open={Boolean(repo)}
      onClose={onClose}
      title={repo || ''}
      eyebrow={t('Choose a version')}
      width={720}
      footer={(
        <>
          {detail && <Button variant="ghost" icon={ExternalLink} onClick={() => api.openExternal(detail.url)}>{t('Model card')}</Button>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button
            variant="primary"
            icon={Download}
            onClick={start}
            disabled={!variant || owned(selected) || Boolean(download) || detail?.gated}
          >
            {variant ? t('Download {0} ({1})', [variant.quant, formatBytes(variant.sizeBytes + (detail?.vision?.size || 0))]) : t('Download')}
          </Button>
        </>
      )}
    >
      {error && <div className="modal-error">{error}</div>}
      {!detail && !error && <div className="mset-loading"><Spinner size={16} />{' '}{t('Listing versions…')}</div>}
      {detail?.gated && (
        <div className="callout warning"><Lock size={15} /><p>{t('This repository needs a Hugging Face login and licence approval. Accept it on the model card, download the file in a browser, then use Import GGUF.')}</p></div>
      )}
      {detail && detail.variants.length === 0 && <p className="modal-copy">{t('This repository has no GGUF model files Uma can use.')}</p>}
      {detail && detail.variants.length > 0 && (
        <div className="mset-body">
          {memoryLoading || memory?.estimate ? (
            <MemoryEstimate estimate={memory?.estimate} hardware={hardware} loading={memoryLoading} />
          ) : memory?.failed ? (
            <div className="mset-memory is-empty"><AlertCircle size={14} />{' '}{t('Could not read this version’s header, so there is no memory estimate.')}</div>
          ) : null}
          <p className="hub-note">
            {t('Estimated at your default context size. You can change settings after downloading.')}
            {detail.vision ? t(' Can see images: includes a {0} vision file.', [formatBytes(detail.vision.size)]) : t(' No vision file here, so this one is probably text-only.')}
          </p>
          <div className="hub-variants">
            {detail.variants.map((item) => {
              const fit = sizeFit(item.sizeBytes, hardware);
              return (
                <button type="button" key={item.key} className={`hub-variant ${item.key === selected ? 'is-on' : ''}`} onClick={() => setSelected(item.key)}>
                  <strong>{item.quant}</strong>
                  <span>{formatBytes(item.sizeBytes)}{item.files.length > 1 ? ` · ${t('{0} files', [item.files.length])}` : ''}</span>
                  {owned(item.key)
                    ? <span className="mini-badge green"><Check size={10} />{' '}{t('Downloaded')}</span>
                    : <span className={`fit-badge fit-${fit.tone}`}>{fit.label}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function ModelBrowser({ hardware, installed, download, onStarted }) {
  const [query, setQuery] = useState('qwen');
  const [sort, setSort] = useState('downloads');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [repo, setRepo] = useState(null);

  const search = async () => {
    setLoading(true);
    setError('');
    try {
      setResults(await api.searchHub({ query, sort, limit: 40 }));
    } catch (err) {
      if (err.name !== 'AbortError' && !/abort/i.test(err.message)) setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="models-section" id="models-hub">
      <div className="models-section-head">
        <div>
          <SectionLabel>{t('Search Hugging Face')}</SectionLabel>
          <p>{t('Every public GGUF model, live. Searching contacts huggingface.co with what you type; nothing else about you or your files is sent.')}</p>
        </div>
      </div>
      <form className="models-toolbar" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('qwen3.8 27b, deepseek, gemma, llama…')} />
        <select className="select" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="downloads">{t('Most downloaded')}</option>
          <option value="likes">{t('Most liked')}</option>
          <option value="trendingScore">{t('Trending')}</option>
          <option value="lastModified">{t('Recently updated')}</option>
        </select>
        <Button variant="secondary" icon={Search} type="submit" loading={loading}>{t('Search')}</Button>
      </form>
      {error && <div className="inline-error"><AlertCircle size={16} /><span>{error}</span></div>}
      {results && results.length === 0 && <Empty icon={Search} title={t('No models found')}>{t('Try a shorter search, such as just the model family.')}</Empty>}
      {results && results.length > 0 && (
        <div className="hub-results">
          {results.map((item) => (
            <button type="button" className="hub-result" key={item.id} onClick={() => setRepo(item.id)}>
              <strong>{item.id.split('/')[1]}</strong>
              <span className="hub-owner">{item.id.split('/')[0]}</span>
              <span className="hub-stats">
                {item.gated && <Lock size={11} />}
                <Download size={11} /> {compactNumber(item.downloads)}
                <Heart size={11} /> {compactNumber(item.likes)}
              </span>
            </button>
          ))}
        </div>
      )}
      <VersionPicker repo={repo} installed={installed} download={download} hardware={hardware} onClose={() => setRepo(null)} onStarted={onStarted} />
    </section>
  );
}
