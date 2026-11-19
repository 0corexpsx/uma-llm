import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowUpRight, Check, ChevronRight, Cpu, Database, ExternalLink,
  Eye, FilePenLine, FolderOpen, Globe, HardDrive, Info, Languages, LockKeyhole, MonitorCog, MousePointerClick, RefreshCw, ShieldAlert,
  ShieldCheck, Terminal, Trash2, Zap,
} from 'lucide-react';
import { api } from '../api.js';
import { Button, Field, Modal, OS, SectionLabel, SettingRow, Toggle, formatBytes } from './ui.jsx';
import NetworkSection from './NetworkSection.jsx';
import SkillsSection from './SkillsSection.jsx';
import ProjectSearchRow from './ProjectSearchRow.jsx';
import ChatMemorySection from './ChatMemorySection.jsx';
import UpdateSection from './UpdateSection.jsx';
import MemorySection from './MemorySection.jsx';
import PcAccessWarning from './PcAccessWarning.jsx';
import InputWarning from './InputWarning.jsx';
import InternetWarning from './InternetWarning.jsx';
import { t, tj } from '../i18n.js';

export default function SettingsView({ boot, onRefreshBoot, showToast }) {
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState(null);
  const settings = boot.settings;


  const update = async (patch, key = '') => {
    if (Object.entries(patch).every(([name, value]) => settings[name] === value)) return true;
    setBusy(key);
    try {
      await api.updateSettings(patch);
      await onRefreshBoot?.();
      showToast(t('Settings saved'), 'success');
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const chooseEngine = async (value) => {
    const engine = boot.runtime.backends?.find((item) => item.id === value);
    if (!engine?.installed) {
      await update({ runtimeBackend: value }, 'backend');
      return;
    }
    setBusy('backend');
    try {
      await api.useRuntime(value);
      await onRefreshBoot?.();
      showToast(t('Now using {0}', [engine.label]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const enablePcAccess = async () => {
    const ok = await update({ allowSystemAccess: true }, 'system-access');
    if (ok) setModal(null);
  };

  const enableInput = async () => {
    const ok = await update({ allowInput: true }, 'input');
    if (ok) setModal(null);
  };

  const enableInternet = async () => {
    const ok = await update({ allowInternet: true }, 'internet');
    if (ok) setModal(null);
  };


  const chooseWorkspace = async () => {
    setBusy('workspace');
    try {
      const info = await api.chooseWorkspace();
      if (info) {
        await onRefreshBoot?.();
        showToast(t('Workspace changed to {0}', [info.name]), 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="settings-view">
      <header className="view-header settings-header">
        <div>
          <div className="eyebrow">{t('Settings')}</div>
          <h2>{t('Settings')}</h2>
        </div>
        <span className="settings-version">{t('Uma LLM')}{' '}{boot.appVersion}</span>
      </header>

      <div className="settings-scroll">
        <section className="settings-section" id="settings-workspace">
          <div className="settings-section-head">
            <SectionLabel>{t('Workspace')}</SectionLabel>
            <h3>{t('The room Uma works in')}</h3>
          </div>
          <div className="workspace-setting-card">
            <div className="workspace-setting-main">
              <span className="workspace-setting-icon"><FolderOpen size={24} strokeWidth={1.4} /></span>
              <div>
                <strong>{boot.workspace?.name}</strong>
                <code>{boot.workspace?.path}</code>
                <div className="workspace-setting-stats">
                  <span>{boot.workspace?.stats.files.toLocaleString()}{' '}{t('files')}</span>
                  <span>{boot.workspace?.stats.folders.toLocaleString()}{' '}{t('folders')}</span>
                  <span>{boot.workspace?.stats.label}</span>
                </div>
              </div>
            </div>
            <div className="workspace-setting-actions">
              <Button variant="secondary" onClick={chooseWorkspace} loading={busy === 'workspace'}>{t('Change folder')}</Button>
              <Button variant="ghost" icon={ExternalLink} onClick={() => api.revealPath('.')}>{t('Reveal')}</Button>
            </div>
          </div>
          <div className="callout">
            {settings.allowSystemAccess ? <ShieldAlert size={15} /> : <LockKeyhole size={15} />}
            <p>
              {settings.allowSystemAccess
                ? t('Full PC access is enabled. The workspace is still the default starting point, but the agent may now use absolute paths to read and write anywhere your {0} can access.', [OS.account])
                : t('Every agent file path is resolved against this folder. Absolute paths, .. escapes, and symlinks that point outside are rejected by the engine before any file operation runs.')}
            </p>
          </div>
          <ProjectSearchRow
            enabled={settings.projectSearch !== false}
            semanticEnabled={settings.semanticSearch !== false}
            workspacePath={settings.workspacePath}
            onToggle={(value) => update({ projectSearch: value }, 'rag')}
            onToggleSemantic={(value) => update({ semanticSearch: value }, 'rag-semantic')}
            showToast={showToast}
          />
        </section>

        <section className="settings-section" id="settings-agent">
          <div className="settings-section-head">
            <SectionLabel>{t('Agent permissions')}</SectionLabel>
            <h3>{t('What Uma is allowed to do')}</h3>
          </div>
          <div className="settings-card">
            <SettingRow
              icon={FilePenLine}
              title={t('Allow file edits')}
              description={t('Create, rewrite, append, and patch files in the workspace.')}
            >
              <Toggle
                checked={settings.allowEdits}
                onChange={(value) => update({ allowEdits: value }, 'edits')}
                disabled={busy === 'edits'}
                label={t('Allow file edits')}
              />
            </SettingRow>
            <SettingRow
              icon={Trash2}
              title={t('Allow deleting files')}
              description={t('Moves files to the {0} instead of erasing them permanently.', [OS.trash])}
            >
              <Toggle
                checked={settings.allowDelete}
                onChange={(value) => update({ allowDelete: value }, 'delete')}
                disabled={busy === 'delete'}
                label={t('Allow deleting files')}
              />
            </SettingRow>
            <SettingRow
              icon={Terminal}
              title={t('Allow terminal commands')}
              description={t('Lets the agent run {0}. Once this is on, commands run without asking each time, downloads and installs included. With full PC access it can operate anywhere; keep this off unless you need it.', [OS.shell])}
              danger
            >
              <Toggle
                checked={settings.allowShell}
                onChange={(value) => update({ allowShell: value }, 'shell')}
                disabled={busy === 'shell'}
                label={t('Allow terminal commands')}
              />
            </SettingRow>
            {settings.allowShell && (
              <SettingRow
                icon={Terminal}
                title={t('Ask before each command')}
                description={t('Off: every terminal command runs without asking, downloads and installs included. It goes off when you allow terminal commands; turn it on to approve each command yourself.')}
                danger={settings.askBeforeCommands === false}
              >
                <Toggle
                  checked={settings.askBeforeCommands !== false}
                  onChange={(value) => update({ askBeforeCommands: value }, 'ask-commands')}
                  disabled={busy === 'ask-commands'}
                  label={t('Ask before each command')}
                />
              </SettingRow>
            )}
            <SettingRow
              icon={ShieldAlert}
              title={t('Full PC access')}
              description={t('Breaks the workspace boundary. The agent may read and write any file your {0} can access.', [OS.account])}
              danger
            >
              <Toggle
                checked={settings.allowSystemAccess}
                onChange={(value) => {
                  if (value) {
                    setModal('pc-access');
                  } else {
                    update({ allowSystemAccess: false }, 'system-access');
                  }
                }}
                disabled={busy === 'system-access'}
                label={t('Full PC access')}
              />
            </SettingRow>
            <SettingRow
              icon={Eye}
              title={t('See the screen')}
              description={t('Lets a model that can see (one with a vision file) take a screenshot of a window, or of the whole screen, to check what a program it started really shows. Each screenshot appears in the chat, and nothing leaves this PC. Whatever is on the screen at that moment is shown to the model.')}
              danger
            >
              <Toggle checked={Boolean(settings.allowScreen)} onChange={(value) => update({ allowScreen: value }, 'screen')} disabled={busy === 'screen'} label={t('See the screen')} />
            </SettingRow>
            <SettingRow
              icon={MousePointerClick}
              title={t('Control the mouse and keyboard')}
              description={t('Lets the AI click, type and press keys in other programs, for example to open a video in Brave and play it. Clicking needs "See the screen" and a model that can see. A notice shows while it acts; press Ctrl+Alt+Esc, or push the mouse into the top-left corner of the screen, to stop it.')}
              danger
            >
              <Toggle
                checked={Boolean(settings.allowInput)}
                onChange={(value) => (value ? setModal('input-warning') : update({ allowInput: false }, 'input'))}
                disabled={busy === 'input'}
                label={t('Control the mouse and keyboard')}
              />
            </SettingRow>
            <SettingRow
              icon={Globe}
              title={t('Internet access')}
              description={t('Allows web_search and fetch_url. Queries and pages leave this PC; web content is untrusted.')}
              danger
            >
              <Toggle
                checked={settings.allowInternet}
                onChange={(value) => {
                  if (value) setModal('internet-warning');
                  else update({ allowInternet: false }, 'internet');
                }}
                disabled={busy === 'internet'}
                label={t('Internet access')}
              />
            </SettingRow>
          </div>
          {settings.allowInternet && (
            <div className="callout warning">
              <Globe size={15} />
              <p>
                <strong>{t('Internet access is enabled.')}</strong>{' '}{t('The agent can search the web and read public pages. Treat page content as untrusted; it may contain prompt injection.')}
                <button type="button" onClick={() => update({ allowInternet: false }, 'internet')}>
                  {t('Disable internet access')}
                </button>
              </p>
            </div>
          )}
          {settings.allowSystemAccess && (
            <div className="callout danger">
              <ShieldAlert size={15} />
              <p>
                <strong>{t('Full PC access is enabled.')}</strong>{' '}{t('The agent can use absolute paths and modify files outside the workspace. You accepted responsibility for this. Terminal access and deleting remain separate permissions.')}
                <button type="button" onClick={() => update({ allowSystemAccess: false }, 'system-access')}>
                  {t('Disable full PC access')}
                </button>
              </p>
            </div>
          )}
          {!settings.allowEdits && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <p>{t('Uma can read and explain files, but any edit request will be refused until you switch edits on.')}</p>
            </div>
          )}
        </section>

        <section className="settings-section" id="settings-appearance">
          <div className="settings-section-head">
            <SectionLabel>{t('Appearance')}</SectionLabel>
            <h3>{t('How Uma looks')}</h3>
          </div>
          <div className="settings-card">
            <SettingRow icon={Languages} title={t('Language')} description={t('The language of menus, messages, and this window. Uma restarts its window to switch.')}>
              <select
                className="select"
                value={settings.language || 'en'}
                aria-label={t('Language')}
                disabled={busy === 'language'}
                onChange={async (event) => {
                  if (await update({ language: event.target.value }, 'language')) window.location.reload();
                }}
              >
                {(boot.languages || []).map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
              </select>
            </SettingRow>
            <SettingRow
              icon={MonitorCog}
              title={t('Use the GPU to draw Uma\'s window')}
              description={t('Off: the processor draws the window instead. This frees graphics memory for the model and about 100 MB of RAM; scrolling and animations can be a little less smooth. Applies after Uma restarts.')}
            >
              <div className="gpu-setting">
                {(settings.interfaceGpu !== false) !== (boot.interfaceGpu !== false) && (
                  <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => api.restartApp()}>{t('Restart Uma')}</Button>
                )}
                <Toggle
                  checked={settings.interfaceGpu !== false}
                  onChange={(value) => update({ interfaceGpu: value }, 'interface-gpu')}
                  disabled={busy === 'interface-gpu'}
                  label={t('Use the GPU to draw Uma\'s window')}
                />
              </div>
            </SettingRow>
          </div>
        </section>

        <section className="settings-section" id="settings-model">
          <div className="settings-section-head">
            <SectionLabel>{t('Model behaviour')}</SectionLabel>
            <h3>{t('How the local mind runs')}</h3>
          </div>
          <div className="settings-card">
            <SettingRow
              icon={Zap}
              title={t('Load the model when Uma opens')}
              description={t('The selected model goes into memory as soon as Uma starts, and when you select another one, so the first reply does not wait for it. It is still unloaded after the idle time in the model\'s own settings (30 minutes unless you change it; 0 keeps it loaded).')}
            >
              <Toggle
                checked={settings.loadModelAtStart !== false}
                onChange={(value) => update({ loadModelAtStart: value }, 'loadstart')}
                disabled={busy === 'loadstart'}
                label={t('Load the model when Uma opens')}
              />
            </SettingRow>
            <SettingRow
              icon={Zap}
              title={t('GPU offload')}
              description={t('Offload model layers to {0}. Turn off to force CPU inference.', [boot.hardware?.gpu || t('the GPU')])}
            >
              <Toggle
                checked={settings.gpuOffload}
                onChange={(value) => update({ gpuOffload: value }, 'gpu')}
                disabled={busy === 'gpu'}
                label={t('GPU offload')}
              />
            </SettingRow>
            <SettingRow
              icon={Cpu}
              title={t('Preferred engine')}
              description={t('An installed engine switches right away. Others are saved as your choice; download them under Models → Inference engine.')}
            >
              <select
                className="select"
                value={settings.runtimeBackend}
                onChange={(event) => chooseEngine(event.target.value)}
                disabled={busy === 'backend'}
              >
                <option value="auto">{t('Auto detect')}</option>
                {(boot.runtime.backends || []).map((item) => (
                  <option value={item.id} key={item.id} disabled={!item.available}>
                    {item.label}{item.installed ? '' : ` (${item.available ? t('not installed') : 'unavailable'})`}
                  </option>
                ))}
              </select>
            </SettingRow>
          </div>
        </section>

        <SkillsSection settings={settings} onUpdate={update} showToast={showToast} />

        <NetworkSection boot={boot} showToast={showToast} />

        <MemorySection settings={settings} update={update} showToast={showToast} />

        <ChatMemorySection settings={settings} update={update} showToast={showToast} />

        <UpdateSection settings={settings} update={update} showToast={showToast} />

        <section className="settings-section" id="settings-storage">
          <div className="settings-section-head">
            <SectionLabel>{t('Storage')}</SectionLabel>
            <h3>{t('Where the pieces live')}</h3>
          </div>
          <div className="storage-grid">
            <div className="storage-card">
              <span className="storage-icon"><HardDrive size={18} /></span>
              <div>
                <strong>{t('Models')}</strong>
                <code>{boot.storage.modelsDir}</code>
                <span>{t('{0} used', [formatBytes(boot.storage.modelBytes)])}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => api.revealModels()}>{t('Open')}</Button>
            </div>
            <div className="storage-card">
              <span className="storage-icon"><Database size={18} /></span>
              <div>
                <strong>{t('Conversations & settings')}</strong>
                <code>{boot.storage.userData}</code>
                <span>{t('Local JSON, no database server')}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => api.openData()}>{t('Open')}</Button>
            </div>
          </div>
        </section>

        <section className="settings-section" id="settings-about">
          <div className="settings-section-head">
            <SectionLabel>{t('About')}</SectionLabel>
            <h3>{t('Made by Ocorex, with Genesys Labs')}</h3>
          </div>
          <div className="about-card">
            <div className="collab-marks">
              <span className="collab-horse" role="img" aria-label={t('Uma, by Ocorex')} />
              <i className="collab-x collab-seal" aria-hidden>×</i>
              <span className="collab-gl" role="img" aria-label={t('Genesys Labs')}><span className="gl-emblem" /></span>
            </div>
            <div className="about-copy">
              <strong>{t('Uma LLM')}{' '}{boot.appVersion}</strong>
              <span className="about-copyright">{t('© 2026 Ocorex. Free and open source under the GNU GPL v3.')}</span>
              <p>
                {t('Uma LLM is made by Ocorex. Its skill pack is by Genesys Labs, which licenses it to Uma for free. Your prompts, files, conversations and models stay on this PC. Uma goes online to download the models and the llama.cpp engine, to keep the engine up to date, to check that your PCs reach the internet, and for web tools you turn on.')}{' '}{t('It also looks for a newer Uma once a day, unless you turn that off in Settings → Updates.')}
              </p>
              <div className="about-links">
                <button type="button" onClick={() => api.openExternal('https://www.0corexpsx.com/uma')}>
                  {t('Website')}{' '}<ArrowUpRight size={12} />
                </button>
                <button type="button" onClick={() => api.openExternal('https://ko-fi.com/0corexpsx')}>
                  {t('Buy me a coffee on Ko-fi')}{' '}<ArrowUpRight size={12} />
                </button>
                <button type="button" onClick={() => api.openExternal('mailto:0corexpsx@gmail.com').catch(() => {})}>
                  {t('Support: {0}', ['0corexpsx@gmail.com'])}
                </button>
                <button type="button" onClick={() => api.openLegal('license').catch((err) => showToast(err.message, 'error'))}>
                  {t('Licence')}
                </button>
                <button type="button" onClick={() => api.openLegal('notices').catch((err) => showToast(err.message, 'error'))}>
                  {t('Open-source notices')}
                </button>
                <button type="button" onClick={() => api.openExternal('https://github.com/ggml-org/llama.cpp')}>
                  {t('llama.cpp')}{' '}<ArrowUpRight size={12} />
                </button>
                <button type="button" onClick={() => api.openExternal('https://huggingface.co')}>
                  {t('Hugging Face')}{' '}<ArrowUpRight size={12} />
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="settings-footer">
          <span><LockKeyhole size={12} />{' '}{t('Local by design')}</span>
          <span>{boot.platform} · {t('{0} cores · {1} GB RAM', [boot.hardware?.cores, boot.hardware?.ramGB])}</span>
        </div>
      </div>

      <InputWarning
        open={modal === 'input-warning'}
        onClose={() => setModal(null)}
        onConfirm={enableInput}
        busy={busy === 'input'}
      />

      <PcAccessWarning
        open={modal === 'pc-access'}
        onClose={() => setModal(null)}
        onConfirm={enablePcAccess}
        busy={busy === 'system-access'}
      />

      <InternetWarning
        open={modal === 'internet-warning'}
        onClose={() => setModal(null)}
        onConfirm={enableInternet}
        busy={busy === 'internet'}
      />
    </div>
  );
}
