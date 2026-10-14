"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { trace: null, index: 0, playback: null, polling: null, captureBusy: false, view: "syscall" };
const icon = (name) => `<svg aria-hidden="true"><use href="icons.svg#${name}"></use></svg>`;
const missing = "未采样";
const mono = (value) => value === null || value === undefined || value === "" ? missing : String(value);

function captureTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date) + " 北京时间";
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = mono(content);
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）`);
  return data;
}

function showTraceError(message) {
  const banner = $("#trace-error");
  banner.hidden = !message;
  banner.querySelector("span").textContent = message || "";
}

function setView(view, updateHash = true) {
  if (!["syscall", "memory", "scheduler"].includes(view) && !window.ChCoreCases?.[view]) view = "syscall";
  if (state.view !== view) window.ChCoreCases?.[state.view]?.onLeave?.();
  state.view = view;
  $$(".view").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#breadcrumb-current").textContent = { syscall: "系统调用", memory: "启动页表", scheduler: "轮转调度" }[view] || window.ChCoreCases[view].title;
  $("#case-select").value = view;
  window.ChCoreCases?.[view]?.onEnter?.();
  if (view !== "syscall") stopPlayback();
  if (view !== "scheduler") stopScheduler();
  if (view === "memory" && !$("#page-walk").children.length) walkAddress();
  if (updateHash) history.replaceState(null, "", `#${view}`);
}

function stopPlayback() {
  clearInterval(state.playback);
  state.playback = null;
  $("#play-trace").innerHTML = icon("play");
  $("#play-trace").setAttribute("aria-label", "播放记录");
  $("#play-trace").title = "播放记录";
}

function startPlayback() {
  if (!state.trace || state.trace.events.length < 2) return;
  if (state.playback) { stopPlayback(); return; }
  if (state.index === state.trace.events.length - 1) selectEvent(0);
  $("#play-trace").innerHTML = icon("pause");
  $("#play-trace").setAttribute("aria-label", "暂停回放");
  $("#play-trace").title = "暂停回放";
  state.playback = setInterval(() => {
    selectEvent(state.index + 1);
    if (state.index >= state.trace.events.length - 1) stopPlayback();
  }, Number($("#playback-speed").value));
}

function eventCoordinates(event, index, count) {
  return { x: count === 1 ? 500 : 100 + index * 800 / (count - 1), y: Number(event.el) === 0 ? 66 : 228 };
}

function pathForEvents(events, until) {
  return events.slice(0, until + 1).map((event, index) => {
    const position = eventCoordinates(event, index, events.length);
    return `${index ? "L" : "M"}${position.x} ${position.y}`;
  }).join(" ");
}

function drawTrace(trace) {
  if (!trace || !Array.isArray(trace.events) || !trace.events.length) throw new Error("采样记录中没有执行事件");
  stopPlayback();
  state.trace = trace;
  state.index = 0;
  $("#empty-stage").hidden = true;
  $("#source-label").textContent = trace.source === "qemu-gdb" ? "QEMU + GDB 实测" : trace.source === "recorded-qemu-gdb" ? "已保存的实测记录" : "执行记录";
  $("#trace-meta").textContent = `${trace.program || "hello_world.bin"} · ${captureTime(trace.capturedAt)}`;
  $("#event-total").textContent = `${trace.events.length} EVENTS`;
  $("#trace-slider").max = trace.events.length - 1;
  $("#trace-slider").disabled = false;
  $("#export-trace").disabled = false;
  $("#serial-output").textContent = trace.console || "本次采样未保存串口输出";
  $("#serial-output").scrollTop = $("#serial-output").scrollHeight;
  const provenance = trace.provenance;
  const notes = [typeof provenance === "string" ? provenance : provenance?.note, trace.summary?.note, trace.consoleIsExcerpt ? "串口输出为已保存摘录" : null].filter(Boolean);
  $("#provenance").textContent = notes.join("；") || "数据来源：QEMU + GDB 的 CPU 执行现场";
  $("#execution-nodes").replaceChildren();
  $("#event-log").replaceChildren();
  trace.events.forEach((event, index) => {
    const pos = eventCoordinates(event, index, trace.events.length);
    const node = element("button", `phase-node ${Number(event.el) === 1 ? "kernel" : "user"}`);
    node.type = "button";
    node.style.left = `${pos.x / 10}%`;
    node.style.top = `calc(${pos.y / 3}% - 9px)`;
    node.title = `${index + 1}. ${event.label} · ${mono(event.pc)}`;
    node.setAttribute("aria-label", node.title);
    const shortLabel = { entry: "异常入口", kernel: "内核处理", return: "执行 eret" }[event.phase] || (/^svc\b/.test(event.instruction || "") ? "执行 svc" : "用户继续");
    const nodeCode = event.phase === "entry" ? "sync_el0_64" : event.phase === "kernel" ? event.symbol || trace.summary?.syscall || "sys_putstr" : event.instruction || missing;
    node.append(element("span", "node-point"), element("span", "node-label", shortLabel), element("code", "", nodeCode), element("span", "node-step", `EVENT ${String(index + 1).padStart(2, "0")}`));
    node.addEventListener("click", () => { stopPlayback(); selectEvent(index); });
    $("#execution-nodes").append(node);
    const row = element("tr", "event-row");
    row.tabIndex = 0;
    row.setAttribute("aria-label", `事件 ${index + 1}：${event.label}`);
    row.append(element("td", "", String(index + 1).padStart(2, "0")), element("td", "", event.label));
    const mode = element("td");
    mode.append(element("span", `mode-pill ${Number(event.el) === 1 ? "kernel" : ""}`, `EL${event.el}`));
    const pc = element("td"); pc.append(element("code", "", event.pc));
    const instruction = element("td"); instruction.append(element("code", "", event.instruction));
    row.append(mode, pc, instruction);
    row.addEventListener("click", () => { stopPlayback(); selectEvent(index); });
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stopPlayback(); selectEvent(index); } });
    $("#event-log").append(row);
  });
  $("#trace-path").setAttribute("d", pathForEvents(trace.events, trace.events.length - 1));
  selectEvent(0);
  showTraceError(null);
}

function selectEvent(index) {
  if (!state.trace) return;
  state.index = Math.max(0, Math.min(index, state.trace.events.length - 1));
  const event = state.trace.events[state.index];
  const number = String(state.index + 1).padStart(2, "0");
  $("#event-counter").textContent = `${number} / ${String(state.trace.events.length).padStart(2, "0")}`;
  $("#trace-slider").value = state.index;
  $("#selected-number").textContent = number;
  $("#selected-label").textContent = event.label;
  $("#selected-mode").textContent = `EL${event.el} · ${Number(event.el) === 0 ? "用户态" : "内核态"}`;
  $("#selected-mode").classList.toggle("kernel", Number(event.el) === 1);
  $("#selected-detail").textContent = `${event.detail || "本事件未保存补充说明。"}${event.buffer !== undefined ? ` 输出缓冲区：${JSON.stringify(event.buffer)}` : ""}`;
  $("#selected-instruction").textContent = event.instruction || (event.symbol ? `${event.symbol}（符号）` : missing);
  $("#reg-pc").textContent = mono(event.pc);
  $("#register-step").textContent = `EVENT ${number}`;
  $("#register-list").replaceChildren();
  const descriptions = { CPSR: "当前处理器状态", ELR_EL1: "异常返回地址", SPSR_EL1: "异常前处理器状态", ESR_EL1: "异常原因", x8: "系统调用号", x0: "参数 · 缓冲区地址", x1: "参数 · 字节长度" };
  Object.entries(descriptions).forEach(([name, description]) => {
    const group = element("div");
    const title = element("dt", "", name);
    title.append(element("small", "", description));
    group.append(title, element("dd", "", mono(name === "CPSR" ? event.cpsr : event.registers?.[name])));
    $("#register-list").append(group);
  });
  const cpsr = typeof event.cpsr === "string" || typeof event.cpsr === "number" ? Number(event.cpsr) : NaN;
  const nibble = Number.isFinite(cpsr) ? cpsr & 15 : null;
  $("#register-note").textContent = nibble === 0 ? "CPSR.M[3:0] = 0x0：当前在 EL0t 执行。ELR、SPSR、ESR 保留最近一次异常的记录。" : nibble === 5 ? "CPSR.M[3:0] = 0x5：当前在 EL1h 执行，使用 SP_EL1。" : "ELR_EL1 和 SPSR_EL1 保存进入异常时的返回地址与处理器状态。";
  $$(".phase-node").forEach((node, i) => { node.classList.toggle("selected", i === state.index); node.classList.toggle("past", i < state.index); node.setAttribute("aria-pressed", String(i === state.index)); });
  $$(".event-row").forEach((row, i) => { row.classList.toggle("selected", i === state.index); row.setAttribute("aria-selected", String(i === state.index)); });
  $("#trace-progress").setAttribute("d", pathForEvents(state.trace.events, state.index));
  $("#previous-event").disabled = state.index === 0;
  $("#next-event").disabled = state.index === state.trace.events.length - 1;
}

async function loadTrace() {
  try {
    const trace = await api("/api/trace/last");
    drawTrace(trace.trace || trace);
  } catch (error) { showTraceError(error.message); }
}

function updateStatus(status) {
  const display = $("#capture-status");
  display.className = `mini-status ${status.state || ""}`;
  const messages = { idle: "采样器就绪", capturing: "正在采样", ready: "采样完成", error: "采样失败" };
  display.textContent = status.message || messages[status.state] || "状态未知";
  display.title = status.error || status.message || "";
  const available = status.available;
  const unavailable = available && ["qemu", "gdb", "kernel", "pexpect"].some((key) => available[key] === false);
  state.captureBusy = status.state === "capturing";
  $("#capture").disabled = state.captureBusy || Boolean(unavailable);
  $("#capture").querySelector("span").textContent = state.captureBusy ? "采样中…" : "重新采样";
  $("#capture").title = unavailable ? "QEMU、GDB 或内核镜像不可用" : "在 QEMU 中重新运行并采集 CPU 现场";
  if (status.state === "error") showTraceError(status.error || status.message || "本次采样失败");
}

async function pollStatus() {
  try {
    const status = await api("/api/status");
    updateStatus(status);
    if (status.state === "capturing") state.polling = setTimeout(pollStatus, 1100);
    else {
      clearTimeout(state.polling);
      state.polling = null;
      if (status.state === "ready") await loadTrace();
    }
  } catch (error) {
    clearTimeout(state.polling);
    state.polling = null;
    state.captureBusy = false;
    $("#capture").disabled = false;
    $("#capture").querySelector("span").textContent = "重新采样";
    $("#capture-status").textContent = "连接失败";
    $("#capture-status").className = "mini-status error";
    showTraceError(error.message);
  }
}

async function capture() {
  if (state.captureBusy) return;
  stopPlayback();
  showTraceError(null);
  state.captureBusy = true;
  $("#capture").disabled = true;
  $("#capture").querySelector("span").textContent = "采样中…";
  $("#capture-status").textContent = "启动 QEMU + GDB";
  $("#capture-status").className = "mini-status capturing";
  try {
    await api("/api/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    clearTimeout(state.polling);
    await pollStatus();
  } catch (error) {
    state.captureBusy = false;
    $("#capture").disabled = false;
    $("#capture").querySelector("span").textContent = "重新采样";
    $("#capture-status").textContent = "采样失败";
    $("#capture-status").className = "mini-status error";
    showTraceError(error.message);
  }
}

function exportTrace() {
  if (!state.trace) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state.trace, null, 2)], { type: "application/json" }));
  const anchor = element("a");
  anchor.href = url;
  anchor.download = `chcore-trace-${String(state.trace.id || "recorded").replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let walkRequest = 0;
async function walkAddress() {
  const request = ++walkRequest;
  const errorBox = $("#address-error");
  errorBox.hidden = true;
  try {
    const result = await api(`/api/page-walk?address=${encodeURIComponent($("#virtual-address").value.trim())}`);
    if (request !== walkRequest) return;
    renderWalk(result);
  } catch (error) {
    if (request !== walkRequest) return;
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    $("#page-walk").replaceChildren();
    $("#address-bits").replaceChildren();
    $("#mapping-attributes").replaceChildren();
    $("#result-virtual").textContent = $("#virtual-address").value.trim();
    $("#result-physical").textContent = "转换失败";
    $("#mapping-kind").textContent = "地址错误";
  }
}

function renderWalk(result) {
  $("#address-bits").replaceChildren();
  const indices = result.indices || [result.l0, result.l1, result.l2, result.l3];
  const stages = result.stages || [];
  const offsetBits = result.granularity === "1 GiB" ? "[29:0]" : result.granularity === "2 MiB" ? "[20:0]" : "[11:0]";
  ["L0", "L1", "L2", "L3", result.granularity ? "块内偏移" : "页内偏移"].forEach((name, index) => {
    const traversed = index === 4 || stages.some((stage) => stage.level === `L${index}` || stage.level === index);
    const bit = element("div", `bit-group${traversed ? "" : " unused"}`);
    const value = index < 4 ? indices[index] : result.offset;
    bit.append(element("span", "", traversed ? name : `${name} · 未遍历`), element("b", "", value), element("small", "", ["[47:39]", "[38:30]", "[29:21]", "[20:12]", offsetBits][index]));
    $("#address-bits").append(bit);
  });
  $("#page-walk").replaceChildren();
  for (let i = 0; i < 4; i += 1) {
    const stage = stages.find((item) => item.level === `L${i}` || item.level === i);
    const node = element("div", `walk-stage ${stage ? stage.type === "block" ? "block" : "" : "unused"}`);
    node.append(element("small", "", `LEVEL ${i}`), element("h3", "", stage?.table || `L${i} 页表`));
    node.append(element("div", "walk-index", stage ? stage.index : "—"));
    node.append(element("small", "", "描述符"), element("code", "", stage ? stage.descriptor : "本地址未遍历此级"));
    node.append(element("span", "walk-type", stage ? { table: "TABLE · 下一级页表", block: "BLOCK · 块映射", page: "PAGE · 页映射", invalid: "INVALID · 未映射" }[stage.type] || stage.type : "跳过"));
    $("#page-walk").append(node);
  }
  $("#walk-granularity").textContent = result.granularity ? `${result.granularity} BLOCK` : "UNMAPPED";
  $("#result-virtual").textContent = result.address;
  $("#result-physical").textContent = result.mapped ? result.physical : "未映射";
  $("#mapping-kind").textContent = { normal: "NORMAL · 普通内存", device: "DEVICE · 设备内存", unmapped: "UNMAPPED" }[result.kind] || result.kind;
  $("#mapping-kind").classList.toggle("kernel", result.kind === "device" || !result.mapped);
  $("#mapping-attributes").replaceChildren();
  const attributes = result.attributes;
  const entries = Array.isArray(attributes) ? attributes.map((value, index) => [`属性 ${index + 1}`, value]) : Object.entries(attributes || {});
  const allEntries = [["映射粒度", result.granularity || "未映射"], ["内存类型", result.kind === "device" ? "Device nGnRnE" : result.kind === "normal" ? "Normal memory" : "未映射"], ...entries];
  allEntries.forEach(([name, value]) => {
    const node = element("div");
    node.append(element("dt", "", name), element("dd", "", Array.isArray(value) ? value.join(" / ") : value));
    $("#mapping-attributes").append(node);
  });
}

const scheduler = { timer: null, tick: 0, cpuCount: 1, quantum: 2, fixed: false, tasks: [], queue: [], slots: [], history: [], switches: 0, lastRuns: [], horizon: 24 };
const taskIds = ["A", "B", "C"];
const bursts = { A: 6, B: 4, C: 5 };

function stopScheduler() {
  clearInterval(scheduler.timer);
  scheduler.timer = null;
  $("#play-scheduler").innerHTML = `${icon("play")}<span>运行</span>`;
}

function resetScheduler() {
  stopScheduler();
  scheduler.cpuCount = Number($("#cpu-count").value);
  scheduler.quantum = Math.max(1, Math.min(8, Number($("#quantum").value) || 2));
  $("#quantum").value = scheduler.quantum;
  scheduler.fixed = $("#affinity").checked;
  scheduler.tasks = taskIds.map((id, i) => ({ id, burst: bursts[id], remaining: bursts[id], waiting: 0, cpu: i % scheduler.cpuCount, done: false }));
  scheduler.queue = [...scheduler.tasks];
  scheduler.slots = Array.from({ length: scheduler.cpuCount }, () => null);
  scheduler.lastRuns = Array.from({ length: scheduler.cpuCount }, () => null);
  scheduler.history = [];
  scheduler.tick = 0;
  scheduler.switches = 0;
  scheduler.horizon = Math.max(24, Object.values(bursts).reduce((a, b) => a + b, 0));
  buildGantt();
  renderScheduler();
}

function buildGantt() {
  const gantt = $("#gantt");
  gantt.replaceChildren();
  gantt.style.minWidth = `${Math.max(580, 56 + scheduler.horizon * 25)}px`;
  const rowStyle = `56px repeat(${scheduler.horizon}, minmax(21px, 1fr))`;
  const times = element("div", "gantt-row time-row");
  times.style.gridTemplateColumns = rowStyle;
  times.append(element("span", "gantt-label", "TICK"));
  for (let i = 0; i < scheduler.horizon; i += 1) times.append(element("span", "gantt-tick", i));
  gantt.append(times);
  for (let cpu = 0; cpu < scheduler.cpuCount; cpu += 1) {
    const row = element("div", "gantt-row");
    row.style.gridTemplateColumns = rowStyle;
    row.append(element("span", "gantt-label", `CPU ${cpu}`));
    for (let i = 0; i < scheduler.horizon; i += 1) {
      const cell = element("span", "gantt-cell");
      cell.dataset.tick = i;
      cell.dataset.cpu = cpu;
      row.append(cell);
    }
    gantt.append(row);
  }
}

function stepScheduler() {
  if (scheduler.tasks.every((task) => task.done)) { stopScheduler(); return; }
  scheduler.slots.forEach((slot, cpu) => {
    if (slot) return;
    const index = scheduler.queue.findIndex((task) => !scheduler.fixed || task.cpu === cpu);
    if (index < 0) return;
    const task = scheduler.queue.splice(index, 1)[0];
    scheduler.slots[cpu] = { task, used: 0 };
  });
  scheduler.queue.forEach((task) => { task.waiting += 1; });
  const runs = scheduler.slots.map((slot) => slot?.task.id || null);
  runs.forEach((id, cpu) => {
    if (id && scheduler.lastRuns[cpu] && scheduler.lastRuns[cpu] !== id) scheduler.switches += 1;
    if (id) scheduler.lastRuns[cpu] = id;
    const cell = $(`#gantt [data-cpu="${cpu}"][data-tick="${scheduler.tick}"]`);
    if (cell) {
      cell.classList.add(id ? "ran" : "idle");
      if (id) cell.classList.add(`thread-${id}`);
      cell.textContent = id || "·";
      cell.title = `t=${scheduler.tick} · CPU ${cpu} · ${id ? `线程 ${id}` : "空闲"}`;
    }
  });
  scheduler.history.push(runs);
  scheduler.slots.forEach((slot, cpu) => {
    if (!slot) return;
    slot.task.remaining -= 1;
    slot.used += 1;
    if (slot.task.remaining === 0) { slot.task.done = true; scheduler.slots[cpu] = null; }
    else if (slot.used >= scheduler.quantum) { scheduler.queue.push(slot.task); scheduler.slots[cpu] = null; }
  });
  scheduler.tick += 1;
  renderScheduler();
  if (scheduler.tasks.every((task) => task.done)) stopScheduler();
}

function renderScheduler() {
  $("#scheduler-tick").textContent = scheduler.tick;
  const complete = scheduler.tasks.filter((task) => task.done).length;
  $("#completed-count").textContent = `${complete} / 3`;
  $("#context-count").textContent = scheduler.switches;
  $("#wait-average").textContent = `${(scheduler.tasks.reduce((sum, task) => sum + task.waiting, 0) / 3).toFixed(1)} ticks`;
  $("#scheduler-state").textContent = complete === 3 ? "COMPLETED" : scheduler.tick ? "RUNNING" : "READY";
  $("#step-scheduler").disabled = complete === 3;
  $("#play-scheduler").disabled = complete === 3;
  $("#ready-queue").replaceChildren();
  if (!scheduler.queue.length) $("#ready-queue").append(element("span", "", "队列为空"));
  scheduler.queue.forEach((task, i) => {
    const item = element("div", `queue-thread thread-${task.id}`);
    item.append(element("b", "", task.id), element("span", "", `剩余 ${task.remaining}`));
    if (scheduler.fixed) item.append(element("span", "", `CPU ${task.cpu}`));
    $("#ready-queue").append(item);
    if (i < scheduler.queue.length - 1) $("#ready-queue").append(element("span", "", "→"));
  });
  $("#cpu-states").replaceChildren();
  scheduler.slots.forEach((slot, cpu) => {
    const box = element("div", "cpu-state");
    box.append(element("span", "", `CPU ${cpu}`), element("b", "", slot ? `线程 ${slot.task.id}` : scheduler.queue.some((task) => !scheduler.fixed || task.cpu === cpu) ? "等待调度" : "空闲"), element("small", "", slot ? `时间片 ${slot.used} / ${scheduler.quantum}` : "—"));
    $("#cpu-states").append(box);
  });
  scheduler.tasks.forEach((task) => {
    const description = $(`#thread-${task.id}-state`);
    description.textContent = task.done ? "已完成" : `剩余 ${task.remaining}`;
    $(`#thread-${task.id}-progress`).style.width = `${(task.burst - task.remaining) / task.burst * 100}%`;
  });
}

function startScheduler() {
  if (scheduler.timer) { stopScheduler(); return; }
  if (scheduler.tasks.every((task) => task.done)) return;
  $("#play-scheduler").innerHTML = `${icon("pause")}<span>暂停</span>`;
  stepScheduler();
  if (!scheduler.tasks.every((task) => task.done)) scheduler.timer = setInterval(stepScheduler, 600);
}

taskIds.forEach((id) => {
  const item = element("div");
  const row = element("div", `thread-setting thread-${id}`);
  const label = element("label", "", `线程 ${id}`);
  label.htmlFor = `burst-${id}`;
  const input = element("input");
  input.type = "number"; input.min = 1; input.max = 20; input.value = bursts[id]; input.id = `burst-${id}`;
  input.setAttribute("aria-label", `线程 ${id} 执行时长`);
  input.addEventListener("change", () => { bursts[id] = Math.max(1, Math.min(20, Number(input.value) || 1)); input.value = bursts[id]; resetScheduler(); });
  const description = element("small", "", ""); description.id = `thread-${id}-state`;
  row.append(element("span", "thread-dot"), label, input, description);
  const progress = element("div", "thread-progress");
  const fill = element("span"); fill.id = `thread-${id}-progress`; progress.append(fill);
  item.append(row, progress);
  $("#thread-settings").append(item);
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
window.addEventListener("hashchange", () => setView(location.hash.slice(1), false));
$("#previous-event").addEventListener("click", () => { stopPlayback(); selectEvent(state.index - 1); });
$("#next-event").addEventListener("click", () => { stopPlayback(); selectEvent(state.index + 1); });
$("#reset-trace").addEventListener("click", () => { stopPlayback(); selectEvent(0); });
$("#play-trace").addEventListener("click", startPlayback);
$("#trace-slider").addEventListener("input", (event) => { stopPlayback(); selectEvent(Number(event.target.value)); });
$("#playback-speed").addEventListener("change", () => { if (state.playback) { stopPlayback(); startPlayback(); } });
$("#capture").addEventListener("click", capture);
$("#retry-trace").addEventListener("click", () => { loadTrace(); pollStatus(); });
$("#export-trace").addEventListener("click", exportTrace);
$("#address-form").addEventListener("submit", (event) => { event.preventDefault(); walkAddress(); });
$$("[data-address]").forEach((button) => button.addEventListener("click", () => { $("#virtual-address").value = button.dataset.address; walkAddress(); }));
$("#cpu-count").addEventListener("change", resetScheduler);
$("#quantum").addEventListener("change", resetScheduler);
$("#affinity").addEventListener("change", resetScheduler);
$("#reset-scheduler").addEventListener("click", resetScheduler);
$("#step-scheduler").addEventListener("click", () => { stopScheduler(); stepScheduler(); });
$("#play-scheduler").addEventListener("click", startScheduler);
$("#case-select").addEventListener("change", event => setView(event.target.value));
resetScheduler();
setView(location.hash.slice(1) || "syscall", false);
loadTrace();
pollStatus();
