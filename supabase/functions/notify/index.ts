// Emails an invitation (with a calendar file) when a booking is made, and a notice when one is cancelled.
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

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function safeZone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}
function whenParts(iso: string, durationMin: number, tz: string) {
  const zone = safeZone(tz);
  const start = new Date(iso);
  const end = new Date(start.getTime() + durationMin * 60000);
  const day = start.toLocaleDateString("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const t = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return { day, time: `${t(start)} – ${t(end)}`, zone };
}
const ics = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

function buildIcs(o: { id: string; start: string; dur: number; title: string; desc: string; where: string; cancel: boolean; organizer: string }) {
  const s = new Date(o.start), e = new Date(s.getTime() + o.dur * 60000);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Open Hours//EN", "CALSCALE:GREGORIAN",
    `METHOD:${o.cancel ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${o.id}@open-hours`,
    `DTSTAMP:${ics(new Date())}`,
    `DTSTART:${ics(s)}`, `DTEND:${ics(e)}`,
    `SUMMARY:${icsEsc(o.title)}`,
    `DESCRIPTION:${icsEsc(o.desc)}`,
    o.where ? `LOCATION:${icsEsc(o.where)}` : "",
    `STATUS:${o.cancel ? "CANCELLED" : "CONFIRMED"}`,
    `SEQUENCE:${o.cancel ? 1 : 0}`,
  ].filter(Boolean);
  if (!o.cancel) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Meeting in 15 minutes", "TRIGGER:-PT15M", "END:VALARM");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

function html(o: {
  preheader: string; kicker: string; heading: string; intro: string;
  day: string; time: string; zone: string; length: string; who: string; whoLabel: string;
  where: string; topic: string; note: string; appUrl: string; cancelled: boolean;
}) {
  const accent = o.cancelled ? "#B3261E" : "#2448C9";
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#586979;font-size:13px;width:92px;vertical-align:top">${label}</td><td style="padding:6px 0;font-size:15px;color:#13202B">${value}</td></tr>`;
  const whereHtml = /^https?:\/\//i.test(o.where)
    ? `<a href="${esc(o.where)}" style="color:${accent}">${esc(o.where)}</a>` : esc(o.where);
  return `<!doctype html><html><body style="margin:0;background:#EEF2F5;font-family:Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #D6DEE5">
<tr><td style="background:${accent};padding:18px 24px;color:#fff;font-size:13px;letter-spacing:.08em;text-transform:uppercase;font-weight:bold">${esc(o.kicker)}</td></tr>
<tr><td style="padding:24px 24px 8px">
<h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:#13202B">${esc(o.heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#13202B">${esc(o.intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F9;border-radius:10px;padding:12px 16px">
<tr><td colspan="2" style="padding:4px 0 8px"><div style="font-size:18px;font-weight:bold;color:#13202B;${o.cancelled ? "text-decoration:line-through" : ""}">${esc(o.day)}</div>
<div style="font-size:16px;color:#13202B;${o.cancelled ? "text-decoration:line-through" : ""}">${esc(o.time)} <span style="color:#586979;font-size:13px">(${esc(o.zone)})</span></div></td></tr>
${row("Length", esc(o.length))}
${row(o.whoLabel, esc(o.who))}
${o.where ? row("Where", whereHtml) : ""}
${o.topic ? row("Topic", esc(o.topic)) : ""}
</table>
<p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#586979">${esc(o.note)}</p>
${o.appUrl ? `<p style="margin:20px 0 8px"><a href="${esc(o.appUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:bold;font-size:15px;padding:11px 20px;border-radius:8px">Open my schedule</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px 24px;font-size:12px;color:#586979">Sent by Open Hours. The attached calendar file adds this meeting to Google Calendar, Outlook or Apple Calendar${o.cancelled ? " and removes it if it was already added" : ", with a reminder 15 minutes before"}.</td></tr>
</table></td></tr></table></body></html>`;
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
    const where = hostRow?.link ?? "";
    const appUrl = Deno.env.get("APP_URL") ?? "";
    const length = b.duration_min >= 60 && b.duration_min % 60 === 0 ? `${b.duration_min / 60} hour${b.duration_min > 60 ? "s" : ""}` : `${b.duration_min} minutes`;

    type Mail = { to: string; subject: string; text: string; html: string; ics: string };
    const mails: Mail[] = [];
    const make = (to: string, zone: string, cancelled: boolean, p: {
      subject: string; kicker: string; heading: string; intro: string; whoLabel: string; who: string; note: string; icsTitle: string;
    }) => {
      const w = whenParts(b.start_at, b.duration_min, zone);
      const text = [
        p.heading, "", p.intro, "",
        `${w.day}`, `${w.time} (${w.zone})`, `Length: ${length}`, `${p.whoLabel}: ${p.who}`,
        where ? `Where: ${where}` : "", b.topic ? `Topic: ${b.topic}` : "", "",
        p.note, appUrl ? `\nOpen my schedule: ${appUrl}` : "",
      ].filter((l) => l !== "").join("\n");
      mails.push({
        to, subject: p.subject, text,
        html: html({ preheader: `${w.day}, ${w.time}`, kicker: p.kicker, heading: p.heading, intro: p.intro, day: w.day, time: w.time,
          zone: w.zone, length, who: p.who, whoLabel: p.whoLabel, where, topic: b.topic ?? "", note: p.note, appUrl, cancelled }),
        ics: buildIcs({ id: b.id, start: b.start_at, dur: b.duration_min, title: p.icsTitle,
          desc: b.topic ? `Topic: ${b.topic}` : "One-on-one meeting booked through Open Hours.", where, cancel: cancelled, organizer: hostName }),
      });
    };

    if (event === "booked") {
      if (hostTo) make(hostTo, hostTz, false, {
        subject: `You're invited: meeting with ${guestName}`, kicker: "New booking",
        heading: `${guestName} booked time with you`,
        intro: `Good news. ${guestName} picked a slot from your open hours. It is on your calendar below.`,
        whoLabel: "With", who: guestName,
        note: "Need to change plans? Open your schedule and cancel, and we will let them know.",
        icsTitle: `Meeting with ${guestName}`,
      });
      if (guestTo) make(guestTo, guestTz, false, {
        subject: `Confirmed: meeting with ${hostName}`, kicker: "You're booked",
        heading: `You're booked with ${hostName}`,
        intro: `Your time with ${hostName} is confirmed. Add it to your calendar and we will nudge you before it starts.`,
        whoLabel: "With", who: hostName,
        note: "Plans changed? Please cancel from your schedule so the time frees up for someone else.",
        icsTitle: `Meeting with ${hostName}`,
      });
    } else {
      const byGuest = b.cancelled_by === b.guest_id;
      if (byGuest && hostTo) make(hostTo, hostTz, true, {
        subject: `Cancelled: ${guestName}`, kicker: "Cancelled",
        heading: `${guestName} cancelled`, intro: "This time is open again for others to book.",
        whoLabel: "With", who: guestName, note: "No action needed.", icsTitle: `Meeting with ${guestName}`,
      });
      if (!byGuest && guestTo) make(guestTo, guestTz, true, {
        subject: `Cancelled by ${hostName}`, kicker: "Cancelled",
        heading: `${hostName} cancelled your meeting`, intro: "Sorry about that. You can pick another time from their open hours.",
        whoLabel: "With", who: hostName, note: "Open the site to book a different slot.", icsTitle: `Meeting with ${hostName}`,
      });
    }

    if (mails.length) {
      const user = Deno.env.get("GMAIL_USER")!;
      const client = new SMTPClient({
        connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
          auth: { username: user, password: Deno.env.get("GMAIL_APP_PASSWORD")! } },
      });
      try {
        for (const m of mails) {
          await client.send({
            from: `Open Hours <${user}>`, to: m.to, subject: m.subject, content: m.text, html: m.html,
            attachments: [{ filename: "meeting.ics", content: m.ics, contentType: "text/calendar; charset=utf-8", encoding: "text" }],
          });
        }
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
