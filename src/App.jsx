import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, FolderOpen, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { api } from './api.js';
import TitleBar from './components/TitleBar.jsx';
import { Rail, default as Sidebar } from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import Inspector from './components/Inspector.jsx';
import SharedView from './components/SharedView.jsx';
import { Spinner } from './components/ui.jsx';
import { t } from './i18n.js';

const ModelsView = lazy(() => import('./components/ModelsView.jsx'));
const CHAT_CACHE_LIMIT = 6;
const SettingsView = lazy(() => import('./components/SettingsView.jsx'));
const BenchmarkView = lazy(() => import('./components/BenchmarkView.jsx'));
const StatusView = lazy(() => import('./components/StatusView.jsx'));

function ViewFallback() {
  return <div className="view-fallback"><Spinner size={18} />{' '}{t('Loading view…')}</div>;
}

function toMeta(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages?.length || 0,
    preview: conversation.preview || '',
  };
}

function mergeConversations(base, incoming) {
  if (!base) return incoming;
  const messages = new Map();
  for (const message of incoming.messages || []) messages.set(message.id, message);
  for (const message of base.messages || []) {
    const other = messages.get(message.id);
    if (!other) {
      messages.set(message.id, message);
      continue;
    }
    const baseBlocks = message.blocks?.length || 0;
    const incomingBlocks = other.blocks?.length || 0;
    if (baseBlocks > incomingBlocks || (message.status && message.status !== 'streaming')) {
      messages.set(message.id, message);
    }
  }
  const ordered = [...messages.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { ...incoming, messages: ordered, title: incoming.title || base.title };
}

function BootSplash({ error, onRetry }) {
  return (
    <div className="boot-screen">
      <h1>{t('Uma LLM')}</h1>
      {error ? (
        <>
          <p className="boot-error"><AlertCircle size={14} /> {error}</p>
          <button type="button" className="boot-retry" onClick={onRetry}><RefreshCw size={14} />{' '}{t('Try again')}</button>
        </>
      ) : (
        <p className="boot-loading"><Spinner size={14} />{' '}{t('Starting Uma…')}</p>
      )}
    </div>
  );
}

export default function App() {
  const [boot, setBoot] = useState(null);
  const [fatal, setFatal] = useState('');
  const [view, setView] = useState('chat');
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 1360);
  const [generatingId, setGeneratingId] = useState(null);
  const [streamSpeed, setStreamSpeed] = useState(null);
  const [modelProgress, setModelProgress] = useState({});
  const [runtimeProgress, setRuntimeProgress] = useState(null);
  const [benchmarkProgress, setBenchmarkProgress] = useState(null);
  const [benchmarks, setBenchmarks] = useState([]);
  const [toast, setToast] = useState(null);
  const activeIdRef = useRef(null);
  const cacheRef = useRef(new Map());
  const toastTimer = useRef(null);
  const workspaceTimer = useRef(null);

  activeIdRef.current = activeId;
  const generatingRef = useRef(null);
  generatingRef.current = generatingId;

  // Chats read before stay in this window for quick switching, but only the most recent few:
  // a long chat with file reads and command output can take many megabytes.
  const trimCache = () => {
    const cache = cacheRef.current;
    for (const id of [...cache.keys()]) {
      if (cache.size <= CHAT_CACHE_LIMIT) break;
      if (id !== activeIdRef.current && id !== generatingRef.current) cache.delete(id);
    }
  };
  const remember = (id, data) => {
    cacheRef.current.delete(id);
    cacheRef.current.set(id, data);
    trimCache();
  };

  // Leaving the Benchmark screen frees what it used: a run is cancelled, and a model it loaded unloads.
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === 'benchmark' && view !== 'benchmark') {
      setBenchmarkProgress(null);
      api.releaseBenchmark?.().catch(() => {});
    }
    previousView.current = view;
  }, [view]);

  const showToast = (message, tone = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  const refreshBoot = async (override) => {
    const next = override && override.settings !== undefined ? override : await api.bootstrap();
    setBoot(next);
    if (next.benchmarks) setBenchmarks(next.benchmarks);
    if (next.benchmark?.progress) setBenchmarkProgress(next.benchmark.progress);
    return next;
  };

  const refreshConversations = async () => {
    const list = await api.listConversations();
    setConversations(list);
    return list;
  };

  const openConversation = async (id) => {
    if (!id) {
      setActiveId(null);
      setConversation(null);
      setView('chat');
      return;
    }
    setActiveId(id);
    setView('chat');
    const cached = cacheRef.current.get(id);
    if (cached) {
      remember(id, cached);
      setConversation(cached);
      return;
    }
    try {
      const data = await api.getConversation(id);
      if (data) {
        remember(id, data);
        setConversation(data);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const newConversation = async () => {
    if (generatingId) {
      showToast(t('Stop the current response before starting a new thread.'), 'error');
      return null;
    }
    try {
      const created = await api.createConversation();
      cacheRef.current.set(created.id, created);
      setConversations((previous) => [toMeta(created), ...previous]);
      setActiveId(created.id);
      setConversation(created);
      setView('chat');
      return created;
    } catch (err) {
      showToast(err.message, 'error');
      return null;
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.bootstrap();
        if (!alive) return;
        setBoot(data);
        setConversations(data.conversations || []);
        setBenchmarks(data.benchmarks || []);
        setBenchmarkProgress(data.benchmark?.progress || null);
        const preferred =
          data.conversations.find((item) => item.id === data.settings.lastConversationId) ||
          data.conversations[0];
        if (preferred) {
          const cached = await api.getConversation(preferred.id);
          if (cached && alive) {
            cacheRef.current.set(cached.id, cached);
            setActiveId(cached.id);
            setConversation(cached);
          }
        }
      } catch (err) {
        if (alive) setFatal(err.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const offChat = api.onChatEvent((event) => {
      const { conversationId } = event;
      let conv = cacheRef.current.get(conversationId);
      if (event.type === 'assistant-start') {
        setStreamSpeed(null);
        if (!conv) {
          conv = {
            id: conversationId,
            title: event.conversationTitle || t('New conversation'),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [event.message],
          };
        } else if (!conv.messages?.some((message) => message.id === event.message.id)) {
          conv = { ...conv, messages: [...(conv.messages || []), event.message] };
        }
        if (event.conversationTitle) conv = { ...conv, title: event.conversationTitle };
        setGeneratingId(conversationId);
        setConversations((previous) =>
          previous.map((item) =>
            item.id === conversationId
              ? { ...item, title: conv.title, messageCount: conv.messages.length }
              : item,
          ),
        );
      } else if (conv) {
        if (event.type === 'block-add') {
          conv = {
            ...conv,
            messages: conv.messages.map((message) => {
              if (message.id !== event.messageId) return message;
              const blocks = [...(message.blocks || [])];
              blocks[event.index] = event.block;
              return { ...message, blocks };
            }),
          };
        } else if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
          conv = {
            ...conv,
            messages: conv.messages.map((message) => {
              if (message.id !== event.messageId) return message;
              const blocks = [...(message.blocks || [])];
              const block = blocks[event.index] || { type: 'text', text: '' };
              blocks[event.index] = { ...block, text: `${block.text || ''}${event.delta}` };
              return { ...message, blocks };
            }),
          };
        } else if (event.type === 'tool-update') {
          conv = {
            ...conv,
            messages: conv.messages.map((message) => {
              if (message.id !== event.messageId) return message;
              const blocks = [...(message.blocks || [])];
              blocks[event.index] = { ...blocks[event.index], ...event.patch };
              return { ...message, blocks };
            }),
          };
        } else if (event.type === 'stream-speed') {
          setStreamSpeed(event.tokensPerSecond ?? null);
        } else if (event.type === 'assistant-end') {
          setStreamSpeed(null);
          const exists = conv.messages.some((message) => message.id === event.message.id);
          conv = {
            ...conv,
            title: event.conversationTitle || conv.title,
            updatedAt: new Date().toISOString(),
            messages: exists
              ? conv.messages.map((message) => (message.id === event.message.id ? event.message : message))
              : [...conv.messages, event.message],
          };
          setGeneratingId((previous) => (previous === conversationId ? null : previous));
          refreshConversations().catch(() => {});
          setTimeout(trimCache, 0);
        } else if (event.type === 'conversation-meta') {
          conv = { ...conv, title: event.title, updatedAt: event.updatedAt, ...(event.folder !== undefined ? { folder: event.folder } : {}) };
        }
        cacheRef.current.set(conversationId, conv);
      }

      if (conv) {
        cacheRef.current.set(conversationId, conv);
        if (activeIdRef.current === conversationId) setConversation(conv);
      }
    });

    const offModels = api.onModelsProgress((state) => {
      setModelProgress((previous) => ({ ...previous, [state.id]: state }));
      if (state.status === 'done') {
        showToast(t('{0} is ready', [state.model?.name || t('Model')]), 'success');
        refreshBoot().catch(() => {});
      }
      if (state.status === 'error') showToast(state.error || t('Model download failed'), 'error');
    });

    const offModelsChanged = api.onModelsChanged(() => {
      refreshBoot().catch(() => {});
    });
    // A setting changed outside the Settings screen ("Don't ask again" in a command dialog).
    const offSettingsChanged = api.onSettingsChanged?.(() => {
      refreshBoot().catch(() => {});
    });

    const offRuntime = api.onRuntimeProgress((state) => {
      setRuntimeProgress(state);
      if (state.phase === 'done') {
        showToast(t('Inference engine installed'), 'success');
        refreshBoot().catch(() => {});
        setTimeout(() => setRuntimeProgress(null), 1200);
      }
      if (state.phase === 'error') showToast(state.message, 'error');
    });

    const offServer = api.onServerStatus((status) => {
      setBoot((previous) => (previous ? { ...previous, server: status } : previous));
    });
    // The low-disk warning about chat memory can open its settings.
    const offOpenSettings = api.onOpenSettings?.(({ section } = {}) => {
      setView('settings');
      if (section) setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    });
    // A newer Uma was found by the daily look: say so once, the rest is in Settings → Updates.
    const offUpdateFound = api.onUpdateFound?.((state) => {
      showToast(t('Uma {0} is available. See Settings → Updates.', [state.version]), 'success');
    });
    const offNetwork = api.onNetworkStatus?.((status) => {
      setBoot((previous) => (previous ? { ...previous, network: status } : previous));
    });

    const offBenchmark = api.onBenchmarkProgress((progress) => {
      setBenchmarkProgress(progress);
      if (progress?.result) {
        setBenchmarks((previous) => {
          const exists = previous.some((run) => run.id === progress.result.id);
          if (exists) return previous.map((run) => (run.id === progress.result.id ? progress.result : run));
          return [progress.result, ...previous].slice(0, 12);
        });
      }
      if (progress?.history) setBenchmarks(progress.history);
    });
    const offBenchmarkHistory = api.onBenchmarkHistory((history) => setBenchmarks(history || []));

    const offWorkspace = api.onWorkspaceChanged(() => {
      clearTimeout(workspaceTimer.current);
      workspaceTimer.current = setTimeout(async () => {
        try {
          const info = await api.getWorkspaceInfo();
          if (info) setBoot((previous) => (previous ? { ...previous, workspace: info } : previous));
        } catch {}
      }, 400);
    });

    return () => {
      offChat();
      offModels();
      offModelsChanged();
      offSettingsChanged?.();
      offRuntime();
      offServer();
      offNetwork?.();
      offOpenSettings?.();
      offUpdateFound?.();
      offWorkspace();
      offBenchmark();
      offBenchmarkHistory();
      clearTimeout(workspaceTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      clearTimeout(toastTimer.current);
    },
    [],
  );

  const send = async (text, attached = []) => {
    if (!text?.trim() && !attached.length) return false;
    if (generatingId) {
      showToast(t('Uma is still working on the current response.'), 'error');
      throw new Error(t('Uma is still working.'));
    }
    let target = activeId;
    if (!target) {
      const created = await newConversation();
      if (!created) throw new Error(t('Could not create a conversation.'));
      target = created.id;
      activeIdRef.current = target;
    }
    try {
      const result = await api.sendMessage(target, text, attached);
      const merged = mergeConversations(cacheRef.current.get(target), result.conversation);
      cacheRef.current.set(target, merged);
      if (activeIdRef.current === target) setConversation(merged);
      setConversations((previous) => {
        const meta = toMeta(merged);
        const exists = previous.some((item) => item.id === target);
        return exists ? previous.map((item) => (item.id === target ? meta : item)) : [meta, ...previous];
      });
      setGeneratingId(target);
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      throw err;
    }
  };

  const stop = async () => {
    if (!generatingId) return;
    try {
      await api.stopChat(generatingId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const selectModel = async (id) => {
    try {
      const next = await api.setActiveModel(id);
      setBoot(next);
      showToast(t('{0} selected', [next.activeModel?.name || t('Model')]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const runBenchmark = async (options) => {
    setView('benchmark');
    try {
      const status = await api.runBenchmark(options?.optimize ? { optimize: true } : undefined);
      setBenchmarkProgress(status.progress);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const cancelBenchmark = async () => {
    try {
      await api.cancelBenchmark();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const clearBenchmarks = async () => {
    try {
      await api.clearBenchmarks();
      setBenchmarks([]);
      setBenchmarkProgress(null);
      showToast(t('Benchmark history cleared'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // The folder one chat works in (null and no picker: back to the workspace).
  const setChatFolder = async (folder, choose) => {
    if (!conversation?.id) return;
    try {
      const result = await api.setChatFolder(conversation.id, folder, choose);
      const current = cacheRef.current.get(conversation.id) || conversation;
      if ((current.folder || null) === result.folder) return;
      const next = { ...current, folder: result.folder };
      cacheRef.current.set(next.id, next);
      setConversation(next);
      showToast(result.folder ? t('This chat now works in {0}', [result.folder]) : t('This chat works in the workspace again'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // The whole chat as Markdown on the clipboard, with the steps Uma took in each reply.
  const copyChat = async () => {
    if (!conversation?.messages?.length) return;
    const parts = [`# ${conversation.title || t('New conversation')}`];
    for (const message of conversation.messages) {
      if (message.role === 'user') {
        parts.push(`**${t('You')}**\n\n${message.content || ''}${message.attachments?.length ? `\n\n(${message.attachments.map((item) => item.name).join(', ')})` : ''}`);
      } else if (message.role === 'assistant') {
        const lines = [];
        for (const block of message.blocks || []) {
          if (block.type === 'tool') lines.push(`> ${block.title || block.name}${block.summary ? ` — ${block.summary}` : ''}`);
          else if (block.type === 'text' && block.text?.trim() && !block.unchecked) lines.push(block.text.trim());
        }
        if (!lines.length && message.content) lines.push(message.content);
        parts.push(`**Uma** · ${message.modelName || ''}\n\n${lines.join('\n\n')}`);
      }
    }
    try {
      await api.copyText(parts.join('\n\n---\n\n'));
      showToast(t('Chat copied'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const chooseFolder = async () => {
    if (generatingId) {
      showToast(t('Stop the current response before changing folders.'), 'error');
      return;
    }
    try {
      const info = await api.chooseWorkspace();
      if (!info) return;
      await refreshBoot();
      setView('chat');
      showToast(t('Workspace changed to {0}', [info.name]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const setFullPc = async (enabled) => {
    try {
      await api.updateSettings({ allowSystemAccess: enabled });
      await refreshBoot();
      showToast(enabled ? t('Full PC access enabled') : t('Workspace boundary restored'), enabled ? 'error' : 'success');
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    }
  };

  const setInternet = async (enabled) => {
    try {
      await api.updateSettings({ allowInternet: enabled });
      await refreshBoot();
      showToast(enabled ? t('Internet access enabled') : t('Internet access disabled'), enabled ? 'error' : 'success');
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    }
  };

  const handleDeleteConversation = async (id) => {
    const remaining = conversations.filter((item) => item.id !== id);
    setConversations(remaining);
    cacheRef.current.delete(id);
    if (activeId === id) {
      if (remaining[0]) await openConversation(remaining[0].id);
      else {
        setActiveId(null);
        setConversation(null);
      }
    }
  };

  const handleRenameConversation = async () => {
    await refreshConversations();
    if (activeId) {
      const data = await api.getConversation(activeId);
      if (data) {
        cacheRef.current.set(activeId, data);
        setConversation(data);
      }
    }
  };

  if (!boot) {
    return (
      <div className="app">
        <BootSplash
          error={fatal}
          onRetry={() => {
            setFatal('');
            window.location.reload();
          }}
        />
        {toast && <div className={`toast toast-${toast.tone}`}><Check size={14} />{toast.message}</div>}
      </div>
    );
  }

  // While this PC is shared as a helper, the chat and benchmark are paused and the Shared screen shows instead.
  const shared = ['on', 'starting'].includes(boot.network?.sharing?.state);

  return (
    <div className="app">
      <TitleBar workspace={boot.workspace} onboarded server={boot.server} model={boot.activeModel} settings={boot.settings} />
      <div className="shell">
        <Rail view={view} setView={setView} />
        <Sidebar
          view={view}
          setView={setView}
          conversations={conversations}
          activeConversationId={activeId}
          generatingId={generatingId}
          onSelectConversation={openConversation}
          onNewConversation={newConversation}
          onDeleteConversation={handleDeleteConversation}
          onRenameConversation={handleRenameConversation}
          workspace={boot.workspace}
          boot={boot}
          benchmarks={benchmarks}
        />
        <main className={`main-panel ${view === 'chat' && !shared ? 'chat-panel' : ''}`}>
          <Suspense fallback={<ViewFallback />}>
          {shared && (view === 'chat' || view === 'benchmark') && (
            <SharedView sharing={boot.network.sharing} onOpenSettings={() => setView('settings')} showToast={showToast} />
          )}
          {view === 'chat' && !shared && (
            <ChatView
              conversation={conversation}
              generating={Boolean(generatingId) && generatingId === activeId}
              busyOther={Boolean(generatingId) && generatingId !== activeId}
              streamSpeed={streamSpeed}
              models={boot.models}
              activeModel={boot.activeModel}
              server={boot.server}
              runtime={boot.runtime}
              workspace={boot.workspace}
              settings={boot.settings}
              inspectorOpen={inspectorOpen}
              onToggleInspector={() => setInspectorOpen((value) => !value)}
              onSend={send}
              onStop={stop}
              onModelChange={selectModel}
              onOpenSettings={() => setView('settings')}
              onOpenModels={() => setView('models')}
              onOpenFiles={() => api.revealPath('.')}
              onChooseFolder={chooseFolder}
              onChatFolder={setChatFolder}
              onCopyChat={copyChat}
              onSetFullPc={setFullPc}
              onSetInternet={setInternet}
            />
          )}
          {view === 'models' && (
            <ModelsView
              boot={boot}
              modelProgress={modelProgress}
              runtimeProgress={runtimeProgress}
              onRefreshBoot={refreshBoot}
              showToast={showToast}
            />
          )}
          {view === 'benchmark' && !shared && (
            <BenchmarkView
              boot={boot}
              progress={benchmarkProgress}
              history={benchmarks}
              onRun={() => runBenchmark()}
              onOptimize={() => runBenchmark({ optimize: true })}
              onCancel={cancelBenchmark}
              onClear={clearBenchmarks}
              onOpenModels={() => setView('models')}
              onOpenSettings={() => setView('settings')}
            />
          )}
          {view === 'status' && (
            <StatusView
              boot={boot}
              generating={Boolean(generatingId)}
              onOpenSettings={() => {
                setView('settings');
                setTimeout(() => document.getElementById('settings-network')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
              }}
              onOpenModels={() => setView('models')}
              showToast={showToast}
            />
          )}
          {view === 'settings' && (
            <SettingsView boot={boot} onRefreshBoot={refreshBoot} showToast={showToast} />
          )}
          </Suspense>
        </main>
        {view === 'chat' && !shared && inspectorOpen && (
          <Inspector
            conversation={conversation}
            workspace={boot.workspace}
            server={boot.server}
            activeModel={boot.activeModel}
            runtime={boot.runtime}
            settings={boot.settings}
            generating={Boolean(generatingId)}
            showToast={showToast}
            onClose={() => setInspectorOpen(false)}
            onOpenModels={() => setView('models')}
          />
        )}
      </div>
      {toast && (
        <div className={`toast toast-${toast.tone}`}>
          {toast.tone === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}
    </div>
  );
}
