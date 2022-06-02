// https://www.shadertoy.com/view/ttVSDW
// The MIT License
// Copyright © 2020 Inigo Quilez
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// This is my own take on al13n's perturbation idea in this
// shader https://www.shadertoy.com/view/XtdBR7, but using a
// more direct method - instead of linearizing the Taylor 
// expansion I directly track the delta growth under z²+c
//
// The trick is that if the reference orbit is in the interior
// of the M-set, it won't diverge and numbers will stay sane.
// Then, the nearby points of the plane will produce orbits that
// will deviate from the reference orbit just a little, little
// enough that the difference can be expressed with single
// precision floating point numbers. So this code iterates the
// reference orbit Zn and also the current orbit Wn in delta form:
//
// Given
//
// Zn and Wn = Zn + ΔZn
// 
// Then
//
// Zn+1 = f(Zn) = Zn² + C
// Wn+1 = f(Wn) = f(Zn+ΔZn) = (Zn+ΔZn)² + C + ΔC = 
//              = Zn² + ΔZn² + 2·Zn·ΔZn + C+ΔC = 
//              = Zn+1 + ΔZn·(ΔZn + 2·Zn) + ΔC = 
//              = Zn+1 + ΔZn+1
//
// So, what we need to iterate is
//
// ΔZn+1 = (ΔZn² + ΔC) + 2·Zn·ΔZn  --> delta-orbit (Wn-Zn)
//  Zn+1 = ( Zn² +  C)             --> periodic orbit, doesn't diverge


vec2 cmul(vec2 a, vec2 b) { return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }

float mandelbrot(vec2 c)
{
    float n = -1.0;
    vec2 z = vec2(0.0);
    for( int i=0; i<6000; i++ )
    {
        z = cmul(z,z) + c;
        if( dot(z,z)>4.0 ) { n=float(i); break; }
    }
    return n;
}

float mandelbrot_perturbation( vec2 c, vec2 dc )
{
    vec2 z  = vec2(0.0);
    vec2 dz = vec2(0.0);
    float n = -1.0;
    for( int i=0; i<6000; i++ )
    {
        dz = cmul(2.0*z+dz,dz) + dc;
        z  = cmul(z,z)+c; // this could be precomputed since it's constant for the whole image
        
        // instead of checking for Wn to escape...
        // if( dot(z+dz,z+dz)>4.0 ) { n=float(i); break; }
        // ... we only check ΔZn, since Zn is periodic and can't escape
        if( dot(dz,dz)>4.0 ) { n=float(i); break; }
    }
    return n;
}

#define AA 1

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    // input
    float time = iTime+0.2;
    
    float s = (iMouse.z<0.001) ? -cos(time*2.0)*1.8 : (2.0*iMouse.x-iResolution.x) / iResolution.y;
    
    vec3 col = vec3(0.0);
    #if AA>1
    for( int m=0; m<AA; m++ )
    for( int n=0; n<AA; n++ )
    {
        vec2 p = (2.0*(fragCoord.xy+vec2(float(m),float(n))/float(AA))-iResolution.xy)/iResolution.y;
    #else
        vec2  p = (2.0*fragCoord-iResolution.xy)/iResolution.y;
    #endif
    
        // viewport
        float zoom; vec2 c;
        if( sin(time)>0.0 ) { zoom=1.5e-6; c=vec2(-1.1900443,0.3043895); }
        else                { zoom=1.0e-6; c=vec2(-0.7436441,0.1318255); }

        // mandelbrot	
        vec2 dc = p*zoom;
        float l = (p.x<s) ? mandelbrot_perturbation(c, dc) : 
                            mandelbrot(c + dc);
        // color
        col += (l<0.0) ? vec3(0.0) : 0.5 + 0.5*cos( pow(zoom,0.22)*l*0.05 + vec3(3.0,3.5,4.0));

        // reference orbit
        if( length(p)<0.02 ) col = vec3(1.0,0.0,0.0);

        // separator
        if( abs(p.x-s)<2.0/iResolution.y) col = vec3(1.0);
    #if AA>1
    }
    col /= float(AA*AA);
    #endif
    
    // output    
    fragColor = vec4(col,1.0);
}

















// https://www.shadertoy.com/view/XtdBR7
const int its = 4000;

vec2 csqr(vec2 a) {
 	return vec2(a.x*a.x-a.y*a.y, 2.*a.x*a.y);
}

vec2 cmul(vec2 a, vec2 b) {
    return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x);
}

float mandel_normal(vec2 c) {
    vec2 z = vec2(0., 0.);
    for (int i = 0; i < its; ++i) {
        if (dot(z, z) > 10.) {
         	return float(i)/float(its);
        }
        z = csqr(z) + c;
    }
    return 0.;
}

// C = a + c, where c should be much smaller than a (e.g. a is center of screen, and we're zoomed in far).
// Z = z0 + c*z1  (higher powers of c are not discarded and go into z1).
// I also tried Z = z0 + c*z1 + c^2*z2, but it made no noticeable difference in all cases I tried.
// This seems to somewhat work when a is inside the mandelbrot set
// (i.e. center point of the screen is black).
float mandel_perturbative(vec2 a, vec2 c) {
    vec2 z0 = vec2(0., 0.);
    vec2 z1 = vec2(0., 0.);
    for (int i = 0; i < its; ++i) {
	    vec2 t = z0 + cmul(z1, c);
        if (dot(t, t) > 10.) {
            return float(i)/float(its);
        }
        z1 = cmul(z0, z1)*2. + vec2(1., 0.) + cmul(c, csqr(z1));
        z0 = csqr(z0) + a;
    }
    return 0.;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 c0 = (fragCoord/iResolution.xy - .5) * 2. * vec2(iResolution.x/iResolution.y, 1.);

    vec2 a = vec2(-1.1900435, .3043896);
    vec2 c = c0 * .000002;

    float split;
    if(iMouse.z <= 0.) {
        split = (sin(iTime * 2.) + 1.)*.3*iResolution.x;
    } else {
        split = iMouse.x;
    }
    
    float r;
    if (fragCoord.x < split) {
        r = mandel_perturbative(a, c);
    } else {
        r = mandel_normal(a + c);
    }
    
    // Draw a frame and a dot in the center.
    vec2 ap = abs(fragCoord/iResolution.xy-.5);
    const float fs = .2;
    vec2 ft = abs(ap - fs);
    float frame = 0.;//float(min(ft.x, ft.y) < .002 && max(ap.x,ap.y) < fs);
    float mid = float(length(c0) < .01);
    
    fragColor = vec4(r,r + frame + mid,r,1.);
}






















void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 offset = vec2(-0.649032, 0.372346);
    float scale = pow(0.5, 15.0);
    
    // Normalized pixel coordinates (from 0 to 1)
    vec2 uv = (fragCoord/iResolution.y)*2.0 - 1.0 - vec2(1.5, 0.0);
    vec2 m  = (iMouse.xy/iResolution.y)*2.0 - 1.0 - vec2(1.5, 0.0);
    
    // m = round(uv*10.0) / 10.0;
    
    vec2 c = vec2((uv-m)*scale);
    vec2 C = vec2(m*scale + offset);
    vec2 z = vec2(0.0);
    vec2 Z = vec2(0.0);
    
    float id = 0.0;
    for(int i = 0; i < 900; ++i) {
        // x+iy = 2*z_n*Z_n
        float x = 2.0*(z.x*Z.x - z.y*Z.y);
        float y = 2.0*(z.x*Z.y + z.y*Z.x);
        
        // z_n+1 = z_n^2 + c + 2*Z_n*z_n
        float a = z.x*z.x - z.y*z.y + c.x + x;
        float b = 2.0*z.x*z.y       + c.y + y;
        z.x = a;
        z.y = b;
        
        // Z_n+1 = Z_n^2 + C
        {
            float a = Z.x*Z.x - Z.y*Z.y + C.x;
            float b = 2.0*Z.x*Z.y + C.y;
            Z.x = a;
            Z.y = b;
        }
        
        // Actual coordinate is: z+Z
        // The idea is to calculate only a few 'Z' in high precision
        // and the 'z' in low precision.
        float d = dot(z, z);
        if (d > 256.0) {
            // https://www.iquilezles.org/www/articles/mset_smooth/mset_smooth.htm
            id = float(i) - log2(log2(d)) + 4.0;
            break;
        }
    }
    
    // Sinebow coloring
    float pi = 3.14159265358979;
    float t = (0.5 - id*0.02)*pi;
    
    float r = cos(t + pi*0.0/3.0);
    float g = cos(t + pi*1.0/3.0);
    float b = cos(t + pi*2.0/3.0);
    
    vec3 col = vec3(r*r, g*g, b*b) * min(id, 1.0);
    
    fragColor = vec4(col,1.0);
}