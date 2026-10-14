"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({ window: {} });
for (const file of ["concurrency-cases.js", "program-cases.js", "io-cases.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "public", file), "utf8"), context, { filename: file });
}
const { SynchronizationModel, MutexModel, ProgramModel, InterruptModel, DMAComparisonModel, PollingComparisonModel } = context.window.OSModels;
let configurations = 0;

function run(model, step = () => model.step(), check = () => {}, limit = 2000) {
  let steps = 0;
  while (!model.done && steps++ < limit) { step(); check(); }
  assert.ok(model.done, `${model.constructor.name} exceeded its progress bound`);
  configurations += 1;
}
function random(seed) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function checkSync(model) {
  const { producer, consumer } = model.workers;
  assert.ok(model.empty >= 0 && model.full >= 0 && model.queue.length <= model.capacity);
  assert.equal(model.empty + model.queue.length + Number(producer.reserved) + Number(consumer.pending), model.capacity);
  assert.equal(model.full + Number(consumer.reserved) + Number(producer.pending), model.queue.length);
  assert.equal(model.produced - model.consumed, model.queue.length);
  assert.ok(model.queue.every((item, index) => !index || model.queue[index - 1] < item), "queue preserves FIFO order");
  model.assertInvariants();
}
for (let capacity = 1; capacity <= 6; capacity += 1) for (let total = 4; total <= 12; total += 1) {
  const model = new SynchronizationModel(capacity, total);
  model.step("consumer");
  assert.equal(model.workers.consumer.state, "blocked");
  assert.equal(model.workers.consumer.waitingOn, "full");
  run(model, () => model.autoStep(), () => checkSync(model));
  assert.equal(model.consumed, total);
  assert.equal(model.empty, capacity);
  assert.equal(model.full, 0);
}
for (let seed = 1; seed <= 100; seed += 1) {
  const choose = random(seed), model = new SynchronizationModel(seed % 6 + 1, seed % 9 + 4);
  run(model, () => model.step(choose() < 0.5 ? "producer" : "consumer"), () => checkSync(model));
}
for (let iterations = 1; iterations <= 5; iterations += 1) for (const mode of ["unlocked", "locked"]) {
  const model = new MutexModel(mode, iterations);
  run(model, () => model.autoStep(), () => model.assertInvariants());
  assert.equal(model.counter, mode === "locked" ? model.expected : iterations);
  assert.equal(model.history.filter((event) => event.action === "STORE").length, model.expected);
  assert.equal(model.owner, null);
}
for (let seed = 1; seed <= 100; seed += 1) {
  const choose = random(seed), model = new MutexModel("locked", seed % 5 + 1);
  run(model, () => model.step(choose() < 0.5 ? "A" : "B"), () => model.assertInvariants());
  assert.equal(model.counter, model.expected);
}

for (const program of ["hello_world.bin", "test_pthread.bin"]) for (const blocking of [false, true]) {
  const model = new ProgramModel({ program, blocking }), seen = new Set(["CREATED"]);
  let loadSteps = 0;
  while (model.processes.some((process) => process.regions.length < 4) && loadSteps++ < 20) model.step();
  assert.ok(model.processes.every((process) => process.regions.length === 4), "programs must finish loading");
  const [first, second] = model.processes;
  assert.notEqual(first.dataPA, second.dataPA);
  const otherValue = model.readMemory(second.pid, second.pid);
  model.writeMemory(first.pid, first.pid, 0x500000, 99);
  assert.equal(model.readMemory(first.pid, first.pid), 99);
  assert.equal(model.readMemory(second.pid, second.pid), otherValue);
  assert.throws(() => model.readMemory(first.pid, second.pid));
  assert.throws(() => model.writeMemory(first.pid, first.pid, 0x400000, 1));
  assert.throws(() => model.readMemory(first.pid, first.pid, 0x1000));
  assert.throws(() => model.writeMemory(first.pid, first.pid, 0x500000, 1.5));
  run(model, () => model.step(), () => {
    model.processes.forEach((process) => seen.add(process.state));
    assert.ok(model.processes.filter((process) => process.state === "RUNNING").length <= 1);
  }, 80);
  for (const state of ["READY", "RUNNING", "EXITED"]) assert.ok(seen.has(state));
  assert.equal(seen.has("BLOCKED"), blocking);
  assert.equal(model.liveObjects, 0);
  assert.ok(model.processes.every((process) => !process.regions.length && !Object.keys(process.memory).length && process.registers.pc === null));
  assert.throws(() => model.readMemory(first.pid, first.pid));
  const tick = model.tick; model.step(); assert.equal(model.tick, tick);
  model.reset(); assert.equal(model.processes.length, 2); assert.equal(model.tick, 0);
}
const processLimit = new ProgramModel();
assert.throws(() => processLimit.addProcess("unknown.bin"));
processLimit.addProcess(); processLimit.addProcess();
assert.equal(processLimit.addProcess(), null);
run(processLimit, undefined, undefined, 120);

for (let period = 2; period <= 12; period += 1) for (const masked of [false, true]) {
  const model = new InterruptModel({ period, masked });
  const invariant = () => {
    assert.equal(model.handled + model.coalesced + Number(model.pending), model.generated);
    assert.equal(model.el, ["vector", "handler", "return"].includes(model.phase) ? 1 : 0);
  };
  run(model, undefined, invariant, 120);
  assert.equal(model.generated, 4);
  assert.ok(model.instructions >= 12);
  assert.equal(model.events.some((event) => event.el === 1), !masked);
  if (masked) {
    assert.equal(model.handled, 0); assert.equal(model.pending, true);
    model.masked = false;
    run(model, undefined, invariant, 20);
    assert.equal(model.handled, 1);
  }
  assert.equal(model.pending, false);
}
for (let words = 4; words <= 16; words += 1) for (let burst = 1; burst <= 4; burst += 1) {
  const model = new DMAComparisonModel({ words, burst });
  run(model, undefined, () => {
    assert.equal(model.cpuBusy + model.cpuUseful, model.tick);
    assert.equal(model.dmaBusy + model.dmaUseful, model.tick);
    assert.equal(model.cpuBusy, model.cpuCopied);
    for (const memory of [model.cpuMemory, model.dmaMemory]) assert.ok(memory.every((value, index) => value === null || value === model.source[index]));
  }, 40);
  for (const memory of [model.cpuMemory, model.dmaMemory]) assert.deepEqual(Array.from(memory), Array.from(model.source));
  assert.equal(model.cpuDoneAt, words);
  assert.equal(model.dmaDoneAt, Math.ceil(words / burst) + 3);
  assert.equal(model.dmaBusy, 3);
}
for (let delay = 2; delay <= 12; delay += 1) {
  const model = new PollingComparisonModel({ delay });
  run(model, undefined, () => {
    assert.equal(model.pollBusy + model.pollUseful, model.tick);
    assert.equal(model.irqBusy + model.irqUseful, model.tick);
  }, 40);
  assert.equal(model.pollCopied, 4); assert.equal(model.irqCopied, 4);
  assert.equal(model.pollChecks, delay); assert.equal(model.irqChecks, 1);
  assert.equal(model.pollBusy, delay + 4); assert.equal(model.irqBusy, 6);
  assert.equal(model.pollDoneAt, delay + 4); assert.equal(model.irqDoneAt, delay + 5);
}
console.log(`Passed ${configurations} model configurations and deterministic interleavings.`);
