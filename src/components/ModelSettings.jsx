import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, RotateCcw } from 'lucide-react';
import { api } from '../api.js';
import { Button, Field, Modal, Spinner, Toggle, formatBytes } from './ui.jsx';
import { t } from '../i18n.js';

const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];

function SliderField({ label, hint, value, min, max, step = 1, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <div className="mset-slider">
        <input type="range" min={min} max={max} step={step} value={Math.min(value, max)} onChange={(event) => onChange(Number(event.target.value))} />
        <input className="input" type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
      </div>
    </Field>
  );
}

function NumberField({ label, hint, value, step = 1, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" type="number" step={step} value={value} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
  );
}

/** The choices for "Graphics cards used": each card alone, and cards of the same kind together. */
function cardChoices(cards) {
  const short = (name) => String(name || '').replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
  const choices = cards.map((card) => ({ value: card.name, label: `${card.name} · ${short(card.card)}` }));
  const kinds = new Map();
  for (const card of cards) kinds.set(card.card, [...(kinds.get(card.card) || []), card.name]);
  for (const [kind, names] of kinds) {
    if (names.length > 1 && names.length < cards.length) choices.push({ value: names.join(','), label: `${names.join(' + ')} · ${names.length}× ${short(kind)}` });
  }
  return choices;
}

function SelectField({ label, hint, value, options, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </Field>
  );
}

/** The memory meter, shared with the Hugging Face version picker. */
export function MemoryEstimate({ estimate, hardware, loading }) {
  if (!estimate) return <div className="mset-memory is-empty">{loading ? <Spinner size={14} /> : null}{' '}{t('Estimating memory…')}</div>;
  const vram = (hardware?.vramGB || 0) * 1024 ** 3;
  const percent = vram ? Math.min(100, (estimate.gpuBytes / vram) * 100) : 0;
  return (
    <div className={`mset-memory fit-${estimate.fit}`}>
      <div className="mset-memory-top">
        <strong>{t('Estimated memory')}</strong>
        <span>{t('GPU')}{' '}<b>{formatBytes(estimate.gpuBytes)}</b></span>
        <span>{t('Total')}{' '}<b>{formatBytes(estimate.totalBytes)}</b></span>
        {loading && <Spinner size={13} />}
      </div>
      {vram > 0 && (
        <div className="mset-meter" title={t('{0} of {1} VRAM', [formatBytes(estimate.gpuBytes), formatBytes(vram)])}>
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <p>
        {estimate.fit === 'good' ? <Check size={13} /> : estimate.fit === 'unknown' ? null : <AlertTriangle size={13} />}
        {estimate.message} {t('{0}/{1} layers on GPU, {2} context cache.', [estimate.gpuLayers, estimate.maxLayers, formatBytes(estimate.kvBytes)])}
      </p>
    </div>
  );
}

export default function ModelSettings({ modelId, hardware, onClose, onSaved, showToast }) {
  const [details, setDetails] = useState(null);
  const [form, setForm] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const [tuning, setTuning] = useState(null);
  const [tuned, setTuned] = useState(null);

  useEffect(() => api.onTuneProgress?.((progress) => { if (progress.id === modelId) setTuning(progress.done ? null : progress); }), [modelId]);

  const tuneNow = async () => {
    setError('');
    setTuning({ step: 0, total: 3 });
    try {
      setTuned(await api.tuneBatch(modelId));
      showToast?.(t('Batch size measured'), 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setTuning(null);
    }
  };

  useEffect(() => {
    if (!modelId) return;
    setDetails(null);
    setForm(null);
    setError('');
    api.modelDetails(modelId).then((data) => {
      setDetails(data);
      setForm(data.settings);
      setEstimate(data.estimate);
    }).catch((err) => setError(err.message));
  }, [modelId]);

  useEffect(() => {
    if (!form || !details) return undefined;
    const request = ++latest.current;
    setEstimating(true);
    const timer = setTimeout(() => {
      api.estimateModel(modelId, form).then((next) => {
        if (request === latest.current) {
          setEstimate(next);
          setError('');
        }
      }).catch((err) => {
        if (request === latest.current) setError(err.message);
      }).finally(() => {
        if (request === latest.current) setEstimating(false);
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [form]);

  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

  const runVision = async (action, closes = false) => {
    setError('');
    try {
      const result = await action();
      await onSaved?.();
      if (closes) {
        showToast?.(result?.repo && result.match && result.match !== 'own'
          ? t('Downloading a compatible vision file from {0}. Progress shows on this page.', [result.repo])
          : t('Downloading the vision file. Progress shows on this page.'), 'success');
        onClose();
      } else if (result !== false) {
        const data = await api.modelDetails(modelId);
        setDetails(data);
        setEstimate(data.estimate);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const save = async (values) => {
    setSaving(true);
    setError('');
    try {
      // Only what differs from the defaults is stored, so later default changes still apply.
      const overrides = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== details.defaults[key]));
      await api.saveModelSettings(modelId, overrides);
      await onSaved?.();
      showToast?.(t('Model settings saved. They apply the next time it loads.'), 'success');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const contextMax = details?.info?.contextLength || 262144;
  const quantizedV = form && !['f16', 'f32', 'bf16'].includes(form.cacheTypeV);
  const gpuAuto = form && (form.gpuLayers === undefined || form.gpuLayers === '');

  return (
    <Modal
      open={Boolean(modelId)}
      onClose={onClose}
      title={details?.model?.name || t('Model settings')}
      eyebrow={t('Model settings')}
      width={720}
      className="mset-modal"
      footer={form && (
        <>
          <Button variant="ghost" icon={RotateCcw} onClick={() => save({})} disabled={saving}>{t('Reset to defaults')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" onClick={() => save(form)} loading={saving}>{t('Save')}</Button>
        </>
      )}
    >
      {error && <div className="modal-error">{error}</div>}
      {!form && !error && <div className="mset-loading"><Spinner size={16} />{' '}{t('Reading the model file…')}</div>}
      {form && (
        <div className="mset-body">
          <MemoryEstimate estimate={estimate} hardware={hardware} loading={estimating} />
          {estimate?.suggestedLayers > 0 && estimate.fit === 'too-big' && !gpuAuto && (
            <Button size="xs" variant="secondary" onClick={() => set('gpuLayers')(estimate.suggestedLayers)}>
              {t('Use the {0} GPU layers that fit', [estimate.suggestedLayers])}
            </Button>
          )}

          <h4>{t('Vision')}</h4>
          <div className="mset-vision">
            {details.model.mmproj ? (
              <>
                <span><Check size={13} />{' '}{t('This model can see images ({0} vision file).', [formatBytes(details.model.mmproj.size)])}{details.model.mmproj.from ? ` ${t('From {0}.', [details.model.mmproj.from])}` : ''}</span>
                <Button size="xs" variant="ghost" onClick={() => runVision(() => api.removeVision(modelId))}>{t('Remove')}</Button>
              </>
            ) : (
              <>
                <span>{t('No vision file, so this model cannot see images.')}</span>
                <Button size="xs" variant="secondary" onClick={() => runVision(() => api.downloadVision(modelId), true)}>{t('Download vision file')}</Button>
                <Button size="xs" variant="ghost" onClick={() => runVision(() => api.importVision(modelId))}>{t('Choose file')}</Button>
              </>
            )}
          </div>

          <h4>{t('Loading')}</h4>
          <SliderField
            label={t('Context Length')}
            hint={t('How much conversation and file text it can hold. This model supports up to {0} tokens. Uses the most memory of any setting here.', [contextMax.toLocaleString()])}
            value={form.contextSize}
            min={1024}
            max={contextMax}
            step={1024}
            onChange={set('contextSize')}
          />
          {gpuAuto ? (
            <Field label={t('GPU Offload')} hint={t('Automatic: the engine fits as many layers as free VRAM allows, about {0} of {1} now.', [estimate?.gpuLayers ?? '…', details.info.nLayer + 1])}>
              <Button size="xs" variant="secondary" onClick={() => set('gpuLayers')(estimate?.gpuLayers ?? details.info.nLayer + 1)}>{t('Set manually')}</Button>
            </Field>
          ) : (
            <>
              <SliderField
                label={t('GPU Offload')}
                hint={t('Layers to run on the GPU, of {0}. Layers left on the CPU run much slower.', [details.info.nLayer + 1])}
                value={Math.min(form.gpuLayers, details.info.nLayer + 1)}
                min={0}
                max={details.info.nLayer + 1}
                onChange={set('gpuLayers')}
              />
              <Button size="xs" variant="ghost" onClick={() => set('gpuLayers')(undefined)}>{t('Back to automatic')}</Button>
            </>
          )}
          <SliderField label={t('CPU Thread Pool Size')} hint={t('Threads for generation, of {0} on this PC.', [details.cpuCount])} value={form.threads} min={1} max={details.cpuCount} onChange={set('threads')} />
          <div className="mset-grid">
            <NumberField label={t('Evaluation Batch Size')} hint={t('Logical maximum batch.')} value={form.batchSize} onChange={set('batchSize')} />
            <NumberField label={t('Physical Batch Size')} hint={t('Higher reads prompts faster and uses more memory.')} value={form.ubatchSize} onChange={set('ubatchSize')} />
            <Field
              label={t('Batch size tuning')}
              hint={t('auto: Uma measures how fast each reply reads its new text and picks the Physical Batch Size by itself (512, 1024 or 2048) for this model with your helper PCs. It learns over a few replies, or right now with the button. A size you set by hand above is used as it is.')}
            >
              <div className="mset-tuning">
                <select className="select" value={form.batchTuning || 'auto'} onChange={(event) => set('batchTuning')(event.target.value)}>
                  <option value="auto">auto</option>
                  <option value="off">off</option>
                </select>
                <Button size="xs" variant="secondary" loading={Boolean(tuning)} onClick={tuneNow}>
                  {tuning?.size ? t('Measuring {0} ({1} of {2})…', [tuning.size, tuning.step, tuning.total]) : t('Tune now')}
                </Button>
              </div>
              <div className="mset-tuning-result">
                {(tuned || details.batchTuning)?.sizes.map((item) => (
                  <span key={item.size} className={(tuned || details.batchTuning).best === item.size && item.measured ? 'is-best' : ''}>
                    {item.size}: {item.failed ? t('does not fit') : item.replies ? `${item.tokensPerSecond} ${t('tok/s')}${item.measured ? '' : ` (${t('still measuring')})`}` : t('not measured yet')}
                  </span>
                ))}
                {details.batchTuning?.byHand && <em>{t('Set by hand: tuning is not used.')}</em>}
              </div>
            </Field>
            <NumberField label={t('Max Concurrent Predictions')} hint={t('Uma sends one at a time, so keep this at 1. Without a unified cache, more splits the context.')} value={form.parallel} onChange={set('parallel')} />
            <NumberField label={t('Context Checkpoints')} hint={t('Snapshots of the model state, so a retry or an edited message is not read again from the start. Each one uses memory and chat memory space (about 150 MB on a 27B model); 8 is enough for normal use.')} value={form.ctxCheckpoints} onChange={set('ctxCheckpoints')} />
            <NumberField label={t('Auto Unload If Idle (minutes)')} hint={t('0 keeps it loaded.')} value={form.idleMinutes} onChange={set('idleMinutes')} />
            <SelectField label={t('MoE expert cache')} hint={t('For mixture-of-experts models (such as Qwen3 30B-A3B or Qwen3.8 Flash Next) that do not fit on the GPU: the experts stay in RAM and the GPU keeps the most used ones, which is usually much faster than the usual split. auto turns it on only when the model does not fit.')} value={form.moeCache || 'auto'} options={['auto', 'off']} onChange={set('moeCache')} />
            <SelectField label={t('Model Loading')} hint={t('auto memory-maps the file when it can. mmap+mlock also keeps the model in RAM, so the system cannot push it out between messages: try it when the first words of each reply are slow, and only with enough RAM for the part of the model that is not on a GPU.')} value={form.loadMode} options={['auto', 'mmap', 'mmap+mlock', 'none']} onChange={set('loadMode')} />
          </div>

          <h4>{t('Speed')}</h4>
          {details.cards?.length > 1 && (
            <div className="mset-grid">
              <Field label={t('Graphics cards used')} hint={t('A model that fits on one card is usually faster on that card alone than shared between several. “Optimize and benchmark” in Benchmark measures this and chooses for you.')}>
                <select className="select" value={form.gpuCards || ''} onChange={(event) => set('gpuCards')(event.target.value)}>
                  <option value="">{t('All cards')}</option>
                  {cardChoices(details.cards).map((choice) => <option value={choice.value} key={choice.value}>{choice.label}</option>)}
                  {form.gpuCards && !cardChoices(details.cards).some((choice) => choice.value === form.gpuCards) && <option value={form.gpuCards}>{form.gpuCards}</option>}
                </select>
              </Field>
              <SelectField label={t('Split between graphics cards')} hint={t('Only for a PC with several graphics cards. auto and layer: each card holds some layers and they work one after the other. tensor (experimental in llama.cpp): the cards work at the same time, which was faster for a model too large for one card (9.0 instead of 6.7 tok/s for a 27B model on an RTX 3060 and two Tesla P40) and no faster for a small one. row does not work with NVIDIA cards. Go back to auto if the model does not load.')} value={form.splitMode || 'auto'} options={['auto', 'layer', 'tensor', 'row']} onChange={set('splitMode')} />
            </div>
          )}
          <div className="mset-grid">
            {details.info?.mtpLayers > 0 && (
              <SelectField label={t('Guess ahead with the model’s own head (MTP)')} hint={t('This model has a small head of its own that guesses the next words, and the model checks them in one step: the same text, written faster (12.6 to 25.5 tok/s on a 27B model), with nothing to download. auto uses it when the engine can. A draft model chosen below is used instead.')} value={form.mtp || 'auto'} options={['auto', 'off']} onChange={set('mtp')} />
            )}
            <SelectField label={t('Guess repeated text (n-gram)')} hint={t('When the model writes text that is already in the chat, such as a file written again with a small change, the engine guesses the repeated part and the model only checks it: the same text, several times faster there. New text is written at the usual speed. auto turns it on when the engine can.')} value={form.ngram || 'auto'} options={['auto', 'off']} onChange={set('ngram')} />
          </div>
          <Field
            label={t('Draft model')}
            hint={t('A small model of the same family guesses the next words, and this model checks several at once, so answers are written faster. With a helper PC connected, it runs on the helper’s GPU, which otherwise waits most of the time. The speed line under each reply shows how many guesses were kept.')}
          >
            {details.draftCandidates?.length > 0 ? (
              <select className="select" value={form.draftModelId || ''} onChange={(event) => set('draftModelId')(event.target.value)}>
                <option value="">{t('Off')}</option>
                {details.draftCandidates.map((item) => (
                  <option value={item.id} key={item.id}>{`${item.name} · ${formatBytes(item.size)}`}</option>
                ))}
              </select>
            ) : details.draftSuggestion ? (
              <div className="mset-draft-empty">
                <span>{t('No installed model can draft for this one yet.')}</span>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      await api.downloadDraftModel(details.info.tokenizer?.pre);
                      showToast?.(t('Downloading {0}. When it is done, open these settings again and choose it here.', [details.draftSuggestion.name]), 'success');
                      onClose?.();
                    } catch (err) {
                      showToast?.(err.message, 'error');
                    }
                  }}
                >
                  {t('Download {0} ({1})', [details.draftSuggestion.name, formatBytes(details.draftSuggestion.sizeBytes)])}
                </Button>
              </div>
            ) : (
              <span className="mset-draft-empty">{t('No installed model uses the same vocabulary as this one.')}</span>
            )}
          </Field>
          {form.draftModelId && details.draftCandidates?.some((item) => item.id === form.draftModelId) && (
            <div className="mset-grid">
              <NumberField label={t('Words guessed ahead')} hint={t('More helps when most guesses are kept. 4 to 8 is usual.')} value={form.draftTokens} onChange={set('draftTokens')} />
            </div>
          )}

          <h4>{t('Memory cache')}{' '}<span className="mini-badge">{t('Experimental')}</span></h4>
          <div className="mset-grid">
            <SelectField label={t('Flash Attention')} value={form.flashAttn} options={['auto', 'on', 'off']} onChange={set('flashAttn')} />
            <Field label={t('Unified KV Cache')} hint={t('Slots share one cache.')}>
              <Toggle checked={form.kvUnified} onChange={set('kvUnified')} label={t('Unified KV Cache')} />
            </Field>
            <SelectField label={t('K Cache Quantization')} hint={t('Smaller types use less memory but can lower quality.')} value={form.cacheTypeK} options={CACHE_TYPES} onChange={set('cacheTypeK')} />
            <SelectField label={t('V Cache Quantization')} value={form.cacheTypeV} options={CACHE_TYPES} onChange={set('cacheTypeV')} />
          </div>
          {quantizedV && form.flashAttn === 'off' && (
            <div className="callout warning"><AlertTriangle size={15} /><p>{t('A quantized V cache needs Flash Attention, so this may fail to load.')}</p></div>
          )}

          <h4>{t('Responses')}</h4>
          <div className="mset-grid">
            <NumberField label={t('Temperature')} hint={t('Lower is more focused.')} step={0.05} value={form.temperature} onChange={set('temperature')} />
            <NumberField label={t('Top P')} step={0.05} value={form.topP} onChange={set('topP')} />
            <NumberField label={t('Top K')} hint={t('0 turns it off.')} value={form.topK} onChange={set('topK')} />
            <NumberField label={t('Min P')} step={0.01} value={form.minP} onChange={set('minP')} />
            <NumberField label={t('Repeat Penalty')} hint={t('1 turns it off.')} step={0.05} value={form.repeatPenalty} onChange={set('repeatPenalty')} />
            <NumberField label={t('Seed')} hint={t('-1 is random.')} value={form.seed} onChange={set('seed')} />
            <NumberField label={t('Reasoning Budget')} hint={t('Tokens for thinking. -1 is unlimited, 0 is none.')} value={form.reasoningBudget} onChange={set('reasoningBudget')} />
          </div>
          <Field label={t('Reasoning Budget Message')} hint={t('Optional text given to the model when its thinking budget runs out.')}>
            <input className="input" value={form.reasoningBudgetMessage} onChange={(event) => set('reasoningBudgetMessage')(event.target.value)} />
          </Field>

          <h4>{t('Advanced')}</h4>
          <Field label={t('Extra llama-server arguments')} hint={t('Added to the command line, for anything not listed above. Uma keeps control of the model path, port, and key.')}>
            <input className="input" value={form.extraArgs} placeholder={t('--threads-http 4')} spellCheck={false} onChange={(event) => set('extraArgs')(event.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
