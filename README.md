# Shaley Gardens

A small site for garden questions in Ocala, Marion County, and The Villages. Chat, voice, and the newsletter signup run as Vercel functions. Newsletter drafts in `newsletter/` are not published on the website.

## Send the newsletter with Resend

Mail goes out only when you run a send. Signups are still saved if mail is not set up. If `RESEND_API_KEY` or `NEWSLETTER_FROM` is missing, no message is sent and the tool says so. If `ADMIN_SEND_TOKEN` is missing, the send tool refuses to run.

Resend's free plan is limited. This project stops at 100 emails in a day, shared by welcome notes and the newsletter, and it waits about half a second between messages. Check Resend's current plan before a large list, because the monthly allowance can be lower than a busy month of notes.

### 1. Create the Resend account

1. Sign up at [https://resend.com](https://resend.com).
2. Create an API key with permission to send. You will put that key in Vercel. Do not commit it, and do not paste it into the website code.

### 2. Verify a sending subdomain at Porkbun

Porkbun email forwarding for `hello@shaleygardens.com` uses MX records on the root domain `shaleygardens.com`. Leave those MX records as they are. Do not delete them, and do not turn on Resend receiving for the root domain. Receiving through Resend would replace forwarding.

Resend recommends sending from a subdomain so newsletter reputation stays separate from the root domain. In Resend, open Domains and add:

`newsletter.shaleygardens.com`

Choose the region closest to readers. US East is a reasonable default. Leave receiving turned off.

Open that domain's Records tab. Resend generates the records for your account. Copy each name, type, and value exactly. Do not reuse sample keys from a guide.

What the tab usually shows:

- Domains added before Resend's August 2026 change: a DKIM TXT record on `resend._domainkey.newsletter`, an MX record on `send.newsletter` for bounces (priority 10, host from the dashboard), and an SPF TXT record on `send.newsletter`.
- Domains added after that change: CNAME records instead of the MX and TXT pair, often on `send.newsletter` and `rsend.newsletter`. A CNAME cannot share a name with any other record.

Those names sit under `newsletter.shaleygardens.com`. They are not the root MX records.

In Porkbun:

1. Open the domain `shaleygardens.com`, then DNS.
2. Find the existing MX records on `@` (the root). Confirm they are still the Porkbun forwarding records. Do not edit them.
3. Add only the records from Resend's Records tab. In Porkbun's host field, enter the part before `.shaleygardens.com`. For a record Resend names `send.newsletter.shaleygardens.com`, the host is `send.newsletter`.
4. Wait until Resend shows the domain as verified. DNS often updates within 15 minutes and can take up to 72 hours. Use Restart verification in Resend if it sits there. [https://dns.email](https://dns.email) can show whether the records are public.
5. After verification, add the DMARC TXT record Resend suggests if you want it. A policy of `p=none` monitors mail and does not reject it.

The From address has to be on the verified subdomain. Use:

`Shaley Gardens <newsletter@newsletter.shaleygardens.com>`

`newsletter@shaleygardens.com` works only if Resend verifies the root domain. Root verification still should not replace the root MX (Resend's bounce MX, when it asks for one, is on `send.shaleygardens.com`). The subdomain is the setup to use.

### 3. Set the environment variables in Vercel

In the Vercel project, open Settings, then Environment Variables. Add these for Production:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | The API key from Resend |
| `NEWSLETTER_FROM` | `Shaley Gardens <newsletter@newsletter.shaleygardens.com>` |
| `ADMIN_SEND_TOKEN` | A long random string, at least 16 characters |

Create the admin token on your computer:

```bash
openssl rand -base64 32
```

Subscriber storage is already the Redis store from signup (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` pair). Leave those in place.

Redeploy after saving the variables so the functions can see them.

Each new signup gets a random unsubscribe token in Redis. People who signed up earlier get a token the first time a note is sent. Every message includes a visible unsubscribe link, a `List-Unsubscribe` header, and a `List-Unsubscribe-Post` header for one-click unsubscribe. The link opens `https://shaleygardens.com/api/unsubscribe?token=...`, removes that signup, and shows a short confirmation. The footer and that page both point to `hello@shaleygardens.com`.

### 4. Send a test, then the list

Drafts stay in `newsletter/` and are not deployed, so run the script from a copy of this repo. It reads the file on your computer.

Test send, one address only:

```bash
ADMIN_SEND_TOKEN='paste-the-token' node scripts/send-newsletter.js \
  --url https://shaleygardens.com \
  --file newsletter/2026-11-november.md \
  --test you@example.com
```

Nothing else on the list is mailed. The test message still has a working unsubscribe link.

Full send to everyone still subscribed:

```bash
ADMIN_SEND_TOKEN='paste-the-token' node scripts/send-newsletter.js \
  --url https://shaleygardens.com \
  --file newsletter/2026-11-november.md \
  --confirm
```

Without `--confirm`, the script stops and sends nothing. Running the same file again skips addresses that already got that file. Add `--again` only when you mean to send that file a second time.

The script asks the website to send in small batches so a long list is not cut off. At 100 messages in a day it stops. Run the same command the next day to continue. The command prints counts only. It does not print subscriber addresses.

To send from your computer without the website hop, export `RESEND_API_KEY`, `NEWSLETTER_FROM`, `ADMIN_SEND_TOKEN`, and the Redis URL and token, then run the same command without `--url`.
