import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Check, ChevronDown, Cpu, Download, Gauge, HardDrive, Import, Layers, Link2, MemoryStick, MoreHorizontal, Play, RefreshCw, Search, Server, SlidersHorizontal, Sparkles, Square, Trash2, Zap, Boxes, CircleStop, FolderOpen, X, Pause,
} from 'lucide-react';
import { api } from '../api.js';
import {
  Button, Empty, Field, IconButton, Modal, Progress, SectionLabel, Spinner,
  formatBytes, formatRelative, formatSpeed,
} from './ui.jsx';
import ModelBrowser, { VersionPicker } from './ModelBrowser.jsx';
import ModelSettings from './ModelSettings.jsx';
import { t, tj } from '../i18n.js';

function activeDownloadState(states) {
  return Object.values(states).find((state) => ['connecting', 'downloading', 'cancelling', 'pausing'].includes(state.status));
}

// The library shows the original models, or (when chosen) only abliterated and modified ones.
const EDITION_KEY = 'uma.models.edition';
function savedEdition() {
  try { return localStorage.getItem(EDITION_KEY) === 'modified' ? 'modified' : 'original'; } catch { return 'original'; }
}

/** Pause or Resume, and Cancel, for a download that is running or paused. */
function DownloadControls({ state, compact = false }) {
  const paused = state.status === 'paused';
  const busy = ['pausing', 'cancelling'].includes(state.status);
  const run = (call) => call.catch?.(() => {});
  return (
    <span className={`download-controls ${compact ? 'is-compact' : ''}`}>
      {paused ? (
        <button type="button" className="download-control" onClick={() => run(api.resumeDownload(state.id))}><Play size={12} />{' '}{t('Resume')}</button>
      ) : (
        <button type="button" className="download-control" disabled={busy} onClick={() => run(api.pauseDownload(state.id))}><Pause size={12} />{' '}{t('Pause')}</button>
      )}
      <button type="button" className="download-control is-cancel" disabled={state.status === 'cancelling'} onClick={() => run(api.cancelDownload(state.id))}><X size={12} />{' '}{t('Cancel')}</button>
    </span>
  );
}

function fitInfo(model, hardware) {
  if (!hardware) return { label: t('Unknown fit'), tone: 'neutral' };
  if (model.minVramGB && hardware.vramGB >= model.minVramGB) {
    return { label: t('Fits your GPU'), tone: 'good' };
  }
  if (hardware.ramGB >= model.minRamGB) {
    return { label: t('Runs on CPU'), tone: 'warm' };
  }
  return { label: t('Needs more memory'), tone: 'bad' };
}

export default function ModelsView({ boot, modelProgress, runtimeProgress, onRefreshBoot, onRuntimeProgress, showToast }) {
  const [data, setData] = useState(boot.models);
  const [backend, setBackend] = useState(boot.runtime.backend || boot.settings.runtimeBackend || 'auto');
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [settingsFor, setSettingsFor] = useState(null);
  const [url, setUrl] = useState('');
  const [urlName, setUrlName] = useState('');
  const [removeTarget, setRemoveTarget] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('All');
  const [edition, setEdition] = useState(savedEdition);
  const chooseEdition = (next) => {
    setEdition(next);
    setFamily('All');
    try { localStorage.setItem(EDITION_KEY, next); } catch {}
  };

  useEffect(() => {
    setData(boot.models);
  }, [boot.models]);

  const download = activeDownloadState(modelProgress);
  // A download that is not a library card (a version, a URL): running, or else paused.
  const notACard = (state) => state && !data.catalog.find((model) => model.id === state.id);
  const pausedOther = Object.values(modelProgress).find((state) => state.status === 'paused' && notACard(state));
  const customDownload = notACard(download) ? download : pausedOther || null;
  const installed = data.installed || [];
  const activeModel = installed.find((model) => model.id === boot.activeModel?.id) || boot.activeModel;
  const recommended = boot.hardware?.vramGB >= 7 ? 'qwen3-4b' : boot.hardware?.vramGB >= 5 ? 'qwen25-3b' : 'qwen25-15b';
  const backendOptions = boot.runtime.backends || [];
  const engineLabel = backendOptions.find((item) => item.id === boot.runtime.backend)?.label
    || (boot.runtime.backend === 'metal' ? 'GPU · Metal' : boot.runtime.backend) || t('Auto');
  const chosenEngine = backendOptions.find((item) => item.id === (backend === 'auto' ? boot.runtime.recommendedBackend : backend));

  const recommendedModels = useMemo(() => {
    if (!data.catalog.length) return [];
    const vram = boot.hardware?.vramGB || 0;
    const ram = boot.hardware?.ramGB || 0;
    const picks = [];
    if (vram >= 20 || ram >= 48) {
      picks.push('qwen25-coder-14b', 'qwen25-32b', 'qwen3-30b-a3b');
    } else if (vram >= 10 || ram >= 32) {
      picks.push('qwen25-coder-14b', 'qwen3-30b-a3b', 'qwen3-14b');
    } else if (vram >= 7 || ram >= 24) {
      picks.push('qwen25-coder-7b', 'qwen3-4b', 'mistral-7b-v03');
    } else if (vram >= 5 || ram >= 16) {
      picks.push('qwen25-3b', 'qwen3-4b', 'mistral-7b-v03');
    } else {
      picks.push('qwen25-15b', 'llama32-3b', 'qwen25-05b');
    }
    return picks.map((id) => data.catalog.find((model) => model.id === id)).filter(Boolean);
  }, [data.catalog, boot.hardware]);

  const refresh = async () => {
    const models = await api.listModels();
    setData(models);
    await onRefreshBoot?.();
  };

  // The catalog card whose every version is being chosen from (All versions).
  const [versionsRepo, setVersionsRepo] = useState(null);

  const startDownload = async (model) => {
    setError('');
    try {
      await api.downloadModel(model.id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const useModel = async (model) => {
    setBusyId(model.id);
    try {
      const next = await api.setActiveModel(model.id);
      await onRefreshBoot?.();
      setData(next.models);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusyId('');
    }
  };

  const removeModel = async () => {
    if (!removeTarget) return;
    try {
      const models = await api.removeModel(removeTarget.id);
      setData(models);
      setModal(null);
      setRemoveTarget(null);
      await onRefreshBoot?.();
      showToast(t('Model removed from this PC'), 'success');
    } catch (err) {
      setError(err.message);
    }
  };

  const installRuntime = async () => {
    setError('');
    setRuntimeBusy(true);
    try {
      await api.installRuntime(backend);
    } catch (err) {
      setError(err.message);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const switchEngine = async () => {
    setError('');
    setRuntimeBusy(true);
    try {
      await api.useRuntime(chosenEngine.id);
      await onRefreshBoot?.();
      showToast(t('Now using {0}', [chosenEngine.label]), 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const addUrl = async () => {
    setError('');
    if (!url.trim()) return;
    try {
      await api.addModelUrl(url.trim(), urlName.trim());
      setModal(null);
      setUrl('');
      setUrlName('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const importModel = async () => {
    setError('');
    try {
      const entry = await api.importModel();
      if (!entry) return;
      await refresh();
      showToast(t('{0} imported', [entry.name]), 'success');
    } catch (err) {
      setError(err.message);
    }
  };

  const runtimeInstalling = runtimeProgress && !['done', 'error'].includes(runtimeProgress.phase);

  const editionCatalog = useMemo(
    () => data.catalog.filter((model) => (edition === 'modified' ? Boolean(model.modified) : !model.modified)),
    [data.catalog, edition],
  );
  const families = useMemo(() => ['All', ...Array.from(new Set(editionCatalog.map((model) => model.family)))], [editionCatalog]);
  const filteredCatalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Each family together, in the order of the chips, smallest model first.
    const order = new Map(families.map((name, index) => [name, index]));
    return editionCatalog.filter((model) => {
      const inFamily = family === 'All' || model.family === family;
      const matchesQuery = !needle
        || `${model.name} ${model.family} ${t(model.description)} ${t(model.tagline)}`.toLowerCase().includes(needle);
      return inFamily && matchesQuery;
    }).sort((a, b) => (order.get(a.family) ?? 99) - (order.get(b.family) ?? 99) || (a.sizeBytes || 0) - (b.sizeBytes || 0));
  }, [editionCatalog, families, family, query]);

  return (
    <div className="models-view">
      <header className="view-header models-header">
        <div>
          <div className="eyebrow">{t('Models')}</div>
          <h2>{t('Models')}</h2>
        </div>
        <div className="models-header-actions">
          <Button size="sm" variant="ghost" icon={Import} onClick={importModel}>{t('Import GGUF')}</Button>
          <Button size="sm" variant="secondary" icon={Link2} onClick={() => setModal('url')}>{t('Add from URL')}</Button>
        </div>
      </header>

      <div className="models-scroll">
        {error && (
          <div className="inline-error">
            <AlertCircle size={16} />
            <span>{error}</span>
            <IconButton label={t('Dismiss')} icon={X} onClick={() => setError('')} />
          </div>
        )}

        <section className="model-hero">
          <div className="model-hero-copy">
            <div className="eyebrow">{t('Active model')}</div>
            <h1>{activeModel?.name || t('No model selected')}</h1>
            <p>
              {activeModel
                ? t('{0} · {1} on disk · {2}', [activeModel.quant || 'GGUF', formatBytes(activeModel.size), boot.server.running ? t('loaded in memory') : t('starts when you send a message')])
                : t('Choose a model below. It downloads once and then runs entirely on this computer.')}
            </p>
            <div className="hero-badges">
              <span className={`status-badge ${boot.server.running ? 'is-live' : ''}`}>
                <span className="status-dot" /> {boot.server.running ? t('Server awake · port {0}', [boot.server.port]) : t('Server asleep')}
              </span>
              <span className="status-badge"><Cpu size={12} /> {engineLabel}</span>
              <span className="status-badge"><HardDrive size={12} /> {t('{0} used', [formatBytes(boot.storage.modelBytes)])}</span>
            </div>
          </div>
          <div className="model-hero-mark">
            <span className="hero-orbit orbit-a" />
            <span className="hero-orbit orbit-b" />
            <span className="hero-core"><Boxes size={34} strokeWidth={1.2} /></span>
          </div>
        </section>

        {customDownload && (
          <section className="active-download-card">
            <div className="active-download-head">
              <span className="download-pulse"><Download size={16} /></span>
              <div>
                <strong>{customDownload.status === 'paused' ? t('Paused') : t('Downloading')}{' '}{customDownload.model?.name || t('custom model')}</strong>
                <span>{customDownload.status === 'cancelling' ? t('Cancelling…') : `${formatBytes(customDownload.received)} of ${formatBytes(customDownload.total)}`}</span>
              </div>
              <span className="download-percent">{Math.round(customDownload.percent || 0)}%</span>
              <DownloadControls state={customDownload} />
            </div>
            <Progress value={customDownload.percent || 0} />
            <div className="download-meta">
              <span>{customDownload.status === 'paused' ? t('Paused') : formatSpeed(customDownload.speed)}</span>
              <span>{t('Pause keeps what is downloaded; Resume continues from there, also after closing Uma.')}</span>
            </div>
          </section>
        )}

        <section className="models-section">
          <div className="models-section-head">
            <div>
              <SectionLabel>{t('On this computer')}</SectionLabel>
              <p>{t('Models live in Uma’s own folder, not inside your workspace.')}</p>
            </div>
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => api.revealModels()}>{t('Open model folder')}</Button>
          </div>

          {installed.length === 0 ? (
            <Empty icon={Boxes} title={t('No local models yet')}>
              {t('Pick one from the library below. A 1.5B model is a good first download.')}
            </Empty>
          ) : (
            <div className="installed-grid">
              {installed.map((model) => {
                const isActive = model.id === activeModel?.id;
                return (
                  <div className={`installed-card ${isActive ? 'is-active' : ''}`} key={model.id}>
                    <div className="installed-top">
                      <span className="installed-icon"><Layers size={18} strokeWidth={1.5} /></span>
                      <div className="installed-title">
                        <strong>{model.name}</strong>
                        <span>{model.quant || t('GGUF')} · {formatBytes(model.size)}</span>
                      </div>
                      <div className="installed-actions">
                        {isActive ? <span className="mini-badge green"><Check size={10} />{' '}{t('In use')}</span> : (
                          <Button size="xs" variant="secondary" onClick={() => useModel(model)} loading={busyId === model.id}>{t('Use')}</Button>
                        )}
                        <IconButton label={t('Settings for {0}', [model.name])} icon={SlidersHorizontal} onClick={() => setSettingsFor(model.id)} />
                        <IconButton
                          label={t('Remove {0}', [model.name])}
                          icon={Trash2}
                          onClick={() => { setRemoveTarget(model); setModal('remove'); setError(''); }}
                        />
                      </div>
                    </div>
                    <div className="installed-path">{model.path}</div>
                    <div className="installed-foot">
                      <span>{model.license || t('See model card')}</span>
                      <span>{t('Added')}{' '}{formatRelative(model.addedAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {recommendedModels.length > 0 && (
          <section className="models-section recommended-section">
            <div className="models-section-head">
              <div>
                <SectionLabel>{t('Recommended for your PC')}</SectionLabel>
                <p>
                  {t('Picked for {0} · {1} GB VRAM · {2} GB RAM.', [boot.hardware?.gpu || t('this hardware'), boot.hardware?.vramGB || 0, boot.hardware?.ramGB || 0])}
                </p>
              </div>
            </div>
            <div className="recommended-grid">
              {recommendedModels.map((model) => {
                const entry = installed.find((item) => item.catalogId === model.id || item.id === model.id);
                const progress = modelProgress[model.id];
                const downloading = progress && ['connecting', 'downloading', 'cancelling', 'pausing', 'paused'].includes(progress.status);
                return (
                  <article className="recommended-card" key={model.id}>
                    <div className="catalog-top">
                      <span className="catalog-family">{model.family}</span>
                      <span className="catalog-params">{model.params}</span>
                    </div>
                    <h4>{model.name}</h4>
                    <p className="recommended-tagline">{t(model.tagline)}</p>
                    <div className="catalog-specs">
                      <span>{model.quant}</span>
                      <span>{model.sizeLabel}</span>
                      <span>{t('{0} tool use', [t(model.tools)])}</span>
                    </div>
                    {downloading ? (
                      <div className="catalog-progress">
                        <div className="catalog-progress-top">
                          <span>{progress.status === 'paused' ? t('Paused') : `${Math.round(progress.percent || 0)}%`}</span>
                          <DownloadControls state={progress} compact />
                        </div>
                        <Progress value={progress.percent || 0} small />
                      </div>
                    ) : entry ? (
                      entry.id === activeModel?.id ? (
                        <span className="mini-badge green"><Check size={10} />{' '}{t('In use')}</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => useModel(entry)} loading={busyId === entry.id}>{t('Use')}</Button>
                      )
                    ) : (
                      <Button size="sm" variant="primary" icon={Download} onClick={() => startDownload(model)} disabled={Boolean(download)}>
                        {t('Download')}
                      </Button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <ModelBrowser hardware={boot.hardware} installed={installed} download={download} onStarted={refresh} />

        <section className="models-section">
          <div className="models-section-head">
            <div>
              <SectionLabel>{t('The library')}</SectionLabel>
              <p>{t('Curated open-weight models, quantized for local machines. Sizes are approximate.')}</p>
            </div>
          </div>

          <div className="edition-switch" role="tablist" aria-label={t('Which models to show')}>
            <button type="button" role="tab" aria-selected={edition === 'original'} className={edition === 'original' ? 'is-on' : ''} onClick={() => chooseEdition('original')}>
              {t('Original models')}
            </button>
            <button type="button" role="tab" aria-selected={edition === 'modified'} className={edition === 'modified' ? 'is-on' : ''} onClick={() => chooseEdition('modified')}>
              {t('Abliterated & modified')}
            </button>
          </div>
          {edition === 'modified' && (
            <p className="edition-note">{t('Community versions of the models: abliterated ones have their refusals removed, others are distilled or fine-tuned. They are not made by the original publishers; check what they produce.')}</p>
          )}

          <div className="models-toolbar">
            <input
              className="input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search models…')}
            />
            <div className="family-chips">
              {families.map((item) => (
                <button
                  type="button"
                  key={item}
                  className={`family-chip ${family === item ? 'is-on' : ''}`}
                  onClick={() => setFamily(item)}
                >
                  {item === 'All' ? t('All') : item}
                </button>
              ))}
            </div>
          </div>

          {filteredCatalog.length === 0 ? (
            <Empty icon={Search} title={t('No models match')}>{t('Try a different search or family filter.')}</Empty>
          ) : (
            <div className="catalog-grid">
              {filteredCatalog.map((model) => {
              const entry = installed.find((item) => item.catalogId === model.id || item.id === model.id)
                || (model.versionsOnly ? installed.find((item) => String(item.id).startsWith(`hub:${model.versionsRepo}:`)) : null);
              const fit = fitInfo(model, boot.hardware);
              const progress = modelProgress[model.id];
              const downloading = progress && ['connecting', 'downloading', 'cancelling', 'pausing', 'paused'].includes(progress.status);
              const isRecommended = recommended === model.id;
              return (
                <article className={`catalog-card ${entry ? 'is-owned' : ''} ${isRecommended ? 'is-recommended' : ''}`} key={model.id}>
                  <div className="catalog-top">
                    <span className="catalog-family">
                      {model.family}
                      {model.modified && <em className="modified-badge">{model.modified === 'abliterated' ? t('Abliterated') : t('Community')}</em>}
                    </span>
                    <span className={`fit-badge fit-${fit.tone}`}>{fit.label}</span>
                  </div>
                  <h3>{model.name}<span>{model.params}</span></h3>
                  <p className="catalog-tagline">{t(model.tagline)}</p>
                  <p className="catalog-desc">{t(model.description)}</p>
                  <div className="catalog-specs">
                    <span>{model.quant}</span>
                    <span>{model.sizeLabel}</span>
                    <span>{t('{0} tool use', [t(model.tools)])}</span>
                  </div>

                  {downloading ? (
                    <div className="catalog-progress">
                      <div className="catalog-progress-top">
                        <span>{Math.round(progress.percent || 0)}%</span>
                        <span>{progress.status === 'paused' ? t('Paused') : progress.status === 'pausing' ? t('Pausing…') : formatSpeed(progress.speed)}</span>
                        <DownloadControls state={progress} compact />
                      </div>
                      <Progress value={progress.percent || 0} small />
                    </div>
                  ) : entry ? (
                    <div className="catalog-owned">
                      <span><Check size={13} />{' '}{t('Downloaded')}</span>
                      {entry.id === activeModel?.id ? (
                        <span className="catalog-in-use">{t('In use')}</span>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => useModel(entry)} loading={busyId === entry.id}>{t('Use model')}</Button>
                      )}
                    </div>
                  ) : (
                    <div className="catalog-action">
                      {model.versionsOnly ? (
                        <Button size="sm" variant="secondary" icon={Download} onClick={() => setVersionsRepo(model.versionsRepo)}>
                          {t('Choose version')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant={isRecommended ? 'primary' : 'secondary'}
                          icon={Download}
                          onClick={() => startDownload(model)}
                          disabled={Boolean(download)}
                        >
                          {t('Download')}
                        </Button>
                      )}
                      {model.versionsRepo && !model.versionsOnly && (
                        <Button size="sm" variant="ghost" onClick={() => setVersionsRepo(model.versionsRepo)}>{t('All versions')}</Button>
                      )}
                      {isRecommended && <span className="recommend-note"><Sparkles size={11} />{' '}{t('Best fit')}</span>}
                    </div>
                  )}
                  {entry && model.versionsRepo && (
                    <button type="button" className="catalog-versions-link" onClick={() => setVersionsRepo(model.versionsRepo)}>{t('All versions')}</button>
                  )}
                  <div className="catalog-license">{model.license} · {model.repo}</div>
                </article>
              );
            })}
          </div>
          )}
        </section>

        <VersionPicker repo={versionsRepo} installed={installed} download={download} hardware={boot.hardware} onClose={() => setVersionsRepo(null)} onStarted={refresh} />

        <section className="models-section runtime-section">
          <div className="runtime-card">
            <div className="runtime-main">
              <div className="runtime-head">
                <span className={`runtime-icon ${boot.runtime.installed ? 'is-installed' : ''}`}><Zap size={20} strokeWidth={1.6} /></span>
                <div>
                  <SectionLabel>{t('Inference engine')}</SectionLabel>
                  <h3>{boot.runtime.installed ? t('llama.cpp is ready') : t('Install the local engine')}</h3>
                  <p>
                    {boot.runtime.installed
                      ? `${engineLabel} · ${boot.runtime.version} · ${boot.runtime.serverPath}`
                      : t('A prebuilt llama.cpp server, downloaded from the official GitHub release. No compiler required.')}
                  </p>
                </div>
              </div>

              {boot.hardware?.hasGpu && backendOptions.length > 0 && (
                <div className="runtime-backend">
                  <span>{t('Backend')}</span>
                  <div className="segmented">
                    <button type="button" className={backend === 'auto' ? 'is-on' : ''} onClick={() => setBackend('auto')}>{t('Auto')}</button>
                    {backendOptions.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className={backend === item.id ? 'is-on' : ''}
                        disabled={!item.available}
                        title={item.reason || (item.installed ? t('Installed ({0})', [item.version]) : t('Not installed yet: {0} download', [item.download]))}
                        onClick={() => setBackend(item.id)}
                      >
                        {item.label}{item.active ? t(' (active)') : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {backendOptions.some((item) => item.build) && (
                <p className="runtime-hint">
                  {t('llama.cpp publishes no GPU engine for Intel Macs, so Uma can build one here with Metal for your graphics card. It needs Apple’s Command Line Tools and CMake, and takes about 15 minutes once. How much faster it is depends on the graphics card: compare the speed under a reply with both engines, and switch back at any time.')}
                </p>
              )}
              {boot.hardware?.nvidia && backendOptions.some((item) => item.id === 'cuda') && (
                <p className="runtime-hint">
                  {t('CUDA is NVIDIA\'s own compute platform. Vulkan is a much smaller download and also works on AMD and Intel GPUs. Installed engines stay on this PC, so you can switch at any time.')}
                </p>
              )}

              {runtimeInstalling ? (
                <div className="runtime-progress">
                  <div className="download-state-top">
                    <span>{runtimeProgress.message}</span>
                    <span>{Math.round(runtimeProgress.percent || 0)}%</span>
                  </div>
                  <Progress value={runtimeProgress.percent || 0} />
                  <div className="download-state-meta">
                    <span>{runtimeProgress.detail || t('Working…')}</span>
                    <span>{formatSpeed(runtimeProgress.speed)}</span>
                  </div>
                </div>
              ) : (
                <div className="runtime-actions">
                  {chosenEngine?.installed && !chosenEngine.active && (
                    <Button variant="primary" icon={Zap} onClick={switchEngine} disabled={runtimeBusy}>
                      {t('Switch to {0}', [chosenEngine.label])}
                    </Button>
                  )}
                  <Button
                    variant={chosenEngine?.installed ? 'ghost' : 'primary'}
                    icon={chosenEngine?.installed ? RefreshCw : Download}
                    onClick={installRuntime}
                    disabled={runtimeBusy}
                  >
                    {chosenEngine?.installed
                      ? (chosenEngine.build ? t('Build {0} again', [chosenEngine.label]) : t('Update {0}', [chosenEngine.label]))
                      : chosenEngine?.build ? t('Build {0} ({1})', [chosenEngine.label, t(chosenEngine.download)])
                        : chosenEngine ? t('Download {0} ({1})', [chosenEngine.label, t(chosenEngine.download)]) : t('Install engine')}
                  </Button>
                  {boot.server.running && (
                    <Button variant="ghost" icon={Square} onClick={async () => { await api.stopServer(); await onRefreshBoot?.(); }}>{t('Stop server')}</Button>
                  )}
                </div>
              )}
            </div>

            <div className="runtime-side">
              <div className="runtime-stat">
                <span><Cpu size={13} />{' '}{t('Processor')}</span>
                <strong>{boot.hardware?.gpu || t('CPU only')}</strong>
                <em>{boot.hardware?.vramGB ? t('{0} GB VRAM', [boot.hardware.vramGB]) : t('{0} GB system RAM', [boot.hardware?.ramGB])}</em>
              </div>
              <div className="runtime-stat">
                <span><Gauge size={13} />{' '}{t('Context')}</span>
                <strong>{((boot.settings.effectiveContextSize || boot.settings.contextSize || 8192) / 1024).toFixed(0)}{t('k tokens')}</strong>
                <em>{boot.settings.gpuOffload ? t('GPU offload on') : t('CPU only')}</em>
              </div>
              <div className="runtime-stat">
                <span><Server size={13} />{' '}{t('Server')}</span>
                <strong>{boot.server.running ? t('Awake') : t('Asleep')}</strong>
                <em>{boot.server.running ? `127.0.0.1:${boot.server.port}` : t('Starts on demand')}</em>
              </div>
            </div>
          </div>
        </section>

        <div className="models-footer-note">
          <HardDrive size={14} />
          {tj('Model files live in {path}. Uma never uploads them.', { path: <code>{boot.storage.modelsDir}</code> })}
        </div>
      </div>

      <ModelSettings
        modelId={settingsFor}
        hardware={boot.hardware}
        onClose={() => setSettingsFor(null)}
        onSaved={onRefreshBoot}
        showToast={showToast}
      />

      <Modal
        open={modal === 'url'}
        onClose={() => setModal(null)}
        title={t('Add a GGUF from a URL')}
        eyebrow={t('Custom model')}
        footer={<><Button variant="ghost" onClick={() => setModal(null)}>{t('Cancel')}</Button><Button variant="primary" icon={Download} onClick={addUrl} disabled={!url.trim()}>{t('Download')}</Button></>}
      >
        <p className="modal-copy">{tj('A direct link to a {ext} file. It downloads into Uma’s model folder.', { ext: <code>.gguf</code> })}</p>
        <Field label={t('Model URL')}>
          <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={t('https://huggingface.co/…/model-Q4_K_M.gguf')} autoFocus />
        </Field>
        <Field label={t('Display name')} hint={t('Optional')}>
          <input className="input" value={urlName} onChange={(event) => setUrlName(event.target.value)} placeholder={t('My custom model')} />
        </Field>
        {error && <div className="modal-error">{error}</div>}
      </Modal>

      <Modal
        open={modal === 'remove'}
        onClose={() => setModal(null)}
        title={t('Remove this model?')}
        eyebrow={t('Confirm')}
        footer={<><Button variant="ghost" onClick={() => setModal(null)}>{t('Keep it')}</Button><Button variant="danger" icon={Trash2} onClick={removeModel}>{t('Remove model')}</Button></>}
      >
        <p className="modal-copy">
          {tj('{model} will be deleted from disk. You can download it again later, but your internet connection and time will be needed.', { model: <strong>{removeTarget?.name}</strong> })}
        </p>
      </Modal>
    </div>
  );
}
