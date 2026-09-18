#!/usr/bin/env node
// Finds child-like Spanish voices in the ElevenLabs voice library for Chapu's
// invented messages, and optionally adds them to the account and to .env.local.
//
//   node scripts/elevenlabs-kid-voices.mjs                 list candidates (with preview links)
//   node scripts/elevenlabs-kid-voices.mjs --add id1,id2   add those voices and write ELEVENLABS_KID_VOICES
//
// Needs ELEVENLABS_API_KEY in the environment or in .env.local. Library voices
// only work through the API once they are in "My Voices", hence --add.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const envPath = path.join(import.meta.dirname, "..", ".env.local");
const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const apiKey = process.env.ELEVENLABS_API_KEY ?? /^ELEVENLABS_API_KEY=(.+)$/m.exec(envText)?.[1]?.trim();
if (!apiKey) {
  console.error("Falta ELEVENLABS_API_KEY (en el entorno o en .env.local)");
  process.exit(1);
}

async function api(pathname, init = {}) {
  const response = await fetch(`https://api.elevenlabs.io${pathname}`, {
    ...init,
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

// The library has no "child" age bucket, so cast a wide net and keep what reads as a kid.
const searches = ["niño", "niña", "kid", "child", "nene", "infantil"];
const kidWords = /niñ|nene|nena|kid|child|infantil|boy|girl|chic[oa]|peque/i;
const found = new Map();
for (const search of searches) {
  for (const language of ["es", ""]) {
    const query = new URLSearchParams({ page_size: "30", search, ...(language ? { language } : {}) });
    const { voices = [] } = await api(`/v1/shared-voices?${query}`).catch((error) => (console.error(String(error)), {}));
    for (const voice of voices) {
      const spanish = voice.language === "es" || (voice.verified_languages ?? []).some((item) => item.language === "es");
      const text = `${voice.name} ${voice.description ?? ""} ${voice.descriptive ?? ""}`;
      if (spanish && kidWords.test(text)) found.set(voice.voice_id, voice);
    }
  }
}

const addIndex = process.argv.indexOf("--add");
if (addIndex < 0) {
  for (const voice of found.values()) {
    console.log(`${voice.voice_id}  ${voice.name}  [${voice.gender ?? "?"}, ${voice.age ?? "?"}, ${voice.accent ?? "?"}]`);
    console.log(`    ${(voice.description ?? "").slice(0, 140)}`);
    console.log(`    ${voice.preview_url ?? ""}`);
  }
  console.log(`\n${found.size} voces. Elegí 2 o 3 y corré: node scripts/elevenlabs-kid-voices.mjs --add id1,id2,id3`);
  process.exit(0);
}

const wanted = (process.argv[addIndex + 1] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const mine = new Set((await api("/v1/voices")).voices.map((voice) => voice.voice_id));
const usable = [];
for (const id of wanted) {
  if (mine.has(id)) {
    usable.push(id);
    continue;
  }
  const voice = found.get(id);
  if (!voice) {
    console.error(`${id}: no aparece en la búsqueda; agregala a mano desde la web de ElevenLabs`);
    continue;
  }
  const added = await api(`/v1/voices/add/${voice.public_owner_id}/${id}`, {
    method: "POST",
    body: JSON.stringify({ new_name: `Chapu - ${voice.name}`.slice(0, 60) }),
  });
  console.log(`Agregada ${voice.name} como ${added.voice_id}`);
  usable.push(added.voice_id);
}
if (usable.length === 0) process.exit(1);
const line = `ELEVENLABS_KID_VOICES=${usable.join(",")}`;
const nextEnv = /^ELEVENLABS_KID_VOICES=.*$/m.test(envText)
  ? envText.replace(/^ELEVENLABS_KID_VOICES=.*$/m, line)
  : `${envText}${envText && !envText.endsWith("\n") ? "\n" : ""}${line}\n`;
writeFileSync(envPath, nextEnv, { mode: 0o600 });
console.log(`${line}\nGuardado en .env.local. Reiniciá el servicio para que Chapu regrabe los mensajes.`);
