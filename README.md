# Charades Online

Mobile-first charades webapp for four or more remote players, two players per side.

## Game setup

Before a match starts, everyone votes for:

- one category pack
- one difficulty: Normal, Hard, or Extreme

The majority category and majority difficulty become the match deck. The app generates 2,000 cards for every category/difficulty pair:

- Everyday Life
- Food & Culture
- Science & Nature
- Places & Geography
- History
- Games & Tech
- Fiction & Entertainment
- Abstract Concepts

That is 48,000 generated cards total before custom clues.

## Turns and clues

Teams alternate turns. The active actor sees the answer and has the timer window to help their teammate guess through app clues:

- sketch clues drawn with a finger or mouse
- recorded audio clues
- image clues selected from the integrated search interface

Clues are sent to the guesser immediately. The opposing team can see the answer and the sent clues; if every opposing player flags a clue as unfair, the active team forfeits the turn for zero points. A correct guess before time expires scores 1 point.

## Local setup

```bash
npm.cmd install
npm.cmd run dev
```

Open `http://127.0.0.1:5173`.

## Supabase setup

1. Create a Supabase project.
2. Copy the project URL and anon/publishable key.
3. Create `.env` from `.env.example`.
4. Create a public Storage bucket named `charades-clues` for recorded audio clues.
5. Fill in:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

The app uses Supabase Realtime Broadcast for room events, Presence for connected players, and Storage for audio clues. No database tables are required for this version.

## Google image search

Create a Google Programmable Search Engine with image search enabled, then add these server-only variables:

```bash
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_ENGINE_ID=...
```

The browser calls `/api/image-search`; the Google key stays hidden on the server.

Google's current docs say the Custom Search JSON API is closed to new customers and existing customers need to transition by January 1, 2027. If your Google account cannot use it, keep the same `/api/image-search` frontend contract and swap the server implementation to another image-search provider.

## Deploy

Deploy this as a Render Web Service so the same app can serve the frontend and the private image-search API.

Build command:

```bash
npm.cmd run build
```

Start command:

```bash
npm.cmd run start
```

Add all variables from `.env.example` in Render's environment settings.
