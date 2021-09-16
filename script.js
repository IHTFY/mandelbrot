const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
if (window.innerWidth / window.innerHeight > 1.25) {
  // wide screen, fill height
  ctx.canvas.height = window.innerHeight;
  ctx.canvas.width = 1.25 * window.innerHeight;
} else {
  // narrow screen, fill width
  ctx.canvas.width = window.innerWidth;
  ctx.canvas.height = window.innerWidth / 1.25;
};
const w = ctx.canvas.width;
const h = ctx.canvas.height;

let imageData = ctx.createImageData(w, h);

// https://gist.github.com/mjackson/5311256
function hslToRgb(h, s, l) {
  var r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    var hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }

    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// returns a color based on a 1D color scale
function palette(i) {
  return hslToRgb((i + 130) / 250 % 1, 1, 0.5);

  // let proportion = i / max;
  // proportion = (4 * proportion) % max;
  // return [
  //   (proportion - 0.6) * 5,
  //   (2 - (Math.abs(proportion - 0.6) * 5)),
  //   (1.5 - (Math.abs(proportion - 0.3) * 5))
  // ].map(i => Math.max(Math.min(i * 255, 255), 0));
}

// sets color of a pixel
function plot(imageData, p, i, imax) {
  const color = palette(i, imax);
  imageData.data[p * 4 + 0] = color[0];
  imageData.data[p * 4 + 1] = color[1];
  imageData.data[p * 4 + 2] = color[2];
  imageData.data[p * 4 + 3] = 255;
}

let highPrecision = false;

// current view range
let xmin = Big(-2.5);
let xmax = Big(1);
let ymin = Big(-1.4);
let ymax = Big(1.4);
// center (-0.75, 0), x+-1.75, y+-1.4

function update() {
  // when resolution falls below 1e-16, use high precision
  // resolution: xrange/w || yrange/h

  highPrecision = xmax.minus(xmin).div(w).lte(1e-16) || ymax.minus(ymin).div(h).lte(1e-16);

  // for each pixel, find number of iterations to diverge from the r=2 circle
  if (highPrecision) {
    let dp = Math.ceil(-Math.log10((xmax.minus(xmin)).div(w).toNumber())); // NOTE haphazard math

    for (let p = 0; p < w * h; p++) {
      let iter = 0;
      let imax = 1000;

      // high precision
      const x0 = Big((p % w) / w).times(xmax.minus(xmin)).plus(xmin).round(dp, 2);
      const y0 = Big(Math.floor(p / w) / h).times(ymax.minus(ymin)).plus(ymin).round(dp, 2);
      let x = Big(0);
      let y = Big(0);
      let x2 = Big(0);
      let y2 = Big(0);

      while (iter++ < imax && x2.plus(y2).lte(4)) {
        // console.log(p, iter);
        x2 = x.pow(2).round(dp, 2);
        y2 = y.pow(2).round(dp, 2);
        [x, y] = [x2.minus(y2).plus(x0).round(dp, 2), Big(2).times(x).times(y).plus(y0).round(dp, 2)];
      }

      plot(imageData, p, iter, imax);
    }

  } else {
    let xn = xmin.toNumber();
    let xx = xmax.toNumber();
    let yn = ymin.toNumber();
    let yx = ymax.toNumber();

    for (let p = 0; p < w * h; p++) {
      let iter = 0;
      let imax = 1000;

      const x0 = ((p % w) / w) * (xx - xn) + xn;
      const y0 = (Math.floor(p / w) / h) * (yx - yn) + yn;
      let x = 0;
      let y = 0;

      while (iter++ < imax && x * x + y * y <= 4) {
        [x, y] = [x * x - y * y + x0, 2 * x * y + y0];
      }

      plot(imageData, p, iter, imax);
    }
  }

  // draw
  ctx.putImageData(imageData, 0, 0);
}

update();


// handle zooming
canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const xrange = Big(xmax.minus(xmin));
  const yrange = Big(ymax.minus(ymin));
  const cx = Big((e.clientX - rect.left) / w).times(xrange).plus(xmin);
  const cy = Big((e.clientY - rect.top) / h).times(yrange).plus(ymin);
  setView(cx, cy, xrange.div(4), yrange.div(4));
  update();
});

function setView(cx, cy, xrange, yrange) {
  xmin = cx.minus(xrange.div(2));
  xmax = xmin.plus(xrange);
  ymin = cy.minus(yrange.div(2));
  ymax = ymin.plus(yrange);
}