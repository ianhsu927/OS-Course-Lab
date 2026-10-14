"use strict";

(() => {
  const DATA_VA = 0x500000;
  const PROGRAMS = ["hello_world.bin", "test_pthread.bin"];
  const STATUS = { CREATED: "创建", READY: "就绪", RUNNING: "运行", BLOCKED: "等待 I/O", EXITED: "已退出" };

  class ProgramModel {
    constructor(options = {}) {
      this.options = { program: PROGRAMS.includes(options.program) ? options.program : PROGRAMS[0], blocking: options.blocking !== false };
      this.reset();
    }

    reset(options = {}) {
      this.options = { ...this.options, ...options };
      this.tick = 0;
      this.nextPid = 201;
      this.processes = [];
      this.events = [];
      this.addProcess(this.options.program, false);
      this.addProcess(this.options.program, false);
      this.lastEvent = { tick: 0, pid: null, operation: "Shell 启动子进程", detail: "两个独立的进程实例等待创建内核对象。" };
      return this;
    }

    addProcess(program = this.options.program, record = true) {
      if (this.processes.length >= 4) return null;
      if (!PROGRAMS.includes(program)) throw new Error("未知的程序模板");
      const pid = this.nextPid++;
      const process = {
        pid, parentPid: 100, program, state: "CREATED", phase: 0, blocking: this.options.blocking,
        wakeAt: null, registers: { pc: null, sp: null }, regions: [], memory: {},
        resources: { capGroup: false, vmspace: false, thread: false, pmos: 0 },
        dataPA: 0x1000000 + (pid - 201) * 0x100000, runCount: 0,
      };
      this.processes.push(process);
      if (record) this.record(process, "Shell 创建子进程", `${program} → PID ${pid}；每个实例获得自己的地址空间。`);
      return process;
    }

    record(process, operation, detail) {
      const event = { tick: this.tick, pid: process?.pid ?? null, operation, detail };
      this.events.push(event);
      this.lastEvent = event;
      return event;
    }

    get done() { return this.processes.length > 0 && this.processes.every((process) => process.state === "EXITED"); }
    get running() { return this.processes.find((process) => process.state === "RUNNING") || null; }
    get readyQueue() { return this.processes.filter((process) => process.state === "READY").map((process) => process.pid); }
    get liveObjects() {
      return this.processes.reduce((total, process) => total + Number(process.resources.capGroup) + Number(process.resources.vmspace) + Number(process.resources.thread) + process.resources.pmos, 0);
    }

    step() {
      if (this.done) return null;
      this.tick += 1;
      let process = this.running;
      if (process) {
        process.runCount += 1;
        if (process.blocking && process.phase === 4) {
          process.state = "BLOCKED";
          process.phase = 5;
          process.wakeAt = this.tick + 3;
          process.registers.pc += 4;
          return this.record(process, "主线程阻塞", "等待模拟 I/O 完成；线程离开 CPU，页表和 PMO 保留。 ");
        }
        process.state = "EXITED";
        process.phase = 8;
        process.registers = { pc: null, sp: null };
        process.resources = { capGroup: false, vmspace: false, thread: false, pmos: 0 };
        process.regions = [];
        process.memory = {};
        return this.record(process, "退出并回收", "主线程结束；本模型释放该进程的能力、地址空间、PMO 和线程对象。");
      }
      process = this.processes.find((item) => item.state === "BLOCKED" && item.wakeAt <= this.tick);
      if (process) {
        process.state = "READY";
        process.phase = 6;
        process.wakeAt = null;
        return this.record(process, "I/O 完成并唤醒", "主线程重新进入就绪队列，等待下一次派发。");
      }
      process = this.processes.find((item) => item.state === "CREATED");
      if (process) {
        if (process.phase === 0) {
          process.resources.capGroup = true;
          process.resources.vmspace = true;
          process.phase = 1;
          return this.record(process, "创建内核对象", "cap_group 保存能力与线程集合；vmspace 保存虚拟地址映射。");
        }
        if (process.phase === 1) {
          process.regions = [
            { name: ".text", va: 0x400000, size: 0x1000, pa: process.dataPA - 0x10000, permissions: "R-X", pmo: `pmo-${process.pid}-text` },
            { name: ".data", va: DATA_VA, size: 0x1000, pa: process.dataPA, permissions: "RW-", pmo: `pmo-${process.pid}-data` },
            { name: "heap", va: 0x600000, size: 0x2000, pa: process.dataPA + 0x10000, permissions: "RW-", pmo: `pmo-${process.pid}-heap` },
          ];
          process.memory[0x400000] = 0xd2800000;
          process.memory[DATA_VA] = (process.pid - 200) * 10;
          process.resources.pmos = 3;
          process.phase = 2;
          return this.record(process, "装载 ELF 与数据", "示意装载可执行段与可写段，另分配堆；同一个数据虚拟地址映射到独立物理页。");
        }
        process.regions.push({ name: "stack", va: 0x7fe000, size: 0x2000, pa: process.dataPA + 0x20000, permissions: "RW-", pmo: `pmo-${process.pid}-stack` });
        process.resources.pmos = 4;
        process.resources.thread = true;
        process.registers = { pc: 0x400000, sp: 0x800000 };
        process.state = "READY";
        process.phase = 3;
        return this.record(process, "创建主线程", "准备用户栈与入口 PC；主线程绑定自己的 cap_group 和 vmspace，进入就绪队列。");
      }
      process = this.processes.find((item) => item.state === "READY");
      if (process) {
        process.state = "RUNNING";
        process.phase = process.phase === 6 ? 7 : 4;
        return this.record(process, "派发主线程", `CPU 0 切换到 PID ${process.pid} 的 vmspace，开始在 EL0 执行。`);
      }
      return this.record(null, "CPU 等待", "所有存活的主线程都在等待 I/O，CPU 执行 idle 线程。");
    }

    access(actorPid, targetPid, address, write = false) {
      if (actorPid !== targetPid) throw new Error("拒绝访问：进程不能直接读取或修改另一个进程的地址空间");
      const process = this.processes.find((item) => item.pid === targetPid);
      if (!process || process.state === "EXITED") throw new Error("地址空间不存在或已回收");
      const region = process.regions.find((item) => address >= item.va && address < item.va + item.size);
      if (!region) throw new Error("该虚拟地址尚未映射");
      if (write && !region.permissions.includes("W")) throw new Error("拒绝写入：该映射为只读或可执行段");
      return process;
    }

    readMemory(actorPid, targetPid, address = DATA_VA) {
      const process = this.access(actorPid, targetPid, address);
      return process.memory[address] ?? 0;
    }

    writeMemory(actorPid, targetPid, address = DATA_VA, value = 0) {
      if (!Number.isSafeInteger(value)) throw new Error("请输入有效整数");
      const process = this.access(actorPid, targetPid, address, true);
      process.memory[address] = value;
      this.record(process, "写入私有数据", `PID ${targetPid}：VA 0x${address.toString(16)} = ${value}；其他进程的值不变。`);
      return value;
    }
  }

  window.OSModels = window.OSModels || {};
  window.OSModels.ProgramModel = ProgramModel;
  if (!window.OSDemo || typeof document === "undefined") return;

  const { mount, icon, player } = window.OSDemo;
  const html = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const hex = (value) => value === null ? "—" : `0x${value.toString(16)}`;
  const query = (id) => document.getElementById(id);
  const model = new ProgramModel();
  let selected = 201;
  let transport;

  mount("programs", {
    number: "07", title: "程序与进程", subtitle: "ELF 装载 · 独立地址空间 · 主线程生命周期",
    sourceNote: "依据 Lab1 内核对象与地址空间定义的教学模型；地址、PID 与装载步骤为示意值，未运行 ELF。",
    body: `
      <div class="case-controls proc-controls">
        <label>程序模板 <select id="proc-program"><option value="hello_world.bin">hello_world.bin</option><option value="test_pthread.bin">test_pthread.bin</option></select></label>
        <label class="checkbox-label"><input id="proc-blocking" type="checkbox" checked>等待 I/O</label>
        <button id="proc-add" class="primary-button" type="button" title="创建一个独立的程序实例">${icon("plus")}<span>创建进程</span></button>
        <div class="proc-transport">
          <button id="proc-reset" class="icon-button" type="button" title="重新开始" aria-label="重新开始">${icon("rotate-ccw")}</button>
          <button id="proc-play" class="icon-button" type="button" title="播放" aria-label="播放">${icon("play")}</button>
          <button id="proc-step" class="icon-button" type="button" title="下一步" aria-label="下一步">${icon("skip-forward")}</button>
          <select id="proc-speed" aria-label="播放速度"><option value="1100">1×</option><option value="550">2×</option><option value="2200">0.5×</option></select>
        </div>
      </div>
      <dl id="proc-stats" class="case-stats proc-stats"></dl>
      <div class="case-grid proc-grid">
        <div>
          <div class="section-heading"><h2>${icon("layers")}进程实例与执行状态</h2><span class="mini-label">CPU 0 · 主线程</span></div>
          <div class="case-stage proc-stage">
            <div class="proc-parent">${icon("terminal")}<strong>Shell</strong><code>PID 100</code><span>父进程</span></div>
            <div id="proc-tree" class="proc-tree" aria-label="子进程"></div>
            <div class="proc-lifecycle" aria-label="进程主线程状态"><span data-state="CREATED">创建<small>CREATED</small></span>${icon("arrow-right")}<span data-state="READY">就绪<small>READY</small></span>${icon("arrow-right")}<span data-state="RUNNING">运行<small>RUNNING</small></span>${icon("arrow-right")}<span data-state="EXITED">退出<small>EXITED</small></span></div>
            <div class="proc-wait-path"><span>等待 I/O</span><code>RUNNING</code>${icon("arrow-right")}<span data-state="BLOCKED">BLOCKED</span>${icon("arrow-right")}<code>READY</code><small>唤醒后重新等待派发</small></div>
            <div class="proc-queue"><span>就绪队列</span><div id="proc-ready"></div></div>
          </div>
          <div class="proc-event" aria-live="polite"><span id="proc-event-tick" class="mini-label"></span><div><h3 id="proc-event-title"></h3><p id="proc-event-detail"></p></div></div>
          <div class="section-heading"><h2>${icon("layers")}相同虚拟地址，不同物理页</h2><code>VA 0x500000</code></div>
          <div id="proc-isolation" class="proc-isolation"></div>
          <form id="proc-write" class="case-controls proc-write"><label>进程 <select id="proc-write-pid" aria-label="写入进程"></select></label><label>值 <input id="proc-value" type="number" min="-9999" max="9999" value="99" required aria-label="数据值"></label><button id="proc-write-button" type="submit" class="primary-button">${icon("file-check")}<span>写入 .data</span></button></form>
          <p id="proc-memory-message" class="case-note" role="status">写入仅影响所属进程的可写映射；本案例不包含跨进程共享内存。</p>
        </div>
        <aside class="proc-inspector">
          <div class="section-heading"><h2>${icon("cpu")}所选进程</h2><code id="proc-selected-pid"></code></div>
          <dl id="proc-objects" class="proc-objects"></dl>
          <div class="section-heading proc-mapping-heading"><h2>地址空间映射</h2><span class="mini-label">vmregion → PMO</span></div>
          <div class="table-scroll case-log proc-mapping-table"><table><thead><tr><th>区域</th><th>虚拟地址</th><th>权限</th></tr></thead><tbody id="proc-regions"></tbody></table></div>
          <p class="case-note">.text 可读、可执行；.data、堆和用户栈可读写。本例以主线程状态代表进程执行状态；ChCore 实际调度的对象是线程。</p>
        </aside>
      </div>
      <div class="section-heading proc-log-heading"><h2>${icon("activity")}装载与生命周期记录</h2><span id="proc-log-count" class="mini-label"></span></div>
      <div class="table-scroll case-log case-log-wrap"><table><thead><tr><th>步骤</th><th>进程</th><th>事件</th><th>对象与状态变化</th></tr></thead><tbody id="proc-log"></tbody></table></div>
      <p class="case-note proc-source-note">ChCore 对照：<code>kernel/include/object/cap_group.h</code> · <code>kernel/include/object/thread.h</code> · <code>kernel/include/mm/vmspace.h</code>。进程服务组织装载；内核维护能力、内存与线程对象。</p>
    `,
  });

  function render() {
    const process = model.processes.find((item) => item.pid === selected) || model.processes[0];
    selected = process.pid;
    query("proc-stats").innerHTML = `<div><dt>执行步骤</dt><dd>${model.tick}</dd></div><div><dt>存活进程</dt><dd>${model.processes.filter((item) => item.state !== "EXITED").length}</dd></div><div><dt>CPU 0</dt><dd>${model.running ? `PID ${model.running.pid}` : "idle"}</dd></div><div><dt>内核对象</dt><dd>${model.liveObjects}</dd></div>`;
    query("proc-tree").innerHTML = model.processes.map((item) => `<button type="button" class="proc-child ${item.pid === selected ? "selected" : ""} ${item.state.toLowerCase()}" data-pid="${item.pid}" aria-pressed="${item.pid === selected}"><span><strong>PID ${item.pid}</strong><span class="case-status">${STATUS[item.state]}</span></span><code>${html(item.program)}</code><small>主线程 ${item.pid}:1</small></button>`).join("");
    document.querySelectorAll("#view-programs .proc-stage [data-state]").forEach((node) => node.classList.toggle("active", node.dataset.state === process.state));
    query("proc-ready").innerHTML = model.readyQueue.length ? model.readyQueue.map((pid) => `<span class="case-token">PID ${pid}</span>`).join("") : '<span class="proc-empty">空</span>';
    const event = model.lastEvent;
    query("proc-event-tick").textContent = `STEP ${String(event.tick).padStart(2, "0")}`;
    query("proc-event-title").textContent = `${event.pid ? `PID ${event.pid} · ` : ""}${event.operation}`;
    query("proc-event-detail").textContent = event.detail;
    query("proc-isolation").innerHTML = model.processes.map((item) => {
      const available = item.regions.some((region) => region.va === DATA_VA);
      const value = available ? model.readMemory(item.pid, item.pid) : "—";
      return `<div class="proc-memory-item ${item.pid === selected ? "selected" : ""}"><div><strong>PID ${item.pid}</strong><span>${available ? "私有 .data" : item.state === "EXITED" ? "已回收" : "尚未装载"}</span></div><dl><div><dt>VA</dt><dd>0x500000</dd></div><div><dt>PA</dt><dd>${available ? hex(item.dataPA) : "—"}</dd></div><div><dt>值</dt><dd class="proc-data-value">${value}</dd></div></dl></div>`;
    }).join("");
    const previousWritePid = Number(query("proc-write-pid").value);
    const writable = model.processes.filter((item) => item.regions.some((region) => region.va === DATA_VA));
    query("proc-write-pid").innerHTML = writable.length ? writable.map((item) => `<option value="${item.pid}">PID ${item.pid}</option>`).join("") : '<option value="">尚无可写进程</option>';
    if (writable.some((item) => item.pid === previousWritePid)) query("proc-write-pid").value = String(previousWritePid);
    query("proc-write-pid").disabled = !writable.length;
    query("proc-write-button").disabled = !writable.length;
    query("proc-value").disabled = !writable.length;
    query("proc-add").disabled = model.processes.length >= 4;
    query("proc-selected-pid").textContent = `PID ${process.pid}`;
    const r = process.resources;
    query("proc-objects").innerHTML = [
      ["程序文件", process.program], ["主线程状态", STATUS[process.state]], ["cap_group", r.capGroup ? `cap_group_${process.pid}` : "未创建 / 已回收"],
      ["vmspace", r.vmspace ? `vmspace_${process.pid}` : "未创建 / 已回收"], ["线程对象", r.thread ? `${process.pid}:1 · main` : "未创建 / 已回收"],
      ["PMO 数量", r.pmos], ["PC", hex(process.registers.pc)], ["用户 SP", hex(process.registers.sp)],
    ].map(([name, value]) => `<div><dt>${name}</dt><dd>${html(value)}</dd></div>`).join("");
    query("proc-regions").innerHTML = process.regions.length ? process.regions.map((region) => `<tr><td><code>${region.name}</code></td><td><code>${hex(region.va)}</code><small>${region.size / 1024} KiB · ${html(region.pmo)}</small></td><td><code>${region.permissions}</code></td></tr>`).join("") : `<tr><td colspan="3" class="proc-empty">${process.state === "EXITED" ? "地址空间已回收" : "ELF 段尚未映射"}</td></tr>`;
    query("proc-log-count").textContent = `${model.events.length} EVENTS`;
    query("proc-log").innerHTML = model.events.length ? model.events.slice().reverse().map((item) => `<tr><td>${String(item.tick).padStart(2, "0")}</td><td>${item.pid ? `PID ${item.pid}` : "CPU 0"}</td><td>${html(item.operation)}</td><td>${html(item.detail)}</td></tr>`).join("") : '<tr><td colspan="4" class="proc-empty">等待创建与装载</td></tr>';
  }

  function reset() {
    model.reset({ program: query("proc-program").value, blocking: query("proc-blocking").checked });
    selected = 201;
    query("proc-memory-message").textContent = "写入仅影响所属进程的可写映射；本案例不包含跨进程共享内存。";
  }

  transport = player("proc", { step: () => model.step(), reset, done: () => model.done, render });
  query("proc-program").addEventListener("change", () => transport.reset());
  query("proc-blocking").addEventListener("change", () => transport.reset());
  query("proc-add").addEventListener("click", () => {
    transport.pause();
    const process = model.addProcess(query("proc-program").value);
    if (process) selected = process.pid;
    render();
    transport.refresh?.();
  });
  query("proc-tree").addEventListener("click", (event) => {
    const node = event.target.closest("[data-pid]");
    if (!node) return;
    selected = Number(node.dataset.pid);
    render();
  });
  query("proc-write").addEventListener("submit", (event) => {
    event.preventDefault();
    transport.pause();
    const pid = Number(query("proc-write-pid").value);
    const raw = query("proc-value").value.trim();
    const value = raw ? Number(raw) : NaN;
    try {
      if (value < -9999 || value > 9999) throw new Error("数据值须在 -9999 到 9999 之间");
      model.writeMemory(pid, pid, DATA_VA, value);
      query("proc-memory-message").textContent = `PID ${pid} 的私有 .data 已写入 ${value}；其他实例仍保存自己的值。`;
      render();
    } catch (error) { query("proc-memory-message").textContent = error.message; }
  });
  render();
  window.ChCoreCases = window.ChCoreCases || {};
  window.ChCoreCases.programs = { title: "程序与进程", onLeave: () => transport.pause(), onEnter: render };
})();
