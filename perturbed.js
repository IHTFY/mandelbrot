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

// modified from https://gist.github.com/mjackson/5311256
function hslToRgb(h, s, l) {
  let r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) ++t;
      if (t > 1) --t;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [r, g, b].map(i => Math.round(i * 255));
}

// returns a color based on a 1D color scale
function palette(i) {
  const paletteLength = 250;
  const offset = 130;
  return hslToRgb((i + offset) / paletteLength % 1, 1, 0.5);

  // let proportion = i / max;
  // proportion = (4 * proportion) % max;
  // return [
  //   (proportion - 0.6) * 5,
  //   (2 - (Math.abs(proportion - 0.6) * 5)),
  //   (1.5 - (Math.abs(proportion - 0.3) * 5))
  // ].map(i => Math.max(Math.min(i * 255, 255), 0));
}

// sets color of a pixel
function plot(imageData, pixel, iter) {
  const color = palette(iter);
  imageData.data[pixel * 4 + 0] = color[0];
  imageData.data[pixel * 4 + 1] = color[1];
  imageData.data[pixel * 4 + 2] = color[2];
  imageData.data[pixel * 4 + 3] = 255;
}

let highPrecision = false;

// current view range
let xmin = Big(-2.5);
let xmax = Big(1);
let ymin = Big(-1.4);
let ymax = Big(1.4);
// center (-0.75, 0), x+-1.75, y+-1.4

function p2c(i, dp) {
  // using globals: w, h, xmin, xmax, ymin, ymax
  const re = Big((i % w) / w).times(xmax.minus(xmin)).plus(xmin).round(dp, 2);
  const im = Big(Math.floor(i / w) / h).times(ymax.minus(ymin)).plus(ymin).round(dp, 2);
  return [re, im];
}

// if the complex number is outside of the r=2 circle
function isOut(x) {
  return x[0] * x[0] + x[1] * x[1] > 4;
}

function update() {
  // when resolution falls below 1e-16, use high precision
  // resolution: xrange/w || yrange/h

  highPrecision = xmax.minus(xmin).toNumber() / w <= 1e-16 || ymax.minus(ymin).toNumber() / h <= 1e-16;
  let imax = 1500;


  // for each pixel, find number of iterations to diverge from the r=2 circle
  if (highPrecision) {

    let dp = Math.ceil(-Math.log10((xmax.minus(xmin)).toNumber() / 2)); // NOTE haphazard math

    // calculate the center pixel accurately

    let iter = 0;

    // get center pixel
    let pRef = Math.floor(w / 2) + w * Math.floor(h / 2);
    let Xn = [];

    // convert pixel to view coordinates
    Xn[0] = p2c(pRef, dp);

    let [x0, y0] = Xn[0];
    // precompute squares
    let x2 = x0.pow(2).round(dp, 2);
    let y2 = y0.pow(2).round(dp, 2);

    // iterate to find when it leaves the circle
    while (iter++ < imax && x2.plus(y2).lte(4)) {
      if (iter > 0) {
        x2 = Xn[iter - 1][0].pow(2).round(dp, 2);
        y2 = Xn[iter - 1][1].pow(2).round(dp, 2);
      }
      Xn[iter] = [
        x2.minus(y2).plus(x0).round(dp, 2),
        Big(2).times(Xn[iter - 1][0]).times(Xn[iter - 1][1]).plus(y0).round(dp, 2)
      ];
    }

    console.log(`iter: ${iter - 1}`);

    plot(imageData, pRef, iter - 1);



    /**
     * approximate remaining pixels using perturbation
     */


    // https://mathr.co.uk/blog/2021-09-08_generalized_series_approximation.html
    //  (c, z) |--> z^2 + c
    //  (C, Z, c, z) |--> 2*Z*z + z^2 + c
    //  (C, Z, c) |--> (a_1)*c + (a_2)*c^2 + (a_3)*c^3 + (a_4)*c^4 + (a_5)*c^5 + (a_6)*c^6 + (a_7)*c^7 + (a_8)*c^8 + (a_9)*c^9 + Order(c^10)
    //  (C, Z, c) |--> (2*Z*a_1 + 1)*c + (a_1^2 + 2*Z*a_2)*c^2 + (2*a_1*a_2 + 2*Z*a_3)*c^3 + (a_2^2 + 2*a_1*a_3 + 2*Z*a_4)*c^4 + (2*a_2*a_3 + 2*a_1*a_4 + 2*Z*a_5)*c^5 + (a_3^2 + 2*a_2*a_4 + 2*a_1*a_5 + 2*Z*a_6)*c^6 + (2*a_3*a_4 + 2*a_2*a_5 + 2*a_1*a_6 + 2*Z*a_7)*c^7 + (a_4^2 + 2*a_3*a_5 + 2*a_2*a_6 + 2*a_1*a_7 + 2*Z*a_8)*c^8 + (2*a_4*a_5 + 2*a_3*a_6 + 2*a_2*a_7 + 2*a_1*a_8 + 2*Z*a_9)*c^9 + Order(c^10)
    //  0  :  a_1  :=  2*Z*a_1 + 1
    //  0  :  a_2  :=  a_1^2 + 2*Z*a_2
    //  0  :  a_3  :=  2*a_1*a_2 + 2*Z*a_3
    //  0  :  a_4  :=  a_2^2 + 2*a_1*a_3 + 2*Z*a_4
    //  0  :  a_5  :=  2*a_2*a_3 + 2*a_1*a_4 + 2*Z*a_5
    //  0  :  a_6  :=  a_3^2 + 2*a_2*a_4 + 2*a_1*a_5 + 2*Z*a_6
    //  0  :  a_7  :=  2*a_3*a_4 + 2*a_2*a_5 + 2*a_1*a_6 + 2*Z*a_7
    //  0  :  a_8  :=  a_4^2 + 2*a_3*a_5 + 2*a_2*a_6 + 2*a_1*a_7 + 2*Z*a_8
    //  0  :  a_9  :=  2*a_4*a_5 + 2*a_3*a_6 + 2*a_2*a_7 + 2*a_1*a_8 + 2*Z*a_9

    function coeff(x) {
      let co = [[1, 0, 0, 0]];
      // NOTE Use High Precision???
      x = x.map(n => n.map(i => i.toNumber()));
      for (let n = 1; n < x.length; ++n) {
        const xn2 = ix(2, x[n - 1]);
        co[n] = [
          ia(ix(xn2, co[n - 1][0]), 1),
          ia(ix(xn2, co[n - 1][1]), ix(co[n - 1][0], co[n - 1][0])),
          ia(ix(xn2, co[n - 1][2]), ix(2, co[n - 1][0], co[n - 1][1])),
          ia(ix(xn2, co[n - 1][3]), ix(2, co[n - 1][0], co[n - 1][2]), ix(co[n - 1][1], co[n - 1][1]))
        ];
      }
      return co;
    }

    function delta(co, d0, n) {
      const d0_2 = ix(d0, d0);
      const d0_3 = ix(d0_2, d0);
      const d0_4 = ix(d0_3, d0);

      const t1 = ix(co[n][0], d0);
      const t2 = ix(co[n][1], d0_2);
      const t3 = ix(co[n][2], d0_3);
      const t4 = ix(co[n][3], d0_4);
      return ia(t1, t2, t3, t4);
    }

    function getEst(x, dn, n) {
      return ia(x[n].map(i => i.toNumber()), dn);
    }

    let co = coeff(Xn);
    console.log(Xn, co);

    // coordinate size of each pixel
    let wRes = xmax.minus(xmin).toNumber() / w;
    let hRes = ymax.minus(ymin).toNumber() / h;
    for (let p = 0; p < w * h; p++) {
      if (p === pRef) continue;

      // number of pixels away from center, scaled by pixel size in coordinate system
      const dx = ((p % w) - (pRef % w)) * wRes;
      const dy = (Math.floor(p / w) - Math.floor(pRef / w)) * hRes;
      const d0 = [dx, dy];

      // binary search to find iteration
      let low = 0;
      let high = iter - 1;
      let n;
      while (low < high) {
        n = Math.floor((high + low) / 2);
        const dn = delta(co, d0, n);
        const est = getEst(Xn, dn, n);
        if (isOut(est)) {
          high = n - 1;
        } else {
          low = n + 1;
        }
      }

      plot(imageData, p, n);
    }


  } else {
    let xn = xmin.toNumber();
    let xx = xmax.toNumber();
    let yn = ymin.toNumber();
    let yx = ymax.toNumber();

    for (let p = 0; p < w * h; p++) {
      let iter = 0;

      // convert pixel to view coordinates
      const x0 = ((p % w) / w) * (xx - xn) + xn;
      const y0 = (Math.floor(p / w) / h) * (yx - yn) + yn;
      let x = 0;
      let y = 0;

      // iterate to find when it leaves the circle
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
  const xrange = xmax.minus(xmin).toNumber();
  const yrange = ymax.minus(ymin).toNumber();
  const cx = xmin.plus((e.clientX - rect.left) / w * xrange);
  const cy = ymin.plus((e.clientY - rect.top) / h * yrange);
  setView(cx, cy, xrange / 4, yrange / 4);
  update();
});

function setView(cx, cy, xrange, yrange) {
  xmin = cx.minus(xrange / 2);
  xmax = xmin.plus(xrange);
  ymin = cy.minus(yrange / 2);
  ymax = ymin.plus(yrange);
}

// complex multiply
function ix() {
  let product = [1, 0];
  for (let i = 0; i < arguments.length; ++i) {
    if (typeof arguments[i] === 'number') {
      product = product.map(z => z * arguments[i]);
    } else {
      product = [
        product[0] * arguments[i][0] - product[1] * arguments[i][1],
        product[0] * arguments[i][1] + product[1] * arguments[i][0]
      ];
    }
  }
  return product;
}

// complex add
function ia() {
  let sum = [0, 0];
  for (let i = 0; i < arguments.length; ++i) {
    if (typeof arguments[i] === 'number') {
      sum[0] += arguments[i];
    } else {
      sum[0] += arguments[i][0];
      sum[1] += arguments[i][1];
    }
  }
  return sum;
}