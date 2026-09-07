import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type Recipient = {
  id: string;
  label: string;
  phone: string;
  color: string;
};

export type MessageBoxSettings = {
  recipients: Recipient[];
  selectedRecipientId: string;
};

// Physical agenda buttons on the box, in the same order as `recipients`.
export const AGENDA_SLOTS = 4;

const settingsPath = path.join(process.cwd(), "data", "settings.json");
const defaultSettings: MessageBoxSettings = {
  recipients: [{
    id: "self",
    label: "Mi número",
    phone: "+15555550100",
    color: "#19c96b",
  }],
  selectedRecipientId: "self",
};

// A destination is either an international phone number or a WhatsApp group
// JID such as 120363012345678901@g.us; both are stored in `phone`.
const GROUP_JID = /^\d{5,}@g\.us$/;

export function isGroupDestination(destination: string) {
  return GROUP_JID.test(destination);
}

function normalizePhone(phone: string) {
  const trimmed = phone.trim();
  if (isGroupDestination(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("Ingresá un número internacional válido o elegí un grupo");
  }
  return `+${digits}`;
}

export async function readSettings(): Promise<MessageBoxSettings> {
  try {
    return JSON.parse(await fs.readFile(settingsPath, "utf8")) as MessageBoxSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeSettings(defaultSettings);
    return defaultSettings;
  }
}

export async function writeSettings(settings: MessageBoxSettings) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

export async function selectRecipient(id: string) {
  const settings = await readSettings();
  if (!settings.recipients.some((recipient) => recipient.id === id)) {
    throw new Error("Destinatario desconocido");
  }
  settings.selectedRecipientId = id;
  await writeSettings(settings);
  return settings;
}

export async function addRecipient(label: string, phone: string) {
  const settings = await readSettings();
  const normalizedPhone = normalizePhone(phone);
  const existing = settings.recipients.find((recipient) => recipient.phone === normalizedPhone);
  if (existing) {
    settings.selectedRecipientId = existing.id;
    await writeSettings(settings);
    return settings;
  }
  if (settings.recipients.length >= AGENDA_SLOTS) {
    throw new Error(`La caja tiene ${AGENDA_SLOTS} botones de agenda; editá uno existente`);
  }
  const colors = ["#ffca46", "#57a8ff", "#ff7f74", "#b48cff"];
  const recipient: Recipient = {
    id: randomUUID().slice(0, 8),
    label: label.trim().slice(0, 24) || normalizedPhone,
    phone: normalizedPhone,
    color: colors[settings.recipients.length % colors.length],
  };
  settings.recipients.push(recipient);
  settings.selectedRecipientId = recipient.id;
  await writeSettings(settings);
  return settings;
}

export async function updateRecipient(id: string, label: string, phone: string) {
  const settings = await readSettings();
  const recipient = settings.recipients.find((item) => item.id === id);
  if (!recipient) throw new Error("Destinatario desconocido");

  const normalizedPhone = normalizePhone(phone);
  const duplicate = settings.recipients.find((item) => item.id !== id && item.phone === normalizedPhone);
  if (duplicate) throw new Error("Ese número ya está en la agenda");

  const normalizedLabel = label.trim().slice(0, 24);
  if (!normalizedLabel) throw new Error("Ingresá un nombre");

  recipient.label = normalizedLabel;
  recipient.phone = normalizedPhone;
  await writeSettings(settings);
  return settings;
}

/**
 * Moves a contact to another agenda button. Buttons map to positions in
 * `recipients`, so this swaps positions; a target beyond the last contact
 * moves it to the end (the first free button).
 */
export async function moveRecipient(id: string, toSlot: number) {
  const settings = await readSettings();
  const fromIndex = settings.recipients.findIndex((recipient) => recipient.id === id);
  if (fromIndex < 0) throw new Error("Destinatario desconocido");
  if (!Number.isInteger(toSlot) || toSlot < 0 || toSlot >= AGENDA_SLOTS) throw new Error("Botón inválido");

  const toIndex = Math.min(toSlot, settings.recipients.length - 1);
  if (toIndex === fromIndex) return { settings, swappedWith: null };
  const swappedWith = settings.recipients[toIndex];
  [settings.recipients[fromIndex], settings.recipients[toIndex]] = [settings.recipients[toIndex], settings.recipients[fromIndex]];
  await writeSettings(settings);
  return { settings, swappedWith };
}

export async function getSelectedRecipient() {
  const settings = await readSettings();
  return settings.recipients.find((recipient) => recipient.id === settings.selectedRecipientId)
    ?? settings.recipients[0];
}
