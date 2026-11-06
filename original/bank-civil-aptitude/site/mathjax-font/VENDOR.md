# Local SVG font dependency

Source: installed npm package `@mathjax/mathjax-newcm-font`, version 4.1.3.
Package repository: https://github.com/mathjax/MathJax-fonts
Package license declaration: Apache-2.0. Apache-2.0 license text included.

Copied without source modifications: svg.js and svg/dynamic/*.js (40 dynamic files).
The site uses these same-origin dependencies instead of requesting the jsDelivr CDN.
Publisher inventory: src-tauri/src/km2/questionbank_math_assets.rs.
Do not remove dynamic glyph files just because a sample paper does not request them.
