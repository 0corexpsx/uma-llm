import React, { useEffect, useState } from 'react';
import { BrainCircuit, FolderOpen, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, SectionLabel, SettingRow, formatBytes, formatRelative } from './ui.jsx';
import { t } from '../i18n.js';

const LIMITS = [10, 20, 50, 100, 200, 500];

/**
 * Settings → Chat memory: what the local model has already read of each chat, saved on disk so a
 * chat continues in seconds after a restart. Shows the space used, the limit, what happens beyond
 * it, and deletes the memory of one chat or of all of them.
 */
export default function ChatMemorySection({ settings, update, showToast }) {
  const [memory, setMemory] = useState(null);
  const [busy, setBusy] = useState('');
  const [moving, setMoving] = useState(null);

  useEffect(() => api.onChatMemoryMoving?.((value) => setMoving(value)), []);

  const move = async (reset) => {
    setBusy(reset ? 'reset' : 'move');
    try {
      const before = memory?.dir;
      const next = await api.moveChatMemory({ reset });
      setMemory(next);
      if (next.dir !== before) showToast(t('Chat memory is now saved in {0}', [next.dir]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
      setMoving(null);
    }
  };

  useEffect(() => {
    let alive = true;
    const load = () => api.chatMemory().then((value) => { if (alive) setMemory(value); }).catch(() => {});
    load();
    const timer = setInterval(load, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [settings.chatMemoryLimitGB, settings.chatMemoryOverLimit]);

  const remove = async (id) => {
    setBusy(id);
    try {
      setMemory(await api.removeChatMemory(id));
      showToast(id === '*' ? t('All chat memory deleted') : t('Chat memory deleted'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const limit = Number(settings.chatMemoryLimitGB) || 50;
  const mode = settings.chatMemoryOverLimit || 'ask';
  const lowDisk = memory && memory.freeBytes < memory.lowDiskBytes;

  return (
    <section className="settings-section" id="settings-memory">
      <div className="settings-section-head">
        <SectionLabel>{t('Chat memory')}</SectionLabel>
        <h3>{t('What the model remembers of each chat')}</h3>
      </div>
      <div className="settings-card">
        <SettingRow
          icon={BrainCircuit}
          title={t('Space for chat memory')}
          description={memory
            ? t('Uma saves what the local model has already read of each chat, so going back to a chat continues in seconds instead of reading it all again. Used now: {0} of {1}. Free on this disk: {2}.', [formatBytes(memory.totalBytes), mode === 'continue' ? t('no limit') : `${limit} GB`, formatBytes(memory.freeBytes)])
            : t('Reading…')}
        >
          <select className="select network-select" value={limit} onChange={(event) => update({ chatMemoryLimitGB: Number(event.target.value) }, 'chat-memory-limit')}>
            {[...new Set([...LIMITS, limit])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{`${value} GB`}</option>)}
          </select>
        </SettingRow>
        <SettingRow
          icon={FolderOpen}
          title={t('Where chat memory is saved')}
          description={memory
            ? `${memory.dir}${memory.isDefault ? ` (${t('default')})` : ''}. ${t('Choose another disk, such as a second HDD or M.2 drive, to keep this one free. The memory already saved moves there, and the model loads again with your next message.')}${moving ? ` ${t('Moving… {0} of {1}', [formatBytes(moving.done), formatBytes(moving.total)])}` : ''}`
            : t('Reading…')}
        >
          <div className="skill-controls">
            {memory && !memory.isDefault && <Button size="sm" variant="ghost" loading={busy === 'reset'} disabled={Boolean(busy)} onClick={() => move(true)}>{t('Use default')}</Button>}
            <Button size="sm" variant="secondary" loading={busy === 'move'} disabled={Boolean(busy)} onClick={() => move(false)}>{t('Change folder…')}</Button>
          </div>
        </SettingRow>
        {memory?.unavailable && (
          <p className="chat-memory-warning">{t('The chat memory folder cannot be used right now (is its drive connected?), so chats are not saved. Connect the drive and restart Uma, or choose another folder.')}</p>
        )}
        <SettingRow
          title={t('When the limit is reached')}
          description={t('Ask: Uma asks once. Replace the oldest: the memory of the chats used longest ago makes room. Keep saving: no limit, until the disk is nearly full (below 20 GB free Uma warns you).')}
        >
          <select className="select network-select" value={mode} onChange={(event) => update({ chatMemoryOverLimit: event.target.value }, 'chat-memory-mode')}>
            <option value="ask">{t('Ask me')}</option>
            <option value="overwrite">{t('Replace the oldest')}</option>
            <option value="continue">{t('Keep saving')}</option>
          </select>
        </SettingRow>
        {lowDisk && (
          <p className="chat-memory-warning">{t('Only {0} free on this disk. Free some space or delete chat memory, so Uma can keep remembering your chats.', [formatBytes(memory.freeBytes)])}</p>
        )}
        {memory?.chats.length ? (
          <div className="chat-memory-list">
            {memory.chats.map((chat) => (
              <div className="chat-memory-item" key={chat.id}>
                <div>
                  <strong>{chat.title || t('Untitled chat')}</strong>
                  <span>{t('{0} · {1} tokens · saved {2}', [formatBytes(chat.bytes), Number(chat.tokens || 0).toLocaleString(), formatRelative(chat.savedAt)])}</span>
                </div>
                <IconButton label={t('Delete this chat memory')} icon={Trash2} disabled={busy === chat.id} onClick={() => remove(chat.id)} />
              </div>
            ))}
            <div className="chat-memory-actions">
              <Button size="sm" variant="ghost" loading={busy === '*'} onClick={() => remove('*')}>{t('Delete all chat memory')}</Button>
            </div>
          </div>
        ) : memory ? (
          <p className="chat-memory-empty">{t('No chat memory saved yet. It is saved a few seconds after each reply.')}</p>
        ) : null}
      </div>
    </section>
  );
}
