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

function normalizePhone(phone: string) {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("Ingresá un número internacional válido");
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

export async function getSelectedRecipient() {
  const settings = await readSettings();
  return settings.recipients.find((recipient) => recipient.id === settings.selectedRecipientId)
    ?? settings.recipients[0];
}
