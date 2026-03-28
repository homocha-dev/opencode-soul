import type { SoulConfig } from "./config";
import { dirname } from "path";
import { mkdir } from "fs/promises";

export async function readSoul(
  cfg: SoulConfig,
  name: string,
): Promise<string | null> {
  const soul = cfg.souls[name];
  if (!soul) return null;

  const file = Bun.file(soul.file);
  if (!(await file.exists())) return null;

  return file.text();
}

export async function writeSoul(
  cfg: SoulConfig,
  name: string,
  section: string,
  content: string,
): Promise<string> {
  const soul = cfg.souls[name];
  if (!soul) return `Soul "${name}" not found in config`;

  const file = Bun.file(soul.file);
  let existing = "";

  if (await file.exists()) {
    existing = await file.text();
  } else {
    await mkdir(dirname(soul.file), { recursive: true });
    existing = "# Soul\n";
  }

  const header = `## ${section}`;
  const idx = existing.indexOf(header);

  if (idx === -1) {
    // append new section
    const updated = existing.trimEnd() + `\n\n${header}\n${content}\n`;
    await Bun.write(soul.file, updated);
    return `Added section "${section}" to ${name}`;
  }

  // find the end of this section (next ## or end of file)
  const after = existing.indexOf("\n## ", idx + header.length);
  const end = after === -1 ? existing.length : after;

  const updated =
    existing.slice(0, idx) + `${header}\n${content}\n` + existing.slice(end);

  await Bun.write(soul.file, updated);
  return `Updated section "${section}" in ${name}`;
}
