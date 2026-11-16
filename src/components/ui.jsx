import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import umaLogo from '../assets/uma-horse.png';
import { t, getLanguage } from '../i18n.js';

export { umaLogo };

// Words that differ between Windows and macOS.
const platform = typeof window !== 'undefined' ? window.uma?.platform : '';
const mac = platform === 'darwin';
const linux = platform === 'linux';
const pick = (windows, macOS, linuxText) => (mac ? macOS : linux ? linuxText : windows);
// Getters, so each word is translated into the language in use when it is read.
export const OS = {
  mac,
  linux,
  get name() { return pick('Windows', 'macOS', 'Linux'); },
  get account() { return t(pick('Windows account', 'Mac user account', 'Linux user account')); },
  get trash() { return t(pick('Recycle Bin', 'Trash', 'Trash')); },
  get shell() { return t(pick('PowerShell', 'Terminal commands (zsh)', 'Terminal commands (bash)')); },
  get fileManager() { return t(pick('Explorer', 'Finder', 'the file manager')); },
  get reveal() { return t(pick('Open in Explorer', 'Show in Finder', 'Open folder')); },
};

export function Logo({ size = 28, className = '' }) {
  return <img className={`logo ${className}`} src={umaLogo} width={size} height={size} alt="" draggable={false} />;
}

// "Ocorex × Genesys Labs": the collaboration credit used in the title bar and boot screen.
export function CollabCredit({ className = 'logo-sub' }) {
  return (
    <span className={className}>
      {t('Ocorex')}<i className="collab-x">×</i>{t('Genesys Labs')}
    </span>
  );
}

export function LogoLockup({ compact = false }) {
  return (
    <div className="logo-lockup">
      <span className="logo-tile">
        <Logo size={26} />
      </span>
      {!compact && (
        <span className="logo-word">
          {t('Uma')}<CollabCredit />
        </span>
      )}
    </div>
  );
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  className = '',
  ...props
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <Loader2 size={15} className="spin" /> : Icon ? <Icon size={15} strokeWidth={1.8} /> : null}
      {children ? <span>{children}</span> : null}
      {IconRight ? <IconRight size={14} strokeWidth={1.8} /> : null}
    </button>
  );
}

export function IconButton({ label, icon: Icon, className = '', ...props }) {
  return (
    <button type="button" className={`icon-btn ${className}`} title={label} aria-label={label} {...props}>
      <Icon size={16} strokeWidth={1.8} />
    </button>
  );
}

export function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'is-on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Progress({ value = 0, tone = 'ember', small = false }) {
  return (
    <div className={`progress ${small ? 'progress-small' : ''}`} role="progressbar" aria-valuenow={Math.round(value)}>
      <span className={`progress-fill tone-${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Spinner({ size = 15 }) {
  return <Loader2 size={size} className="spin" />;
}

export function Modal({ open, onClose, title, eyebrow, children, footer, width = 480, className = '' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className={`modal-card ${className}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h3>{title}</h3>
          </div>
          <IconButton label={t('Close')} icon={X} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SectionLabel({ children, action }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty">
      {Icon && (
        <span className="empty-icon">
          <Icon size={22} strokeWidth={1.5} />
        </span>
      )}
      <h4>{title}</h4>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** "12 Nov 2026, 18:22" in the app's language. */
export function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

/** "2 hours ago", "yesterday", "3 days ago" in the app's language. */
export function formatAgo(iso) {
  if (!iso) return '';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const steps = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  try {
    const relative = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
    for (const [unit, size] of steps) {
      if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    }
    return t('just now');
  } catch {
    return '';
  }
}

export function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return t('just now');
  if (diff < 3_600_000) return t('{0}m', [Math.floor(diff / 60_000)]);
  if (diff < 86_400_000) return t('{0}h', [Math.floor(diff / 3_600_000)]);
  if (diff < 7 * 86_400_000) return t('{0}d', [Math.floor(diff / 86_400_000)]);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function groupThreads(conversations) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = { Today: [], Yesterday: [], 'Previous 7 days': [], Older: [] };
  for (const thread of conversations) {
    const time = new Date(thread.updatedAt || thread.createdAt).getTime();
    if (time >= startOfToday) groups.Today.push(thread);
    else if (time >= startOfToday - 86_400_000) groups.Yesterday.push(thread);
    else if (time >= startOfToday - 7 * 86_400_000) groups['Previous 7 days'].push(thread);
    else groups.Older.push(thread);
  }
  return groups;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useLatest(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

export function SettingRow({ title, description, children, icon: Icon, danger = false }) {
  return (
    <div className={`setting-row ${danger ? 'is-danger' : ''}`}>
      {Icon && <span className="setting-icon"><Icon size={17} strokeWidth={1.6} /></span>}
      <div className="setting-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
