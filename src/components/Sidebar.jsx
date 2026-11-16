import React, { memo, useDeferredValue, useMemo, useState } from 'react';
import {
  Boxes, Check, ChevronRight, FilePenLine, FolderOpen, Gauge, HardDrive, Layers,
  MessageSquare, Plus, Search, Settings2, SlidersHorizontal, Sparkles, Trash2, Wrench,
  Zap, LockKeyhole, Cpu, Database, Info, Network, Terminal, RefreshCw, SunMoon, BrainCircuit, BookMarked,
} from 'lucide-react';
import {
  Button, IconButton, Logo, Modal, OS, SectionLabel, Spinner, formatBytes, formatRelative, groupThreads,
} from './ui.jsx';
import { api } from '../api.js';
import carrotImage from '../assets/carrot.png';

// Uma's carrots, drawn by hand, in the empty part of the rail (they hide when the window is short).
const RAIL_CARROTS = [-24, 18, -8, 30, -30];
import { t, tj, tn } from '../i18n.js';
import { ServerStatusIcon } from './StatusView.jsx';

const NAV = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'benchmark', label: 'Benchmark', icon: Gauge },
  { id: 'status', label: 'Status', title: 'Server status', icon: ServerStatusIcon },
];

const SETTINGS_SECTIONS = [
  { id: 'settings-workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'settings-appearance', label: 'Appearance', icon: SunMoon },
  { id: 'settings-agent', label: 'Permissions', icon: LockKeyhole },
  { id: 'settings-model', label: 'Model', icon: SlidersHorizontal },
  { id: 'settings-network', label: 'Network', icon: Network },
  { id: 'settings-user-memory', label: 'Memory', icon: BookMarked },
  { id: 'settings-memory', label: 'Chat memory', icon: BrainCircuit },
  { id: 'settings-storage', label: 'Storage', icon: Database },
  { id: 'settings-about', label: 'About', icon: Info },
];

export const Rail = memo(function Rail({ view, setView }) {
  return (
    <nav className="rail">
      <div className="rail-nav">
        {NAV.map(({ id, label, title, icon: Icon }) => (
          <button
            type="button"
            key={id}
            data-view={id}
            className={`rail-item ${view === id ? 'is-active' : ''}`}
            onClick={() => setView(id)}
            title={t(title || label)}
          >
            <span className="rail-icon"><Icon size={19} strokeWidth={1.65} /></span>
            <span className="rail-label">{t(label)}</span>
          </button>
        ))}
      </div>
      <div className="rail-carrots" aria-hidden="true">
        {RAIL_CARROTS.map((angle, index) => (
          <img key={index} src={carrotImage} alt="" draggable={false} style={{ transform: `rotate(${angle}deg)` }} />
        ))}
      </div>
      <div className="rail-bottom">
        <button
          type="button"
          className={`rail-item ${view === 'settings' ? 'is-active' : ''}`}
          onClick={() => setView('settings')}
          title={t('Settings')}
        >
          <span className="rail-icon"><Settings2 size={19} strokeWidth={1.65} /></span>
          <span className="rail-label">{t('Settings')}</span>
        </button>
        <div className="rail-local" title={t('No cloud connection')}>
          <LockKeyhole size={12} />
          <span>{t('Local')}</span>
        </div>
      </div>
    </nav>
  );
});

function ThreadItem({ thread, active, generating, onSelect, onRename, onDelete }) {
  return (
    <div className={`thread-item ${active ? 'is-active' : ''}`}>
      <button type="button" className="thread-main" onClick={() => onSelect(thread.id)}>
        <span className="thread-icon">{generating ? <Spinner size={13} /> : <MessageSquare size={13} strokeWidth={1.7} />}</span>
        <span className="thread-copy">
          <span className="thread-title">{thread.title}</span>
          <span className="thread-meta">{generating ? t('working…') : thread.messageCount ? tn(thread.messageCount, '{count} message', '{count} messages') : t('empty')}</span>
        </span>
        <span className="thread-time">{formatRelative(thread.updatedAt)}</span>
      </button>
      <div className="thread-actions">
        <button type="button" title={t('Rename')} onClick={() => onRename(thread)}><FilePenLine size={12} /></button>
        <button type="button" title={t('Delete')} onClick={() => onDelete(thread)}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

function Sidebar({
  view,
  setView,
  conversations,
  activeConversationId,
  generatingId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onRenameConversation,
  workspace,
  boot,
  benchmarks = [],
}) {
  const [threadQuery, setThreadQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [error, setError] = useState('');
  const deferredThreadQuery = useDeferredValue(threadQuery);

  const filteredThreads = useMemo(() => {
    const needle = deferredThreadQuery.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((thread) => thread.title.toLowerCase().includes(needle));
  }, [conversations, deferredThreadQuery]);
  const groups = groupThreads(filteredThreads);
  const activeModel = boot.activeModel;
  const installedCount = boot.models.installed.length;
  const benchmarkHistory = benchmarks.length ? benchmarks : (boot.benchmarks || []);
  const latestBenchmark = benchmarkHistory[0];

  const submitRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await api.renameConversation(renameTarget.id, renameValue.trim());
      onRenameConversation?.();
      setRenameTarget(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.removeConversation(deleteTarget.id);
      onDeleteConversation?.(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const scrollToSetting = (id) => {
    if (view !== 'settings') {
      setView('settings');
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <aside className="sidebar">
      {view === 'chat' && (
        <>
          <div className="sidebar-head">
            <div>
              <div className="eyebrow">{t('Conversations')}</div>
              <h3>{t('Threads')}</h3>
            </div>
            <button type="button" className="new-thread-btn" onClick={onNewConversation} title={t('New conversation')}>
              <Plus size={16} />
            </button>
          </div>
          <div className="sidebar-search">
            <Search size={14} />
            <input value={threadQuery} onChange={(event) => setThreadQuery(event.target.value)} placeholder={t('Search threads…')} />
          </div>
          <div className="sidebar-scroll">
            {Object.entries(groups).map(([label, threads]) =>
              threads.length ? (
                <div className="thread-group" key={label}>
                  <SectionLabel>{t(label)}</SectionLabel>
                  {threads.map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      active={thread.id === activeConversationId}
                      generating={thread.id === generatingId}
                      onSelect={onSelectConversation}
                      onRename={(target) => { setRenameTarget(target); setRenameValue(target.title); setError(''); }}
                      onDelete={(target) => { setDeleteTarget(target); setError(''); }}
                    />
                  ))}
                </div>
              ) : null,
            )}
            {!filteredThreads.length && (
              <div className="sidebar-empty">
                <MessageSquare size={18} />
                <span>{conversations.length ? t('No threads match that search.') : t('No threads yet. Ask Uma something.')}</span>
              </div>
            )}
          </div>
          <button type="button" className="sidebar-workspace" onClick={() => api.revealPath('.')} title={t('Open the working folder in {0}', [OS.fileManager])}>
            <span className="sidebar-workspace-icon"><FolderOpen size={16} /></span>
            <span>
              <strong>{workspace?.name}</strong>
              <em>{t('{0} files · {1}', [workspace?.stats.files, workspace?.stats.label])}</em>
            </span>
            <ChevronRight size={14} />
          </button>
        </>
      )}

      {view === 'models' && (
        <>
          <div className="sidebar-head">
            <div>
              <div className="eyebrow">{t('Models')}</div>
              <h3>{t('Library')}</h3>
            </div>
          </div>
          <div className="sidebar-scroll">
            <div className="side-model-card">
              <span className={`side-model-orb ${boot.server.running ? 'is-live' : ''}`}><Boxes size={22} strokeWidth={1.4} /></span>
              <div>
                <span className="eyebrow">{t('Active model')}</span>
                <strong>{activeModel?.name || t('None selected')}</strong>
                <em>{activeModel ? `${activeModel.quant || t('GGUF')} · ${formatBytes(activeModel.size)}` : t('Download one to begin')}</em>
              </div>
            </div>
            <div className="side-stat-grid">
              <div><strong>{installedCount}</strong><span>{t('models')}</span></div>
              <div><strong>{formatBytes(boot.storage.modelBytes)}</strong><span>{t('on disk')}</span></div>
              <div><strong>{boot.runtime.installed ? t('Ready') : t('Missing')}</strong><span>{t('engine')}</span></div>
            </div>
            <div className="side-list">
              <SectionLabel>{t('Quick actions')}</SectionLabel>
              <button type="button" onClick={() => setView('models')}><Layers size={14} />{' '}{t('Browse the library')}{' '}<ChevronRight size={13} /></button>
              <button type="button" onClick={() => api.revealModels()}><FolderOpen size={14} />{' '}{t('Open model folder')}{' '}<ChevronRight size={13} /></button>
              <button type="button" onClick={() => setView('settings')}><Settings2 size={14} />{' '}{t('Model settings')}{' '}<ChevronRight size={13} /></button>
            </div>
            <div className="side-engine-card">
              <span><Zap size={14} />{' '}{t('llama.cpp')}</span>
              <strong>{boot.runtime.installed ? `${boot.runtime.backend} · ${boot.runtime.version}` : t('Not installed')}</strong>
              <em>{boot.server.running ? t('Awake on port {0}', [boot.server.port]) : t('Starts with your first message')}</em>
            </div>
          </div>
          <button type="button" className="sidebar-workspace" onClick={() => api.openData()}>
            <span className="sidebar-workspace-icon"><HardDrive size={16} /></span>
            <span><strong>{t('Uma data')}</strong><em>{boot.storage.userData}</em></span>
            <ChevronRight size={14} />
          </button>
        </>
      )}

      {view === 'benchmark' && (
        <>
          <div className="sidebar-head">
            <div>
              <div className="eyebrow">{t('Benchmark')}</div>
              <h3>{t('Benchmark')}</h3>
            </div>
          </div>
          <div className="sidebar-scroll">
            {latestBenchmark ? (
              <div className="bench-side-latest">
                <span className="bench-side-icon"><Gauge size={21} strokeWidth={1.5} /></span>
                <div>
                  <span className="eyebrow">{t('Last score')}</span>
                  <strong>{latestBenchmark.speed?.tokensPerSecond ?? '—'} <em>{t('tok/s')}</em></strong>
                  <small>{latestBenchmark.device?.mode || t('CPU')} · {latestBenchmark.model?.name}</small>
                </div>
              </div>
            ) : (
              <div className="bench-side-empty">
                <Gauge size={20} />
                <strong>{t('No runs yet')}</strong>
                <span>{t('Measure prompt speed, generation speed, and real hardware usage.')}</span>
              </div>
            )}

            {benchmarkHistory.length > 0 && (
              <div className="side-list bench-history-list">
                <SectionLabel>{t('Recent runs')}</SectionLabel>
                {benchmarkHistory.slice(0, 5).map((run) => (
                  <div className="bench-history-row" key={run.id}>
                    <span>{run.device?.mode || t('CPU')}</span>
                    <strong>{run.speed?.tokensPerSecond ?? '—'}{' '}{t('tok/s')}</strong>
                    <em>{formatRelative(run.createdAt)}</em>
                  </div>
                ))}
              </div>
            )}

            <div className="side-local-card">
              <span className="side-local-icon"><Cpu size={16} /></span>
              <div>
                <strong>{t('Measured locally')}</strong>
                <p>{t('Samples come from the llama-server process, nvidia-smi, and system memory. Nothing is uploaded.')}</p>
              </div>
            </div>
          </div>
          <button type="button" className="sidebar-workspace" onClick={() => setView('benchmark')}>
            <span className="sidebar-workspace-icon"><Gauge size={16} /></span>
            <span><strong>{t('Benchmark lab')}</strong><em>{t('Uses the active model')}</em></span>
            <ChevronRight size={14} />
          </button>
        </>
      )}

      {view === 'status' && (
        <>
          <div className="sidebar-head">
            <div>
              <div className="eyebrow">{t('Network')}</div>
              <h3>{t('Server status')}</h3>
            </div>
          </div>
          <div className="sidebar-scroll">
            <div className="side-list status-legend">
              <SectionLabel>{t('What the lights mean')}</SectionLabel>
              <div><span className="status-light is-ok" /><span>{t('Green: the PC answers and nothing is wrong')}</span></div>
              <div><span className="status-light is-warn" /><span>{t('Amber: it answers, but something needs attention')}</span></div>
              <div><span className="status-light is-bad" /><span>{t('Red: it does not answer, or cannot be used')}</span></div>
              <div><span className="status-light is-off" /><span>{t('Grey: turned off in Settings')}</span></div>
            </div>
            <div className="side-local-card">
              <span className="side-local-icon"><Network size={16} /></span>
              <div>
                <strong>{t('Read every two seconds')}</strong>
                <p>{t('Each helper reports its own CPU, memory, GPU and data. Nothing leaves your network, except a short check that each PC reaches the internet.')}</p>
              </div>
            </div>
          </div>
          <button type="button" className="sidebar-workspace" onClick={() => scrollToSetting('settings-network')}>
            <span className="sidebar-workspace-icon"><Network size={16} /></span>
            <span><strong>{t('Helper PCs')}</strong><em>{t('Add, test, or turn off')}</em></span>
            <ChevronRight size={14} />
          </button>
        </>
      )}

      {view === 'settings' && (
        <>
          <div className="sidebar-head">
            <div>
              <div className="eyebrow">{t('Preferences')}</div>
              <h3>{t('Settings')}</h3>
            </div>
          </div>
          <div className="sidebar-scroll">
            <div className="settings-nav">
              {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
                <button type="button" key={id} onClick={() => scrollToSetting(id)}>
                  <Icon size={15} strokeWidth={1.6} />
                  <span>{t(label)}</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
            <div className="side-local-card">
              <span className="side-local-icon"><LockKeyhole size={16} /></span>
              <div>
                <strong>{t('Nothing leaves this PC')}</strong>
                <p>{t('No telemetry, no account, no cloud sync. Your chats, files and models stay on this PC.')}</p>
              </div>
            </div>
            <div className="side-about">
              <span>{t('Uma LLM')}{' '}{boot.appVersion}</span>
              <span>{boot.platform}</span>
            </div>
          </div>
          <button type="button" className="sidebar-workspace" onClick={() => api.openData()}>
            <span className="sidebar-workspace-icon"><Database size={16} /></span>
            <span><strong>{t('Open data folder')}</strong><em>{t('Settings & conversations')}</em></span>
            <ChevronRight size={14} />
          </button>
        </>
      )}

      <Modal
        open={Boolean(renameTarget)}
        onClose={() => setRenameTarget(null)}
        title={t('Rename thread')}
        eyebrow={t('Conversation')}
        footer={<><Button variant="ghost" onClick={() => setRenameTarget(null)}>{t('Cancel')}</Button><Button variant="primary" onClick={submitRename} disabled={!renameValue.trim()}>{t('Rename')}</Button></>}
      >
        <input className="input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus onKeyDown={(event) => event.key === 'Enter' && submitRename()} />
        {error && <div className="modal-error">{error}</div>}
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={t('Delete this thread?')}
        eyebrow={t('Confirm')}
        footer={<><Button variant="ghost" onClick={() => setDeleteTarget(null)}>{t('Keep it')}</Button><Button variant="danger" icon={Trash2} onClick={confirmDelete}>{t('Delete')}</Button></>}
      >
        <p className="modal-copy">
          {tj('{thread} and its messages will be removed from this computer. This cannot be undone.', { thread: <strong>{deleteTarget?.title}</strong> })}
        </p>
      </Modal>
    </aside>
  );
}

export default memo(Sidebar, (previous, next) => (
  previous.view === next.view
  && previous.activeConversationId === next.activeConversationId
  && previous.generatingId === next.generatingId
  && previous.conversations === next.conversations
  && previous.benchmarks === next.benchmarks
  && previous.workspace?.path === next.workspace?.path
  && previous.workspace?.stats?.files === next.workspace?.stats?.files
  && previous.boot?.activeModel?.id === next.boot?.activeModel?.id
  && previous.boot?.server?.running === next.boot?.server?.running
  && previous.boot?.models?.installed === next.boot?.models?.installed
));

// t('Status') t('Server status')
