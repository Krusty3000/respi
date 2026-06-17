(() => {
  const presetSelect = document.getElementById("preset");
  const customFields = document.getElementById("customFields");
  const inhaleInput = document.getElementById("inhale");
  const holdInput = document.getElementById("hold");
  const exhaleInput = document.getElementById("exhale");
  const hold2Input = document.getElementById("hold2");
  const durationSelect = document.getElementById("duration");
  const soundToggle = document.getElementById("soundToggle");

  const circle = document.getElementById("circle");
  const phaseText = document.getElementById("phaseText");
  const cycleCount = document.getElementById("cycleCount");
  const timeRemainingEl = document.getElementById("timeRemaining");
  const cyclesValueEl = document.getElementById("cyclesValue");

  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const resetBtn = document.getElementById("resetBtn");

  const PRESETS = {
    "365": { inhale: 5, hold: 0, exhale: 5 },
    "46": { inhale: 4, hold: 0, exhale: 6 },
    "478": { inhale: 4, hold: 7, exhale: 8 },
  };

  let audioCtx = null;
  let sessionDuration = Number(durationSelect.value);
  let phases = [];
  let cycleDuration = 0;
  let totalCycles = 0;

  let tickHandle = null;
  let elapsedMs = 0;
  let lastTickAt = 0;
  let running = false;
  let currentPhaseIndex = -1;
  let currentCycle = 0;
  let wakeLock = null;

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (err) {
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch (err) {
        /* already released */
      }
      wakeLock = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && running && !wakeLock) {
      requestWakeLock();
    }
  });

  const DEFAULT_PAUSE = 0.25;

  function getActiveDurations() {
    if (presetSelect.value === "custom") {
      const hold = Math.max(0, Number(holdInput.value) || 0);
      const hold2 = Math.max(0, Number(hold2Input.value) || 0);
      return {
        inhale: Math.max(1, Number(inhaleInput.value) || 1),
        hold: hold > 0 ? hold : DEFAULT_PAUSE,
        exhale: Math.max(1, Number(exhaleInput.value) || 1),
        hold2: hold2 > 0 ? hold2 : DEFAULT_PAUSE,
      };
    }
    return PRESETS[presetSelect.value];
  }

  function buildPhases() {
    const { inhale, hold, exhale, hold2 = 0 } = getActiveDurations();
    const list = [{ name: "inhale", duration: inhale, label: "Inspirez" }];
    if (hold > 0) list.push({ name: "hold", duration: hold, label: "Pause" });
    list.push({ name: "exhale", duration: exhale, label: "Expirez" });
    if (hold2 > 0) list.push({ name: "hold2", duration: hold2, label: "Pause" });
    return list;
  }

  function recompute() {
    phases = buildPhases();
    cycleDuration = phases.reduce((sum, p) => sum + p.duration, 0);
    sessionDuration = Math.max(1, Number(durationSelect.value) || 5) * 60;
    totalCycles = Math.max(1, Math.floor(sessionDuration / cycleDuration));
    if (!running) {
      formatTime(sessionDuration);
      cyclesValueEl.textContent = `0 / ${totalCycles}`;
    }
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = String(Math.floor(s / 60)).padStart(2, "0");
    const r = String(s % 60).padStart(2, "0");
    timeRemainingEl.textContent = `${m}:${r}`;
  }

  const NOISE_BASE_GAIN = 0.3;
  const NOISE_MIN_FACTOR = 0.1;

  let noiseSource = null;
  let noiseFilter = null;
  let noiseGain = null;

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function createBreathNoiseBuffer(ctx) {
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[i] = lastOut * 3.5;
    }
    return buffer;
  }

  function startNoise() {
    const ctx = ensureAudio();
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = createBreathNoiseBuffer(ctx);
    noiseSource.loop = true;
    noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 380;
    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseSource.start();
  }

  function stopNoise() {
    if (noiseSource) {
      try {
        noiseSource.stop();
      } catch (err) {
        /* already stopped */
      }
      noiseSource.disconnect();
      noiseSource = null;
    }
    if (noiseFilter) {
      noiseFilter.disconnect();
      noiseFilter = null;
    }
    if (noiseGain) {
      noiseGain.disconnect();
      noiseGain = null;
    }
  }

  function updateNoiseVolume(phase, timeIntoPhase) {
    if (!noiseGain) return;
    if (!soundToggle.checked) {
      noiseGain.gain.value = 0;
      return;
    }
    const t = Math.min(1, Math.max(0, timeIntoPhase / phase.duration));
    let factor;
    if (phase.name === "inhale" || phase.name === "exhale") {
      factor = NOISE_MIN_FACTOR + (1 - NOISE_MIN_FACTOR) * Math.sin(Math.PI * t);
    } else {
      factor = NOISE_MIN_FACTOR;
    }
    noiseGain.gain.value = NOISE_BASE_GAIN * factor;
  }

  function setPhaseVisual(phase) {
    circle.classList.remove("inhale", "hold", "exhale", "hold2");
    circle.classList.add(phase.name);
    phaseText.textContent = phase.label;
  }

  function totalElapsedAtCycleStart(cycle) {
    return cycle * cycleDuration;
  }

  function tick(now) {
    if (!running) return;
    const deltaMs = now - lastTickAt;
    lastTickAt = now;
    elapsedMs += deltaMs;

    const elapsedSec = elapsedMs / 1000;
    const remaining = sessionDuration - elapsedSec;

    if (remaining <= 0 || currentCycle >= totalCycles) {
      finishSession();
      return;
    }

    formatTime(remaining);

    const cycle = Math.floor(elapsedSec / cycleDuration);
    const timeIntoCycle = elapsedSec - totalElapsedAtCycleStart(cycle);

    let acc = 0;
    let phaseIdx = 0;
    for (let i = 0; i < phases.length; i++) {
      if (timeIntoCycle < acc + phases[i].duration) {
        phaseIdx = i;
        break;
      }
      acc += phases[i].duration;
    }

    if (cycle !== currentCycle) {
      currentCycle = cycle;
      cyclesValueEl.textContent = `${currentCycle} / ${totalCycles}`;
    }

    const globalPhaseKey = cycle * phases.length + phaseIdx;
    if (globalPhaseKey !== currentPhaseIndex) {
      currentPhaseIndex = globalPhaseKey;
      setPhaseVisual(phases[phaseIdx]);
    }

    const timeIntoPhase = timeIntoCycle - acc;
    updateNoiseVolume(phases[phaseIdx], timeIntoPhase);

    tickHandle = requestAnimationFrame(tick);
  }

  function finishSession() {
    running = false;
    releaseWakeLock();
    stopNoise();
    cyclesValueEl.textContent = `${totalCycles} / ${totalCycles}`;
    formatTime(0);
    phaseText.textContent = "Terminé";
    circle.classList.remove("inhale", "hold", "exhale", "hold2");
    startBtn.disabled = false;
    startBtn.textContent = "Recommencer";
    pauseBtn.disabled = true;
    resetBtn.disabled = false;
    setControlsDisabled(false);
  }

  function setControlsDisabled(disabled) {
    presetSelect.disabled = disabled;
    inhaleInput.disabled = disabled;
    holdInput.disabled = disabled;
    exhaleInput.disabled = disabled;
    hold2Input.disabled = disabled;
    durationSelect.disabled = disabled;
  }

  function start() {
    recompute();
    if (!running && elapsedMs === 0) {
      currentPhaseIndex = -1;
      currentCycle = 0;
    }
    running = true;
    lastTickAt = performance.now();
    startBtn.disabled = true;
    startBtn.textContent = "Commencer";
    pauseBtn.disabled = false;
    pauseBtn.textContent = "Pause";
    resetBtn.disabled = false;
    setControlsDisabled(true);
    requestWakeLock();
    startNoise();
    tickHandle = requestAnimationFrame(tick);
  }

  function pause() {
    running = false;
    if (tickHandle) cancelAnimationFrame(tickHandle);
    releaseWakeLock();
    stopNoise();
    pauseBtn.textContent = "Reprendre";
    pauseBtn.onclick = resume;
  }

  function resume() {
    running = true;
    lastTickAt = performance.now();
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = pause;
    requestWakeLock();
    startNoise();
    tickHandle = requestAnimationFrame(tick);
  }

  function reset() {
    running = false;
    if (tickHandle) cancelAnimationFrame(tickHandle);
    releaseWakeLock();
    stopNoise();
    elapsedMs = 0;
    currentPhaseIndex = -1;
    currentCycle = 0;
    circle.classList.remove("inhale", "hold", "exhale", "hold2");
    phaseText.textContent = "Prêt";
    recompute();
    startBtn.disabled = false;
    startBtn.textContent = "Commencer";
    pauseBtn.disabled = true;
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = pause;
    resetBtn.disabled = true;
    setControlsDisabled(false);
  }

  function onPresetChange() {
    customFields.classList.toggle("visible", presetSelect.value === "custom");
    recompute();
  }

  presetSelect.addEventListener("change", onPresetChange);
  [inhaleInput, holdInput, exhaleInput, hold2Input, durationSelect].forEach((el) =>
    el.addEventListener("change", recompute)
  );

  startBtn.addEventListener("click", start);
  pauseBtn.addEventListener("click", pause);
  resetBtn.addEventListener("click", reset);

  onPresetChange();
  recompute();
})();
