import { copyFile, mkdir, readdir } from "node:fs/promises";
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

export async function buildPublic(root, output = join(root, "public-site")) {
  await mkdir(join(output, "assets"), { recursive: true });
  await verifyDirectory(output, files);
  for (const file of files) {
    const target = join(output, file);
    await copyFile(join(root, file), target);
  }
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("/build-public.mjs")) {
  await buildPublic(dirname(dirname(fileURLToPath(import.meta.url))));
}
