import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(value) {
  return String(value ?? "").trim();
}

function buildReceiptText(member, mode, items) {
  const lines = [];

  lines.push("IGELKOTTS BIBLIOTEKEN");
  lines.push("");
  lines.push(mode === "borrow" ? "LÅNEKVITTO" : "ÅTERLÄMNINGSKVITTO");
  lines.push("");
  lines.push(`Namn: ${member.name}`);
  lines.push(`Lånekort: ${member.card_number}`);
  lines.push(`Datum: ${new Date().toLocaleString("sv-SE", {
    timeZone: "Europe/Stockholm"
  })}`);
  lines.push("");

  for (const item of items || []) {
    lines.push(`- ${item.title || "Okänd bok"}`);

    if (mode === "borrow" && item.due_date) {
      lines.push(`  Förfaller: ${item.due_date}`);
    }
  }

  lines.push("");
  lines.push("Tack för besöket!");

  return lines.join("\n");
}

function buildReceiptHtml(member, mode, items) {
  const title =
    mode === "borrow"
      ? "Lånekvitto"
      : "Återlämningskvitto";

  const rows = (items || []).map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #ddd">
        ${esc(item.title || "Okänd bok")}
      </td>
      <td style="padding:8px;border-bottom:1px solid #ddd">
        ${mode === "borrow"
          ? esc(item.due_date || "-")
          : "Återlämnad"}
      </td>
    </tr>
  `).join("");

  return `
  <!doctype html>
  <html lang="sv">
  <body style="font-family:Arial,sans-serif">
    <h1>📚 Igelkotts Biblioteken</h1>
    <h2>${esc(title)}</h2>

    <p>
      <b>Namn:</b> ${esc(member.name)}<br>
      <b>Lånekort:</b> ${esc(member.card_number)}
    </p>

    <table style="border-collapse:collapse;width:100%">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px">Bok</th>
          <th style="text-align:left;padding:8px">
            ${mode === "borrow" ? "Förfaller" : "Status"}
          </th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p>Tack för besöket!</p>
  </body>
  </html>
  `;
}

Deno.serve(async (req) => {

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }

  if (req.method !== "POST") {
    return json({
      ok: false,
      message: "Endast POST stöds."
    }, 405);
  }

  try {

    const body = await req.json();

    const receiptToken = text(body.receipt_token);
    const channel = text(body.channel).toLowerCase();
    const mode = text(body.mode).toLowerCase();
    const items = Array.isArray(body.items) ? body.items : [];

    if (!receiptToken) {
      return json({
        ok: false,
        message: "Kvittotoken saknas."
      }, 400);
    }

    if (!["email", "sms"].includes(channel)) {
      return json({
        ok: false,
        message: "Ogiltig kvittokanal."
      }, 400);
    }

    if (!["borrow", "return"].includes(mode)) {
      return json({
        ok: false,
        message: "Ogiltigt kvittoläge."
      }, 400);
    }

    if (!items.length) {
      return json({
        ok: false,
        message: "Kvittot innehåller inga böcker."
      }, 400);
    }


    // Server-side Supabase client.
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");

    if (!supabaseUrl || !secretKeysRaw) {
      throw new Error("Supabase Edge Function är inte korrekt konfigurerad.");
    }

    const secretKeys = JSON.parse(secretKeysRaw);
    const secretKey = secretKeys["default"];

    if (!secretKey) {
      throw new Error("Supabase secret key saknas.");
    }

    const supabaseAdmin = createClient(
      supabaseUrl,
      secretKey
    );


    // Kontrollera token.
    const tokenHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(receiptToken)
    );

    const tokenHashHex =
      Array.from(new Uint8Array(tokenHash))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");


    const { data: tokenRow, error: tokenError } =
      await supabaseAdmin
        .from("receipt_tokens")
        .select("id,member_id,expires_at,used_at")
        .eq("token_hash", tokenHashHex)
        .maybeSingle();

    if (tokenError) throw tokenError;

    if (!tokenRow) {
      return json({
        ok: false,
        message: "Kvitto-sessionen hittades inte."
      }, 401);
    }

    if (tokenRow.used_at) {
      return json({
        ok: false,
        message: "Kvitto-sessionen har redan använts."
      }, 401);
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return json({
        ok: false,
        message: "Kvitto-sessionen har gått ut. Logga in igen."
      }, 401);
    }


    // Hämta mottagarens kontaktuppgifter från databasen.
    const { data: member, error: memberError } =
      await supabaseAdmin
        .from("members")
        .select("id,name,card_number,email,phone")
        .eq("id", tokenRow.member_id)
        .single();

    if (memberError) throw memberError;


    // Kontrollera att mottagaren verkligen har valt en kanal.
    if (channel === "email" && !member.email) {
      return json({
        ok: false,
        message: "Det finns ingen e-postadress registrerad."
      }, 400);
    }

    if (channel === "sms" && !member.phone) {
      return json({
        ok: false,
        message: "Det finns inget telefonnummer registrerat."
      }, 400);
    }


    const receiptText =
      buildReceiptText(member, mode, items);

    const receiptHtml =
      buildReceiptHtml(member, mode, items);


    // ======================================================
    // E-POST VIA RESEND
    // ======================================================

    if (channel === "email") {

      const resendKey =
        Deno.env.get("RESEND_API_KEY");

      const fromEmail =
        Deno.env.get("RESEND_FROM_EMAIL");

      if (!resendKey || !fromEmail) {
        throw new Error(
          "E-posttjänsten är inte konfigurerad. Lägg in RESEND_API_KEY och RESEND_FROM_EMAIL."
        );
      }


      const emailResponse =
        await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              "Authorization":
                `Bearer ${resendKey}`,
              "Content-Type":
                "application/json"
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [member.email],
              subject:
                mode === "borrow"
                  ? "Igelkotts Biblioteken – lånekvitto"
                  : "Igelkotts Biblioteken – återlämningskvitto",
              html: receiptHtml,
              text: receiptText
            })
          }
        );


      if (!emailResponse.ok) {

        const errorText =
          await emailResponse.text();

        throw new Error(
          `E-posttjänsten svarade med fel: ${errorText}`
        );

      }

    }


    // ======================================================
    // SMS VIA TWILIO
    // ======================================================

    if (channel === "sms") {

      const sid =
        Deno.env.get("TWILIO_ACCOUNT_SID");

      const auth =
        Deno.env.get("TWILIO_AUTH_TOKEN");

      const from =
        Deno.env.get("TWILIO_FROM_NUMBER");

      if (!sid || !auth || !from) {
        throw new Error(
          "SMS-tjänsten är inte konfigurerad. Lägg in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN och TWILIO_FROM_NUMBER."
        );
      }


      const smsResponse =
        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              "Authorization":
                "Basic " +
                btoa(`${sid}:${auth}`),
              "Content-Type":
                "application/x-www-form-urlencoded"
            },
            body:
              new URLSearchParams({
                From: from,
                To: member.phone,
                Body: receiptText
              }).toString()
          }
        );


      if (!smsResponse.ok) {

        const errorText =
          await smsResponse.text();

        throw new Error(
          `SMS-tjänsten svarade med fel: ${errorText}`
        );

      }

    }


    // Token får användas en gång.
    await supabaseAdmin
      .from("receipt_tokens")
      .update({
        used_at: new Date().toISOString()
      })
      .eq("id", tokenRow.id);


    return json({
      ok: true,
      message:
        channel === "sms"
          ? "Kvitto skickat via SMS."
          : "Kvitto skickat via e-post."
    });


  } catch (error) {

    return json({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Ett okänt fel inträffade."
    }, 500);

  }

});
