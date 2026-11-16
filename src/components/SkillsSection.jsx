import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, FolderOpen, Library, Search, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { Button, Field, Modal, SectionLabel, SettingRow, Spinner, Toggle, formatBytes, useLatest } from './ui.jsx';
import { t, tj } from '../i18n.js';

// Rows shown before "Show all": a long list of installed skills would bury the rest of Settings.
const INSTALLED_PAGE = 30;
const LIBRARY_PAGE = 40;

function riskLabel(risk) {
  if (risk === 'critical') return t('Acts on real accounts or servers');
  if (risk === 'offensive') return t('Security testing');
  if (risk === 'safe' || risk === 'none') return t('Marked safe by its authors');
  return '';
}

/** The skills that ship with Uma but are not installed: search, read what each does, install. */
function LibraryModal({ open, onClose, onChanged, showToast }) {
  // showToast is a new function on every render of the app; reading it through a ref keeps the
  // searches below from running again each time.
  const toast = useLatest(showToast);
  const [query, setQuery] = useState('');
  const [risk, setRisk] = useState('');
  const [result, setResult] = useState({ items: [], total: 0, librarySize: 0 });
  const [loading, setLoading] = useState(false);
  const [busyName, setBusyName] = useState('');
  const request = useRef(0);

  const load = useCallback(async (offset = 0) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const page = await api.searchSkillLibrary({ query, risk, offset, limit: LIBRARY_PAGE });
      // Typing fast sends several searches; only the latest may show.
      if (id !== request.current) return;
      setResult((previous) => (offset ? { ...page, items: [...previous.items, ...page.items] } : page));
    } catch (err) {
      toast.current(err.message, 'error');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [query, risk, toast]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => load(0), query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [open, query, risk, load]);

  const install = async (name) => {
    setBusyName(name);
    try {
      const done = await api.installSkill(name);
      if (done?.installed) {
        setResult((previous) => ({ ...previous, items: previous.items.map((item) => (item.name === name ? { ...item, installed: true } : item)) }));
        showToast(t('{0} is installed', [name]), 'success');
        onChanged();
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusyName('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      className="skill-library-modal"
      eyebrow={t('Skills')}
      title={t('Skill library')}
      footer={(
        <>
          <span className="skill-library-count">
            {loading ? <Spinner size={13} /> : t('Showing {0} of {1}', [result.items.length, result.total])}
          </span>
          {result.items.length < result.total && (
            <Button variant="secondary" disabled={loading} onClick={() => load(result.items.length)}>{t('Show more')}</Button>
          )}
          <Button variant="primary" onClick={onClose}>{t('Done')}</Button>
        </>
      )}
    >
      <p className="modal-copy">
        {t('All {0} skills from the Advance Skills Pack are always enabled. For each request the model picks the ones that fit, or the one you name at the start of a message. Install a skill to have your own copy to edit.', [result.librarySize])}
      </p>
      <div className="skill-library-search">
        <div className="skill-search-box">
          <Search size={14} />
          <input
            className="input"
            autoFocus
            value={query}
            placeholder={t('Search skills: docker, cold email, unit tests…')}
            aria-label={t('Search the skill library')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <select className="select" value={risk} aria-label={t('Filter by risk')} onChange={(event) => setRisk(event.target.value)}>
          <option value="">{t('All skills')}</option>
          <option value="safe">{t('Marked safe')}</option>
          <option value="unknown">{t('Not reviewed')}</option>
          <option value="critical">{t('Acts on real accounts')}</option>
        </select>
      </div>
      <div className="skill-library-list">
        {!loading && result.items.length === 0 && (
          <p className="skill-library-empty">{query ? t('No skill matches “{0}”. Try one or two plain words.', [query]) : t('The skill library is empty.')}</p>
        )}
        {result.items.map((item) => (
          <div className="skill-library-row" key={item.name}>
            <div className="skill-library-text">
              <div className="skill-library-name">
                {item.name}
                {item.risk === 'critical' && <span className="skill-badge is-warning" title={t('This skill can change things outside this PC, such as accounts, servers, or repositories.')}><AlertTriangle size={11} />{' '}{riskLabel(item.risk)}</span>}
                {item.risk === 'offensive' && <span className="skill-badge is-warning"><AlertTriangle size={11} />{' '}{riskLabel(item.risk)}</span>}
                {item.files > 0 && <span className="skill-badge" title={t('Extra files the model can read or run: references, scripts, templates.')}>{t('{0} files · {1}', [item.files + 1, formatBytes(item.bytes)])}</span>}
              </div>
              <p>{item.description}</p>
            </div>
            <div className="skill-library-actions">
              {item.installed ? (
                <span className="skill-library-installed"><Check size={14} />{' '}{t('Installed')}</span>
              ) : (
                <Button size="sm" variant="ghost" icon={Download} disabled={busyName === item.name} onClick={() => install(item.name)} title={t('Copy it into your skills, to edit it')}>
                  {busyName === item.name ? t('Installing…') : t('Install')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function SkillsSection({ settings, onUpdate, showToast }) {
  const [skills, setSkills] = useState([]);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [librarySize, setLibrarySize] = useState(0);
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', scope: 'global' });
  const toast = useLatest(showToast);

  const refresh = useCallback(() => {
    api.listSkills().then(setSkills).catch((err) => toast.current(err.message, 'error'));
  }, [toast]);

  useEffect(() => {
    refresh();
  }, [refresh, settings.workspacePath, settings.disabledSkills]);

  useEffect(() => {
    api.searchSkillLibrary({ limit: 1 }).then((page) => setLibrarySize(page.librarySize || 0)).catch(() => {});
  }, []);

  const toggle = async (name, enabled) => {
    const disabled = new Set(settings.disabledSkills || []);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await onUpdate({ disabledSkills: [...disabled] }, 'skills');
  };

  const create = async () => {
    try {
      setSkills(await api.createSkill(form));
      setCreating(false);
      setForm({ name: '', description: '', scope: 'global' });
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const remove = async (name) => {
    try {
      setSkills(await api.removeSkill(name));
      showToast(t('{0} was moved to the Recycle Bin', [name]), 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const open = (action) => action().catch((err) => showToast(err.message, 'error'));

  const visible = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return skills;
    return skills.filter((skill) => words.every((word) => skill.name.includes(word) || String(skill.description || '').toLowerCase().includes(word)));
  }, [skills, filter]);
  const shown = showAll || filter ? visible : visible.slice(0, INSTALLED_PAGE);
  const usable = skills.filter((skill) => skill.enabled && !skill.error && !skill.needs).length;

  return (
    <section className="settings-section" id="settings-skills">
      <div className="settings-section-head">
        <SectionLabel>{t('Skills')}</SectionLabel>
        <h3>{t('Step-by-step instructions the model can load')}</h3>
      </div>
      {librarySize > 0 && (
        <div className="settings-card">
          <SettingRow
            icon={Library}
            title={t('Advance Skills Pack from Genesys Lab ({0} skills)', [librarySize])}
            description={t('{0} skills are always enabled. For each request the model picks the ones that fit. Installing a skill lets you edit it.', [(librarySize + usable).toLocaleString()])}
          />
        </div>
      )}
      {skills.length > 8 && (
        <div className="skill-search-box skill-installed-filter">
          <Search size={14} />
          <input
            className="input"
            value={filter}
            placeholder={t('Filter the {0} installed skills', [skills.length])}
            aria-label={t('Filter installed skills')}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}
      <div className="settings-card">
        {skills.length === 0 && (
          <SettingRow icon={Sparkles} title={t('No skills yet')} description={t('Create one below. A skill is a short SKILL.md file with steps for one kind of task.')} />
        )}
        {shown.map((skill) => (
          <SettingRow
            key={`${skill.source}:${skill.name}`}
            icon={skill.error ? AlertTriangle : Sparkles}
            title={`${skill.name} · ${skill.source === 'project' ? t('this project') : t('all projects')}`}
            description={skill.error || (skill.needs ? t('{0} Turn on {1} to use this skill.', [t(skill.description), t(skill.needs)]) : t(skill.description))}
          >
            <div className="skill-controls">
              <Button size="sm" variant="ghost" onClick={() => open(() => api.openSkill(skill.name))}>{t('Edit')}</Button>
              {skill.source === 'global' && (
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={t('Remove {0}', [skill.name])} title={t('Move this skill to the Recycle Bin')} onClick={() => remove(skill.name)} />
              )}
              <Toggle checked={skill.enabled} disabled={Boolean(skill.error)} onChange={(value) => toggle(skill.name, value)} label={t('Use {0}', [skill.name])} />
            </div>
          </SettingRow>
        ))}
        {shown.length < visible.length && (
          <button type="button" className="skill-show-all" onClick={() => setShowAll(true)}>{t('Show all {0} skills', [visible.length])}</button>
        )}
        {filter && visible.length === 0 && <p className="skill-library-empty">{t('No installed skill matches “{0}”.', [filter])}</p>}
      </div>
      <p className="skills-hint">
        {tj('The model picks a matching skill by itself. To choose one yourself, start your message with its name, like {example}. Skills only add instructions: file changes and commands still ask you first.', { example: <code>/{skills[0]?.name || 'skill-name'}{' '}{t('make a calculator')}</code> })}
        {usable > 30 && <>{' '}{t('With {0} skills in use there are too many to show the model at once, so Uma offers it only the ones whose words match your request.', [usable])}</>}
      </p>
      <div className="runtime-actions">
        <Button variant="secondary" icon={Sparkles} onClick={() => setCreating(true)}>{t('New skill')}</Button>
        {librarySize > 0 && (
          <Button variant="secondary" icon={Library} onClick={() => setBrowsing(true)}>{t('Browse the library ({0})', [librarySize])}</Button>
        )}
        <Button variant="ghost" icon={FolderOpen} onClick={() => open(() => api.openSkillsFolder())}>{t('Open skills folder')}</Button>
      </div>
      <LibraryModal
        open={browsing}
        onClose={() => setBrowsing(false)}
        onChanged={refresh}
        showToast={showToast}
      />
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={t('New skill')}
        eyebrow={t('Skills')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t('Cancel')}</Button>
            <Button variant="primary" onClick={create}>{t('Create and edit')}</Button>
          </>
        )}
      >
        <Field label={t('Name')} hint={t('Lowercase letters, numbers, and hyphens.')}>
          <input className="input" value={form.name} placeholder={t('fix-build-errors')} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label={t('When should the model use it?')} hint={t('The model reads only this line when deciding, so be specific.')}>
          <input className="input" value={form.description} placeholder={t('Fix compiler errors in a C++ project')} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <Field label={t('Available in')}>
          <select className="select" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>
            <option value="global">{t('All projects')}</option>
            <option value="project">{t('This project only')}</option>
          </select>
        </Field>
      </Modal>
    </section>
  );
}
