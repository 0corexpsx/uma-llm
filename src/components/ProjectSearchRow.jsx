import React, { useEffect, useState } from 'react';
import { BookOpenText, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { Button, SettingRow, Toggle, formatBytes } from './ui.jsx';
import { t } from '../i18n.js';

/**
 * Settings → Workspace: whether Uma adds the passages of the project that match a request to it
 * (RAG), how much of the folder is searchable, and a way to read it all again.
 */
export default function ProjectSearchRow({ enabled, semanticEnabled, workspacePath, onToggle, onToggleSemantic, showToast }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [download, setDownload] = useState(null);

  useEffect(() => api.onRagDownload?.((value) => {
    setDownload(value.downloading);
    if (!value.downloading) api.ragStatus().then(setStatus).catch(() => {});
  }), []);

  const installSemantic = async () => {
    setDownload({ percent: 0 });
    try {
      setStatus(await api.installSemanticSearch());
      showToast(t('Search by meaning is ready'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setDownload(null);
    }
  };

  useEffect(() => {
    let alive = true;
    const load = () => api.ragStatus().then((value) => { if (alive) setStatus(value); }).catch(() => {});
    load();
    // The first build runs in the background; show it finish.
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [workspacePath]);

  const rebuild = async () => {
    setBusy(true);
    try {
      setStatus(await api.rebuildRag());
      showToast(t('The project search index was rebuilt'), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const detail = !status || status.building
    ? t('Reading the workspace…')
    : status.files
      ? t('{0} files, {1} passages ({2}){3}', [status.files.toLocaleString(), status.passages.toLocaleString(), formatBytes(status.bytes), status.truncated ? t(', only part of a very large folder') : ''])
      : t('No text files found yet.');

  const semantic = status?.semantic || {};
  const downloading = download || semantic.downloading;
  const semanticDetail = !semantic.installed
    ? (downloading ? t('Downloading… {0}%', [Math.round(downloading.percent || 0)]) : t('Needs a small model ({0}), downloaded once.', [formatBytes(semantic.sizeBytes || 333590944)]))
    : !semanticEnabled
      ? ''
      : semantic.total && semantic.embedded < semantic.total
        ? t('Understanding passages: {0} of {1}{2}', [semantic.embedded.toLocaleString(), semantic.total.toLocaleString(), semantic.device ? ` (${semantic.device})` : ''])
        : semantic.total ? t('All {0} passages understood.', [semantic.total.toLocaleString()]) : '';

  return (
    <div className="settings-card project-search-card">
      <SettingRow
        icon={BookOpenText}
        title={t('Find relevant parts of the project')}
        description={`${t('For each request about the workspace, Uma looks up the passages of your files that match it and gives them to the model with the request, so a small model works from the right code even in a big project. Long attached documents are read the same way: the parts that match your question instead of only the start. Nothing leaves this PC.')} ${enabled ? detail : ''}`}
      >
        <div className="skill-controls">
          {enabled && <Button size="sm" variant="ghost" loading={busy} onClick={rebuild}>{t('Rebuild')}</Button>}
          <Toggle checked={enabled} onChange={onToggle} label={t('Find relevant parts of the project')} />
        </div>
      </SettingRow>
      {enabled && (
        <SettingRow
          icon={Sparkles}
          title={t('Search by meaning')}
          description={`${t('Also finds passages that say the same thing in other words or another language, such as an Italian question about English code. A small model reads the project once in the background and pauses while Uma answers.')} ${semanticDetail}`}
        >
          <div className="skill-controls">
            {semantic.installed
              ? <Toggle checked={semanticEnabled} onChange={onToggleSemantic} label={t('Search by meaning')} />
              : <Button size="sm" variant="secondary" loading={Boolean(downloading)} onClick={installSemantic}>{t('Download')}</Button>}
          </div>
        </SettingRow>
      )}
    </div>
  );
}
