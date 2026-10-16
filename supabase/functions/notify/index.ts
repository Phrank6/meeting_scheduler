// Emails the host (and a confirmation to the guest) when a booking is made or cancelled.
// Sends through your own Gmail account using an app password. Secrets to set:
//   GMAIL_USER, GMAIL_APP_PASSWORD, APP_URL (your GitHub Pages address)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function when(iso: string, durationMin: number, tz: string) {
  let zone = tz;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
  const start = new Date(iso);
  const end = new Date(start.getTime() + durationMin * 60000);
  const day = start.toLocaleDateString("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return `${day}, ${t(start)} to ${t(end)} (${zone})`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: auth } = await admin.auth.getUser(jwt);
    const caller = auth?.user;
    if (!caller) return json({ error: "Not signed in" }, 401);

    const { booking_id, event, tz } = await req.json();
    if (event !== "booked" && event !== "cancelled") return json({ error: "Bad event" }, 400);

    const { data: b } = await admin.from("bookings").select("*").eq("id", booking_id).maybeSingle();
    if (!b || (b.host_id !== caller.id && b.guest_id !== caller.id)) return json({ error: "Not allowed" }, 403);
    if (event === "booked" && (b.status !== "confirmed" || b.emailed_booking)) return json({ skipped: true });
    if (event === "cancelled" && (b.status !== "cancelled" || b.emailed_cancel)) return json({ skipped: true });

    const [{ data: hostRow }, { data: priv }, { data: hostProf }, { data: guestProf }, hostUser, guestUser] = await Promise.all([
      admin.from("hosts").select("tz, link").eq("user_id", b.host_id).maybeSingle(),
      admin.from("host_private").select("notify_email").eq("user_id", b.host_id).maybeSingle(),
      admin.from("profiles").select("name").eq("id", b.host_id).maybeSingle(),
      admin.from("profiles").select("name").eq("id", b.guest_id).maybeSingle(),
      admin.auth.admin.getUserById(b.host_id),
      admin.auth.admin.getUserById(b.guest_id),
    ]);

    const hostName = hostProf?.name ?? "your host";
    const guestName = guestProf?.name ?? "A guest";
    const hostTz = hostRow?.tz ?? "UTC";
    const hostTo = (priv?.notify_email || hostUser.data.user?.email || "").trim();
    const guestTo = (guestUser.data.user?.email ?? "").trim();
    const guestTz = caller.id === b.guest_id && typeof tz === "string" ? tz : hostTz;
    const link = hostRow?.link ? `\nWhere: ${hostRow.link}` : "";
    const topic = b.topic ? `\nTopic: ${b.topic}` : "";
    const appUrl = Deno.env.get("APP_URL") ?? "";
    const foot = appUrl ? `\n\nManage your meetings: ${appUrl}` : "";

    const mails: { to: string; subject: string; content: string }[] = [];
    if (event === "booked") {
      if (hostTo) mails.push({ to: hostTo, subject: `New booking: ${guestName}`,
        content: `${guestName} booked time with you.\n\n${when(b.start_at, b.duration_min, hostTz)}${topic}${link}${foot}` });
      if (guestTo) mails.push({ to: guestTo, subject: `Booked with ${hostName}`,
        content: `You are booked with ${hostName}.\n\n${when(b.start_at, b.duration_min, guestTz)}${topic}${link}${foot}` });
    } else {
      const byGuest = b.cancelled_by === b.guest_id;
      if (byGuest && hostTo) mails.push({ to: hostTo, subject: `Cancelled: ${guestName}`,
        content: `${guestName} cancelled.\n\n${when(b.start_at, b.duration_min, hostTz)}${foot}` });
      if (!byGuest && guestTo) mails.push({ to: guestTo, subject: `Cancelled by ${hostName}`,
        content: `${hostName} cancelled your meeting.\n\n${when(b.start_at, b.duration_min, guestTz)}${foot}` });
    }

    if (mails.length) {
      const user = Deno.env.get("GMAIL_USER")!;
      const client = new SMTPClient({
        connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
          auth: { username: user, password: Deno.env.get("GMAIL_APP_PASSWORD")! } },
      });
      try {
        for (const m of mails) await client.send({ from: user, to: m.to, subject: m.subject, content: m.content });
      } finally { await client.close(); }
    }

    await admin.from("bookings")
      .update(event === "booked" ? { emailed_booking: true } : { emailed_cancel: true })
      .eq("id", b.id);
    return json({ sent: mails.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
