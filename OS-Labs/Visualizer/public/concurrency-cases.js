(function () {
  "use strict";

  const bounded = (value, minimum, maximum, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
  };

  class SynchronizationModel {
    constructor(capacity = 3, total = 6) {
      this.capacity = bounded(capacity, 1, 6, 3);
      this.total = bounded(total, 4, 12, 6);
      this.empty = this.capacity;
      this.full = 0;
      this.queue = [];
      this.produced = 0;
      this.consumed = 0;
      this.lockOwner = null;
      this.lockWaiters = [];
      this.history = [];
      this.autoTurn = "consumer";
      this.workers = {
        producer: { phase: "wait-empty", state: "ready", waitingOn: null, reserved: false, pending: false, completed: 0 },
        consumer: { phase: "wait-full", state: "ready", waitingOn: null, reserved: false, pending: false, completed: 0 },
      };
    }

    get done() { return this.workers.producer.state === "done" && this.workers.consumer.state === "done"; }

    record(worker, action, detail) {
      this.history.push({ number: this.history.length + 1, worker, action, detail, empty: this.empty, full: this.full, size: this.queue.length });
    }

    block(id, target) {
      const worker = this.workers[id];
      worker.state = "blocked";
      worker.waitingOn = target;
      if (target === "lock" && !this.lockWaiters.includes(id)) this.lockWaiters.push(id);
      this.record(id, "阻塞", target === "lock" ? "缓冲区锁已被占用，加入等待队列" : `${target} = 0，等待资源`);
    }

    signal(id, target, receiver) {
      const waiter = this.workers[receiver];
      if (waiter.state === "blocked" && waiter.waitingOn === target) {
        waiter.state = "ready";
        waiter.waitingOn = null;
        waiter.reserved = true;
        waiter.phase = "lock";
        this.record(id, `signal(${target})`, `资源直接交给${receiver === "producer" ? "生产者" : "消费者"}，计数保持 0`);
        this.record(receiver, "唤醒", `wait(${target}) 完成，下一步申请缓冲区锁`);
      } else {
        this[target] += 1;
        this.record(id, `signal(${target})`, `${target} 增加到 ${this[target]}`);
      }
    }

    unlock(id) {
      this.lockOwner = null;
      this.record(id, "unlock", "离开缓冲区临界区");
      const next = this.lockWaiters.shift();
      if (next) {
        const worker = this.workers[next];
        worker.state = "ready";
        worker.waitingOn = null;
        worker.phase = "operate";
        this.lockOwner = next;
        this.record(next, "唤醒并获锁", "从锁等待队列进入临界区");
      }
    }

    step(id) {
      const worker = this.workers[id];
      if (!worker || worker.state === "done" || worker.state === "blocked") return false;
      if (worker.phase === "wait-empty" || worker.phase === "wait-full") {
        const semaphore = id === "producer" ? "empty" : "full";
        if (this[semaphore] === 0) this.block(id, semaphore);
        else {
          this[semaphore] -= 1;
          worker.reserved = true;
          worker.phase = "lock";
          this.record(id, `wait(${semaphore})`, `获得 1 份资源，${semaphore} = ${this[semaphore]}`);
        }
      } else if (worker.phase === "lock") {
        if (this.lockOwner && this.lockOwner !== id) this.block(id, "lock");
        else {
          this.lockOwner = id;
          worker.phase = "operate";
          this.record(id, "lock", "获得缓冲区锁，进入临界区");
        }
      } else if (worker.phase === "operate") {
        worker.reserved = false;
        worker.pending = true;
        worker.phase = "unlock";
        if (id === "producer") {
          const item = ++this.produced;
          this.queue.push(item);
          this.record(id, "放入数据", `数据 #${item} 入队，缓冲区占用 ${this.queue.length}/${this.capacity}`);
        } else {
          const item = this.queue.shift();
          this.consumed += 1;
          this.record(id, "取出数据", `数据 #${item} 出队，缓冲区占用 ${this.queue.length}/${this.capacity}`);
        }
      } else if (worker.phase === "unlock") {
        this.unlock(id);
        worker.phase = "signal";
      } else if (worker.phase === "signal") {
        worker.pending = false;
        this.signal(id, id === "producer" ? "full" : "empty", id === "producer" ? "consumer" : "producer");
        worker.completed += 1;
        worker.phase = id === "producer" ? "wait-empty" : "wait-full";
        if (worker.completed === this.total) worker.state = "done";
        if (id === "consumer") this.autoTurn = "producer";
      }
      this.assertInvariants();
      return true;
    }

    autoStep() {
      if (this.done) return false;
      const opposite = this.autoTurn === "producer" ? "consumer" : "producer";
      if (this.workers[this.autoTurn].state === "blocked" || this.workers[this.autoTurn].state === "done") this.autoTurn = opposite;
      const changed = this.step(this.autoTurn);
      if (this.workers[this.autoTurn].state === "blocked" || this.workers[this.autoTurn].state === "done") this.autoTurn = this.autoTurn === "producer" ? "consumer" : "producer";
      return changed;
    }

    assertInvariants() {
      const producer = this.workers.producer;
      const consumer = this.workers.consumer;
      const valid = this.empty >= 0 && this.full >= 0 && this.queue.length <= this.capacity
        && this.empty + this.queue.length + Number(producer.reserved) + Number(consumer.pending) === this.capacity
        && this.full + Number(consumer.reserved) + Number(producer.pending) === this.queue.length
        && this.produced - this.consumed === this.queue.length
        && this.produced <= this.total && this.consumed <= this.total;
      if (!valid) throw new Error("生产者消费者模型的资源计数不守恒");
      return true;
    }
  }

  class MutexModel {
    constructor(mode = "unlocked", iterations = 2) {
      this.mode = mode === "locked" ? "locked" : "unlocked";
      this.iterations = bounded(iterations, 1, 5, 2);
      this.counter = 0;
      this.owner = null;
      this.waiters = [];
      this.history = [];
      this.autoTurn = "A";
      const initial = this.mode === "locked" ? "lock" : "load";
      this.workers = {
        A: { phase: initial, state: "ready", local: null, completed: 0 },
        B: { phase: initial, state: "ready", local: null, completed: 0 },
      };
    }

    get expected() { return this.iterations * 2; }
    get done() { return this.workers.A.state === "done" && this.workers.B.state === "done"; }

    record(id, action, detail) {
      this.history.push({ number: this.history.length + 1, worker: id, action, detail, counter: this.counter, owner: this.owner });
    }

    finish(id) {
      const worker = this.workers[id];
      worker.completed += 1;
      worker.state = worker.completed === this.iterations ? "done" : "ready";
      worker.phase = this.mode === "locked" ? "lock" : "load";
    }

    step(id) {
      const worker = this.workers[id];
      if (!worker || worker.state === "done" || worker.state === "blocked") return false;
      if (worker.phase === "lock") {
        if (this.owner !== null && this.owner !== id) {
          worker.state = "blocked";
          this.waiters.push(id);
          this.record(id, "等待互斥锁", `线程 ${this.owner} 持锁，线程 ${id} 阻塞`);
        } else {
          this.owner = id;
          worker.phase = "load";
          this.record(id, "lock", `线程 ${id} 进入临界区`);
        }
      } else if (worker.phase === "load") {
        worker.local = this.counter;
        worker.phase = "increment";
        this.record(id, "LOAD", `local_${id} ← counter = ${this.counter}`);
      } else if (worker.phase === "increment") {
        worker.local += 1;
        worker.phase = "store";
        this.record(id, "ADD", `local_${id} ← ${worker.local}`);
      } else if (worker.phase === "store") {
        const before = this.counter;
        this.counter = worker.local;
        this.record(id, "STORE", `counter: ${before} → ${this.counter}${before === this.counter ? "，另一线程的更新被覆盖" : ""}`);
        if (this.mode === "locked") worker.phase = "unlock";
        else this.finish(id);
      } else if (worker.phase === "unlock") {
        this.owner = null;
        this.finish(id);
        this.record(id, "unlock", `线程 ${id} 离开临界区`);
        const next = this.waiters.shift();
        if (next) {
          this.owner = next;
          this.workers[next].state = "ready";
          this.workers[next].phase = "load";
          this.record(next, "唤醒并获锁", `锁交给等待线程 ${next}`);
        }
      }
      this.assertInvariants();
      return true;
    }

    autoStep() {
      if (this.done) return false;
      let id = this.autoTurn;
      if (this.workers[id].state === "blocked" || this.workers[id].state === "done") id = id === "A" ? "B" : "A";
      this.autoTurn = id === "A" ? "B" : "A";
      return this.step(id);
    }

    assertInvariants() {
      const within = this.counter >= 0 && this.counter <= this.expected;
      const ownerValid = this.owner === null || (this.workers[this.owner].state !== "blocked" && this.workers[this.owner].state !== "done");
      const onlyOwnerExecutes = this.mode !== "locked" || Object.entries(this.workers).every(([id, worker]) => worker.phase === "lock" || worker.state === "done" || id === this.owner);
      const waitersValid = this.waiters.length === new Set(this.waiters).size && this.waiters.every((id) => this.workers[id].state === "blocked");
      if (!within || !ownerValid || !onlyOwnerExecutes || !waitersValid) throw new Error("互斥锁模型出现无效状态");
      if (this.done && this.mode === "locked" && this.counter !== this.expected) throw new Error("互斥锁未保护共享计数器");
      return true;
    }
  }

  window.OSModels = Object.assign(window.OSModels || {}, { SynchronizationModel, MutexModel });
  if (typeof document === "undefined" || !window.OSDemo) return;

  const { mount, icon, player } = window.OSDemo;
  const $ = (id) => document.getElementById(id);
  const node = (tag, className, value) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  };
  const transport = (prefix) => `<div class="transport"><button class="icon-button" id="${prefix}-reset" aria-label="重置案例" title="重置案例">${icon("rotate-ccw")}</button><button class="play-button" id="${prefix}-play" aria-label="自动运行" title="自动运行">${icon("play")}</button><button class="icon-button" id="${prefix}-step" aria-label="下一步" title="下一步">${icon("skip-forward")}</button></div><label>速度<select id="${prefix}-speed"><option value="900">慢</option><option value="500" selected>中</option><option value="200">快</option></select></label>`;
  const stateNames = { ready: "就绪", blocked: "阻塞", done: "完成" };
  const syncPhases = { producer: ["wait-empty", "lock", "operate", "unlock", "signal"], consumer: ["wait-full", "lock", "operate", "unlock", "signal"] };
  const syncInstructions = { producer: ["wait(empty)", "lock", "buffer.push", "unlock", "signal(full)"], consumer: ["wait(full)", "lock", "buffer.pop", "unlock", "signal(empty)"] };
  const workerLane = (prefix, id, title) => `<div class="case-lane concurrency-worker" id="${prefix}-${id}-lane"><div class="case-row"><h3>${title}</h3><span class="case-status" id="${prefix}-${id}-state"></span></div><div class="concurrency-instructions" id="${prefix}-${id}-instructions"></div><div class="case-row"><span class="concurrency-worker-detail" id="${prefix}-${id}-detail"></span><button class="concurrency-step-button" id="${prefix}-${id}-step">${icon("skip-forward")}<span>${title}一步</span></button></div></div>`;
  const historyTable = (prefix, headers) => `<div class="section-heading"><h2>执行记录</h2><span class="mini-label" id="${prefix}-events"></span></div><div class="case-log concurrency-log"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody id="${prefix}-history"></tbody></table></div>`;
  function renderHistory(prefix, history, values) {
    const body = $(`${prefix}-history`);
    body.replaceChildren();
    history.slice(-12).forEach((event) => {
      const row = node("tr");
      values(event).forEach((value) => row.append(node("td", "", value)));
      body.append(row);
    });
    $(`${prefix}-events`).textContent = `${history.length} 条事件 · 最近 12 条`;
  }
  function renderInstructions(prefix, id, worker, phases, instructions) {
    const list = $(`${prefix}-${id}-instructions`);
    list.replaceChildren();
    instructions.forEach((instruction, index) => {
      const item = node("code", "concurrency-instruction", instruction);
      if (worker.phase === phases[index] && worker.state !== "done") item.classList.add("current");
      list.append(item);
    });
    const lane = $(`${prefix}-${id}-lane`);
    lane.classList.toggle("blocked", worker.state === "blocked");
    lane.classList.toggle("completed", worker.state === "done");
    $(`${prefix}-${id}-state`).textContent = stateNames[worker.state];
    $(`${prefix}-${id}-step`).disabled = worker.state === "blocked" || worker.state === "done";
  }

  mount("synchronization", {
    number: "05", title: "同步与信号量", subtitle: "生产者 / 消费者 · 有界缓冲区",
    sourceNote: "教学模型 · 信号量安排资源和执行顺序，锁保护缓冲区操作；ChCore 的等待与唤醒接口见 kernel/include/ipc/futex.h。",
    body: `<div class="case-controls"><label>缓冲区容量<input type="number" id="sync-capacity" min="1" max="6" value="3"></label><label>数据数量<input type="number" id="sync-total" min="4" max="12" value="6"></label>${transport("sync")}<span class="case-status" id="sync-progress"></span></div><div class="case-grid"><div><div class="section-heading"><h2>有界缓冲区</h2><span class="mini-label" id="sync-occupancy"></span></div><div class="case-stage concurrency-buffer"><div class="concurrency-slots" id="sync-slots"></div><div class="case-row concurrency-buffer-foot"><span>FIFO 队列</span><span id="sync-owner"></span></div></div>${workerLane("sync", "producer", "生产者")}${workerLane("sync", "consumer", "消费者")}<p class="case-note" id="sync-note" aria-live="polite"></p>${historyTable("sync", ["#", "线程", "操作", "empty", "full"])}</div><aside><div class="section-heading"><h2>资源计数</h2></div><dl class="case-stats"><div><dt>empty · 空槽</dt><dd id="sync-empty"></dd></div><div><dt>full · 可用数据</dt><dd id="sync-full"></dd></div><div><dt>已生产</dt><dd id="sync-produced"></dd></div><div><dt>已消费</dt><dd id="sync-consumed"></dd></div><div><dt>锁等待队列</dt><dd id="sync-waiters"></dd></div></dl><div class="concurrency-semaphore-key"><h3>empty / full</h3><p>wait 获得一份资源；计数为 0 时阻塞。signal 释放资源并唤醒等待者。</p><h3>buffer lock</h3><p>一次只允许一个线程修改队列。资源已被预留时，信号量计数可以与槽位占用不同。</p></div></aside></div>`,
  });
  let sync = new SynchronizationModel();
  let syncPlayer;
  function renderSync() {
    $("sync-slots").replaceChildren();
    for (let index = 0; index < sync.capacity; index += 1) {
      const item = sync.queue[index];
      const slot = node("div", `concurrency-slot${item === undefined ? " empty" : " filled"}`);
      slot.append(node("small", "", `槽位 ${index + 1}`), node("strong", "", item === undefined ? "空" : `#${item}`));
      $("sync-slots").append(slot);
    }
    $("sync-empty").textContent = sync.empty;
    $("sync-full").textContent = sync.full;
    $("sync-produced").textContent = `${sync.produced} / ${sync.total}`;
    $("sync-consumed").textContent = `${sync.consumed} / ${sync.total}`;
    $("sync-owner").textContent = sync.lockOwner ? `持锁：${sync.lockOwner === "producer" ? "生产者" : "消费者"}` : "缓冲区锁空闲";
    $("sync-waiters").textContent = sync.lockWaiters.map((id) => id === "producer" ? "生产者" : "消费者").join(" → ") || "空";
    $("sync-occupancy").textContent = `${sync.queue.length} / ${sync.capacity} 槽位`;
    $("sync-progress").textContent = sync.done ? "全部消费完成" : "实验进行中";
    const event = sync.history[sync.history.length - 1];
    $("sync-note").textContent = event ? `${event.worker === "producer" ? "生产者" : "消费者"} · ${event.action}：${event.detail}` : "初始状态：缓冲区为空，empty = 容量，full = 0。";
    Object.entries(sync.workers).forEach(([id, worker]) => {
      renderInstructions("sync", id, worker, syncPhases[id], syncInstructions[id]);
      const pending = worker.reserved ? " · 已预留资源" : worker.pending ? " · 等待 signal" : "";
      $("sync-" + id + "-detail").textContent = `完成 ${worker.completed}/${sync.total}${pending}${worker.waitingOn ? ` · 等待 ${worker.waitingOn}` : ""}`;
    });
    renderHistory("sync", sync.history, (entry) => [entry.number, entry.worker === "producer" ? "生产者" : "消费者", entry.action, entry.empty, entry.full]);
  }
  function resetSync() {
    sync = new SynchronizationModel($("sync-capacity").value, $("sync-total").value);
    $("sync-capacity").value = sync.capacity;
    $("sync-total").value = sync.total;
  }
  syncPlayer = player("sync", { step: () => sync.autoStep(), reset: resetSync, done: () => sync.done, render: renderSync });
  ["sync-capacity", "sync-total"].forEach((id) => $(id).addEventListener("change", () => syncPlayer.reset()));
  ["producer", "consumer"].forEach((id) => $("sync-" + id + "-step").addEventListener("click", () => { syncPlayer.pause(); sync.step(id); syncPlayer.refresh(); }));

  mount("mutex", {
    number: "06", title: "互斥与竞态", subtitle: "共享计数器 · 两个线程的一次读改写",
    sourceNote: "教学模型 · 用户态互斥锁可借助 futex 等待与唤醒；ChCore 提供 CHCORE_SYS_futex（kernel/user-include/uapi/syscall_num.h）。",
    body: `<div class="case-controls"><fieldset class="concurrency-modes"><legend class="sr-only">计数器保护方式</legend><label><input name="mutex-mode" type="radio" value="unlocked" checked><span>无锁</span></label><label><input name="mutex-mode" type="radio" value="locked"><span>互斥锁</span></label></fieldset><label>每线程次数<input type="number" id="mutex-iterations" min="1" max="5" value="2"></label>${transport("mutex")}<span class="case-status" id="mutex-progress"></span></div><div class="case-grid"><div><div class="case-stage concurrency-critical" id="mutex-critical"><div class="case-row"><span>共享内存 · counter</span><span class="case-status" id="mutex-owner"></span></div><div class="concurrency-counter" id="mutex-counter">0</div><div class="case-row concurrency-buffer-foot"><span id="mutex-result"></span><span id="mutex-waiters"></span></div></div>${workerLane("mutex", "A", "线程 A")}${workerLane("mutex", "B", "线程 B")}<p class="case-note" id="mutex-note" aria-live="polite"></p>${historyTable("mutex", ["#", "线程", "指令", "counter", "持锁者"])}</div><aside><div class="section-heading"><h2>共享状态</h2></div><dl class="case-stats"><div><dt>期望最终值</dt><dd id="mutex-expected"></dd></div><div><dt>当前计数</dt><dd id="mutex-current"></dd></div><div><dt>已完成写入</dt><dd id="mutex-stores"></dd></div><div><dt>丢失的更新</dt><dd id="mutex-lost"></dd></div><div><dt>local_A</dt><dd id="mutex-local-A"></dd></div><div><dt>local_B</dt><dd id="mutex-local-B"></dd></div></dl><div class="concurrency-semaphore-key"><h3>读 → 改 → 写</h3><p>counter++ 包含多个步骤。两个线程可能读到相同旧值，随后写入同一个新值。</p><h3>临界区</h3><p>互斥锁保护完整的读改写过程。持锁线程完成后，等待线程才能读取最新值。</p></div></aside></div>`,
  });
  let mutex = new MutexModel();
  let mutexPlayer;
  function renderMutex() {
    const stores = mutex.history.filter((entry) => entry.action === "STORE").length;
    $("mutex-counter").textContent = mutex.counter;
    $("mutex-current").textContent = mutex.counter;
    $("mutex-expected").textContent = mutex.expected;
    $("mutex-stores").textContent = `${stores} / ${mutex.expected}`;
    $("mutex-lost").textContent = Math.max(0, stores - mutex.counter);
    $("mutex-owner").textContent = mutex.mode === "unlocked" ? "无锁保护" : mutex.owner ? `线程 ${mutex.owner} 持锁` : "锁空闲";
    $("mutex-waiters").textContent = `等待队列：${mutex.waiters.join(" → ") || "空"}`;
    $("mutex-result").textContent = mutex.done ? `最终 ${mutex.counter} / 期望 ${mutex.expected}` : `目标值 ${mutex.expected}`;
    $("mutex-progress").textContent = mutex.done ? mutex.counter === mutex.expected ? "计数正确" : "发生丢失更新" : "实验进行中";
    $("mutex-critical").classList.toggle("protected", mutex.mode === "locked");
    $("mutex-critical").classList.toggle("has-loss", stores > mutex.counter);
    const event = mutex.history[mutex.history.length - 1];
    $("mutex-note").textContent = event ? `线程 ${event.worker} · ${event.action}：${event.detail}` : "初始状态：counter = 0，两个线程尚未读取共享值。";
    Object.entries(mutex.workers).forEach(([id, worker]) => {
      const phases = mutex.mode === "locked" ? ["lock", "load", "increment", "store", "unlock"] : ["load", "increment", "store"];
      const instructions = mutex.mode === "locked" ? ["lock", "LOAD", "ADD", "STORE", "unlock"] : ["LOAD", "ADD", "STORE"];
      renderInstructions("mutex", id, worker, phases, instructions);
      $("mutex-" + id + "-lane").classList.toggle("owns-lock", mutex.owner === id);
      $("mutex-" + id + "-detail").textContent = `local_${id} = ${worker.local === null ? "未读取" : worker.local} · 完成 ${worker.completed}/${mutex.iterations}`;
      $("mutex-local-" + id).textContent = worker.local === null ? "未读取" : worker.local;
    });
    renderHistory("mutex", mutex.history, (entry) => [entry.number, entry.worker, entry.action, entry.counter, entry.owner || "—"]);
  }
  function resetMutex() {
    const mode = document.querySelector('input[name="mutex-mode"]:checked').value;
    mutex = new MutexModel(mode, $("mutex-iterations").value);
    $("mutex-iterations").value = mutex.iterations;
  }
  mutexPlayer = player("mutex", { step: () => mutex.autoStep(), reset: resetMutex, done: () => mutex.done, render: renderMutex });
  document.querySelectorAll('input[name="mutex-mode"]').forEach((input) => input.addEventListener("change", () => mutexPlayer.reset()));
  $("mutex-iterations").addEventListener("change", () => mutexPlayer.reset());
  ["A", "B"].forEach((id) => $("mutex-" + id + "-step").addEventListener("click", () => { mutexPlayer.pause(); mutex.step(id); mutexPlayer.refresh(); }));
  window.ChCoreCases = Object.assign(window.ChCoreCases || {}, {
    synchronization: { title: "同步与信号量", onLeave: () => syncPlayer.pause() },
    mutex: { title: "互斥与竞态", onLeave: () => mutexPlayer.pause() },
  });
})();
