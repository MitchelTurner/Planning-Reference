# Ketchikan Planning Fact Book

A reference site for the Ketchikan Gateway Borough Planning Commission, plus an **Ask** panel that answers questions from the adopted 2035 Comprehensive Plan, its appendices, the Fact Book, and anything else you put in `docs/`. Every answer shows the passages it relied on, with page numbers where the source has them.

```
server.js        Express server: serves the site, streams answers from the Claude API
public/          The reference site (index.html) with the Ask panel
docs/            Source documents Claude answers from (.txt, .md, .pdf)
railway.json     Railway start command and health check
.env.example     Settings to copy into Railway (or a local .env)
```

## Run it on your computer

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... APP_PASSCODE=pick-one npm start
# open http://localhost:3000
```

## Deploy to Railway

1. Put this folder in a **private** GitHub repo (`git init`, commit, push).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo. Railway detects Node and runs `npm start`.
3. Open the service's **Variables** tab and add:
   - `ANTHROPIC_API_KEY`: from console.anthropic.com → API Keys
   - `APP_PASSCODE`: anything you like. The reference pages stay public; only Ask needs the passcode.
   - Optional: `CLAUDE_MODEL`, `CACHE_TTL`, `MAX_TOKENS`, `RATE_LIMIT_PER_MIN` (see `.env.example`)
4. **Settings → Networking → Generate Domain** to get a URL.
5. Open the site, click **Ask**, enter the passcode once (the browser remembers it).

Each push to the repo redeploys automatically.

## Add supporting documents

Drop files into `docs/` and push. Supported: `.txt`, `.md`, `.pdf` (text-based PDFs; scanned images won't extract). The file name becomes the citation title, minus any leading number, so `05-KGBC Title 18 Planning and Zoning.pdf` shows as "KGBC Title 18 Planning and Zoning".

Worth adding:
- **KGB Code Titles 17 and 18**, from ketchikangateway.borough.codes. The Fact Book only has excerpts, so code questions will be much better with the full titles.
- Staff reports and the agenda packet for upcoming meetings
- The 2024–2028 Borough Strategic Plan, the Tourism Strategy, the Housing Market Study
- Adopted area plans (Creek Street, Hopkins Alley/Newtown)

Everything in `docs/` goes to Claude on every question. The current set is about 110,000 tokens. Claude Sonnet 5.5 can take about 1 million, but cost and speed grow with size, so remove old agenda packets when you're done with them. The server log prints the total at startup.

## Using it in a meeting

- About 15 minutes before the meeting, open Ask and click **Preload**. That loads the documents into Claude's cache, so answers start in a couple of seconds.
- With `CACHE_TTL=1h` (the default), the cache lasts an hour after the last question, so it stays warm through a meeting.
- **New** starts a fresh conversation. Follow-up questions inside one conversation keep context.
- Click a `[1]` marker or a source to see the exact passage.

## Cost (Claude Sonnet 5.5, about 110k tokens of documents)

| Action | Approximate cost |
| --- | --- |
| Preload (writes the 1-hour cache) | $0.44 |
| Each question while cached | $0.03 |
| Each question with no cache | $0.25 |

A two-hour meeting with 30 questions comes to roughly $1.50. Set a monthly spend limit in the Anthropic Console. `claude-opus-5-5` gives stronger answers at a higher cost, about $0.90 for a preload and still about $0.03 per cached question. `claude-haiku-4-5-20251001` is cheapest but has a 200k-token limit.

## Things to know

- **Not legal advice.** In quasi-judicial items (CUPs, variances, plats, single-parcel rezones), decisions must rest on the code criteria and the hearing record. Use Ask to find the right page, then cite the page, not the AI.
- **Public records.** Questions you type as a commissioner may be treated as public records. Ask the Borough Clerk how they should be kept.
- **Privacy.** Questions and documents are sent to Anthropic's API. Don't put confidential material in `docs/`.
- **Passcode.** Without `APP_PASSCODE`, anyone with the link could run up your API bill. The server also limits each visitor to `RATE_LIMIT_PER_MIN` questions a minute.

## Editing the site

All content lives in `public/index.html`. Sections are defined in the `sec(...)` calls in the main script, and the Q&A list is the `QA` array. After you change the Fact Book, also update `docs/04-Planning Fact Book.txt` so Ask stays in sync.
