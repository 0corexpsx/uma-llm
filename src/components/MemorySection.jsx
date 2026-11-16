import React, { useEffect, useMemo, useState } from 'react';
import { BookMarked, Copy, Download, FileUp, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, Modal, SectionLabel, SettingRow, Toggle, formatRelative } from './ui.jsx';
import { t } from '../i18n.js';

// Where an export can come from. The steps say how to get it out of each one.
const SOURCES = [
  { id: 'ChatGPT', steps: () => t('In ChatGPT, open a chat and send the request below. Or open Settings → Personalization → Manage memories and copy the list.') },
  { id: 'Claude', steps: () => t('In Claude, send the request below in a new chat. Or open Settings → Capabilities → Memory and copy what is there.') },
  { id: 'Gemini', steps: () => t('In Gemini, send the request below. Or open Saved info and copy the list.') },
  { id: 'Local agent', label: () => t('Local agent'), steps: () => t('From another local assistant (Open WebUI, LM Studio, AnythingLLM, Jan, another Uma…): export its memory as a .txt, .md or .json file, or ask it with the request below.') },
  { id: 'Other', label: () => t('Other'), steps: () => t('Paste any list of facts about you: one per line works best.') },
];

const sourceLabel = (source) => ({ you: t('Added by you'), uma: t('Saved by Uma') }[source] || t('Imported from {0}', [source]));

function ImportMemory({ open, onClose, exportPrompt, onImported, showToast }) {
  const [source, setSource] = useState('ChatGPT');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [chosen, setChosen] = useState(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText('');
    setParsed(null);
  }, [open]);

  const read = async (value) => {
    const items = await api.parseMemoryImport(value);
    setParsed(items);
    setChosen(new Set(items.map((item, index) => (item.known ? -1 : index)).filter((index) => index >= 0)));
  };

  const openFile = async () => {
    try {
      const file = await api.openMemoryFile();
      if (!file) return;
      setText(file.text.length > 200000 ? `${file.text.slice(0, 200000)}\n…` : file.text);
      await read(file.text);
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const items = parsed.filter((_, index) => chosen.has(index)).map((item) => item.text);
      const result = await api.importMemory(items, source);
      onImported(result.items);
      showToast(t('{0} memories imported', [result.added]), 'success');
      onClose();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (index) => setChosen((previous) => {
    const next = new Set(previous);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  });

  const steps = SOURCES.find((item) => item.id === source)?.steps() || '';
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={t('Memory')}
      title={t('Import memory from another assistant')}
      width={720}
      className="memory-import"
      footer={parsed ? (
        <>
          <Button variant="ghost" onClick={() => setParsed(null)}>{t('Back')}</Button>
          <Button variant="primary" loading={busy} disabled={!chosen.size} onClick={save}>{t('Import {0}', [chosen.size])}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" icon={FileUp} onClick={openFile}>{t('Open a file…')}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => read(text)}>{t('Read the list')}</Button>
        </>
      )}
    >
      {!parsed ? (
        <div className="memory-import-body">
          <div className="family-chips">
            {SOURCES.map((item) => (
              <button type="button" key={item.id} className={`family-chip ${source === item.id ? 'is-on' : ''}`} onClick={() => setSource(item.id)}>
                {item.label ? item.label() : item.id}
              </button>
            ))}
          </div>
          <p className="memory-steps">{steps}</p>
          {source !== 'Other' && (
            <div className="memory-prompt">
              <code>{exportPrompt}</code>
              <IconButton label={t('Copy the request')} icon={Copy} onClick={() => { navigator.clipboard.writeText(exportPrompt); showToast(t('Copied'), 'success'); }} />
            </div>
          )}
          <textarea
            className="input memory-paste"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('Paste the answer or the exported memory here…')}
            rows={9}
          />
          <p className="memory-note">{t('Imported memory is kept on this PC and given to the model as information about you, never as instructions.')}</p>
        </div>
      ) : (
        <div className="memory-preview">
          <p className="memory-steps">{parsed.length
            ? t('Found {0} facts. Untick the ones you do not want; those Uma already has are unticked.', [parsed.length])
            : t('No facts found in that text. Paste one fact per line.')}</p>
          {parsed.map((item, index) => (
            <label className={`memory-preview-item ${item.known ? 'is-known' : ''}`} key={`${index}-${item.text}`}>
              <input type="checkbox" checked={chosen.has(index)} onChange={() => toggle(index)} />
              <span>{item.text}{item.known ? <em>{` · ${t('already in memory')}`}</em> : null}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * Settings → Memory: the facts about the user Uma gives to every chat. Add, edit and delete them,
 * import them from ChatGPT, Claude, Gemini or another local assistant, and export them.
 */
export default function MemorySection({ settings, update, showToast }) {
  const [items, setItems] = useState(null);
  const [exportPrompt, setExportPrompt] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.memory().then((value) => { setItems(value.items); setExportPrompt(value.exportPrompt); }).catch(() => setItems([]));
  }, []);

  const run = async (action) => {
    try {
      setItems(await action());
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const add = async () => {
    if (!draft.trim()) return;
    await run(() => api.addMemory(draft));
    setDraft('');
  };

  const exportAll = async () => {
    try {
      const file = await api.exportMemory();
      if (file) showToast(t('Memory exported to {0}', [file]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const shown = useMemo(() => {
    const list = [...(items || [])].reverse();
    const query = filter.trim().toLowerCase();
    return query ? list.filter((item) => item.text.toLowerCase().includes(query)) : list;
  }, [items, filter]);

  const enabled = settings.useMemory !== false;
  return (
    <section className="settings-section" id="settings-user-memory">
      <div className="settings-section-head">
        <SectionLabel>{t('Memory')}</SectionLabel>
        <h3>{t('What Uma knows about you')}</h3>
      </div>
      <div className="settings-card">
        <SettingRow
          icon={BookMarked}
          title={t('Use memory in chats')}
          description={t('Uma gives these facts to the model in every new chat, and the model can save new ones when you ask it to remember something. Import what ChatGPT, Claude, Gemini or another local assistant knows about you, so Uma starts with the same knowledge. Everything stays on this PC.')}
        >
          <Toggle checked={enabled} onChange={(value) => update({ useMemory: value }, 'memory')} label={t('Use memory in chats')} />
        </SettingRow>
        <div className="memory-toolbar">
          <Button size="sm" variant="secondary" icon={Upload} onClick={() => setImporting(true)}>{t('Import memory')}</Button>
          <Button size="sm" variant="ghost" icon={Download} disabled={!items?.length} onClick={exportAll}>{t('Export')}</Button>
          {items?.length > 8 && <input className="input memory-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('Search memory…')} />}
        </div>
        <div className="memory-add">
          <input
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') add(); }}
            placeholder={t('Add a fact, e.g. "I write code in Python and answer in Italian"')}
          />
          <Button size="sm" variant="secondary" icon={Plus} disabled={!draft.trim()} onClick={add}>{t('Add')}</Button>
        </div>
        {items && !items.length && <p className="chat-memory-empty memory-empty">{t('Nothing remembered yet.')}</p>}
        {shown.length > 0 && (
          <div className="chat-memory-list">
            {shown.map((item) => (
              <div className="chat-memory-item" key={item.id}>
                {editing?.id === item.id ? (
                  <input
                    className="input memory-edit"
                    autoFocus
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { run(() => api.updateMemory(item.id, editing.text)); setEditing(null); }
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                  />
                ) : (
                  <div>
                    <strong className="memory-text">{item.text}</strong>
                    <span>{`${sourceLabel(item.source)} · ${formatRelative(item.createdAt)}`}</span>
                  </div>
                )}
                <div className="skill-controls">
                  <IconButton label={t('Edit')} icon={Pencil} onClick={() => setEditing({ id: item.id, text: item.text })} />
                  <IconButton label={t('Forget this')} icon={Trash2} onClick={() => run(() => api.removeMemory(item.id))} />
                </div>
              </div>
            ))}
            <div className="chat-memory-actions">
              <Button size="sm" variant="ghost" onClick={() => run(() => api.removeMemory('*'))}>{t('Forget everything')}</Button>
            </div>
          </div>
        )}
        <p className="memory-note memory-footnote">{t('A chat keeps the memory it started with, so the model does not read the whole chat again; facts saved meanwhile are added to your next message, and new chats get everything.')}</p>
      </div>
      <ImportMemory open={importing} onClose={() => setImporting(false)} exportPrompt={exportPrompt} onImported={setItems} showToast={showToast} />
    </section>
  );
}
