# mandelbrot
View the Mandelbrot set to arbitrary depth...very slowly

Click on the image to zoom in.

## Mandelbrot Background
This is an interactive visualization of the [Mandelbrot set](https://en.wikipedia.org/wiki/Mandelbrot_set). The original view is the [complex plane](https://en.wikipedia.org/wiki/Complex_plane) (real numbers on the x-axis and imaginary on the y-axis) with an x-range of 3.5 and a y-range of 2.8i. Each pixel/point (c) is colored based on the recursive formula: Z_n+1 = Z_n^2 + c, where Z_0 = 0. As this function is iterated, values will either cycle, settle, or explode. It has been proven that if the value escapes the circle of radius 2 centered at the origin, then it will never return. The coloring is based on how many iterations it takes for each point to exit the circle.

## Floating-point precision
JavaScript uses double precision (64 bits) to store numbers. Roughly speaking, it uses 53 bits to encode the ~16 digits you can read out, and 11 bits to store the order of magnitude ~10^±1023. When zooming far into the Mandelbrot set (range ~1e-17) there is not enough room in the 16-bit portion of the number to accurately give each pixel a unique value, i.e. blocks of pixels will round to the same number value. This creates a pixelated image. This limitation can be overcome by using a library to calculate decimals to arbitrary precision, but this makes computation prohibitively slow. Another method is to use [perturbation](https://en.wikipedia.org/wiki/Perturbation_theory).

## Perturbation
Rather than store each pixel as a starting (seed) value, we can instead pick a reference pixel and represent each other pixel as an offset from that reference. In this implementation, the reference pixel is simply the point you click on (which becomes the center of the zoomed-in image). This way, the reference pixel "shares" its 16 bits of "zoom-in" resolution to all the other pixels. The other pixels can use their 16 bits to store pixel-to-pixel distance.

## Recommendation 
In this implementation, the approximation works best if the reference pixel is deeper in the black area. The black area contains points which do not escape after 4000 iterations (the default maximum).
