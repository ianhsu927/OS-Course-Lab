"use strict";

(() => {
  window.ChCoreCases = window.ChCoreCases || {};
  window.OSModels = window.OSModels || {};
  const icon = name => `<svg aria-hidden="true"><use href="icons.svg#${name}"></use></svg>`;

  function mount(id, { number, title, subtitle, sourceNote, body }) {
    const host = document.getElementById(`view-${id}`);
    if (!host) throw new Error(`Missing case section: ${id}`);
    host.innerHTML = `<div class="page-heading"><div><div class="eyebrow">${number} / OS CASE STUDY</div><h1></h1><p class="page-subtitle"></p></div><span class="model-badge">教学模型</span></div><div class="evidence-bar"><span class="evidence-badge model">教学模型</span><span class="case-source"></span><span class="evidence-spacer"></span><span class="mini-status">离散步骤 · 非性能测量</span></div>${body}`;
    host.querySelector("h1").textContent = title;
    host.querySelector(".page-subtitle").textContent = subtitle;
    host.querySelector(".case-source").textContent = sourceNote;
    return host;
  }

  function player(prefix, { step, reset, done, render }) {
    const button = suffix => document.getElementById(`${prefix}-${suffix}`);
    let timer = null;
    const playButton = button("play");
    const stepButton = button("step");
    const resetButton = button("reset");
    const speedInput = button("speed");
    function playLabel(active) {
      const label = active ? "暂停" : "运行";
      return icon(active ? "pause" : "play") + (playButton?.matches(".icon-button, .play-button") ? "" : `<span>${label}</span>`);
    }
    function refresh() {
      render();
      const finished = done ? done() : false;
      if (finished && timer) pause();
      if (stepButton) stepButton.disabled = finished;
      if (playButton) {
        playButton.disabled = finished;
        playButton.innerHTML = playLabel(Boolean(timer));
        playButton.title = timer ? "暂停演示" : "运行演示";
        playButton.setAttribute("aria-label", playButton.title);
      }
    }
    function pause() {
      clearInterval(timer);
      timer = null;
      if (playButton) {
        playButton.innerHTML = playLabel(false);
        playButton.title = "运行演示";
        playButton.setAttribute("aria-label", playButton.title);
      }
    }
    function advance() {
      if (done && done()) { pause(); return; }
      step();
      refresh();
    }
    function play() {
      if (timer) { pause(); return; }
      if (done && done()) return;
      const delay = Math.max(80, Math.min(5000, Number(speedInput?.value) || 650));
      timer = setInterval(advance, delay);
      refresh();
    }
    function restart() { pause(); reset(); refresh(); }
    if (stepButton) stepButton.addEventListener("click", () => { pause(); advance(); });
    if (resetButton) resetButton.addEventListener("click", restart);
    if (playButton) playButton.addEventListener("click", play);
    if (speedInput) speedInput.addEventListener("change", () => { if (timer) { pause(); play(); } });
    refresh();
    return { pause, reset: restart, step: advance, play, refresh };
  }

  window.OSDemo = { icon, mount, player };
})();
