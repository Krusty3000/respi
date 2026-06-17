(() => {
  const presetSelect = document.getElementById("preset");
  const customFields = document.getElementById("customFields");
  const inhaleInput = document.getElementById("inhale");
  const holdInput = document.getElementById("hold");
  const exhaleInput = document.getElementById("exhale");
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

  function getActiveDurations() {
    if (presetSelect.value === "custom") {
      return {
        inhale: Math.max(1, Number(inhaleInput.value) || 1),
        hold: Math.max(0, Number(holdInput.value) || 0),
        exhale: Math.max(1, Number(exhaleInput.value) || 1),
      };
    }
    return PRESETS[presetSelect.value];
  }

  function buildPhases() {
    const { inhale, hold, exhale } = getActiveDurations();
    const list = [{ name: "inhale", duration: inhale, label: "Inspirez" }];
    if (hold > 0) list.push({ name: "hold", duration: hold, label: "Retenez" });
    list.push({ name: "exhale", duration: exhale, label: "Expirez" });
    return list;
  }

  function recompute() {
    phases = buildPhases();
    cycleDuration = phases.reduce((sum, p) => sum + p.duration, 0);
    sessionDuration = Number(durationSelect.value);
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

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function playTone(freq, durationMs) {
    if (!soundToggle.checked) return;
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  }

  function toneForPhase(name) {
    if (name === "inhale") playTone(440, 300);
    else if (name === "exhale") playTone(330, 300);
    else playTone(550, 200);
  }

  function setPhaseVisual(phase) {
    circle.classList.remove("inhale", "hold", "exhale");
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
      toneForPhase(phases[phaseIdx].name);
    }

    tickHandle = requestAnimationFrame(tick);
  }

  function finishSession() {
    running = false;
    releaseWakeLock();
    cyclesValueEl.textContent = `${totalCycles} / ${totalCycles}`;
    formatTime(0);
    phaseText.textContent = "Terminé";
    circle.classList.remove("inhale", "hold", "exhale");
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
    tickHandle = requestAnimationFrame(tick);
  }

  function pause() {
    running = false;
    if (tickHandle) cancelAnimationFrame(tickHandle);
    releaseWakeLock();
    pauseBtn.textContent = "Reprendre";
    pauseBtn.onclick = resume;
  }

  function resume() {
    running = true;
    lastTickAt = performance.now();
    pauseBtn.textContent = "Pause";
    pauseBtn.onclick = pause;
    requestWakeLock();
    tickHandle = requestAnimationFrame(tick);
  }

  function reset() {
    running = false;
    if (tickHandle) cancelAnimationFrame(tickHandle);
    releaseWakeLock();
    elapsedMs = 0;
    currentPhaseIndex = -1;
    currentCycle = 0;
    circle.classList.remove("inhale", "hold", "exhale");
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
  [inhaleInput, holdInput, exhaleInput, durationSelect].forEach((el) =>
    el.addEventListener("change", recompute)
  );

  startBtn.addEventListener("click", start);
  pauseBtn.addEventListener("click", pause);
  resetBtn.addEventListener("click", reset);

  onPresetChange();
  recompute();
})();
