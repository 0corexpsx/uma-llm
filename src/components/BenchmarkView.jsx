import React, { useMemo } from 'react';
import {
  Activity, AlertCircle, ArrowRight, BarChart3, Boxes, Check, CircleStop, Cpu,
  Gauge, HardDrive, Layers, MemoryStick, Play, RefreshCw, Server, Timer, Trash2,
  Zap,
} from 'lucide-react';
import { Button, SectionLabel, Progress, formatBytes, formatRelative } from './ui.jsx';
import { t, tj } from '../i18n.js';

function number(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits).replace(/\.0$/, '');
}

function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function deviceLabel(device) {
  if (!device) return t('Unknown');
  const backend = ({ vulkan: 'Vulkan', cuda: 'CUDA', metal: 'Metal', rocm: 'ROCm', cpu: 'CPU' })[device.backend] || device.backend || 'llama.cpp';
  if (device.mode === 'GPU') {
    if (device.offloadedLayers != null && device.totalLayers) {
      return t('GPU · {0}/{1} layers', [device.offloadedLayers, device.totalLayers]);
    }
    return `GPU · ${backend}`;
  }
  return `CPU · ${backend}`;
}

function MetricCard({ icon: Icon, label, value, sub, tone = '' }) {
  return (
    <div className={`bench-metric ${tone}`}>
      <span className="bench-metric-icon"><Icon size={15} strokeWidth={1.6} /></span>
      <span className="bench-metric-label">{label}</span>
      <strong>{value}</strong>
      {sub && <em>{sub}</em>}
    </div>
  );
}

function LiveBench({ progress, onCancel }) {
  const sample = progress.sample || {};
  const measuring = progress.phase === 'measuring';
  const percent = progress.percent || 0;
  return (
    <section className="bench-live">
      <div className="bench-live-head">
        <span className="bench-pulse"><Activity size={17} /></span>
        <div>
          <strong>{progress.message || t('Running benchmark…')}</strong>
          <span>{progress.phase} · {t('{0} elapsed', [duration(progress.elapsedMs)])}</span>
        </div>
        <Button size="sm" variant="ghost" icon={CircleStop} onClick={onCancel}>{t('Cancel')}</Button>
      </div>
      <Progress value={percent} />
      <div className="bench-live-metrics">
        <div><span><Cpu size={12} />{' '}{t('CPU')}</span><strong>{measuring ? `${number(sample.cpuPercent)}%` : '—'}</strong><em>{measuring && sample.coresUsed != null ? t('{0} cores', [number(sample.coresUsed, 2)]) : t('sampling')}</em></div>
        <div><span><MemoryStick size={12} />{' '}{t('AI process')}</span><strong>{measuring && sample.processMB ? `${sample.processMB} MB` : '—'}</strong><em>{t('working set')}</em></div>
        <div><span><Gauge size={12} />{' '}{t('GPU')}</span><strong>{progress.device?.mode === 'CPU' ? t('CPU mode') : measuring && sample.gpuUtil != null ? `${sample.gpuUtil}%` : '—'}</strong><em>{progress.device?.mode === 'CPU' ? t('not used') : sample.vramUsedMB ? t('{0} MB VRAM', [sample.vramUsedMB]) : 'nvidia-smi'}</em></div>
        <div><span><Server size={12} />{' '}{t('System RAM')}</span><strong>{sample.systemUsedGB ? `${sample.systemUsedGB} GB` : '—'}</strong><em>{t('in use')}</em></div>
      </div>
    </section>
  );
}

function ResultPanel({ result, onRun }) {
  const speed = result.speed || {};
  const memory = result.memory || {};
  const device = result.device || {};
  const model = result.model || {};
  const isGpu = device.mode === 'GPU';
  const gpuMax = Math.max(device.gpuUtilPeak || 0, 1);
  return (
    <section className="bench-result">
      <div className="bench-result-head">
        <div>
          <div className="eyebrow">{t('Result · {0}', [new Date(result.createdAt).toLocaleString()])}</div>
          <h1>{number(speed.tokensPerSecond)} <span>{t('tok/s')}</span></h1>
          <p>{model.name} · {model.quant} · {formatBytes(model.size)}</p>
        </div>
        <div className={`bench-device-badge ${isGpu ? 'is-gpu' : 'is-cpu'}`}>
          {isGpu ? <Zap size={17} /> : <Cpu size={17} />}
          <span>{deviceLabel(device)}</span>
        </div>
      </div>

      <div className="bench-primary-metrics">
        <MetricCard icon={Zap} label={t('Generation')} value={`${number(speed.tokensPerSecond)} tok/s`} sub={t('{0} tokens', [speed.generationTokens || 0])} tone="accent" />
        <MetricCard icon={Layers} label={t('Prompt eval')} value={`${number(speed.promptTokensPerSecond)} tok/s`} sub={t('{0} prompt tokens', [speed.promptTokens || 0])} />
        <MetricCard icon={Timer} label={t('First token')} value={speed.firstTokenMs ? `${speed.firstTokenMs} ms` : '—'} sub={t('latency')} />
        <MetricCard icon={Activity} label={t('Total run')} value={duration(speed.totalMs)} sub={speed.loadMs ? t('load {0}', [duration(speed.loadMs)]) : t('load warm')} />
      </div>

      <div className="bench-detail-grid">
        <div className="bench-detail-card">
          <SectionLabel>{t('Compute')}</SectionLabel>
          <div className="bench-kv"><span>{t('Device')}</span><strong>{device.mode || t('Unknown')}</strong></div>
          <div className="bench-kv"><span>{t('Backend')}</span><strong>{device.backend || '—'}</strong></div>
          <div className="bench-kv"><span>{t('GPU')}</span><strong>{device.gpuName || '—'}</strong></div>
          <div className="bench-kv"><span>{t('Offloaded layers')}</span><strong>{device.offloadedLayers != null ? `${device.offloadedLayers} / ${device.totalLayers || '?'}` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('GPU utilization')}</span><strong>{device.mode === 'CPU' ? t('not used — CPU mode') : device.gpuUtilAvg != null ? t('{0}% avg · {1}% peak', [number(device.gpuUtilAvg), number(device.gpuUtilPeak)]) : t('not available')}</strong></div>
          {device.gpuUtilPeak != null && (
            <div className="bench-gpu-bar"><span style={{ width: `${Math.min(100, (device.gpuUtilPeak / gpuMax) * 100)}%` }} /></div>
          )}
        </div>

        <div className="bench-detail-card">
          <SectionLabel>{t('Memory & CPU')}</SectionLabel>
          <div className="bench-kv"><span>{t('AI process peak')}</span><strong>{memory.processPeakMB ? `${memory.processPeakMB} MB` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('AI process avg')}</span><strong>{memory.processAvgMB ? `${memory.processAvgMB} MB` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('CPU average')}</span><strong>{memory.cpuAvgPercent != null ? t('{0}% · {1} cores', [number(memory.cpuAvgPercent), number(memory.coresUsedAvg, 2)]) : '—'}</strong></div>
          <div className="bench-kv"><span>{t('CPU peak')}</span><strong>{memory.cpuPeakPercent != null ? `${number(memory.cpuPeakPercent)}%` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('System RAM peak')}</span><strong>{memory.systemPeakGB ? `${number(memory.systemPeakGB)} / ${number(memory.systemTotalGB)} GB` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('VRAM peak')}</span><strong>{device.mode === 'CPU' ? t('not used') : device.vramUsedPeakMB ? t('{0} MB (GPU total)', [device.vramUsedPeakMB]) : t('not sampled')}</strong></div>
        </div>

        <div className="bench-detail-card">
          <SectionLabel>{t('Test setup')}</SectionLabel>
          <div className="bench-kv"><span>{t('Model')}</span><strong>{model.name || '—'}</strong></div>
          <div className="bench-kv"><span>{t('Quantization')}</span><strong>{model.quant || '—'}</strong></div>
          <div className="bench-kv"><span>{t('Context')}</span><strong>{(speed.contextSize || 0) ? `${(speed.contextSize / 1024).toFixed(0)}k` : '—'}</strong></div>
          <div className="bench-kv"><span>{t('Generated')}</span><strong>{t('{0} token cap', [speed.maxTokens || 128])}</strong></div>
          <div className="bench-kv"><span>{t('Warmup')}</span><strong>{speed.warmupMs ? duration(speed.warmupMs) : '—'}</strong></div>
          <div className="bench-kv"><span>{t('Model load')}</span><strong>{speed.loadMs ? duration(speed.loadMs) : t('already warm')}</strong></div>
        </div>
      </div>

      <div className="bench-result-foot">
        <span><Check size={13} />{' '}{t('Measured locally · no cloud round trip')}</span>
        <Button size="sm" variant="secondary" icon={RefreshCw} onClick={onRun}>{t('Run it again')}</Button>
      </div>
    </section>
  );
}

export default function BenchmarkView({ boot, progress, history = [], onRun, onCancel, onClear, onOpenModels, onOpenSettings }) {
  const running = progress && ['starting', 'loading', 'warming', 'probing', 'measuring'].includes(progress.phase);
  const result = progress?.result || (progress?.phase === 'done' ? null : (running ? null : history[0]));
  const latest = history[0];
  const canRun = Boolean(boot.activeModel && boot.runtime.installed) && !running;
  const modelLabel = boot.activeModel?.name || t('No model selected');

  const runHistory = useMemo(() => history.slice(0, 8), [history]);

  return (
    <div className="benchmark-view">
      <header className="view-header benchmark-header">
        <div>
          <div className="eyebrow">{t('Benchmark')}</div>
          <h2>{t('Benchmark')}</h2>
        </div>
        <div className="benchmark-header-actions">
          {history.length > 0 && !running && (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => {
              if (window.confirm(t('Clear all benchmark history?'))) onClear();
            }}>{t('Clear history')}</Button>
          )}
          {running ? (
            <Button size="sm" variant="secondary" icon={CircleStop} onClick={onCancel}>{t('Cancel')}</Button>
          ) : (
            <Button size="sm" variant="primary" icon={Play} onClick={onRun} disabled={!canRun}>{t('Run benchmark')}</Button>
          )}
        </div>
      </header>

      <div className="benchmark-scroll">
        <section className="bench-hero">
          <div className="bench-hero-copy">
            <div className="eyebrow">{t('Know your machine')}</div>
            <h1>{t('How fast is your local AI,')}<br /><em>{t('really?')}</em></h1>
            <p>
              {t('A real 128-token generation through the active model. Uma measures prompt speed, generation speed, first-token latency, the llama-server CPU and RAM, and — when a supported GPU is present — utilization and VRAM.')}
            </p>
            <div className="bench-hero-actions">
              <Button variant="primary" size="lg" icon={running ? CircleStop : Play} onClick={running ? onCancel : onRun} disabled={!running && !canRun}>
                {running ? t('Cancel benchmark') : t('Run benchmark')}
              </Button>
              <span className="bench-hero-hint">{boot.activeModel ? t('{0} · {1}k context', [modelLabel, (boot.settings.contextSize / 1024).toFixed(0)]) : t('Choose a model first')}</span>
            </div>
          </div>
          <div className="bench-hero-gauge">
            <div className="gauge-ring gauge-ring-1" />
            <div className="gauge-ring gauge-ring-2" />
            <div className="gauge-needle" />
            <span className="gauge-core"><Gauge size={36} strokeWidth={1.2} /></span>
            <span className="gauge-label">{t('tok/s')}</span>
          </div>
        </section>

        {!boot.runtime.installed || !boot.activeModel ? (
          <div className="bench-setup-required">
            <span className="bench-empty-icon"><Boxes size={24} strokeWidth={1.4} /></span>
            <h2>{t('A model and engine are needed first')}</h2>
            <p>{t('Download a GGUF model and install the local llama.cpp engine, then come back to measure it.')}</p>
            <div className="bench-empty-actions">
              <Button variant="primary" onClick={onOpenModels}>{t('Open Models')}{' '}<ArrowRight size={14} /></Button>
              {!boot.runtime.installed && <Button variant="ghost" onClick={onOpenSettings}>{t('Engine settings')}</Button>}
            </div>
          </div>
        ) : running ? (
          <LiveBench progress={progress} onCancel={onCancel} />
        ) : progress?.phase === 'error' ? (
          <div className="inline-error"><AlertCircle size={16} /><span>{progress.message}</span></div>
        ) : progress?.phase === 'cancelled' ? (
          <div className="bench-cancelled"><CircleStop size={15} />{' '}{t('Benchmark cancelled. The model remains loaded.')}</div>
        ) : result ? (
          <ResultPanel result={result} onRun={onRun} />
        ) : (
          <section className="bench-empty-state">
            <span className="bench-empty-icon"><BarChart3 size={25} strokeWidth={1.4} /></span>
            <h2>{t('No measurements yet.')}</h2>
            <p>{t('Run the first benchmark to see what this model does on this exact machine.')}</p>
            <Button variant="primary" icon={Play} onClick={onRun} disabled={!canRun}>{t('Run the first benchmark')}</Button>
          </section>
        )}

        {runHistory.length > 0 && (
          <section className="bench-history">
            <div className="bench-history-head">
              <div>
                <SectionLabel>{t('Run history')}</SectionLabel>
                <p>{t('Stored locally in Uma\'s app data.')}</p>
              </div>
            </div>
            <div className="bench-table">
              <div className="bench-table-head">
                <span>{t('When')}</span><span>{t('Model')}</span><span>{t('Device')}</span><span>{t('Speed')}</span><span>{t('First token')}</span><span>{t('AI RAM')}</span>
              </div>
              {runHistory.map((run) => (
                <div className="bench-table-row" key={run.id}>
                  <span>{formatRelative(run.createdAt)}</span>
                  <span>{run.model?.name || '—'}</span>
                  <span className={run.device?.mode === 'GPU' ? 'is-gpu' : 'is-cpu'}>{run.device?.mode || '—'}</span>
                  <strong>{number(run.speed?.tokensPerSecond)}{' '}{t('tok/s')}</strong>
                  <span>{run.speed?.firstTokenMs ? `${run.speed.firstTokenMs} ms` : '—'}</span>
                  <span>{run.memory?.processPeakMB ? `${run.memory.processPeakMB} MB` : '—'}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="bench-method">
          <div className="bench-method-icon"><Activity size={18} /></div>
          <div>
            <h3>{t('How the numbers are measured')}</h3>
            <p>
              {tj('The benchmark warms the model, performs a short first-token probe, then generates a fixed 128-token response with prompt caching off. Speed comes from llama.cpp\'s own timings. CPU and working-set memory are sampled from the {server} process; GPU utilization and VRAM come from {smi}. A cold model load is reported separately. The test is local and takes roughly 10–30 seconds.', {
                server: <code>llama-server</code>,
                smi: <code>nvidia-smi</code>,
              })}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
