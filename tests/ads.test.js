import assert from 'node:assert/strict';
import { setMaxListeners } from 'node:events';
import { beforeEach, test } from 'node:test';

// Script tags the module added, recorded instead of fetched.
let added;
let shown;
let online = true;

const storage = new Map();
let storageReadable = true;
globalThis.localStorage = {
  getItem: (k) => {
    if (!storageReadable) throw new Error('blocked');
    return storage.get(k) ?? null;
  },
};

Object.defineProperty(globalThis, 'navigator', { get: () => ({ onLine: online }) });

let now = 0;
Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });

// The window's size, as the rail's media queries see it.
let screenSize = '300x600';
const queries = new Map();
globalThis.matchMedia = (query) => {
  if (!queries.has(query)) {
    const list = new EventTarget();
    Object.defineProperty(list, 'matches', {
      get: () => (query.includes('1466px') ? screenSize === '300x600' : screenSize !== null),
    });
    queries.set(query, list);
  }
  return queries.get(query);
};
const resize = (size) => {
  screenSize = size;
  for (const list of queries.values()) list.dispatchEvent(new Event('change'));
};

// The window's events: the rail waits for the visitor's first drag, wheel, tap, or key press.
const events = new EventTarget();
// Each fresh copy of the module adds its own listeners.
setMaxListeners(Infinity, events);
const press = (type = 'keydown') => events.dispatchEvent(new Event(type));

// A minimal page: the module only creates script tags and adds them to `head`.
const body = new Set();
class FakeNode extends EventTarget {
  removed = false;
  style = {};
  dataset = {};
  get isConnected() {
    return body.has(this);
  }
  remove() {
    this.removed = true;
    body.delete(this);
  }
}
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: events.addEventListener.bind(events),
  document: {
    cookie: '',
    createElement: () => new FakeNode(),
    head: { appendChild: (el) => added.push(el) },
  },
});

const tick = () => new Promise((resolve) => setTimeout(resolve));
let fresh = 0;
// A new copy of the module, so each test starts with no loader.
const loadAds = () => import(`../ads.js?${fresh++}`);
// An ad box attached to the page.
const box = () => {
  const el = new FakeNode();
  body.add(el);
  return el;
};

beforeEach(() => {
  added = [];
  body.clear();
  shown = [];
  online = true;
  storage.clear();
  storageReadable = true;
  document.cookie = '';
  now = 0;
  screenSize = '300x600';
  queries.clear();
  Object.assign(globalThis, {
    ihtfyAds: { show: (...args) => shown.push(args) },
  });
});

test('the loader is added once, then gets each box', async () => {
  const { showAd } = await loadAds();
  const a = box();
  showAd(a, 'a');
  showAd(a, 'b');
  assert.equal(added.length, 1);
  assert.equal(added[0].src, 'https://ihtfy.com/ads/v1.js');
  added[0].dispatchEvent(new Event('load'));
  await tick();
  assert.deepEqual(shown, [
    [a, 'a'],
    [a, 'b'],
  ]);
});

test('nothing loads offline', async () => {
  online = false;
  const { showAd } = await loadAds();
  showAd(box(), 'a');
  assert.equal(added.length, 0);
});

test('a failed load stays quiet, and the next opening tries again', async () => {
  const { showAd } = await loadAds();
  showAd(box(), 'a');
  added[0].dispatchEvent(new Event('error'));
  await tick();
  assert.equal(shown.length, 0);
  assert.equal(added[0].removed, true);
  showAd(box(), 'b');
  assert.equal(added.length, 2);
});

test('a box removed before the loader arrives gets no ad, so its replacement can', async () => {
  const { showAd } = await loadAds();
  const a = box();
  const b = box();
  showAd(a, 'same');
  a.remove();
  showAd(b, 'same');
  added[0].dispatchEvent(new Event('load'));
  await tick();
  assert.deepEqual(shown, [[b, 'same']]);
});

test('loadForBuyer loads nothing for a visitor without an ad-free token', async () => {
  const { loadForBuyer } = await loadAds();
  loadForBuyer();
  assert.equal(added.length, 0);
});

test('loadForBuyer loads the loader at startup when localStorage holds a token', async () => {
  storage.set('ihtfy-ad-free', 'token');
  const { loadForBuyer, showAd } = await loadAds();
  loadForBuyer();
  assert.equal(added.length, 1);
  assert.equal(added[0].src, 'https://ihtfy.com/ads/v1.js');
  showAd(box(), 'a');
  assert.equal(added.length, 1);
});

test('loadForBuyer loads the loader at startup when only the cookie holds a token', async () => {
  document.cookie = 'a=b; ihtfy-ad-free=token';
  const { loadForBuyer } = await loadAds();
  loadForBuyer();
  assert.equal(added.length, 1);
});

test('loadForBuyer still finds the cookie when storage cannot be read', async () => {
  storageReadable = false;
  document.cookie = 'ihtfy-ad-free=token';
  const { loadForBuyer } = await loadAds();
  loadForBuyer();
  assert.equal(added.length, 1);
});

// The aside on the right edge, holding the boxes the rail adds.
const rail = () => {
  const el = { hidden: true, boxes: [] };
  el.append = (child) => {
    body.add(child);
    el.boxes.push(child);
  };
  return el;
};
const current = (el) => el.boxes.filter((b) => b.isConnected);

test('the rail gets a box of the window size, and loads nothing before the first input', async () => {
  const { startRail, PLAY_AD_SLOT } = await loadAds();
  const el = rail();
  startRail(el);
  assert.equal(el.hidden, false);
  const [a] = current(el);
  assert.deepEqual(a.style, { width: '300px', height: '600px' });
  assert.deepEqual(a.dataset, { adSlot: PLAY_AD_SLOT, adSize: '300x600' });
  await tick();
  assert.equal(added.length, 0);
  press();
  await tick();
  assert.equal(added.length, 1);
  added[0].dispatchEvent(new Event('load'));
  await tick();
  assert.deepEqual(shown, [[a, 'play/1']]);
});

for (const type of ['pointerdown', 'wheel', 'keydown']) {
  test(`a ${type} is a first input`, async () => {
    const { startRail } = await loadAds();
    startRail(rail());
    press(type);
    await tick();
    assert.equal(added.length, 1);
  });
}

test('a buyer or a narrow window gets no rail box', async () => {
  const { startRail } = await loadAds();
  screenSize = null;
  const narrow = rail();
  startRail(narrow);
  assert.equal(narrow.hidden, true);
  assert.equal(narrow.boxes.length, 0);

  screenSize = '300x600';
  storage.set('ihtfy-ad-free', 'token');
  const buyer = rail();
  startRail(buyer);
  assert.equal(buyer.hidden, true);
  assert.equal(buyer.boxes.length, 0);
});

test('the breakpoints keep the canvas at 1000 px or more, in a window 700 px tall', async () => {
  const { PLAY_AD_SIZES } = await loadAds();
  assert.deepEqual(
    PLAY_AD_SIZES.map(({ query, size }) => {
      const [, width] = query.match(/min-width: (\d+)px/);
      const [adWidth] = size.split('x').map(Number);
      return { canvas: Number(width) - 166 - adWidth, height: query.includes('min-height: 700px') };
    }),
    [
      { canvas: 1000, height: true },
      { canvas: 1000, height: true },
    ],
  );
});

test('a new size gets a new box and key at once, and a narrow window hides the rail', async () => {
  const { startRail } = await loadAds();
  const el = rail();
  startRail(el);
  resize('160x600');
  assert.deepEqual(current(el)[0].style, { width: '160px', height: '600px' });
  resize(null);
  assert.equal(el.hidden, true);
  assert.equal(current(el).length, 0);
  resize('160x600');
  press();
  await tick();
  added[0].dispatchEvent(new Event('load'));
  await tick();
  // Only the box still on the page asks for an ad.
  assert.deepEqual(shown, [[current(el)[0], 'play/3']]);
});
