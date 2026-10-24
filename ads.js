// The ad on the right edge comes from the shared IHTFY loader, which ihtfy.com
// serves for all the games (its source is in the IHTFY/com.ihtfy repo). Nothing
// ad-related loads until the first drag, wheel, tap, or key press: the loader
// arrives then, and AdSense after it at browser idle. A visitor who may have
// bought ad-free gets the loader at startup instead (loadForBuyer), so it can
// hide the ad box before it is ever shown.
const LOADER = 'https://ihtfy.com/ads/v1.js';

// The games-play unit: 300×600 in AdSense; the 160×600 box uses it too.
export const PLAY_AD_SLOT = '7239875855';

// The size of the ad on the right edge, by window, first match wins; the
// stylesheet narrows the canvas from the same widths. The canvas keeps at least
// 1000 px, and the strip beside it holds 150 px to the ad, the ad, and 16 px to
// the window's edge: 1000 + 166 + width. The window must also be 700 px tall,
// for the 600 px ad and its label.
export const PLAY_AD_SIZES = [
  { query: '(min-width: 1466px) and (min-height: 700px)', size: '300x600' },
  { query: '(min-width: 1326px) and (min-height: 700px)', size: '160x600' },
];

let loader = null;

const load = () =>
  (loader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = LOADER;
    script.addEventListener('load', resolve);
    script.addEventListener('error', () => {
      script.remove();
      loader = null;
      reject(new Error('The ad loader did not load'));
    });
    document.head.appendChild(script);
  }));

// Whether this browser holds an ad-free token, unchecked; the loader checks it.
function mayBeAdFree() {
  let found = false;
  try {
    found = Boolean(localStorage.getItem('ihtfy-ad-free'));
  } catch {
    // Storage off: the cookie may still hold the token.
  }
  try {
    found ||= /(?:^|;\s*)ihtfy-ad-free=/.test(document.cookie);
  } catch {
    // Cookies off too: there is no token to find.
  }
  return found;
}

// Loads the loader now if this browser holds an ad-free token, so it can hide the ad box.
export function loadForBuyer() {
  if (mayBeAdFree()) load().catch(() => {});
}

// Fills `box` with an ad under `key`; offline or on failure it stays empty.
export function showAd(box, key) {
  if (!navigator.onLine) return;
  // A box that left the page meanwhile would hold the key and block its replacement.
  load().then(
    () => box.isConnected && window.ihtfyAds.show(box, key),
    () => {},
  );
}

// The visitor's first drag, wheel, tap, or key press. The ad waits for it, so
// nothing ad-related loads with the page.
const firstInput = new Promise((resolve) => {
  for (const type of ['pointerdown', 'wheel', 'keydown']) {
    addEventListener(type, resolve, { once: true, capture: true });
  }
});

let plays = 0;

// Shows the ad in `rail` while the window fits one, in a new box (and key) for
// each new size. A buyer gets no rail.
export function startRail(rail) {
  if (mayBeAdFree()) return;
  const queries = PLAY_AD_SIZES.map((p) => matchMedia(p.query));
  let size;
  let box;

  const update = () => {
    const next = PLAY_AD_SIZES.find((_, i) => queries[i].matches)?.size;
    if (next === size) return;
    size = next;
    box?.remove();
    box = undefined;
    rail.hidden = !size;
    if (!size) return;

    plays += 1;
    const key = `play/${plays}`;
    const [width, height] = size.split('x');
    box = document.createElement('div');
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.dataset.adSlot = PLAY_AD_SLOT;
    box.dataset.adSize = size;
    rail.append(box);
    const shown = box;
    firstInput.then(() => {
      if (shown.isConnected) showAd(shown, key);
    });
  };

  for (const query of queries) query.addEventListener('change', update);
  update();
}
