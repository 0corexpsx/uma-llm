import React, { useState } from 'react';
import {
  ArrowUpRight, Check, ChevronRight, CircleStop, Cpu, FolderOpen, Gauge, HardDrive, Play,
  Layers, LockKeyhole, Network, Server, ShieldAlert, ShieldCheck, Sparkles, Wrench, X,
} from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, OS, SectionLabel, Spinner, formatBytes } from './ui.jsx';
import { t } from '../i18n.js';
import GpuCards from './GpuCards.jsx';

export default function Inspector({
  conversation,
  workspace,
  server,
  activeModel,
  runtime,
  settings,
  generating = false,
  showToast,
  onClose,
  onOpenModels,
}) {
  const [power, setPower] = useState('');
  const loading = server?.state === 'starting';
  // Load the model now, or stop it so its RAM and VRAM are free for other programs.
  const setLoaded = async (on) => {
    setPower(on ? 'load' : 'stop');
    try {
      if (on) await api.startServer();
      else {
        await api.stopServer();
        showToast?.(t('Model stopped and memory freed'), 'success');
      }
    } catch (err) {
      showToast?.(err.message, 'error');
    } finally {
      setPower('');
    }
  };
  const recentTools = [];
  for (const message of conversation?.messages || []) {
    if (message.role !== 'assistant') continue;
    for (const block of message.blocks || []) {
      if (block.type === 'tool') recentTools.push(block);
    }
  }
  const tools = recentTools.slice(-5).reverse();
  const contextLabel = t('{0}k tokens', [((settings.effectiveContextSize || settings.contextSize || 8192) / 1024).toFixed(0)]);

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <div className="eyebrow">{t('Context')}</div>
          <h3>{t('This room')}</h3>
        </div>
        <IconButton label={t('Close context panel')} icon={X} onClick={onClose} />
      </div>

      <div className="inspector-scroll">
        <section className="inspector-card workspace-inspector">
          <div className="inspector-card-head">
            <span className="inspector-card-icon"><FolderOpen size={17} /></span>
            <div>
              <strong>{workspace?.name}</strong>
              <span>{t('Working folder')}</span>
            </div>
          </div>
          <code className="inspector-path">{workspace?.path}</code>
          <div className="inspector-stats">
            <div><span>{workspace?.stats.files.toLocaleString()}</span><em>{t('files')}</em></div>
            <div><span>{workspace?.stats.folders.toLocaleString()}</span><em>{t('folders')}</em></div>
            <div><span>{workspace?.stats.label}</span><em>{t('size')}</em></div>
          </div>
          <div className="inspector-actions">
            <Button size="sm" variant="secondary" icon={ArrowUpRight} onClick={() => api.revealPath('.')}>{OS.reveal}</Button>
          </div>
        </section>

        <section className="inspector-section">
          <SectionLabel>{t('Activity')}</SectionLabel>
          {tools.length ? (
            <div className="activity-list">
              {tools.map((tool) => (
                <div className="activity-item" key={tool.id}>
                  <span className={`activity-icon ${tool.status}`}>
                    {tool.status === 'running' ? <Spinner size={12} /> : tool.status === 'error' ? <X size={12} /> : <Check size={12} />}
                  </span>
                  <div>
                    <strong>{tool.title}</strong>
                    <span>{tool.summary || (tool.status === 'running' ? t('Working…') : '')}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="activity-empty">
              <Wrench size={16} />
              <span>{t('Tool calls appear here while Uma works.')}</span>
            </div>
          )}
        </section>

        <section className="inspector-card model-inspector">
          <div className="inspector-card-head">
            <span className={`inspector-card-icon ${server?.running ? 'is-live' : ''}`}><Cpu size={17} /></span>
            <div>
              <strong>{activeModel?.name || t('No model')}</strong>
              <span>{server?.running ? t('Awake · 127.0.0.1:{0}', [server.port]) : loading ? t('Loading into memory…') : t('Asleep until you send')}</span>
            </div>
            <span className={`status-dot ${server?.running ? 'is-live' : ''}`} />
          </div>
          <div className="model-inspector-grid">
            <div><span><Gauge size={12} />{' '}{t('Context')}</span><strong>{contextLabel}</strong></div>
            <div><span><Layers size={12} />{' '}{t('Quant')}</span><strong>{activeModel?.quant || '—'}</strong></div>
            <div><span><HardDrive size={12} />{' '}{t('Size')}</span><strong>{activeModel ? formatBytes(activeModel.size) : '—'}</strong></div>
            <div><span><Server size={12} />{' '}{t('Engine')}</span><strong>{runtime?.installed ? runtime.backend : 'missing'}</strong></div>
          </div>
          {activeModel && (
            <div className="model-power">
              {server?.running || loading ? (
                <Button size="sm" variant="secondary" icon={CircleStop} loading={power === 'stop'} disabled={generating} onClick={() => setLoaded(false)} title={generating ? t('Wait for the current response to finish.') : t('Unloads the model, so its RAM and graphics memory are free for other programs. It loads again when you send a message.')}>
                  {t('Stop model and free memory')}
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={Play} loading={power === 'load'} disabled={!runtime?.installed} onClick={() => setLoaded(true)}>
                  {t('Load model')}
                </Button>
              )}
            </div>
          )}
          {server?.running && server.helpers?.servers?.length > 0 && (
            <p className="inspector-helpers">
              <Network size={12} />{' '}{t('Spread over this PC and {0}: {1}', [server.helpers.servers.length === 1 ? t('1 helper PC') : t('{0} helper PCs', [server.helpers.servers.length]), server.helpers.servers.join(', ')])}
            </p>
          )}
          {server?.running && server.placement && (
            <p className="inspector-helpers" title={!server.helpers?.servers?.length
              // No helpers: the plan is for this PC's own graphics cards.
              ? (server.placement.mode === 'balanced'
                ? t('The model fits on this PC’s graphics cards, so it is shared between them in proportion to their free memory.')
                : t('The model is larger than this PC’s graphics cards, so they are filled first and the rest stays in RAM.'))
              : server.placement.mode === 'balanced'
              ? t('The model fits on the GPUs, so it is shared in proportion to their free memory.')
              : server.placement.devices.some((device) => device.kind === 'cpu')
                ? t('The model is larger than the GPUs, so they are filled first, then the helpers’ RAM.')
                : t('The model is larger than the GPUs, so they are filled first. The rest stays in this PC’s RAM, which is faster than a helper’s.')}
            >
              <Layers size={12} />{' '}
              {server.placement.devices.map((device) => t('{0} up to {1}', [
                device.label
                  ? (device.kind === 'cpu' ? t('{0} RAM', [device.label]) : t('{0} GPU', [device.label]))
                  : device.card || t('this PC’s GPU'),
                formatBytes(device.wantMB * 1024 * 1024),
              ])).join(' · ')}
            </p>
          )}
          {server?.running && server.unusedGpus?.length > 0 && (
            <p className="inspector-helpers is-warning" title={t('This PC has these graphics cards, but the installed engine does not list them, so nothing runs on them. Try another engine in Models: a Tesla P40 or a GTX 10 card needs CUDA 12.')}>
              <Layers size={12} />{' '}{t('Not used by this engine: {0}', [server.unusedGpus.join(', ')])}
            </p>
          )}
          {server?.helpers?.skipped?.length > 0 && (
            <p className="inspector-helpers is-warning">
              <Network size={12} />{' '}{t('Loaded without these helpers (not answering or stopped):')}{' '}{server.helpers.skipped.join(', ')}
            </p>
          )}
          {server?.running && server.moeCache && (
            <p className="inspector-helpers">
              <Layers size={12} />{' '}{t('Experts in RAM, {0} GB of them cached on the GPU', [(server.moeCache.mib / 1024).toFixed(1)])}
            </p>
          )}
          {server?.running && server.draft && (
            <p className="inspector-helpers" title={t('A small model guesses the next words and this model checks several at once. The speed line under each reply shows how many guesses were kept.')}>
              <Layers size={12} />{' '}{server.draft.device ? t('Draft model: {0} on {1}', [server.draft.name, server.draft.device]) : t('Draft model: {0}', [server.draft.name])}
            </p>
          )}
          {server?.running && server.cacheFix && (
            <p className="inspector-helpers" title={t('llama.cpp stops on NVIDIA GPUs with an iq4_nl cache when helper PCs take part or the model has a sparse-attention indexer, so q4_0 is used, which takes the same memory.')}>
              <Layers size={12} />{' '}{t('KV cache: {0} instead of {1}, so this model can run', [server.cacheFix.split('>')[1], server.cacheFix.split('>')[0]])}
            </p>
          )}
          {(server?.helpers?.mismatched || []).map((reason) => (
            <p key={reason} className="inspector-helpers is-warning">
              <Network size={12} />{' '}{reason}
            </p>
          ))}
          <button type="button" className="mini-manage" onClick={onOpenModels}>{t('Manage models')}{' '}<ChevronRight size={13} /></button>
        </section>

        <GpuCards />

        <section className={`scope-card ${settings?.allowEdits ? '' : 'is-readonly'}`}>
          <span className="scope-icon">{settings?.allowSystemAccess ? <ShieldAlert size={17} /> : settings?.allowEdits ? <ShieldCheck size={17} /> : <LockKeyhole size={17} />}</span>
          <div>
            <strong>{settings?.allowSystemAccess ? t('Full PC access is on') : settings?.allowEdits ? t('Edits allowed here') : t('Read-only right now')}</strong>
            <p>
              {settings?.allowSystemAccess
                ? t('The agent can use absolute paths and reach outside this folder. You accepted responsibility for this access.')
                : settings?.allowEdits
                  ? t('Uma can change files inside this folder. Deletes go to the {0}.', [OS.trash])
                  : t('Uma can read and explain, but cannot change files until you allow edits.')}
            </p>
          </div>
        </section>
      </div>
    </aside>
  );
}
