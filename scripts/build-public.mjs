import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const files = [
  "index.html", "robots.txt", "sitemap.xml", "llms.txt",
  "assets/hero-airport-transfer.jpg", "assets/carcargo-logo-original.png",
  "assets/carcargo-logo.png", "assets/apple-touch-icon.png", "assets/favicon.png",
  "assets/carcargo-share.png",
];

async function verifyDirectory(directory, allowed) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.name === "assets" && allowed === files && entry.isDirectory()) {
      await verifyDirectory(entryPath, files.filter(file => file.startsWith("assets/")).map(file => basename(file)));
    } else if (!entry.isFile() || !allowed.includes(entry.name)) {
      throw new Error("Unexpected item in public-site output. Use an empty output directory.");
    }
  }
}

export function renderPublicPage(html, context) {
  let rendered = html;
  for (const id of ["preview-booking-markup", "preview-booking-script"]) {
    const section = new RegExp(`<template id="${id}">([\\s\\S]*?)</template>`);
    if (!section.test(rendered)) throw new Error("Missing Preview booking template.");
    rendered = rendered.replace(section, context === "deploy-preview" ? "$1" : "");
  }
  return rendered;
}

export async function buildPublic(root, output = join(root, "public-site"), context) {
  await mkdir(join(output, "assets"), { recursive: true });
  await verifyDirectory(output, files);
  for (const file of files) {
    const target = join(output, file);
    if (file === "index.html") {
      await writeFile(target, renderPublicPage(await readFile(join(root, file), "utf8"), context));
    } else {
      await copyFile(join(root, file), target);
    }
  }
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("/build-public.mjs")) {
  await buildPublic(dirname(dirname(fileURLToPath(import.meta.url))), undefined, process.env.CONTEXT);
}
