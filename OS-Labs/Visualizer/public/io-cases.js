(function (global) {
  "use strict";

  const clamp = (value, minimum, maximum, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.round(number))) : fallback;
  };

  class InterruptModel {
    constructor(options = {}) {
      this.period = clamp(options.period, 2, 12, 6);
      this.masked = Boolean(options.masked);
      this.tick = 0;
      this.instructions = 0;
      this.generated = 0;
      this.coalesced = 0;
      this.handled = 0;
      this.pending = false;
      this.phase = "user";
      this.returnInstruction = null;
      this.events = [];
    }

    get el() { return ["vector", "handler", "return"].includes(this.phase) ? 1 : 0; }
    get done() {
      return this.instructions >= 12 && this.generated >= 4 && this.phase === "user" && (this.masked || !this.pending);
    }

    step() {
      if (this.done) return;
      this.tick += 1;
      let signal = "";
      if (this.generated < 4 && this.tick % this.period === 0) {
        this.generated += 1;
        if (this.pending) this.coalesced += 1;
        this.pending = true;
        signal = `定时器第 ${this.generated} 次置位 IRQ；`;
      }
      let detail;
      switch (this.phase) {
        case "user":
          this.instructions += 1;
          detail = `用户指令 ${this.instructions} 完成`;
          if (this.pending && !this.masked) {
            this.phase = "pending";
            detail += "，在指令边界发现待处理中断";
          } else if (this.pending) detail += "，IRQ 被屏蔽，保持 pending";
          break;
        case "pending":
          this.returnInstruction = this.instructions + 1;
          this.phase = "vector";
          detail = "保存 ELR_EL1 / SPSR_EL1，跳转 EL1 IRQ 向量入口";
          break;
        case "vector":
          this.phase = "handler";
          this.pending = false;
          this.handled += 1;
          detail = "内核处理中断并确认定时器，清除 pending 状态";
          break;
        case "handler":
          this.phase = "return";
          detail = "恢复用户上下文，准备执行 eret";
          break;
        case "return":
          this.phase = "user";
          detail = `eret 返回 EL0，下一条用户指令为 ${this.returnInstruction}`;
          break;
      }
      this.events.push({ tick: this.tick, el: this.el, phase: this.phase, detail: signal + detail });
      if (this.events.length > 120) this.events.shift();
    }
  }

  class DMAComparisonModel {
    constructor(options = {}) {
      this.words = clamp(options.words, 4, 16, 8);
      this.burst = clamp(options.burst, 1, 4, 2);
      this.source = Array.from({ length: this.words }, (_, index) => 0x41 + index);
      this.cpuMemory = Array(this.words).fill(null);
      this.dmaMemory = Array(this.words).fill(null);
      this.tick = 0;
      this.cpuCopied = 0;
      this.dmaCopied = 0;
      this.cpuBusy = 0;
      this.dmaBusy = 0;
      this.cpuUseful = 0;
      this.dmaUseful = 0;
      this.cpuDoneAt = null;
      this.dmaDoneAt = null;
      this.phase = "descriptor";
      this.lastIndices = [];
      this.events = [];
    }

    get done() { return this.cpuDoneAt !== null && this.dmaDoneAt !== null; }

    step() {
      if (this.done) return;
      this.tick += 1;
      this.lastIndices = [];
      let cpuAction;
      if (this.cpuCopied < this.words) {
        this.cpuMemory[this.cpuCopied] = this.source[this.cpuCopied];
        this.cpuCopied += 1;
        this.cpuBusy += 1;
        cpuAction = `CPU 复制第 ${this.cpuCopied} 个字`;
        if (this.cpuCopied === this.words) this.cpuDoneAt = this.tick;
      } else {
        this.cpuUseful += 1;
        cpuAction = "复制已完成，CPU 执行其他工作";
      }
      let dmaAction;
      switch (this.phase) {
        case "descriptor":
          this.dmaBusy += 1;
          this.phase = "doorbell";
          dmaAction = `CPU 设置源、目标和长度 ${this.words} 的 DMA 描述符`;
          break;
        case "doorbell":
          this.dmaBusy += 1;
          this.phase = "transfer";
          dmaAction = "CPU 写启动寄存器，DMA 控制器开始工作";
          break;
        case "transfer": {
          this.dmaUseful += 1;
          const count = Math.min(this.burst, this.words - this.dmaCopied);
          for (let index = 0; index < count; index += 1) {
            this.lastIndices.push(this.dmaCopied);
            this.dmaMemory[this.dmaCopied] = this.source[this.dmaCopied];
            this.dmaCopied += 1;
          }
          dmaAction = `DMA 搬运 ${count} 个字；CPU 同时执行其他工作`;
          if (this.dmaCopied === this.words) this.phase = "irq";
          break;
        }
        case "irq":
          this.dmaBusy += 1;
          this.phase = "done";
          this.dmaDoneAt = this.tick;
          dmaAction = "DMA 发出完成 IRQ，CPU 确认中断并取得缓冲区";
          break;
        case "done":
          this.dmaUseful += 1;
          dmaAction = "DMA 已完成，CPU 继续其他工作";
          break;
      }
      this.events.push({ tick: this.tick, cpu: cpuAction, dma: dmaAction });
      if (this.events.length > 80) this.events.shift();
    }
  }

  class PollingComparisonModel {
    constructor(options = {}) {
      this.delay = clamp(options.delay, 2, 12, 6);
      this.words = 4;
      this.tick = 0;
      this.ready = false;
      this.pollChecks = 0;
      this.irqChecks = 0;
      this.pollBusy = 0;
      this.irqBusy = 0;
      this.pollUseful = 0;
      this.irqUseful = 0;
      this.pollCopied = 0;
      this.irqCopied = 0;
      this.pollPhase = "waiting";
      this.irqPhase = "waiting";
      this.pollDoneAt = null;
      this.irqDoneAt = null;
      this.events = [];
    }

    get done() { return this.pollPhase === "done" && this.irqPhase === "done"; }

    step() {
      if (this.done) return;
      this.tick += 1;
      this.ready = this.tick >= this.delay;
      let pollAction;
      if (this.pollPhase === "waiting") {
        this.pollChecks += 1;
        this.pollBusy += 1;
        pollAction = `第 ${this.pollChecks} 次读取设备状态：${this.ready ? "READY" : "BUSY"}`;
        if (this.ready) this.pollPhase = "copy";
      } else if (this.pollPhase === "copy") {
        this.pollCopied += 1;
        this.pollBusy += 1;
        pollAction = `CPU 读取设备数据，第 ${this.pollCopied} / ${this.words} 个字`;
        if (this.pollCopied === this.words) {
          this.pollPhase = "done";
          this.pollDoneAt = this.tick;
        }
      } else {
        this.pollUseful += 1;
        pollAction = "数据已接收，CPU 执行其他工作";
      }
      let irqAction;
      if (this.irqPhase === "waiting") {
        if (this.ready) {
          this.irqBusy += 1;
          this.irqPhase = "handler";
          irqAction = "设备 READY，发出中断，CPU 进入 IRQ 向量";
        } else {
          this.irqUseful += 1;
          irqAction = "CPU 执行其他工作，设备独立准备数据";
        }
      } else if (this.irqPhase === "handler") {
        this.irqChecks += 1;
        this.irqBusy += 1;
        this.irqPhase = "copy";
        irqAction = "处理 IRQ，读取并确认设备 READY 状态";
      } else if (this.irqPhase === "copy") {
        this.irqCopied += 1;
        this.irqBusy += 1;
        irqAction = `CPU 读取设备数据，第 ${this.irqCopied} / ${this.words} 个字`;
        if (this.irqCopied === this.words) {
          this.irqPhase = "done";
          this.irqDoneAt = this.tick;
        }
      } else {
        this.irqUseful += 1;
        irqAction = "数据已接收，CPU 执行其他工作";
      }
      this.events.push({ tick: this.tick, poll: pollAction, irq: irqAction });
      if (this.events.length > 80) this.events.shift();
    }
  }

  global.OSModels = Object.assign(global.OSModels || {}, { InterruptModel, DMAComparisonModel, PollingComparisonModel });
  if (!global.document || !global.OSDemo) return;

  const { mount, icon, player } = global.OSDemo;
  const $ = (selector) => document.querySelector(selector);
  const controls = (prefix, settings) => `<div class="case-controls">${settings}<span class="settings-spacer"></span><span class="scheduler-time">t = <b id="${prefix}-tick">0</b></span><button id="${prefix}-reset" class="icon-button" title="重新开始" aria-label="重新开始">${icon("rotate-ccw")}</button><button id="${prefix}-step" class="icon-button" title="执行下一步" aria-label="执行下一步">${icon("skip-forward")}</button><button id="${prefix}-play" class="icon-button io-play-button" title="运行模型" aria-label="运行模型">${icon("play")}</button><label class="case-speed">速度<select id="${prefix}-speed" aria-label="播放速度"><option value="1200">0.5×</option><option value="600" selected>1×</option><option value="300">2×</option></select></label></div>`;
  const stat = (name, value) => `<div><dt>${name}</dt><dd>${value}</dd></div>`;
  const phaseTitle = { user: "用户程序", pending: "IRQ 待处理", vector: "IRQ 向量入口", handler: "中断处理", return: "准备 eret", descriptor: "CPU 配置描述符", doorbell: "CPU 启动 DMA", transfer: "DMA 搬运 / CPU 并行工作", irq: "完成中断等待 CPU 确认", done: "传输完成", waiting: "等待设备", copy: "CPU 搬运数据" };

  function tableRows(selector, events, fields) {
    const target = $(selector);
    const fragment = document.createDocumentFragment();
    events.slice(-60).forEach((event) => {
      const row = document.createElement("tr");
      fields.forEach((field) => {
        const cell = document.createElement("td");
        cell.textContent = typeof field === "function" ? field(event) : event[field] ?? "--";
        row.append(cell);
      });
      fragment.append(row);
    });
    target.replaceChildren(fragment);
  }

  function memoryWords(values, transferred, active = []) {
    return values.map((value, index) => `<div class="io-memory-word ${index < transferred ? "written" : ""} ${active.includes(index) ? "active" : ""}"><small>[${index}]</small><code>${value === null ? "--" : value.toString(16).toUpperCase().padStart(2, "0")}</code></div>`).join("");
  }

  mount("interrupts", {
    number: "04",
    title: "中断与异常返回",
    subtitle: "定时器 IRQ / EL0 → EL1 → EL0",
    sourceNote: "教学模型：4 次周期定时信号；真实中断记录单独采集",
    body: `${controls("irq", `<label>定时周期<input id="irq-period" type="number" min="2" max="12" value="6"><span>ticks</span></label><label class="checkbox-label"><input id="irq-masked" type="checkbox">屏蔽 IRQ（DAIF.I）</label>`)}
      <div class="case-grid"><div>
        <div class="section-heading"><h2>异常处理路径</h2><span id="irq-mode" class="mode-pill">EL0 用户态</span></div>
        <div class="case-stage io-irq-stage"><div class="io-irq-device"><span>定时器设备</span><b id="irq-device">下次触发 t = 6</b><div class="io-signal-line" id="irq-signal"><span>IRQ</span></div></div><div id="irq-path" class="io-irq-path"></div></div>
        <div class="case-status" id="irq-detail" role="status" aria-live="polite">用户程序开始执行，设备定时器独立计时。</div>
        <div class="section-heading"><h2>模型事件</h2><span class="mini-label">1 STEP / 1 TICK</span></div>
        <div class="event-table-wrap"><table class="case-log event-table"><thead><tr><th>tick</th><th>级别</th><th>执行现场</th></tr></thead><tbody id="irq-events"></tbody></table></div>
      </div><aside>
        <div class="section-heading"><h2>CPU 与设备</h2><span class="mini-label">MODEL</span></div><dl id="irq-stats" class="case-stats"></dl>
        <p class="case-note">定时器不需要用户程序执行 svc。IRQ 到达后，CPU 在指令边界保存返回现场，进入 EL1；eret 恢复 EL0。处理期间，IRQ 被硬件屏蔽。</p>
        <p class="case-note">这里用一个 pending 位表示设备中断请求。多个触发可合并为一个请求，事件次数不等于处理次数；真实定时器的重装与确认时序由内核驱动决定。</p>
      </aside></div>
      <div class="io-real-region"><div class="section-heading"><h2>内核定时器实测</h2><button id="irq-capture" class="primary-button">${icon("circle-dot")}<span>采样中断</span></button></div><div class="evidence-bar"><span class="evidence-badge">QEMU + GDB</span><span id="irq-real-status" role="status" aria-live="polite">尚未采集内核中断现场</span></div><div class="event-table-wrap"><table class="case-log event-table"><thead><tr><th>事件</th><th>级别</th><th>PC</th><th>指令 / 说明</th></tr></thead><tbody id="irq-real-events"></tbody></table></div></div>`
  });

  let irqModel;
  function resetIRQ() {
    irqModel = new InterruptModel({ period: $("#irq-period").value, masked: $("#irq-masked").checked });
    $("#irq-period").value = irqModel.period;
  }
  resetIRQ();
  function renderIRQ() {
    $("#irq-tick").textContent = irqModel.tick;
    $("#irq-mode").textContent = `EL${irqModel.el} ${irqModel.el ? "内核态" : "用户态"}`;
    $("#irq-mode").classList.toggle("kernel", irqModel.el === 1);
    $("#irq-device").textContent = irqModel.generated === 4 ? "4 次信号已触发" : `下次触发 t = ${(irqModel.generated + 1) * irqModel.period}`;
    $("#irq-signal").classList.toggle("active", irqModel.pending);
    $("#irq-path").innerHTML = ["user", "pending", "vector", "handler", "return"].map((phase) => `<div class="io-irq-phase ${irqModel.phase === phase ? "active" : ""} ${["vector", "handler", "return"].includes(phase) ? "kernel" : ""}"><span class="io-phase-dot"></span><b>${phaseTitle[phase]}</b><small>${["vector", "handler", "return"].includes(phase) ? "EL1" : "EL0"}</small></div>`).join("");
    $("#irq-detail").textContent = irqModel.events.at(-1)?.detail || "用户程序开始执行，设备定时器独立计时。";
    $("#irq-stats").innerHTML = stat("用户指令完成", `${irqModel.instructions} 条`) + stat("定时器触发", `${irqModel.generated} / 4`) + stat("中断已处理", irqModel.handled) + stat("触发合并", irqModel.coalesced) + stat("IRQ pending", irqModel.pending ? "1 · 待确认" : "0") + stat("当前 IRQ 屏蔽", irqModel.masked || irqModel.el === 1 ? "I = 1" : "I = 0") + stat("保存的返回位置", irqModel.returnInstruction === null ? "未进入 IRQ" : `用户指令 ${irqModel.returnInstruction}`) + stat("运行状态", irqModel.done ? irqModel.pending ? "结束 · IRQ 仍待处理" : "观察完成" : phaseTitle[irqModel.phase]);
    tableRows("#irq-events", irqModel.events, ["tick", (event) => `EL${event.el}`, "detail"]);
  }
  const irqPlayer = player("irq", { step: () => irqModel.step(), reset: resetIRQ, done: () => irqModel.done, render: renderIRQ });
  ["#irq-period", "#irq-masked"].forEach((selector) => $(selector).addEventListener("change", () => irqPlayer.reset()));

  let realBusy = false;
  let realVisible = false;
  let realLoaded = false;
  let realLoading = false;
  let realTimer = null;
  async function fetchJSON(path, options) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || data.message || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function drawRealTrace(data) {
    const trace = data.trace || data;
    if (!Array.isArray(trace.events) || !trace.events.length) throw new Error("中断采样记录中没有事件");
    tableRows("#irq-real-events", trace.events, ["label", (event) => `EL${event.el}`, "pc", (event) => [event.instruction, event.detail].filter(Boolean).join(" · ")]);
    const source = trace.source === "qemu-gdb" ? "QEMU + GDB 实测" : trace.source === "recorded-qemu-gdb" ? "已保存的 QEMU + GDB 实测" : "执行记录";
    realLoaded = true;
    return `${source} · ${trace.events.length} 个事件`;
  }
  async function loadRealTrace() {
    if (realLoading) return;
    realLoading = true;
    try {
      const data = await fetchJSON("/api/trace/last?case=interrupt");
      if (!realBusy) $("#irq-real-status").textContent = drawRealTrace(data);
    } catch (error) {
      if (!realBusy && error.status !== 404) $("#irq-real-status").textContent = error.message;
    } finally { realLoading = false; }
  }
  function realFinished(message) {
    realBusy = false;
    clearTimeout(realTimer);
    realTimer = null;
    $("#irq-capture").disabled = false;
    $("#irq-capture span").textContent = "采样中断";
    $("#irq-real-status").textContent = message;
  }
  async function pollInterruptCapture() {
    clearTimeout(realTimer);
    realTimer = null;
    try {
      const status = await fetchJSON("/api/status");
      $("#irq-real-status").textContent = status.message || "QEMU + GDB 正在采集 IRQ 现场";
      if (status.state === "capturing") {
        if (realVisible) realTimer = setTimeout(pollInterruptCapture, 1100);
      } else if (status.state === "ready") {
        if (status.case !== "interrupt") {
          realFinished("采样器已完成其他案例，未产生新的中断记录");
          return;
        }
        const data = await fetchJSON("/api/trace/last?case=interrupt");
        realFinished(drawRealTrace(data));
      } else if (status.state === "error") realFinished(status.error || status.message || "中断采样失败");
      else realFinished(status.message || "采样尚未启动，请重试");
    } catch (error) { realFinished(error.message); }
  }
  $("#irq-capture").addEventListener("click", async () => {
    if (realBusy) return;
    realBusy = true;
    $("#irq-capture").disabled = true;
    $("#irq-capture span").textContent = "采样中";
    $("#irq-real-status").textContent = "正在启动 QEMU + GDB";
    try {
      await fetchJSON("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case: "interrupt" }) });
      await pollInterruptCapture();
    } catch (error) { realFinished(error.message); }
  });

  mount("dma", {
    number: "09",
    title: "DMA 与 CPU 复制",
    subtitle: "描述符配置 / 设备搬运 / 完成中断",
    sourceNote: "教学模型：两种传输方式并列运行；没有接入真实 DMA 驱动",
    body: `${controls("dma", `<label>传输长度<input id="dma-words" type="number" min="4" max="16" value="8"><span>字</span></label><label>DMA 突发量<select id="dma-burst"><option value="1">1 字 / tick</option><option value="2" selected>2 字 / tick</option><option value="3">3 字 / tick</option><option value="4">4 字 / tick</option></select></label>`)}
      <div class="case-grid"><div>
        <div class="section-heading"><h2>设备源缓冲区</h2><span class="mini-label">SOURCE</span></div><div id="dma-source" class="case-memory-grid io-memory-grid"></div>
        <div class="io-dma-comparison"><div class="io-dma-column"><div class="section-heading"><h2>CPU 逐字复制</h2><span id="dma-cpu-state" class="mode-pill">待开始</span></div><div class="case-stage io-transfer-stage"><div class="io-bus-node cpu">CPU</div><div class="io-transfer-path"><span>CPU 读取 → CPU 写入</span><div id="dma-cpu-progress" class="io-transfer-progress"><span></span></div></div><div class="io-bus-node memory">内存</div></div><div id="dma-cpu-memory" class="case-memory-grid io-memory-grid"></div></div>
        <div class="io-dma-column"><div class="section-heading"><h2>DMA 控制器搬运</h2><span id="dma-device-state" class="mode-pill">配置描述符</span></div><div class="case-stage io-transfer-stage"><div class="io-bus-node device">DMA</div><div class="io-transfer-path"><span>设备直接读写总线</span><div id="dma-device-progress" class="io-transfer-progress"><span></span></div></div><div class="io-bus-node memory">内存</div></div><div id="dma-device-memory" class="case-memory-grid io-memory-grid"></div></div></div>
        <div class="case-row io-dma-cpu-work"><span>DMA 方案中的 CPU</span><b id="dma-cpu-work">配置描述符</b><span id="dma-irq" class="case-token">完成 IRQ 未触发</span></div>
        <div class="section-heading"><h2>并行执行记录</h2><span class="mini-label">同一时间尺度</span></div><div class="event-table-wrap"><table class="case-log event-table"><thead><tr><th>tick</th><th>CPU 复制方案</th><th>DMA 方案</th></tr></thead><tbody id="dma-events"></tbody></table></div>
      </div><aside><div class="section-heading"><h2>CPU 开销对比</h2><span class="mini-label">TICKS</span></div><dl id="dma-stats" class="case-stats"></dl><p class="case-note">CPU 复制每个字都需要 CPU 参与。DMA 方案由 CPU 配置和启动，随后设备负责搬运，CPU 可以继续其他工作；完成后通过 IRQ 通知 CPU。</p><p class="case-note">模型中配置、启动和确认 IRQ 各占 1 tick。小传输不一定更快。这里未模拟总线竞争、地址映射、缓存维护和内存一致性，字数与耗时不代表硬件性能。</p></aside></div>`
  });
  let dmaModel;
  function resetDMA() {
    dmaModel = new DMAComparisonModel({ words: $("#dma-words").value, burst: $("#dma-burst").value });
    $("#dma-words").value = dmaModel.words;
    $("#dma-burst").value = dmaModel.burst;
  }
  resetDMA();
  function renderDMA() {
    $("#dma-tick").textContent = dmaModel.tick;
    $("#dma-source").innerHTML = memoryWords(dmaModel.source, dmaModel.words);
    $("#dma-cpu-memory").innerHTML = memoryWords(dmaModel.cpuMemory, dmaModel.cpuCopied, dmaModel.cpuCopied ? [dmaModel.cpuCopied - 1] : []);
    $("#dma-device-memory").innerHTML = memoryWords(dmaModel.dmaMemory, dmaModel.dmaCopied, dmaModel.lastIndices);
    $("#dma-cpu-progress span").style.width = `${dmaModel.cpuCopied / dmaModel.words * 100}%`;
    $("#dma-device-progress span").style.width = `${dmaModel.dmaCopied / dmaModel.words * 100}%`;
    $("#dma-cpu-state").textContent = dmaModel.cpuDoneAt === null ? `${dmaModel.cpuCopied} / ${dmaModel.words}` : "复制完成";
    $("#dma-device-state").textContent = dmaModel.phase === "irq" ? "IRQ 待确认" : dmaModel.phase === "done" ? "传输完成" : `${dmaModel.dmaCopied} / ${dmaModel.words}`;
    $("#dma-cpu-work").textContent = ["transfer", "done"].includes(dmaModel.phase) ? "可执行其他工作" : dmaModel.phase === "irq" ? "即将处理完成中断" : phaseTitle[dmaModel.phase];
    $("#dma-irq").textContent = dmaModel.phase === "irq" ? "完成 IRQ 待确认" : dmaModel.phase === "done" ? "完成 IRQ 已确认" : "完成 IRQ 未触发";
    $("#dma-irq").classList.toggle("kernel", dmaModel.phase === "irq");
    $("#dma-stats").innerHTML = stat("CPU 复制占用", `${dmaModel.cpuBusy} ticks`) + stat("DMA 的 CPU 占用", `${dmaModel.dmaBusy} ticks`) + stat("CPU 复制其他工作", `${dmaModel.cpuUseful} ticks`) + stat("DMA 的其他工作", `${dmaModel.dmaUseful} ticks`) + stat("CPU 复制完成", dmaModel.cpuDoneAt === null ? "等待" : `t = ${dmaModel.cpuDoneAt}`) + stat("DMA 确认完成", dmaModel.dmaDoneAt === null ? "等待" : `t = ${dmaModel.dmaDoneAt}`) + stat("DMA 搬运", `${dmaModel.dmaCopied} / ${dmaModel.words} 字`);
    tableRows("#dma-events", dmaModel.events, ["tick", "cpu", "dma"]);
  }
  const dmaPlayer = player("dma", { step: () => dmaModel.step(), reset: resetDMA, done: () => dmaModel.done, render: renderDMA });
  ["#dma-words", "#dma-burst"].forEach((selector) => $(selector).addEventListener("change", () => dmaPlayer.reset()));

  mount("polling", {
    number: "08",
    title: "程序查询与中断 I/O",
    subtitle: "轮询设备状态 / 设备主动通知",
    sourceNote: "教学模型：同一设备准备时间、同一传输长度；非硬件 I/O 实测",
    body: `${controls("poll", `<label>设备准备时间<input id="poll-delay" type="number" min="2" max="12" value="6"><span>ticks</span></label><span class="mini-label">传输 4 个字</span>`)}
      <div class="case-grid"><div><div class="section-heading"><h2>设备与 CPU</h2><span id="poll-device-status" class="mode-pill">设备 BUSY</span></div>
        <div class="case-stage io-polling-stage"><div class="io-polling-lane"><div class="io-lane-label"><b>程序查询</b><small>CPU 主动检查</small></div><div id="poll-cpu" class="io-cpu-state"></div><div class="io-direction">CPU → 状态寄存器</div><div id="poll-device" class="io-device-state"></div></div><div class="io-polling-lane"><div class="io-lane-label"><b>中断 I/O</b><small>设备主动通知</small></div><div id="poll-irq-cpu" class="io-cpu-state"></div><div class="io-direction">设备 → IRQ → CPU</div><div id="poll-irq-device" class="io-device-state"></div></div></div>
        <div class="case-status" id="poll-detail" role="status" aria-live="polite">设备准备数据时，查询方案占用 CPU，中断方案允许 CPU 做其他工作。</div>
        <div class="section-heading"><h2>两种方式逐步对比</h2><span class="mini-label">CPU 负责实际数据搬运</span></div><div class="event-table-wrap"><table class="case-log event-table"><thead><tr><th>tick</th><th>程序查询</th><th>中断 I/O</th></tr></thead><tbody id="poll-events"></tbody></table></div>
      </div><aside><div class="section-heading"><h2>等待开销</h2><span class="mini-label">MODEL</span></div><dl id="poll-stats" class="case-stats"></dl><p class="case-note">程序查询反复读取设备状态，设备就绪后读取数据。中断 I/O 在等待期间释放 CPU 时间，但增加中断进入和确认开销。</p><p class="case-note">两种方式的数据搬运仍由 CPU 执行。DMA 才将搬运交给设备控制器。这里每次状态查询、每个字的复制、IRQ 进入和确认各计 1 tick。</p></aside></div>`
  });
  let pollModel;
  function resetPolling() {
    pollModel = new PollingComparisonModel({ delay: $("#poll-delay").value });
    $("#poll-delay").value = pollModel.delay;
  }
  resetPolling();
  function renderPolling() {
    $("#poll-tick").textContent = pollModel.tick;
    $("#poll-device-status").textContent = pollModel.ready ? "设备 READY" : "设备 BUSY";
    $("#poll-cpu").innerHTML = `<b>${pollModel.pollPhase === "waiting" ? "读取设备状态" : phaseTitle[pollModel.pollPhase]}</b><small>状态读取 ${pollModel.pollChecks} 次 / 已搬运 ${pollModel.pollCopied} 字</small>`;
    $("#poll-irq-cpu").innerHTML = `<b>${pollModel.irqPhase === "waiting" ? "执行其他工作" : pollModel.irqPhase === "handler" ? "进入 IRQ / 准备确认" : phaseTitle[pollModel.irqPhase]}</b><small>状态读取 ${pollModel.irqChecks} 次 / 已搬运 ${pollModel.irqCopied} 字</small>`;
    ["#poll-device", "#poll-irq-device"].forEach((selector) => { $(selector).innerHTML = `<b>${pollModel.ready ? "READY" : "BUSY"}</b><small>${pollModel.ready ? "数据已准备" : `t = ${pollModel.delay} 就绪`}</small>`; $(selector).classList.toggle("ready", pollModel.ready); });
    $("#poll-detail").textContent = pollModel.done ? "两种方式均接收完 4 个字；等待开销与完成时间见对比。" : pollModel.events.at(-1) ? `程序查询：${pollModel.events.at(-1).poll}。中断 I/O：${pollModel.events.at(-1).irq}。` : "设备准备数据时，查询方案占用 CPU，中断方案允许 CPU 做其他工作。";
    $("#poll-stats").innerHTML = stat("程序查询状态读取", `${pollModel.pollChecks} 次`) + stat("中断方式状态读取", `${pollModel.irqChecks} 次`) + stat("查询方案 CPU 占用", `${pollModel.pollBusy} ticks`) + stat("中断方案 CPU 占用", `${pollModel.irqBusy} ticks`) + stat("查询方案其他工作", `${pollModel.pollUseful} ticks`) + stat("中断方案其他工作", `${pollModel.irqUseful} ticks`) + stat("查询完成时间", pollModel.pollDoneAt === null ? "等待" : `t = ${pollModel.pollDoneAt}`) + stat("中断完成时间", pollModel.irqDoneAt === null ? "等待" : `t = ${pollModel.irqDoneAt}`);
    tableRows("#poll-events", pollModel.events, ["tick", "poll", "irq"]);
  }
  const pollingPlayer = player("poll", { step: () => pollModel.step(), reset: resetPolling, done: () => pollModel.done, render: renderPolling });
  $("#poll-delay").addEventListener("change", () => pollingPlayer.reset());

  global.ChCoreCases = Object.assign(global.ChCoreCases || {}, {
    interrupts: { title: "中断", onEnter() { realVisible = true; if (realBusy && !realTimer) pollInterruptCapture(); else if (!realBusy && !realLoaded) loadRealTrace(); }, onLeave() { irqPlayer.pause(); realVisible = false; clearTimeout(realTimer); realTimer = null; } },
    dma: { title: "DMA", onLeave() { dmaPlayer.pause(); } },
    polling: { title: "程序查询", onLeave() { pollingPlayer.pause(); } }
  });
})(typeof window === "undefined" ? globalThis : window);
