import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => Promise.withResolvers();

// Deterministic host time: no paid API requests or real multi-second waits.
function clock() {
  let now = 0, serial = 0;
  const timers = new Map();
  return {
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay = 0) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms = 0) {
      const end = now + ms;
      for (let turns = 0; ; turns++) {
        if (turns > 1000) throw new Error('Timer loop did not settle');
        await flush();
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]); next[1].fn();
      }
      now = end;
      await flush();
    },
    get count() { return timers.size; },
  };
}

async function fixture() {
  const time = clock();
  const window = new EventTarget();
  const host = {
    settings: { imageConcurrency: 1, autoGenerateImages: true, autoProcessReplies: true, autoImageDelay: 0 },
    context: { scope: 'card', chatId: 'chat-a', latestMessageId: 1 },
    ready: true, saving: false, events: [], reply: { messageId: 1, text: 'new reply' }, receive: null,
  };
  const context = vm.createContext({ window, AbortController, DOMException, Event, structuredClone,
    Date: time.Date, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  const stubs = {
    './settings.js': { currentPreferences: () => host.settings },
    './chat-host.js': {
      imageChatContext: () => host.context, isChatReadyForImages: () => host.ready,
      captureLatestAssistant: async () => ({ ...host.reply }), readLatestAssistantReply: () => host.reply,
      watchReplyGeneration: receive => { host.receive = receive; return () => { host.receive = null; }; },
    },
    './image-markers.js': { parseImageMarkers: text => text.includes('<img>') ? [{}] : [] },
    './model-settings.js': { isImageSizeModeSaving: () => host.saving },
    './pet-events.js': { emitPetEvent: event => host.events.push(event) },
  };
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const stub = stubs[name];
    const mod = stub
      ? new vm.SyntheticModule(Object.keys(stub), function() { for (const [key, value] of Object.entries(stub)) this.setExport(key, value); }, { context })
      : new vm.SourceTextModule(await readFile(new URL(`../dist/${name.replace('./', '')}`, import.meta.url), 'utf8'), { context, identifier: name });
    modules.set(name, mod);
    await mod.link(load);
    await mod.evaluate();
    return mod;
  }
  const queue = (await load('./image-queue.js')).namespace;
  const lifecycle = new AbortController();
  queue.bindImageQueuePreferences(lifecycle.signal);
  const automatic = (await load('./automatic-images.js')).namespace;
  const change = values => {
    Object.assign(host.settings, values);
    window.dispatchEvent(new Event('witch-paintbox:preferences-changed'));
  };
  function tasks() {
    const started = [], jobs = new Map(), results = [];
    return {
      started, jobs, results,
      add(id, progress) {
        const controller = new AbortController(), done = deferred();
        jobs.set(id, { controller, ...done });
        const result = queue.queueImageGeneration(() => { started.push(id); return done.promise; }, controller.signal, progress)
          .then(value => ({ value }), error => ({ error }));
        results.push(result);
        return result;
      },
      async finish(id, error = false) {
        const job = jobs.get(id);
        if (error) job.reject(new Error(id)); else job.resolve(id);
        await flush();
      },
    };
  }
  function dispatch() {
    const calls = [], jobs = new Map();
    let mounted = true;
    const api = automatic.automaticImages({
      mounted: () => mounted,
      generate(candidate, signal) {
        const done = deferred(); calls.push(candidate.entry.key);
        jobs.set(candidate.entry.key, { ...done, signal });
        return done.promise;
      },
    });
    api.update([], true);
    return { api, calls, jobs, mount(value) { mounted = value; } };
  }
  return { host, time, queue, change, tasks, dispatch, lifecycle, load };
}

const candidate = (key, start = 0, text = 'new reply', messageId = 1) => ({
  message: { messageId, text }, entry: { key, marker: { start } },
});

test('old preferences default to one image, invalid limits are rejected', async () => {
  const { readSettings, readImageConcurrency, defaultSettings } = await import('../dist/settings.js');
  const read = value => readSettings({ extensionSettings: { 'tavern-image-plugin': value } });
  assert.equal(defaultSettings().imageConcurrency, 1);
  const old = read({ autoProcessReplies: true, autoGenerateImages: true, autoImageDelay: 2.5 });
  assert.equal(old.imageConcurrency, 1);
  assert.equal(old.autoProcessReplies, true);
  assert.equal(old.autoGenerateImages, true);
  assert.equal(old.autoImageDelay, 2.5);
  assert.equal(read({ imageConcurrency: 4, lastPage: 'image-workflow' }).lastPage, 'image-workflow');
  for (const bad of [0, -1, 5, 1.5, '2', NaN, Infinity, null]) {
    assert.equal(readImageConcurrency(bad), null);
    assert.equal(read({ imageConcurrency: bad }).imageConcurrency, 1);
  }
});

test('shared FIFO starts up to the limit and fills a freed slot out of completion order', async () => {
  const f = await fixture(); f.change({ imageConcurrency: 2 });
  const tasks = f.tasks(), states = [];
  f.queue.onImageQueueChanged(state => states.push({ ...state }));
  for (const id of ['floor', 'portrait', 'preview', 'redraw']) tasks.add(id);
  assert.deepEqual(tasks.started, ['floor', 'portrait']);
  assert.equal(states.at(-1).active, 2); assert.equal(states.at(-1).queued, 2);
  await tasks.finish('portrait');
  assert.deepEqual(tasks.started, ['floor', 'portrait', 'preview']);
  await tasks.finish('preview'); await tasks.finish('floor'); await tasks.finish('redraw');
  assert.deepEqual(tasks.started, ['floor', 'portrait', 'preview', 'redraw']);
  assert.equal(states.at(-1).active, 0); assert.equal(states.at(-1).queued, 0);
  assert.deepEqual((await Promise.all(tasks.results)).map(result => result.value), ['floor', 'portrait', 'preview', 'redraw']);
});

test('raising the limit starts waiting work; lowering it preserves active requests', async () => {
  const f = await fixture(), tasks = f.tasks();
  for (const id of ['a', 'b', 'c', 'd']) tasks.add(id);
  assert.deepEqual(tasks.started, ['a']);
  f.change({ imageConcurrency: 3 });
  assert.deepEqual(tasks.started, ['a', 'b', 'c']);
  f.change({ imageConcurrency: 1 });
  assert.equal(tasks.jobs.get('a').controller.signal.aborted, false);
  await tasks.finish('b'); await tasks.finish('a');
  assert.deepEqual(tasks.started, ['a', 'b', 'c']);
  await tasks.finish('c');
  assert.deepEqual(tasks.started, ['a', 'b', 'c', 'd']);
  await tasks.finish('d');
});

test('cancellation, a failed request and a throwing progress callback do not block FIFO', async () => {
  const f = await fixture(), tasks = f.tasks();
  tasks.add('a', () => { throw new Error('view update failed'); });
  const cancelled = tasks.add('cancelled'); tasks.add('c');
  tasks.jobs.get('cancelled').controller.abort();
  assert.equal((await cancelled).error.name, 'AbortError');
  await tasks.finish('a', true);
  assert.deepEqual(tasks.started, ['a', 'c']);
  await tasks.finish('c');
  const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(f.queue.queueImageGeneration(() => assert.fail('must not send'), preAborted.signal), { name: 'AbortError' });
});

test('automatic images overlap, respect order and refill without retrying failures', async () => {
  const f = await fixture(); f.change({ imageConcurrency: 2 });
  const d = f.dispatch(), entries = [candidate('c', 30), candidate('a', 10), candidate('b', 20)];
  d.api.update(entries, true); await f.time.tick();
  assert.deepEqual(d.calls, ['a', 'b']);
  d.jobs.get('b').reject(new Error('provider failed')); await f.time.tick();
  assert.deepEqual(d.calls, ['a', 'b', 'c']);
  d.jobs.get('a').resolve(); d.jobs.get('c').resolve(); await f.time.tick();
  d.api.update(entries, true); await f.time.tick(5000);
  assert.deepEqual(d.calls, ['a', 'b', 'c']); d.api.dispose();
});

test('automatic interval preserves serial delay and spaces concurrent starts', async () => {
  const f = await fixture(); f.change({ autoImageDelay: 1 });
  const d = f.dispatch(), entries = [candidate('a'), candidate('b', 10), candidate('c', 20)];
  d.api.update(entries, true); await f.time.tick(999); assert.equal(d.calls.length, 0);
  await f.time.tick(1); assert.deepEqual(d.calls, ['a']);
  d.jobs.get('a').resolve(); await f.time.tick(999); assert.deepEqual(d.calls, ['a']);
  await f.time.tick(1); assert.deepEqual(d.calls, ['a', 'b']);
  f.change({ imageConcurrency: 2 }); d.api.update(entries, true);
  await f.time.tick(1000); assert.deepEqual(d.calls, ['a', 'b', 'c']); d.api.dispose();
});

test('automatic limit changes preserve active requests and allow immediate expansion', async () => {
  const f = await fixture(); f.change({ imageConcurrency: 3 });
  const d = f.dispatch(), entries = ['a', 'b', 'c', 'd', 'e'].map((id, i) => candidate(id, i));
  d.api.update(entries, true); await f.time.tick(); assert.equal(d.calls.length, 3);
  f.change({ imageConcurrency: 1 }); d.api.update(entries, true);
  d.jobs.get('b').resolve(); d.jobs.get('a').resolve(); await f.time.tick(); assert.equal(d.calls.length, 3);
  assert.equal(d.jobs.get('c').signal.aborted, false);
  f.change({ imageConcurrency: 3 }); d.api.update(entries, true); await f.time.tick();
  assert.deepEqual(d.calls, ['a', 'b', 'c', 'd', 'e']); d.api.dispose();
});

test('chat switches cancel every active automatic job and establish a history baseline', async () => {
  const f = await fixture(); f.change({ imageConcurrency: 2 }); const d = f.dispatch();
  d.api.update([candidate('a'), candidate('b', 1), candidate('waiting', 2)], true); await f.time.tick();
  f.host.context = { ...f.host.context, chatId: 'chat-b' };
  d.api.update([candidate('historical')], true);
  assert.equal(d.jobs.get('a').signal.aborted, true); assert.equal(d.jobs.get('b').signal.aborted, true);
  d.api.update([candidate('historical'), candidate('new')], true); await f.time.tick();
  assert.deepEqual(d.calls, ['a', 'b', 'new']);
  d.jobs.get('a').resolve(); d.jobs.get('b').resolve(); await f.time.tick();
  assert.equal(d.jobs.get('new').signal.aborted, false); d.api.dispose();
});

test('disabling and re-enabling auto images never backfills current markers', async () => {
  const f = await fixture(); const d = f.dispatch(), entries = [candidate('a'), candidate('b', 1)];
  d.api.update(entries, true); await f.time.tick();
  f.change({ autoGenerateImages: false }); d.api.update(entries, true);
  assert.equal(d.jobs.get('a').signal.aborted, true);
  f.change({ autoGenerateImages: true }); d.api.update(entries, true); await f.time.tick(5000);
  assert.deepEqual(d.calls, ['a']); d.api.dispose();
});

test('host busy, unmounted markers and pending size saves wait without sending requests', async () => {
  const f = await fixture(); f.host.ready = false; const d = f.dispatch(), entries = [candidate('a')];
  d.api.update(entries, true); await f.time.tick(1000); assert.equal(d.calls.length, 0);
  f.host.ready = true; f.host.saving = true; await f.time.tick(1000); assert.equal(d.calls.length, 0);
  f.host.saving = false; d.mount(false); await f.time.tick(1000); assert.equal(d.calls.length, 0);
  d.mount(true); d.api.update(entries, true); await f.time.tick(); assert.deepEqual(d.calls, ['a']); d.api.dispose();
});

test('an in-flight readiness check cannot launch after a chat reset', async () => {
  const f = await fixture(), ready = deferred(); f.host.ready = ready.promise; const d = f.dispatch();
  d.api.update([candidate('a')], true); await f.time.tick();
  f.host.context = { ...f.host.context, chatId: 'other' }; d.api.update([], true);
  ready.resolve(true); await f.time.tick(); assert.equal(d.calls.length, 0); d.api.dispose();
});

test('newer replies cancel old automatic requests and remove old waiting markers', async () => {
  const f = await fixture(); const d = f.dispatch();
  d.api.update([candidate('a'), candidate('b', 1)], true); await f.time.tick();
  f.host.context.latestMessageId = 2;
  d.api.update([candidate('a'), candidate('b', 1), candidate('new', 0, 'second reply', 2)], true);
  assert.equal(d.jobs.get('a').signal.aborted, true);
  d.jobs.get('a').resolve(); await f.time.tick(); assert.deepEqual(d.calls, ['a', 'new']); d.api.dispose();
});


test('completed reply waits for helper work, then writes tags once and dispatches concurrent images', async () => {
  const f = await fixture(); f.change({ imageConcurrency: 2 });
  const d = f.dispatch(), calls = [];
  const processor = { busy: false, async process(_selection, options) {
    calls.push(options.snapshot.text);
    f.host.reply = { ...f.host.reply, text: 'new reply <img>tags-a</img><img>tags-b</img>' };
    d.api.update([candidate('a', 0, f.host.reply.text), candidate('b', 10, f.host.reply.text)], true);
    return true;
  } };
  const { autoProcessReplies } = (await f.load('./auto-process.js')).namespace;
  autoProcessReplies(processor, f.lifecycle.signal, message => assert.fail(message));
  const reply = { kind: 'reply', target: { key: 'reply-1', matches: message => message.messageId === 1 } };
  f.host.receive(reply); f.host.receive({ kind: 'helper-start', id: 'variables' });
  await f.time.tick(5000); assert.equal(calls.length, 0);
  f.host.receive({ kind: 'helper-end', id: 'variables' });
  await f.time.tick(2999); assert.equal(calls.length, 0);
  await f.time.tick(501); assert.deepEqual(calls, ['new reply']); assert.deepEqual(d.calls, ['a', 'b']);
  f.host.receive(reply); await f.time.tick(5000); assert.equal(calls.length, 1);
  f.lifecycle.abort(); d.api.dispose();
});

test('stopped or disabled reply processing never sends a model request', async () => {
  const f = await fixture(); let requests = 0;
  const { autoProcessReplies } = (await f.load('./auto-process.js')).namespace;
  autoProcessReplies({ busy: false, async process() { ++requests; return true; } }, f.lifecycle.signal, message => assert.fail(message));
  const reply = { kind: 'reply', target: { key: 'reply-1', matches: () => true } };
  f.host.receive(reply); await f.time.tick(1000); f.host.receive({ kind: 'stopped' });
  await f.time.tick(5000); assert.equal(requests, 0);
  f.host.receive(reply); f.change({ autoProcessReplies: false });
  await f.time.tick(5000); assert.equal(requests, 0); f.lifecycle.abort();
});
