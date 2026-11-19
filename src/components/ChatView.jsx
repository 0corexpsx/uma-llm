import React, { useEffect, useRef, useState, memo } from 'react';
import {
  AlertCircle, ArrowUp, Check, ChevronDown, Copy, CornerUpLeft, ExternalLink, ChevronRight, ChevronUp, CircleStop, Cpu, FilePenLine,
  FileSearch, FileText, Files, FolderOpen, FolderSearch, FolderTree, Gauge, Globe, ListTree, LockKeyhole, Paperclip, PanelRight,
  PencilLine, Search, Settings2, ShieldAlert, Sparkles, SquareTerminal, Trash2, Undo2, Wrench, X, Zap,
} from 'lucide-react';
import api from '../api.js';
import PcAccessWarning from './PcAccessWarning.jsx';
import InternetWarning from './InternetWarning.jsx';
import Markdown from './Markdown.jsx';
import { Logo, umaLogo, Button, IconButton, Spinner, formatAgo, formatBytes, formatDateTime, formatTime } from './ui.jsx';
import { t, tj, tn } from '../i18n.js';

const SUGGESTIONS = [
  {
    icon: ListTree,
    title: 'Map this workspace',
    text: 'Give me a map of this workspace. List the important files, explain what this project appears to be, and suggest three useful next steps.',
  },
  {
    icon: FilePenLine,
    title: 'Write a README',
    text: 'Look through this workspace and write a clear README.md that explains what it is, how it is organized, and how to use it. Then tell me what you changed.',
  },
  {
    icon: Search,
    title: 'Find loose ends',
    text: 'Search this workspace for TODO, FIXME, HACK, and unfinished notes. Summarize what you find and offer to fix the most important items.',
  },
  {
    icon: FolderTree,
    title: 'Tidy a folder',
    text: 'Inspect the top-level structure of this workspace and propose a tidier organization. Do not move anything yet — show me the plan first.',
  },
];

function iconForTool(name) {
  if (name === 'read_file') return FileSearch;
  if (name === 'write_file' || name === 'append_file' || name === 'replace_in_file' || name === 'save_document') return PencilLine;
  if (name === 'list_files') return ListTree;
  if (name === 'search_files') return Search;
  if (name === 'delete_file') return Trash2;
  if (name === 'run_command') return SquareTerminal;
  if (name === 'load_skill') return Sparkles;
  if (name === 'move_file' || name === 'create_folder') return FolderTree;
  return Wrench;
}

function ToolCard({ block, conversationId, messageId }) {
  const [open, setOpen] = useState(false);
  const [undoError, setUndoError] = useState('');
  const Icon = iconForTool(block.name);
  const running = block.status === 'running';
  const undo = async () => {
    setUndoError('');
    try {
      await api.undoToolChange(conversationId, messageId, block.id);
    } catch (err) {
      setUndoError(err.message);
    }
  };
  return (
    <div className={`tool-card ${block.status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon"><Icon size={14} strokeWidth={1.7} /></span>
        <span className="tool-title">{block.title || block.name}</span>
        {block.summary && <span className="tool-summary">{block.summary}</span>}
        <span className="tool-state">
          {running ? <Spinner size={13} /> : block.status === 'error' ? <AlertCircle size={13} /> : <Check size={13} />}
        </span>
        <ChevronRight size={13} className={`tool-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {(block.undoId || block.undone) && (
        <div className="tool-undo">
          {block.undone ? <span>{t('Change undone')}</span> : (
            <button type="button" onClick={undo} title={t('Put the file back as it was before this change')}><Undo2 size={12} />{' '}{t('Undo this change')}</button>
          )}
          {undoError && <span className="is-error">{undoError}</span>}
        </div>
      )}
      {block.image && <img className="tool-shot" src={block.image} alt={block.title || ''} title={t('What the model was shown')} />}
      {open && (
        <div className="tool-details">
          <div className="tool-detail-label">{t('Input')}</div>
          <pre>{JSON.stringify(block.args || {}, null, 2)}</pre>
          {(block.output || block.error) && (
            <>
              <div className="tool-detail-label">{block.status === 'error' ? t('Error') : t('Result')}</div>
              <pre className={block.status === 'error' ? 'is-error' : ''}>{block.output || block.error}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const MemoToolCard = memo(ToolCard);

function shortDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return t('under 1 s');
  if (seconds < 60) return t('{0} s', [seconds]);
  return t('{0} min {1} s', [Math.floor(seconds / 60), seconds % 60]);
}

/**
 * How fast the model worked on a reply, from the engine's own measurements: the tokens it had to
 * read (tools, history, the message), the tokens it wrote, and the wait before the first word.
 * These are the numbers to compare after changing a setting or how helper PCs are used.
 */
/** Under a message: a button that copies it, and when it was written (date, time, and how long ago). */
function MessageFooter({ text, at }) {
  const [copied, setCopied] = useState(false);
  // "5 minutes ago" keeps counting while the chat stays open.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 60000);
    return () => clearInterval(timer);
  }, []);
  const copy = async () => {
    await api.copyText(text || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="message-footer">
      <button type="button" className="message-copy" onClick={copy} title={t('Copy this message')} aria-label={t('Copy this message')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t('Copied') : t('Copy')}</span>
      </button>
      {at && <span className="message-when" title={formatDateTime(at)}>{formatDateTime(at)} · {formatAgo(at)}</span>}
    </div>
  );
}

/** What a reply says, without the answers that were set aside. */
function replyText(message) {
  const parts = (message.blocks || []).filter((block) => block.type === 'text' && block.text?.trim() && !block.unchecked && !block.superseded).map((block) => block.text.trim());
  return parts.length ? parts.join('\n\n') : message.content || '';
}

function ReplySpeed({ stats }) {
  if (!stats || (!stats.promptTokens && !stats.outputTokens)) return null;
  const rate = (tokens, ms) => (ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : 0);
  const parts = [];
  if (stats.promptTokens > 0) parts.push(t('read {0} tokens at {1} tok/s', [stats.promptTokens.toLocaleString(), rate(stats.promptTokens, stats.promptMs)]));
  if (stats.outputTokens > 0) parts.push(t('wrote {0} tokens at {1} tok/s', [stats.outputTokens.toLocaleString(), rate(stats.outputTokens, stats.outputMs)]));
  if (stats.draftTokens > 0) parts.push(t('draft guesses kept {0}%', [Math.round((stats.draftAccepted / stats.draftTokens) * 100)]));
  if (stats.firstTokenMs != null) parts.push(t('first word after {0}', [shortDuration(stats.firstTokenMs)]));
  if (stats.totalMs) parts.push(t('{0} in total', [shortDuration(stats.totalMs)]));
  return (
    <div
      className="message-speed"
      title={t('How fast the model worked on this reply. “Read” is everything it had to process first: the tool list, the conversation, and your message. “Wrote” is the answer. Compare these numbers after changing a setting to see whether it helped.')}
    >
      <Gauge size={12} />{' '}{parts.join(' · ')}
    </div>
  );
}

function AssistantMessage({ message, conversationId, generating, streamSpeed, activeModel, onOpenSettings, onOpenModels }) {
  const isStreaming = message.status === 'streaming';
  return (
    <article className="message assistant">
      <div className="assistant-avatar">
        <Logo size={19} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{t('Uma')}</span>
          <span className="message-dot">·</span>
          <span>{message.modelName || activeModel?.name || t('local model')}</span>
          <span className="message-dot">·</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>

        {message.blocks?.map((block, index) => {
          if (block.type === 'text') {
            if (!block.text) return null;
            if (block.superseded && !isStreaming) {
              return (
                <details className="superseded-block" key={`text-${index}`}>
                  <summary>{t('Earlier draft of the answer, said again below')}</summary>
                  <Markdown>{block.text}</Markdown>
                </details>
              );
            }
            return (
              <div className={`message-text ${block.unchecked ? 'is-unchecked' : ''}`} key={`text-${index}`}>
                {block.unchecked && (
                  <div className="unchecked-label">
                    {block.unchecked === 'claimed'
                      ? t('The model said it made these changes, but no tool ran, so nothing was changed. Set aside; Uma asked it to really do them')
                      : block.unchecked === 'unseen'
                        ? t('The model described a screen or page it had not looked at, so this was set aside and not used')
                        : block.unchecked === 'repeat'
                          ? t('The model repeated an earlier answer in place of answering, so this was set aside and not used')
                          : t('Written before Uma looked at the files, so it was set aside and not used')}
                  </div>
                )}
                {isStreaming ? (
                  <div className="streaming-plain">{block.text}</div>
                ) : (
                  <Markdown>{block.text}</Markdown>
                )}
              </div>
            );
          }
          if (block.type === 'reasoning') {
            return (
              <details className="reasoning-block" key={`reason-${index}`}>
                <summary><Sparkles size={13} />{' '}{t('Reasoning')}</summary>
                <div className="reasoning-text">{block.text}</div>
              </details>
            );
          }
          if (block.type === 'tool') {
            return <MemoToolCard block={block} conversationId={conversationId} messageId={message.id} key={block.id || `tool-${index}`} />;
          }
          return null;
        })}

        {isStreaming && !message.blocks?.length && (
          <div className="thinking-dots"><span /><span /><span /></div>
        )}

        {isStreaming && message.blocks?.length > 0 && (
          <div className="streaming-line">
            <span className="stream-caret" />{' '}{t('working locally')}
            {streamSpeed != null && <span className="stream-speed"> · {streamSpeed}{' '}{t('tok/s')}</span>}
          </div>
        )}

        {!isStreaming && <ReplySpeed stats={message.stats} />}
        {!isStreaming && <MessageFooter text={replyText(message)} at={message.finishedAt || message.createdAt} />}

        {message.status === 'stopped' && <div className="message-note">{t('Stopped.')}</div>}

        {message.status === 'error' && (
          <div className="message-error">
            <AlertCircle size={16} />
            <div>
              <strong>{t('That run hit a snag.')}</strong>
              <p>{message.error || t('The local model did not finish this response.')}</p>
              <div className="message-error-actions">
                {message.errorCode === 'MODEL_MISSING' && (
                  <Button size="sm" variant="secondary" onClick={onOpenModels}>{t('Open Models')}</Button>
                )}
                {message.errorCode === 'RUNTIME_MISSING' && (
                  <Button size="sm" variant="secondary" onClick={onOpenModels}>{t('Install the engine')}</Button>
                )}
                <Button size="sm" variant="ghost" onClick={onOpenSettings}>{t('Settings')}</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

const MemoAssistantMessage = memo(
  AssistantMessage,
  (previous, next) => previous.message === next.message
    && previous.activeModel?.id === next.activeModel?.id
    && previous.streamSpeed === next.streamSpeed,
);

/** Turns any image the browser can decode into a PNG, scaled to what vision models actually use. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const draw = (maxSide, type, quality) => {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  };
  const png = draw(1568, 'image/png');
  const thumbnail = draw(320, 'image/jpeg', 0.7);
  bitmap.close();
  const binary = atob(png.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes, thumbnail };
}

function AttachmentChip({ item, onRemove }) {
  return (
    <span className={`attach-chip ${item.warning ? 'is-warning' : ''}`} title={item.name}>
      {item.thumbnail ? <img src={item.thumbnail} alt="" /> : item.uploading ? <Spinner size={13} /> : <FileText size={14} />}
      <span className="attach-chip-name">{item.name}</span>
      {item.size ? <span className="attach-chip-size">{formatBytes(item.size)}</span> : null}
      {onRemove && <button type="button" aria-label={t('Remove {0}', [item.name])} onClick={onRemove}><X size={13} /></button>}
    </span>
  );
}

function UserMessage({ message }) {
  const attached = message.attachments || [];
  return (
    <article className="message user">
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{t('You')}</span>
          <span className="message-dot">·</span>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        {attached.length > 0 && (
          <div className="user-attachments">
            {attached.map((item) => (item.thumbnail
              ? <img className="attach-photo" src={item.thumbnail} alt={item.name} title={item.name} key={item.id} />
              : <AttachmentChip item={item} key={item.id} />))}
          </div>
        )}
        <div className="user-text">{message.content}</div>
        <MessageFooter text={message.content} at={message.createdAt} />
      </div>
    </article>
  );
}

const MemoUserMessage = memo(UserMessage);

function ModelPicker({ models, activeModel, server, onModelChange, onOpenModels }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handle = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  return (
    <div className="model-picker-wrap" ref={ref}>
      <button type="button" className={`model-pill ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)}>
        <span className={`model-dot ${server?.running ? 'is-live' : ''}`} />
        <span>{activeModel?.name || t('Choose a model')}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="dropdown model-dropdown">
          <div className="dropdown-label">{t('Local models')}</div>
          {models.installed.length === 0 && <div className="dropdown-empty">{t('No models installed yet.')}</div>}
          {models.installed.map((model) => (
            <button
              type="button"
              key={model.id}
              className={`dropdown-item ${model.id === activeModel?.id ? 'is-active' : ''}`}
              onClick={() => {
                setOpen(false);
                onModelChange(model.id);
              }}
            >
              <span className="dropdown-item-main">
                <span>{model.name}</span>
                <span className="dropdown-sub">{formatBytes(model.size)} · {model.quant || t('GGUF')}</span>
              </span>
              {model.id === activeModel?.id && <Check size={14} />}
            </button>
          ))}
          <div className="dropdown-rule" />
          <button type="button" className="dropdown-item" onClick={() => { setOpen(false); onOpenModels(); }}>
            <span className="dropdown-item-main"><span>{t('Manage models')}</span><span className="dropdown-sub">{t('Download, import, remove')}</span></span>
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

const MemoModelPicker = memo(
  ModelPicker,
  (previous, next) => previous.models === next.models
    && previous.activeModel?.id === next.activeModel?.id
    && previous.server?.running === next.server?.running
    && previous.server?.port === next.server?.port,
);

export default function ChatView({
  conversation,
  generating,
  busyOther = false,
  streamSpeed = null,
  models,
  activeModel,
  server,
  runtime,
  workspace,
  settings,
  inspectorOpen,
  onToggleInspector,
  onSend,
  onStop,
  onModelChange,
  onOpenSettings,
  onOpenModels,
  onOpenFiles,
  onChooseFolder,
  onChatFolder,
  onCopyChat,
  onSetFullPc,
  onSetInternet,
}) {
  const [folderOpen, setFolderOpen] = useState(false);
  const folderRef = useRef(null);
  // The folder this chat works in: its own (named in a message or chosen here), or the workspace.
  const chatFolder = conversation?.folder || '';
  const folderName = chatFolder ? chatFolder.split(/[\\/]/).filter(Boolean).pop() : workspace?.name;
  useEffect(() => {
    const handler = (event) => {
      if (folderRef.current && !folderRef.current.contains(event.target)) setFolderOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pcWarning, setPcWarning] = useState(false);
  const [internetWarning, setInternetWarning] = useState(false);
  const [attached, setAttached] = useState([]);
  const [attachError, setAttachError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const scopeRef = useRef(null);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const stickRef = useRef(true);
  const scrollFrame = useRef(null);
  const missingModel = !activeModel;  const missingRuntime = !runtime?.installed;
  const messages = conversation?.messages || [];
  const [visibleCount, setVisibleCount] = useState(80);
  const visibleMessages = messages.length > visibleCount ? messages.slice(-visibleCount) : messages;
  const hiddenMessages = Math.max(0, messages.length - visibleMessages.length);
  const canChat = !missingModel && !missingRuntime && !busyOther;

  const scrollToBottom = (smooth = false) => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  useEffect(() => {
    stickRef.current = true;
    setVisibleCount(80);
    const timer = setTimeout(() => scrollToBottom(false), 30);
    return () => clearTimeout(timer);
  }, [conversation?.id]);

  useEffect(() => {
    if (!stickRef.current) return undefined;
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => scrollToBottom(false));
    return () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    };
  }, [conversation, generating]);

  useEffect(() => {
    const handler = (event) => {
      if (scopeRef.current && !scopeRef.current.contains(event.target)) setScopeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 190)}px`;
  }, [value]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  };

  const addFiles = async (fileList) => {
    const files = [...fileList];
    if (!files.length) return;
    setAttachError('');
    await Promise.all(files.map(async (file, index) => {
      const key = `up-${Date.now()}-${index}`;
      const name = file.name || `pasted-image-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      setAttached((current) => [...current, { key, name, uploading: true, kind: file.type.startsWith('image/') ? 'image' : 'document' }]);
      try {
        let stored;
        if (file.type.startsWith('image/')) {
          const { bytes, thumbnail } = await prepareImage(file);
          stored = await api.addAttachment({ name, kind: 'image', bytes, thumbnail });
        } else {
          stored = await api.addAttachment({ name, kind: 'document', bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        setAttached((current) => current.map((item) => (item.key === key ? { ...stored, key } : item)));
      } catch (err) {
        setAttached((current) => current.filter((item) => item.key !== key));
        setAttachError(`${name}: ${err.message}`);
      }
    }));
    setTimeout(() => composerRef.current?.focus(), 20);
  };

  const removeAttachment = (item) => {
    setAttached((current) => current.filter((entry) => entry.key !== item.key));
    if (item.id) api.removeAttachment(item.id).catch(() => {});
  };

  const uploading = attached.some((item) => item.uploading);
  const blockedImage = attached.some((item) => item.kind === 'image') && !activeModel?.mmproj;

  const submit = async (text = value) => {
    const clean = text.trim();
    if ((!clean && !attached.length) || generating || sending || uploading || blockedImage) return;
    const sentAttachments = attached;
    setValue('');
    setAttached([]);
    setAttachError('');
    setSending(true);
    try {
      await onSend(clean, sentAttachments.map(({ key, uploading: _uploading, ...item }) => item));
    } catch (err) {
      setValue(clean);
      setAttached(sentAttachments);
    } finally {
      setSending(false);
      setTimeout(() => composerRef.current?.focus(), 20);
    }
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  const title = conversation?.title || t('New conversation');

  return (
    <div className="chat-view">
      <header className="view-header chat-header">
        <div className="chat-title-block">
          <div className="eyebrow">{t('{0} · local thread', [folderName || t('Workspace')])}</div>
          <h2>{title}</h2>
        </div>
        <div className="chat-header-actions">
          {conversation?.messages?.length > 0 && (
            <IconButton label={t('Copy the whole chat')} icon={Copy} onClick={onCopyChat} />
          )}
          <div className="scope-picker-wrap" ref={scopeRef}>
            <button
              type="button"
              className={`scope-pill ${settings?.allowSystemAccess ? 'is-full-pc' : ''}`}
              onClick={() => setScopeOpen((open) => !open)}
              title={t('Change what this AI can access')}
            >
              {settings?.allowSystemAccess ? <ShieldAlert size={13} /> : <FolderTree size={13} />}
              <span>{settings?.allowSystemAccess ? t('Full PC') : workspace?.name || t('Workspace')}</span>
              <ChevronDown size={12} />
            </button>
            {scopeOpen && (
              <div className="dropdown scope-dropdown">
                <div className="dropdown-label">{t('AI access scope')}</div>
                <div className="scope-current">
                  <span>{settings?.allowSystemAccess ? <ShieldAlert size={14} /> : <LockKeyhole size={14} />}</span>
                  <div>
                    <strong>{settings?.allowSystemAccess ? t('Whole PC') : t('Workspace only')}</strong>
                    <em>{settings?.allowSystemAccess ? t('Absolute paths are allowed') : workspace?.path}</em>
                  </div>
                </div>
                <div className="dropdown-rule" />
                <button type="button" className="scope-option" onClick={async () => {
                  setScopeOpen(false);
                  await onChooseFolder?.();
                }}>
                  <span className="scope-option-icon"><FolderOpen size={15} /></span>
                  <span className="scope-option-copy">
                    <strong>{t('Choose a folder…')}</strong>
                    <em>{t('Switch the workspace at any time')}</em>
                  </span>
                </button>
                {settings?.allowSystemAccess ? (
                  <button type="button" className="scope-option" onClick={async () => {
                    setScopeOpen(false);
                    await onSetFullPc?.(false);
                  }}>
                    <span className="scope-option-icon"><LockKeyhole size={15} /></span>
                    <span className="scope-option-copy">
                      <strong>{t('Return to workspace only')}</strong>
                      <em>{t('Restore the folder boundary')}</em>
                    </span>
                  </button>
                ) : (
                  <button type="button" className="scope-option is-danger" onClick={() => {
                    setScopeOpen(false);
                    setPcWarning(true);
                  }}>
                    <span className="scope-option-icon"><ShieldAlert size={15} /></span>
                    <span className="scope-option-copy">
                      <strong>{t('Use the whole PC…')}</strong>
                      <em>{t('Requires accepting a warning')}</em>
                    </span>
                  </button>
                )}
                <div className="dropdown-rule" />
                {settings?.allowInternet ? (
                  <button type="button" className="scope-option" onClick={async () => {
                    setScopeOpen(false);
                    await onSetInternet?.(false);
                  }}>
                    <span className="scope-option-icon"><Globe size={15} /></span>
                    <span className="scope-option-copy">
                      <strong>{t('Internet access is on')}</strong>
                      <em>{t('Click to disable web search and page reading')}</em>
                    </span>
                  </button>
                ) : (
                  <button type="button" className="scope-option is-danger" onClick={() => {
                    setScopeOpen(false);
                    setInternetWarning(true);
                  }}>
                    <span className="scope-option-icon"><Globe size={15} /></span>
                    <span className="scope-option-copy">
                      <strong>{t('Enable internet access…')}</strong>
                      <em>{t('Web search and public page reading')}</em>
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
          {!settings?.allowEdits && (
            <button type="button" className="readonly-chip" onClick={onOpenSettings}>
              <LockKeyhole size={12} />{' '}{t('Read-only')}
            </button>
          )}
          <MemoModelPicker
            models={models}
            activeModel={activeModel}
            server={server}
            onModelChange={onModelChange}
            onOpenModels={onOpenModels}
          />
          <IconButton
            label={inspectorOpen ? t('Hide context') : t('Show context')}
            icon={PanelRight}
            className={inspectorOpen ? 'is-active' : ''}
            onClick={onToggleInspector}
          />
        </div>
      </header>

      {settings?.allowSystemAccess && (
        <div className="pc-access-banner">
          <ShieldAlert size={16} />
          <div>
            <strong>{t('Full PC access is on')}</strong>
            <span>{t('Uma can read and write outside this folder. You accepted responsibility for this access.')}</span>
          </div>
          <button type="button" onClick={onOpenSettings}>{t('Manage')}</button>
        </div>
      )}

      {busyOther && (
        <div className="setup-banner busy-banner">
          <span className="setup-banner-icon"><Spinner size={17} /></span>
          <div>
            <strong>{t('Uma is working in another thread')}</strong>
            <span>{t('This is a single local model, so it can only answer one conversation at a time.')}</span>
          </div>
          <Button size="sm" variant="secondary" icon={CircleStop} onClick={onStop}>{t('Stop it')}</Button>
        </div>
      )}

      {(!canChat && !busyOther) && (
        <div className="setup-banner">
          <span className="setup-banner-icon">{missingModel ? <Cpu size={18} /> : <Zap size={18} />}</span>
          <div>
            <strong>{missingModel ? t('No local model yet') : t('The inference engine is not ready yet')}</strong>
            <span>
              {missingModel
                ? t('Download a GGUF model to start talking to Uma.')
                : t('Uma downloads it by itself on first launch. Open Models to see its progress, or to retry if it failed.')}
            </span>
          </div>
          <Button size="sm" variant="secondary" onClick={onOpenModels}>
            {missingModel ? t('Choose a model') : t('Open Models')}
          </Button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="uma-stage">
              <div className="uma-band" />
              <img className="uma-portrait" src={umaLogo} width={152} height={152} alt={t('Uma, the horse')} draggable={false} />
            </div>
            <div className="uma-credit">
              {t('Uma by Ocorex')}<i className="collab-x">×</i><span className="gl-emblem" aria-hidden />{t('Genesys Labs')}
            </div>
            <h1>{t('{0}. What are we making?', [greeting])}</h1>
            <p>
              {tj('Uma can see {folder} and work inside it. Ask a question, plan a change, or point it at a mess.', { folder: <strong>{workspace?.name}</strong> })}
            </p>
            <div className="suggestion-grid">
              {SUGGESTIONS.map(({ icon: Icon, title: suggestionTitle, text }) => (
                <button
                  type="button"
                  key={suggestionTitle}
                  className="suggestion-card"
                  disabled={!canChat}
                  onClick={() => { setValue(''); submit(t(text)); }}
                >
                  <span className="suggestion-icon"><Icon size={17} strokeWidth={1.6} /></span>
                  <span className="suggestion-title">{t(suggestionTitle)}</span>
                  <span className="suggestion-arrow">↗</span>
                </button>
              ))}
            </div>

            <div className={`empty-access ${settings?.allowSystemAccess ? 'is-full-pc' : ''}`}>
              <span className="empty-access-label">
                {settings?.allowSystemAccess ? <ShieldAlert size={13} /> : <FolderTree size={13} />}
                {tj('AI access: {scope}', { scope: <strong>{settings?.allowSystemAccess ? t('Whole PC') : workspace?.name}</strong> })}
              </span>
              <button type="button" onClick={onChooseFolder}>{t('Change folder')}</button>
              {!settings?.allowSystemAccess && (
                <button type="button" className="is-danger" onClick={() => setPcWarning(true)}>
                  {t('Use all PC')}
                </button>
              )}
              {!settings?.allowInternet ? (
                <button type="button" onClick={() => setInternetWarning(true)}>{t('Enable internet')}</button>
              ) : (
                <span><Globe size={12} />{' '}{t('Internet on')}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {hiddenMessages > 0 && (
              <button type="button" className="load-earlier" onClick={() => setVisibleCount((count) => count + 80)}>
                <ChevronUp size={13} />{' '}{tn(hiddenMessages, 'Show {count} earlier message', 'Show {count} earlier messages')}
              </button>
            )}
            {visibleMessages.map((message) =>
              message.role === 'user' ? (
                <MemoUserMessage message={message} key={message.id} />
              ) : (
                <MemoAssistantMessage
                  key={message.id}
                  message={message}
                  conversationId={conversation?.id}
                  generating={generating}
                  streamSpeed={streamSpeed}
                  activeModel={activeModel}
                  onOpenSettings={onOpenSettings}
                  onOpenModels={onOpenModels}
                />
              ),
            )}
          </div>
        )}
      </div>

      <div
        className="composer-zone"
        onDragOver={(event) => {
          if (!canChat || generating || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (canChat && !generating) addFiles(event.dataTransfer.files);
        }}
      >
        <div className={`composer ${generating ? 'is-generating' : ''} ${dragging ? 'is-dragging' : ''}`}>
          {attachError && <div className="attach-error"><AlertCircle size={13} /><span>{attachError}</span></div>}
          {blockedImage && (
            <div className="attach-error">
              <AlertCircle size={13} />
              <span>
                {tj('{model} cannot see images. Add a vision file in its settings under {models}, or remove the image.', {
                  model: activeModel?.name || t('This model'),
                  models: <button type="button" onClick={onOpenModels}>{t('Models')}</button>,
                })}
              </span>
            </div>
          )}
          {attached.length > 0 && (
            <div className="attach-list">
              {attached.map((item) => (
                <AttachmentChip
                  key={item.key}
                  item={{ ...item, warning: item.kind === 'image' && !activeModel?.mmproj }}
                  onRemove={item.uploading ? null : () => removeAttachment(item)}
                />
              ))}
            </div>
          )}
          <textarea
            ref={composerRef}
            rows={1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onPaste={(event) => {
              if (event.clipboardData.files.length) {
                event.preventDefault();
                addFiles(event.clipboardData.files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={busyOther ? t('Uma is busy in another thread…') : canChat ? t('Ask Uma to change something…') : t('Set up a model to start…')}
            disabled={generating || busyOther}
          />
          <div className="composer-bar">
            <div className="composer-context">
              <button
                type="button"
                className="attach-button"
                aria-label={t('Attach files')}
                title={t('Attach screenshots or documents. You can also drag them here or paste with {0}.', [api?.platform === 'darwin' ? '⌘V' : 'Ctrl+V'])}
                disabled={generating || busyOther || !canChat}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <div className="folder-menu-wrap" ref={folderRef}>
                <button type="button" className={`context-chip ${chatFolder ? 'is-chat-folder' : ''}`} onClick={() => setFolderOpen((open) => !open)} title={chatFolder || workspace?.path || ''}>
                  <FolderTree size={13} />
                  <span>{folderName || t('Workspace')}</span>
                  <span className={`context-chip-sub ${settings?.allowSystemAccess ? 'is-full-pc' : ''}`}>
                    {chatFolder ? t('this chat') : settings?.allowSystemAccess ? t('full PC access') : t('only this folder')}
                  </span>
                  <ChevronUp size={12} />
                </button>
                {folderOpen && (
                  <div className="dropdown folder-dropdown">
                    <div className="dropdown-label">{t('This chat works in')}</div>
                    <div className="scope-current">
                      <span><FolderTree size={14} /></span>
                      <div>
                        <strong>{folderName || t('Workspace')}</strong>
                        <em>{chatFolder || workspace?.path}</em>
                      </div>
                    </div>
                    <div className="dropdown-rule" />
                    {settings?.allowSystemAccess && conversation?.id && (
                      <button type="button" className="scope-option" onClick={() => { setFolderOpen(false); onChatFolder?.(null, true); }}>
                        <span className="scope-option-icon"><FolderOpen size={15} /></span>
                        <span className="scope-option-copy">
                          <strong>{t('Choose a folder for this chat…')}</strong>
                          <em>{t('Only this chat; other chats keep the workspace')}</em>
                        </span>
                      </button>
                    )}
                    {chatFolder && (
                      <button type="button" className="scope-option" onClick={() => { setFolderOpen(false); onChatFolder?.(null, false); }}>
                        <span className="scope-option-icon"><CornerUpLeft size={15} /></span>
                        <span className="scope-option-copy">
                          <strong>{t('Back to the workspace')}</strong>
                          <em>{workspace?.path}</em>
                        </span>
                      </button>
                    )}
                    <button type="button" className="scope-option" onClick={async () => { setFolderOpen(false); await onChooseFolder?.(); }}>
                      <span className="scope-option-icon"><FolderSearch size={15} /></span>
                      <span className="scope-option-copy">
                        <strong>{t('Change the workspace…')}</strong>
                        <em>{t('The working folder for every chat')}</em>
                      </span>
                    </button>
                    <button type="button" className="scope-option" onClick={() => { setFolderOpen(false); if (chatFolder) api.openChatFolder(conversation.id); else onOpenFiles?.(); }}>
                      <span className="scope-option-icon"><ExternalLink size={15} /></span>
                      <span className="scope-option-copy">
                        <strong>{t('Open the folder')}</strong>
                        <em>{t('In the file manager')}</em>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="composer-actions">
              <span className="composer-hint">{t('Enter to send · Shift+Enter for a new line')}</span>
              {generating ? (
                <Button variant="secondary" icon={CircleStop} onClick={onStop}>{t('Stop')}</Button>
              ) : (
                <button
                  type="button"
                  className="send-btn"
                  disabled={(!value.trim() && !attached.length) || !canChat || sending || uploading || blockedImage}
                  onClick={() => submit()}
                  title={t('Send')}
                >
                  {sending ? <Spinner size={15} /> : <ArrowUp size={17} strokeWidth={2} />}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="composer-foot">
          <span><LockKeyhole size={11} />{' '}{t('Local model')} · {settings?.allowSystemAccess ? t('full PC access is on') : t('files stay inside {0}', [workspace?.name || t('the workspace')])}</span>
          <span>{t('{0}k context', [settings?.effectiveContextSize ? (settings.effectiveContextSize / 1024).toFixed(0) : 8])}</span>
        </div>
      </div>
      <PcAccessWarning
        open={pcWarning}
        onClose={() => setPcWarning(false)}
        onConfirm={async () => {
          const ok = await onSetFullPc?.(true);
          if (ok) setPcWarning(false);
        }}
      />
      <InternetWarning
        open={internetWarning}
        onClose={() => setInternetWarning(false)}
        onConfirm={async () => {
          const ok = await onSetInternet?.(true);
          if (ok) setInternetWarning(false);
        }}
      />
    </div>
  );
}
