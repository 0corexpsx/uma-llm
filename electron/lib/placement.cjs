// Where a model's layers go when helper PCs take part, or when this PC has several graphics cards.
//
// llama.cpp's --fit fills the last device in its list first and gives the earlier ones what is left.
// Left alone, that fills this PC's GPU and leaves a helper's GPU half empty, and a helper's RAM is
// never used: layers that fit no GPU land in this PC's RAM. Uma steers --fit with the device order
// (-dev) and a free-memory margin per device (--fit-target):
// - If the model fits on the GPUs with room to spare, it is spread over them in proportion to their
//   free memory (-ts). Margins alone cannot do this: each GPU also needs a few hundred MB of work
//   buffers, and with a small model those outweigh its share, so --fit would move everything to the CPU.
// - If not, every GPU is filled, then the helpers' RAM (keeping a reserve for each helper), and
//   only what is left stays in this PC's RAM.

const GPU_MARGIN_MB = 512;
const DEFAULT_RAM_RESERVE_MB = 4096;
// Work buffers llama.cpp keeps on each GPU, besides the model's share.
const GPU_WORK_MB = 700;
// Fixed proportions are only used with this much room to spare: llama.cpp cannot adjust them, so a
// plan that does not fit fails to load (and Uma then retries with llama.cpp's own split).
const FIT_HEADROOM = 0.85;
// RAM this PC keeps for Windows, Uma and the engine's own buffers when it holds layers itself.
const MAIN_RAM_RESERVE_MB = 4096;

/** "  RPC0: 192.168.1.20:50052 (12288 MiB, 11020 MiB free)" lines from llama-server --list-devices. */
function parseDeviceList(text) {
  const devices = [];
  for (const match of String(text).matchAll(/^\s*(\w+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)/gm)) {
    devices.push({ name: match[1], description: match[2], totalMB: Number(match[3]), freeMB: Number(match[4]) });
  }
  return devices;
}

/**
 * Labels each device gpu or cpu and says which helper it belongs to. A helper lists its devices in
 * the order its info names them; a helper that does not say (an older Uma) is taken as GPUs only.
 */
function labelDevices(devices, helpers) {
  const seen = new Map();
  return devices.map((device) => {
    if (!/^RPC\d+$/.test(device.name)) {
      return { ...device, remote: false, kind: /^CPU/i.test(device.name) ? 'cpu' : 'gpu', reserveMB: 0 };
    }
    const helper = helpers.find((item) => item.address === device.description);
    const index = seen.get(device.description) || 0;
    seen.set(device.description, index + 1);
    const offered = helper?.info?.devices?.[index];
    const kind = offered?.kind === 'cpu' ? 'cpu' : 'gpu';
    return {
      ...device,
      remote: true,
      kind,
      label: helper?.label || device.description,
      // The helper says how much RAM it keeps for itself (less when it runs at full power); one
      // that does not say keeps the default.
      reserveMB: kind === 'cpu' ? (offered?.reserveMB > 0 ? Math.max(1024, offered.reserveMB) : DEFAULT_RAM_RESERVE_MB) : 0,
    };
  });
}

/**
 * The -dev order and --fit-target margins for llama-server. needMB is what the whole model needs on
 * GPUs (weights, cache, and work buffers), from the memory estimate; mainFreeRamMB is this PC's free
 * RAM. forceFill skips the balanced split (used to retry a balanced plan that did not load).
 * draftMB is room for a draft model (speculative decoding): it goes on the helper GPU with the most
 * free memory, which otherwise waits for the main PC most of the time, and the big model's share
 * of that GPU shrinks by as much. plan.draftDevice names where it goes.
 */
function planPlacement({ devices, helpers = [], needMB, mainFreeRamMB = 0, forceFill = false, draftMB = 0 }) {
  let labelled = labelDevices(devices, helpers).filter((device) => device.kind === 'gpu' || device.remote);
  let draftDevice = '';
  if (draftMB > 0) {
    const byFree = (a, b) => b.freeMB - a.freeMB;
    const candidates = labelled.filter((device) => device.kind === 'gpu' && device.freeMB - GPU_MARGIN_MB > draftMB);
    const chosen = [...candidates.filter((device) => device.remote).sort(byFree), ...candidates.filter((device) => !device.remote).sort(byFree)][0];
    if (chosen) {
      draftDevice = chosen.name;
      labelled = labelled.map((device) => (device === chosen ? { ...device, freeMB: device.freeMB - draftMB, draftMB } : device));
    }
  }
  const gpus = labelled.filter((device) => device.kind === 'gpu');
  const allHelperRam = labelled.filter((device) => device.kind === 'cpu');
  const usable = (device) => Math.max(0, device.freeMB - GPU_MARGIN_MB);
  const gpuRoom = gpus.reduce((sum, device) => sum + usable(device), 0);
  // --fit fills from the end of the list: this PC's GPUs last in the list, so they fill first in
  // fill mode, then the helpers' GPUs, then the helpers' RAM.
  const ordered = [...gpus.filter((device) => device.remote), ...gpus.filter((device) => !device.remote)];

  if (!forceFill && gpus.length > 1 && needMB > 0 && needMB + GPU_WORK_MB * gpus.length <= gpuRoom * FIT_HEADROOM) {
    const plan = ordered.map((device) => {
      const share = gpuRoom ? usable(device) / gpuRoom : 0;
      return { ...device, share, wantMB: Math.ceil(needMB * share), targetMB: GPU_MARGIN_MB + (device.draftMB || 0) };
    });
    return { mode: 'balanced', devices: plan, needMB, gpuRoomMB: gpuRoom, draftDevice };
  }

  // Layers that fit no GPU are computed by a CPU. A helper's CPU is the slow place for them: every
  // token then waits for it, with two more trips over the network, and its GPU sits idle meanwhile
  // (measured on a laptop helper: CPU at 95%, GPU at 10-30%). So those layers stay in this PC's RAM
  // when it has room, and a helper's RAM takes only what does not fit here. When this PC's free RAM
  // or the model's size is not known, the helpers' RAM is offered in full, as before.
  const leftoverMB = Math.max(0, needMB - gpuRoom);
  const ramHereMB = Math.max(0, mainFreeRamMB - MAIN_RAM_RESERVE_MB);
  const known = needMB > 0 && mainFreeRamMB > 0 && ordered.length > 0;
  let overflowMB = known ? Math.max(0, leftoverMB - ramHereMB) : Infinity;
  const helperRam = [];
  for (const device of allHelperRam) {
    const room = Math.max(0, device.freeMB - device.reserveMB);
    const takeMB = Math.min(room, overflowMB);
    if (takeMB <= 0) continue;
    overflowMB -= takeMB;
    // --fit-target is what must stay free on the device, so a smaller share means a larger margin.
    helperRam.push({ ...device, wantMB: Math.round(takeMB), targetMB: Math.round(device.freeMB - takeMB) });
  }

  const plan = [
    ...helperRam,
    // --fit-target is measured against what is free now, so the draft's room is added to the margin.
    ...ordered.map((device) => ({ ...device, wantMB: usable(device), targetMB: GPU_MARGIN_MB + (device.draftMB || 0) })),
  ];
  return {
    mode: 'fill',
    devices: plan,
    needMB,
    gpuRoomMB: gpuRoom,
    // For the log: what the CPUs must hold, and how much of it this PC's own RAM takes.
    leftoverMB: Math.round(leftoverMB),
    ramHereMB: known ? Math.round(Math.min(leftoverMB, ramHereMB)) : null,
    draftDevice,
  };
}

/** A card's name the way both nvidia-smi and llama.cpp write it, for comparing: "tesla p40". */
function cardKey(name) {
  return String(name || '').toLowerCase().replace(/\bnvidia\b|\bcorporation\b|\((?:r|tm)\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Which of this PC's graphics cards (their names, from nvidia-smi) the engine lists as devices.
 * `used` are the engine's devices for those cards, in the engine's order; `missing` are the cards
 * it does not list. An engine can leave a card out: a CUDA 13 build has no code for a Tesla P40 or
 * a GTX 10 card, and Vulkan cannot see a card that is in compute-only mode. A device that is none
 * of the cards (an integrated GPU) is left to llama.cpp, which uses one only when nothing else is there.
 */
function localCards(devices, names) {
  const cards = names.map((name) => ({ name, key: cardKey(name), taken: false }));
  const used = [];
  for (const device of devices) {
    if (/^(?:RPC|CPU)/i.test(device.name)) continue;
    const key = cardKey(device.description);
    const card = key && cards.find((item) => !item.taken && item.key && (item.key === key || key.includes(item.key) || item.key.includes(key)));
    if (!card) continue;
    card.taken = true;
    used.push({ ...device, card: card.name });
  }
  return { used, missing: cards.filter((card) => !card.taken).map((card) => card.name) };
}

/** llama-server arguments for a plan. */
function placementArgs(plan) {
  if (!plan?.devices.length) return [];
  const names = ['-dev', plan.devices.map((device) => device.name).join(',')];
  if (plan.mode === 'balanced') {
    // Whole-number proportions out of 100, as llama.cpp's -ts takes them.
    const targets = plan.devices.map((device) => device.targetMB);
    const margin = targets.every((target) => target === targets[0]) ? String(targets[0]) : targets.join(',');
    return [...names, '-ts', plan.devices.map((device) => Math.max(1, Math.round(device.share * 100))).join(','), '--fit-target', margin];
  }
  return [...names, '--fit-target', plan.devices.map((device) => device.targetMB).join(',')];
}

module.exports = { planPlacement, placementArgs, parseDeviceList, labelDevices, localCards, GPU_MARGIN_MB, DEFAULT_RAM_RESERVE_MB };
