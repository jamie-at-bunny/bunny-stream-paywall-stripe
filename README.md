# Selling videos with Bunny Stream and Stripe

A paywall for a single video with no app server and no user accounts. One Edge Script sits in front of a static site. Bunny Stream won't play the video without a signed token, and the script won't sign that token until Stripe confirms the payment.

This is the finished project from the tutorial **Selling Videos with Bunny Stream and Stripe**.

## How it works

- **Bunny Stream** hosts the video and refuses to play it without a signed token.
- **Bunny Storage** serves the static HTML behind a Pull Zone.
- **An Edge Script** runs as middleware on that Pull Zone. It creates the checkout session, checks that Stripe has marked it paid, sets a signed access cookie, and signs the player URL.
- **Stripe Checkout** collects the money.
- **Bunny Database** stores each purchase, and an emailed access code lets the buyer watch on another device.

The script is the only component that holds secrets.

## What's in the repo

| Path | What it is |
| --- | --- |
| `public/index.html` | The sales page. The buy button is a plain form that posts to `/buy`. |
| `public/watch.html` | The player page, with an empty `iframe#player` the script fills in. |
| `public/unlock.html` | Where a returning buyer enters their access code. |
| `script/main.ts` | The Edge Script: routes, the gate, Stripe, the webhook and the signed player URL. |
| `schema.sql` | The `purchases` table for Bunny Database. |
| `.env.example` | Every environment variable the script needs. |

## Routes

| Route | What the script does |
| --- | --- |
| `POST /buy` | Creates a Checkout Session and redirects to Stripe. |
| `GET /thanks?session_id=...` | Asks Stripe if the session is paid, records it, sets the cookie. |
| `POST /unlock` | Checks an access code against the database and sets the cookie. |
| `POST /webhooks/stripe` | Verifies Stripe's signature and records `checkout.session.completed`. |
| `GET /watch.html` | Redirects to `/unlock.html` without a valid cookie, otherwise signs the player URL. |

## Set it up

You'll need a [bunny.net](https://bunny.net) account with the bunny.net CLI installed, a Stripe account in test mode, and a [Resend](https://resend.com) API key (or any email provider with an HTTP API).

### 1. Lock the video

Upload your video to a Stream library. Under **Stream > your library > Security**, turn on **embed view token authentication**, copy the **Token authentication key**, and add your site's hostname to **Allowed domains**.

### 2. Publish the pages

```bash
bunny sites create video-shop
```

```bash
bunny sites deploy ./public
```

### 3. Create the database

Create a Bunny Database and run `schema.sql` against it. On its **Access** page, generate tokens and choose **Add Secrets to Edge Script** once the script exists.

### 4. Set up Stripe

Create a product with a one-time price and copy the price ID. Create a restricted API key that can only read and write Checkout Sessions. Add a webhook endpoint at `https://<your-site>/webhooks/stripe` for the `checkout.session.completed` event and copy its signing secret.

### 5. Deploy the script

Create a middleware script and attach it to the site's Pull Zone:

```bash
bunny scripts init --name video-shop-gate --type middleware
```

Replace the scaffolded entry file with `script/main.ts`, then set each variable from `.env.example`, using `--secret` for the secrets:

```bash
bunny scripts env set SITE_URL https://video-shop.b-cdn.net
```

```bash
bunny scripts env set COOKIE_SECRET <long-random-string> --secret
```

Deploy it:

```bash
bunny scripts deploy <file>
```

Finally, open the Pull Zone, go to **General > Origin** and turn on **Run script before cache**. If it's off, the gate doesn't run and no error tells you.

## Check it works

1. `curl -I https://<your-site>/watch.html` returns a `303` to `/unlock.html`.
2. The unsigned player URL, `https://player.mediadelivery.net/embed/{library_id}/{video_id}`, returns `403`.
3. `/thanks?session_id=cs_test_made_up` sends you back to the sales page.
4. A test purchase with card `4242 4242 4242 4242` lands on `/watch.html` with the video playing, and one email arrives.
5. The emailed code unlocks the video in a private window.

If the watch page loads without a cookie, **Run script before cache** is switched off on the Pull Zone. If the player shows a 403 after a successful purchase, check that `STREAM_TOKEN_KEY` holds the token authentication key and that `STREAM_VIDEO_ID` matches the video.

## What this leaves out

- Buyers can save the video with a browser extension. Blocking downloads needs Enterprise DRM.
- A code works for whoever holds it.
- Refunds don't revoke access. The `revoked` column is there for when you add a `charge.refunded` handler.
- Tax. Stripe Tax can calculate and collect it inside Checkout.
- A catalogue. That needs a video ID on each purchase and in the cookie's signature.
