// Runs once when the Next.js server starts. Boots the reminder scheduler that
// replays the voice cue for WhatsApp notes nobody has listened to yet.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReminderScheduler } = await import("@/lib/reminders");
  startReminderScheduler();

  // TCP bridge the ESP32 streams through while it talks with gpt-live-1.
  const { startLiveBridge } = await import("@/lib/live-bridge");
  startLiveBridge();

  // Start listening for WhatsApp notes even if nobody opens the web panel;
  // the sync webhook always points at this same server.
  const { ensureWacliSync } = await import("@/lib/wacli");
  const port = process.env.PORT ?? "3000";
  void ensureWacliSync(`http://127.0.0.1:${port}`).catch(() => {
    // Not linked yet, or wacli missing: the panel reports it.
  });
}
