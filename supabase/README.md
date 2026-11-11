# Supabase setup

This project is being migrated from Firebase Realtime Database to Supabase PostgreSQL.

## 1. Create a Supabase project
1. Create a project in the Supabase dashboard.
2. Open **SQL Editor** and run all of `supabase/schema.sql`.
3. Open **Project Settings → API** and copy:
   - Project URL
   - Publishable key (or legacy anon public key)

Never put a service-role/secret key in browser code.

## 2. Realtime
The schema attempts to add `rooms` and `room_data` to the `supabase_realtime` publication.
If the dashboard shows either table is not enabled, open **Database → Publications** (or the Realtime settings page) and enable Postgres Changes for both tables.

## 3. Current access model
The app deliberately preserves the existing room-code-only workflow: no account creation and no login. The SQL therefore grants anonymous browser access to room records. This is convenient, but it is not private: anyone who obtains the project URL and public key can query or modify data. Do not store sensitive personal information in this project under this access model.

## 4. Migration status
- Original Firebase-based page is backed up at `backups/index.html.firebase-original.html`.
- `supabase/schema.sql` defines room metadata and JSONB data sections.
- The frontend now loads the Supabase JS client and a compatibility adapter from `supabase/legacy-adapter.js`.
- `index.html` is switched to the Supabase project configuration in `supabase/config.js`.
- Re-run the updated `supabase/schema.sql` in SQL Editor before testing (it now includes focus/cursor presence sections).
- Existing Firebase room data has NOT been imported. Do not delete the Firebase project/data until migration and live collaboration are verified.
