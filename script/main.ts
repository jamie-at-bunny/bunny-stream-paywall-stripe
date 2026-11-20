import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.13.0";
import { connect } from "npm:@bunny.net/database-client";
import process from "node:process";
import * as z from "npm:zod@4";

// Parsed at startup, so a missing secret stops the script on its first run
// with the variable's name in the error.
const env = z
  .object({
    SITE_URL: z.url(),
    COOKIE_SECRET: z.string().min(32),
    STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_/),
    STRIPE_PRICE_ID: z.string().startsWith("price_"),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
    STREAM_LIBRARY_ID: z.string().min(1),
    STREAM_VIDEO_ID: z.string().min(1),
    STREAM_TOKEN_KEY: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    EMAIL_FROM: z.string().min(1),
    BUNNY_DATABASE_URL: z.url(),
    BUNNY_DATABASE_AUTH_TOKEN: z.string().min(1),
  })
  .parse(process.env);

// Reads BUNNY_DATABASE_URL and BUNNY_DATABASE_AUTH_TOKEN from the environment.
const db = connect();

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function sha256(input: string) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

// Compare two strings without leaking where they differ.
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function redirect(location: string, cookie?: string) {
  const headers = new Headers({ Location: location });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// The access cookie: an expiry time and an HMAC of it
// ---------------------------------------------------------------------------

const THIRTY_DAYS = 60 * 60 * 24 * 30;

async function accessCookie() {
  const expires = Math.floor(Date.now() / 1000) + THIRTY_DAYS;
  const signature = await hmac(env.COOKIE_SECRET, String(expires));
  return `access=${expires}.${signature}; Path=/; Max-Age=${THIRTY_DAYS}; HttpOnly; Secure; SameSite=Lax`;
}

async function hasAccess(request: Request) {
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.match(/(?:^|;\s*)access=(\d+)\.([a-f0-9]{64})/);
  if (!match) return false;

  const [, expires, signature] = match;
  const stillValid = Number(expires) > Date.now() / 1000;
  return stillValid && safeEqual(signature, await hmac(env.COOKIE_SECRET, expires));
}

// ---------------------------------------------------------------------------
// Stripe Checkout
// ---------------------------------------------------------------------------

const CheckoutSession = z.object({
  id: z.string(),
  created: z.number(),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  customer_details: z.object({ email: z.email().nullable() }).nullable(),
});
type CheckoutSession = z.infer<typeof CheckoutSession>;

async function stripe<T>(schema: z.ZodType<T>, path: string, body?: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    body,
  });
  if (!response.ok) throw new Error(`Stripe returned ${response.status}`);
  return schema.parse(await response.json());
}

async function startCheckout() {
  const session = await stripe(
    CheckoutSession.extend({ url: z.url() }),
    "checkout/sessions",
    new URLSearchParams({
      mode: "payment",
      "line_items[0][price]": env.STRIPE_PRICE_ID,
      "line_items[0][quantity]": "1",
      // {CHECKOUT_SESSION_ID} is a literal string. Stripe swaps in the real ID.
      success_url: `${env.SITE_URL}/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.SITE_URL}/`,
    }),
  );
  return redirect(session.url);
}

const ONE_DAY = 60 * 60 * 24;

// Arriving at the success URL proves nothing, so ask Stripe about the session.
async function confirmPurchase(url: URL) {
  const id = url.searchParams.get("session_id");
  if (!id) return redirect("/");

  try {
    const session = await stripe(
      CheckoutSession,
      `checkout/sessions/${encodeURIComponent(id)}`,
    );
    const recent = Date.now() / 1000 - session.created < ONE_DAY;
    if (session.payment_status !== "paid" || !recent) return redirect("/");

    // A paid buyer still gets the cookie when fulfil fails. The webhook retries it.
    await fulfil(session).catch((error) => console.error("fulfil failed", error));
    return redirect("/watch.html", await accessCookie());
  } catch {
    return redirect("/");
  }
}

// ---------------------------------------------------------------------------
// Recording the purchase and emailing an access code
// ---------------------------------------------------------------------------

// Called from the success redirect and the webhook, sometimes within the same
// second, so the insert ignores a session it has already seen and the email
// only goes out when a new row lands.
async function fulfil(session: CheckoutSession) {
  const email = session.customer_details?.email;
  if (!email) throw new Error(`Session ${session.id} has no email`);

  const code = crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
  const result = await db.sql`
    INSERT INTO purchases (session_id, email, code_hash)
    VALUES (${session.id}, ${email}, ${await sha256(code)})
    ON CONFLICT (session_id) DO NOTHING`.run();
  if (result.rowsAffected !== 1) return;

  try {
    await sendCode(email, code);
  } catch (error) {
    // Only the hash is stored, so an unsent code is lost. Remove the row
    // and let the next attempt create a fresh one.
    await db.sql`DELETE FROM purchases WHERE session_id = ${session.id}`.run();
    throw error;
  }
}

async function sendCode(to: string, code: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: "Your access code",
      text: `Thanks for buying. Watch any time at ${env.SITE_URL}/unlock.html with this code: ${code}`,
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

// ---------------------------------------------------------------------------
// Unlocking on another device
// ---------------------------------------------------------------------------

const AccessCode = z.string().trim().toUpperCase().regex(/^[0-9A-F]{16}$/);

async function unlock(request: Request) {
  const form = await request.formData();
  const code = AccessCode.safeParse(form.get("code"));
  if (!code.success) return redirect("/unlock.html");

  const purchase = await db.sql`
    SELECT session_id FROM purchases
    WHERE code_hash = ${await sha256(code.data)} AND revoked = 0`.first();

  if (!purchase) return redirect("/unlock.html");
  return redirect("/watch.html", await accessCookie());
}

// ---------------------------------------------------------------------------
// Stripe webhook: catches the buyers who paid and closed the tab
// ---------------------------------------------------------------------------

const StripeEvent = z.object({
  type: z.string(),
  data: z.object({ object: z.unknown() }),
});

async function stripeWebhook(request: Request) {
  // The signature covers the exact raw body, so don't parse it first.
  const payload = await request.text();
  const header = request.headers.get("stripe-signature") ?? "";

  const timestamp = header.match(/t=(\d+)/)?.[1] ?? "";
  const signatures = [...header.matchAll(/v1=([a-f0-9]+)/g)].map((m) => m[1]);
  const expected = await hmac(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${payload}`);

  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  const genuine = signatures.some((signature) => safeEqual(signature, expected));
  if (!fresh || !genuine) return new Response("Invalid signature", { status: 400 });

  try {
    const event = StripeEvent.parse(JSON.parse(payload));
    if (event.type === "checkout.session.completed") {
      const session = CheckoutSession.parse(event.data.object);
      if (session.payment_status === "paid") await fulfil(session);
    }
    return new Response("ok");
  } catch (error) {
    console.error("webhook failed", error);
    // A 500 tells Stripe to deliver the event again later.
    return new Response("Try again", { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// The signed Bunny Stream player URL
// ---------------------------------------------------------------------------

async function signedEmbedUrl() {
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 4;
  const token = await sha256(
    env.STREAM_TOKEN_KEY + env.STREAM_VIDEO_ID + expires,
  );
  return (
    `https://player.mediadelivery.net/embed/` +
    `${env.STREAM_LIBRARY_ID}/${env.STREAM_VIDEO_ID}` +
    `?token=${token}&expires=${expires}`
  );
}

// ---------------------------------------------------------------------------
// The middleware. Client hooks run on every request, cache hit or miss.
// ---------------------------------------------------------------------------

BunnySDK.net.http
  .servePullZone({ url: env.SITE_URL })
  .onClientRequest(async ({ request }) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    if (route === "POST /buy") return startCheckout();
    if (route === "GET /thanks") return confirmPurchase(url);
    if (route === "POST /unlock") return unlock(request);
    if (route === "POST /webhooks/stripe") return stripeWebhook(request);

    if (url.pathname === "/watch.html" && !(await hasAccess(request))) {
      return redirect("/unlock.html");
    }

    return request;
  })
  .onClientResponse(async ({ request, response }) => {
    if (new URL(request.url).pathname !== "/watch.html") return response;

    // Fill in a personal signed URL without the CDN ever storing it.
    const src = await signedEmbedUrl();
    const page = new HTMLRewriter()
      .on("iframe#player", {
        element(player) {
          player.setAttribute("src", src);
        },
      })
      .transform(response);

    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(page.body, { status: page.status, headers });
  });
