"use client";

import { useEffect, useRef, useState } from "react";

type RecorderResources = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
};

const MAX_RECORDING_MS = 3000;

function mergeChunks(chunks: Float32Array[]) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resample(input: Float32Array, sourceRate: number, targetRate: number) {
  if (sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function encodeWave(samples: Float32Array, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

type Props = {
  recipientId: string;
  label: string;
  nameSource: "recorded" | "generated";
  onChange: () => void;
};

/**
 * Records the contact's name from the browser microphone (up to 3 s), saves it
 * as the spoken name Chapu plays, and lets the user preview or remove it.
 */
export function NameRecorder({ recipientId, label, nameSource, onChange }: Props) {
  const recorder = useRef<RecorderResources | null>(null);
  const stopTimer = useRef<number | null>(null);
  const clockTimer = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "recording" | "saving">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState("");
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    if (clockTimer.current !== null) window.clearInterval(clockTimer.current);
    recorder.current?.stream.getTracks().forEach((track) => track.stop());
    void recorder.current?.context.close();
  }, []);

  const stopAndSave = async () => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    if (clockTimer.current !== null) window.clearInterval(clockTimer.current);
    active.processor.disconnect();
    active.source.disconnect();
    active.silentGain.disconnect();
    active.stream.getTracks().forEach((track) => track.stop());
    await active.context.close();

    const captured = mergeChunks(active.chunks);
    if (captured.length < active.sampleRate / 5) {
      setStatus("idle");
      setError("La grabación fue demasiado corta. Probá de nuevo.");
      return;
    }

    setStatus("saving");
    try {
      const wave = encodeWave(resample(captured, active.sampleRate, 16000));
      const response = await fetch(`/api/settings/names/${recipientId}`, {
        method: "PUT",
        headers: { "Content-Type": "audio/wav" },
        body: wave,
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "No se pudo guardar el nombre");
      setPreviewKey((value) => value + 1);
      onChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No se pudo guardar el nombre");
    } finally {
      setStatus("idle");
    }
  };

  const startRecording = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentGain = context.createGain();
      const chunks: Float32Array[] = [];
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      recorder.current = { context, stream, source, processor, silentGain, chunks, sampleRate: context.sampleRate };
      const startedAt = performance.now();
      setElapsedMs(0);
      setStatus("recording");
      clockTimer.current = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 50);
      stopTimer.current = window.setTimeout(() => void stopAndSave(), MAX_RECORDING_MS);
    } catch {
      setError("Necesito permiso para usar el micrófono de la Mac.");
    }
  };

  const removeRecording = async () => {
    setError("");
    const response = await fetch(`/api/settings/names/${recipientId}`, { method: "DELETE" });
    if (!response.ok) {
      setError("No se pudo borrar la grabación");
      return;
    }
    setPreviewKey((value) => value + 1);
    onChange();
  };

  return (
    <div className="name-recorder">
      <div className="name-recorder-status">
        <span>Nombre que dice Chapu</span>
        <strong>{nameSource === "recorded" ? `Grabado: "${label}"` : `Voz de la Mac: "${label}"`}</strong>
      </div>
      <audio key={previewKey} controls preload="none" src={`/api/settings/names/${recipientId}?v=${previewKey}`}>
        Tu navegador no puede reproducir este audio.
      </audio>
      <div className="name-recorder-actions">
        <button
          type="button"
          className={`record-name-button is-${status}`}
          disabled={status === "saving"}
          onClick={status === "recording" ? () => void stopAndSave() : () => void startRecording()}
        >
          {status === "recording" ? `Grabando ${(elapsedMs / 1000).toFixed(1)} / 3.0 s · tocar para guardar`
            : status === "saving" ? "Guardando…"
              : nameSource === "recorded" ? "Volver a grabar" : "Grabar nombre"}
        </button>
        {nameSource === "recorded" && status === "idle" && (
          <button type="button" className="cancel-add-person" onClick={() => void removeRecording()}>Usar voz de la Mac</button>
        )}
      </div>
      {error && <p className="name-recorder-error">{error}</p>}
    </div>
  );
}
