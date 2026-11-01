# Credits

## Inspiration

- [Ombre Brain](https://github.com/P0luz/Ombre-Brain) — the idea of emotionally tagged memories that decay over time, surface on their own at the start of a conversation, and get digested in "dream" passes. This project started as a rewrite of that idea for Cloudflare Workers; no code was copied.

## Third-party code

- [three.js](https://github.com/mrdoob/three.js) (MIT) — bundled in `public/memories/assets/vendor/` for the 3D star map; original copyright header kept.

## Garden background — `public/memories/assets/garden.jpg`

- **Work:** *Moonlight on the Lake, Roundhay Park, Leeds* (c. 1872)
- **Artist:** John Atkinson Grimshaw (1836–1893)
- **License:** Public domain (the artist died more than 100 years ago)
- **Source:** https://commons.wikimedia.org/wiki/File:John_Atkinson_Grimshaw_-_Moonlight_on_the_Lake,_Roundhay_Park,_Leeds.jpg
- **Changes:** center-cropped to 2:3 portrait, resized to 1024×1536, re-encoded as JPEG (~410 KB).

Want different art? Replace the file and keep the name, or change the `url(...)` in `public/memories/glass.css` and `pages/garden/glass.css`.
