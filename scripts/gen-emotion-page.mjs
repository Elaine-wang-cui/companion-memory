// node scripts/gen-emotion-page.mjs → src/emotion-page.ts
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../pages/emotion/emotion.html", import.meta.url), "utf8");
writeFileSync(new URL("../src/emotion-page.ts", import.meta.url), `// generated from pages/emotion/emotion.html (node scripts/gen-emotion-page.mjs)\nexport const EMOTION_PAGE_HTML: string = ${JSON.stringify(html)};\n`);
