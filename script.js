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

// returns a color based on a 1D color scale
function palette(i, max) {
  const proportion = i / max;
  return [
    (proportion - 0.6) * 5,
    (2 - (Math.abs(proportion - 0.6) * 5)),
    (1.5 - (Math.abs(proportion - 0.3) * 5))
  ].map(i => Math.max(Math.min(i * 255, 255), 0));
}

// sets color of a pixel
function plot(imageData, p, i, imax) {
  const color = palette(i, imax);
  imageData.data[p * 4 + 0] = color[0];
  imageData.data[p * 4 + 1] = color[1];
  imageData.data[p * 4 + 2] = color[2];
  imageData.data[p * 4 + 3] = 255;
}

// current view range
let xmin = -2.5;
let xmax = 1;
let ymin = -1.4;
let ymax = 1.4;
// center (-0.75, 0), x+-1.75, y+-1.4

function update() {
  // for each pixel, find number of iterations to diverge from the r=2 circle
  for (let p = 0; p < w * h; p++) {
    const x0 = ((p % w) / w) * (xmax - xmin) + xmin;
    const y0 = (Math.floor(p / w) / h) * (ymax - ymin) + ymin;
    let x = 0;
    let y = 0;
    let iter = 0;
    let imax = 100;
    while (iter++ < imax && x * x + y * y <= 4) {
      [x, y] = [x * x - y * y + x0, 2 * x * y + y0];
    }
    plot(imageData, p, iter, imax);
  }

  // draw
  ctx.putImageData(imageData, 0, 0);
}

update();


// handle zooming
canvas.addEventListener('click', e => {
  const rect = canvas.getBoundingClientRect();
  const xrange = (xmax - xmin);
  const yrange = (ymax - ymin);
  const cx = ((e.clientX - rect.left) / w) * xrange + xmin;
  const cy = ((e.clientY - rect.top) / h) * yrange + ymin;
  setView(cx, cy, xrange / 2, yrange / 2);
  update();
});

function setView(cx, cy, xrange, yrange) {
  xmin = cx - xrange / 2;
  xmax = cx + xrange / 2;
  ymin = cy - yrange / 2;
  ymax = cy + yrange / 2;
}