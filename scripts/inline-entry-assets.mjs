import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist", "client");
const htmlPath = path.join(distDir, "index.html");

const html = await readFile(htmlPath, "utf8");
let nextHtml = html;

nextHtml = await inlineStylesheet(nextHtml);
// Keep the module at its emitted /assets URL. Moving it into the document
// changes the base URL of relative imports and breaks lazy-loaded workspaces.

await writeFile(htmlPath, nextHtml, "utf8");

async function inlineStylesheet(source) {
  const linkPattern = /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+\.css)">/;
  const match = source.match(linkPattern);
  if (!match) return source;

  const cssPath = path.join(distDir, match[1]);
  const css = await readFile(cssPath, "utf8");
  const safeCss = css.replaceAll(/<\/style/gi, () => String.raw`<\/style`);
  return source.replace(match[0], () => `<style data-inline-entry>${safeCss}</style>`);
}
