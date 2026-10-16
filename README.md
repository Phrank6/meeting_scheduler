# Open Hours

A scheduling page where people publish weekly open hours and others book one-on-one time. The page is static (GitHub Pages); sign-in, data and email run on Supabase's free tier.

- Sign in with an email link, no passwords.
- Each person sets weekly windows, meeting length (30/45/60 min), a cap on bookings per week and a cap on hours per week.
- Everyone sees open times in their own time zone. The database enforces the limits and prevents double booking.
- Booking and cancellation emails go to the host and the guest through your Gmail account.

## Setup (about 20 minutes)

### 1. Create the Supabase project
1. Sign up at supabase.com and create a new project (free plan is fine).
2. Open **SQL Editor**, paste all of `supabase/schema.sql`, and run it.

### 2. Point the site at it
1. In Supabase, go to **Project Settings > API**. Copy the **Project URL** and the **anon public** key.
2. Paste both into `config.js`. The anon key is designed to be public. The rules in `schema.sql` protect the data.

### 3. Allow sign-in from your site
In **Authentication > URL Configuration**, set **Site URL** to your GitHub Pages address (for example `https://YOUR-NAME.github.io/REPO/`) and add the same address under **Redirect URLs**.

Supabase's built-in sign-in emails are limited to a few per hour. Before sharing the link widely, go to **Authentication > Emails > SMTP Settings** and enter the same Gmail address and app password you use in step 4.

### 4. Turn on booking emails
1. In your Google account, turn on 2-step verification, then create an **App password** (Google Account > Security > App passwords).
2. In Supabase, open **Edge Functions**, create a function named `notify`, and paste in `supabase/functions/notify/index.ts`. (Or use the Supabase CLI: `supabase functions deploy notify`.)
3. Under **Edge Functions > Secrets**, add:
   - `GMAIL_USER`: your Gmail address
   - `GMAIL_APP_PASSWORD`: the app password
   - `APP_URL`: your GitHub Pages address

Gmail allows roughly 500 outgoing emails a day, which is plenty for a club or team.

### 5. Publish
In the GitHub repo, go to **Settings > Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`. The site appears at the address from step 3 after a minute or two.

## Good to know
- Emails are sent by the page right after a booking. If someone closes the tab in that second, that one email is skipped (the booking still stands and shows in My schedule).
- Only the host and guest can see a booking's details. Everyone else only sees that a time is taken.
- People who want a notification address different from their sign-in email can set one under My hours.
