# mandelbrot
Deep-zoom Mandelbrot viewer that runs on the GPU in the browser.

Click to zoom in, right-click to zoom out, drag to pan, scroll or pinch to zoom. "Zoom to minibrot" finds the nearest minibrot and zooms to it. The location is saved in the URL, so you can share a view.

## Mandelbrot Background
This is an interactive visualization of the [Mandelbrot set](https://en.wikipedia.org/wiki/Mandelbrot_set). The original view is the [complex plane](https://en.wikipedia.org/wiki/Complex_plane) (real numbers on the x-axis and imaginary on the y-axis) with an x-range of 3.5 and a y-range of 2.8i. Each pixel/point (c) is colored based on the recursive formula: $Z_{n+1} = Z_n^2 + c$, where $Z_{0} = 0$. As this function is iterated, values will either cycle, settle, or explode. It has been proven that if the value escapes the circle of radius 2 centered at the origin, then it will never return. The coloring is based on how many iterations it takes for each point to exit the circle.

## Floating-point precision
JavaScript uses double precision (64 bits) to store numbers. Roughly speaking, it uses 52 bits to encode the ~16 digits you can read out, and 11 bits to store the order of magnitude ~$10^{±1023}$, and one bit for the sign (+ or -). When zooming far into the Mandelbrot set (range ~1e-17) there is not enough room in the 16-digit portion of the number to accurately give each pixel a unique value, i.e. blocks of pixels will round to the same number value. This creates a pixelated image. This limitation can be overcome by using a library to calculate decimals to arbitrary precision, but this makes computation prohibitively slow. Another method is to use [perturbation](https://en.wikipedia.org/wiki/Perturbation_theory).

## Perturbation
Rather than iterate each pixel's full value, we iterate one reference point C in high precision and represent each pixel as an offset dc from it. The pixel's orbit is the reference orbit Z plus a small offset z, which follows

$z_{n+1} = 2 Z_n z_n + z_n^2 + dc$

The offsets are small, so ordinary 32-bit floats on the GPU can hold them, while the reference orbit is computed once per view with JavaScript `BigInt` fixed-point numbers (`reference-worker.js`).

The methods follow [Kalles Fraktaler](https://mathr.co.uk/kf/kf.html) and [Fraktaler 3](https://fraktaler.mathr.co.uk/):

- **Nucleus reference.** The reference isn't an arbitrary point: it's the nucleus (the periodic center) of the lowest-period minibrot near the view center. Ball-method period detection finds the period p, and Newton's method solves $z_p(c) = 0$. The ball test is conservative, so if the nucleus Newton finds isn't in view, the search repeats with a smaller ball. The nucleus orbit cycles back to 0 every p iterations and never escapes, so p values serve any iteration count.
- **Rebasing.** When a pixel's orbit $Z + z$ passes closer to 0 than to the reference, the pixel restarts the reference from the beginning with $z = Z + z$. This removes the "glitches" perturbation used to suffer from without detecting and re-rendering them.
- **Bilinear approximation.** While z is small, many iterations collapse into one step $z \to A z + B\,dc$, with A and B precomputed from the reference orbit. This skips most of the work at deep zooms.
- **Distance estimation and slope shading** come from tracking the derivative along with z.
- **Scaled iterations.** Past a zoom of about $10^{30}$, z gets too small for 32-bit floats. The deep shader then stores z as a float times a separate power of 2, and so does the derivative, as KF's "floatexp" numbers do. Once z is large enough, it switches back to plain floats.
- **Interior detection.** The renderer tracks how much the orbit shrinks small changes in its start. A pixel whose orbit is pulled into an attracting cycle is inside the set and stops early instead of running to the iteration limit, which makes views with a lot of black much faster.

## Colors
Coloring follows KF's options: a palette (a cyclic gradient or the rainbow), the spacing of color cycles (linear, square root, or log in the iteration count), the cycle length and offset, slope shading strength and light angle, darkened edges from the distance estimate, and the inside color. "Half" resolution renders a quarter of the pixels, for slow devices.

## Limits
The view size and the reference search use JavaScript doubles, which bottom out near $10^{-308}$, so zooming stops at a pixel size of $10^{-290}$ (a zoom of roughly $10^{288}$). The deep shader is a few times slower per iteration than the plain one, and the reference orbit takes longer as the coordinates get more digits.

The viewer needs WebGL2 with float render targets, which current desktop and mobile browsers have.
