import { readFile, writeFile } from "node:fs/promises";

const sizes = [16, 32, 48];

function directoryEntry(size, offset, length) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0);
  entry.writeUInt8(size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(length, 8);
  entry.writeUInt32LE(offset, 12);
  return entry;
}

async function buildIcon() {
  const images = await Promise.all(
    sizes.map((size) => readFile(new URL(`favicon-${size}.png`, import.meta.url))),
  );
  const header = Buffer.from([0, 0, 1, 0, sizes.length, 0]);
  let offset = header.length + sizes.length * 16;
  const entries = images.map((image, index) => {
    const entry = directoryEntry(sizes[index], offset, image.length);
    offset += image.length;
    return entry;
  });
  await writeFile(
    new URL("favicon.ico", import.meta.url),
    Buffer.concat([header, ...entries, ...images]),
  );
}

await buildIcon();
