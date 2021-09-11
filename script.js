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
    (proportion - 0.6) / 0.2,
    (2 - (Math.abs(proportion - 0.6) / 0.2)),
    (1.5 - (Math.abs(proportion - 0.3) / 0.2)),
    255
  ].map(i => Math.max(Math.min(i * 255, 255), 0));
}

// sets color of a pixel
function plot(imageData, p, i, imax) {
  const color = palette(i, imax);
  imageData.data[p * 4 + 0] = color[0];
  imageData.data[p * 4 + 1] = color[1];
  imageData.data[p * 4 + 2] = color[2];
  imageData.data[p * 4 + 3] = color[3];
}

// current view range
let xmin = -2.5;
let xmax = 1;
let ymin = -1.4;
let ymax = 1.4;
// center (-0.75, 0), x+-1.75, y+-1.4

function update() {
  // for each pixel, find number of iterations to diverge
  for (let p = 0; p < w * h; p++) {
    const x0 = ((p % w) / w) * (xmax - xmin) + xmin;
    const y0 = (Math.floor(p / w) / h) * (ymax - ymin) + ymin;
    let x = 0;
    let y = 0;
    let iter = 0;
    let imax = 100;
    while (x ** 2 + y ** 2 <= 4 && iter++ < imax) {
      [x, y] = [x ** 2 - y ** 2 + x0, 2 * x * y + y0];
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
  const cx = ((e.clientX - rect.left) / w) * (xmax - xmin) + xmin;
  const cy = ((e.clientY - rect.top) / h) * (ymax - ymin) + ymin;
  xmin = cx - (xmax - xmin) / 4;
  xmax = cx + (xmax - xmin) / 4;
  ymin = cy - (ymax - ymin) / 4;
  ymax = cy + (ymax - ymin) / 4;
  update();
});