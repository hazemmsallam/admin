# CSAT Survey Runner

A JavaScript rewrite of `csat.py`: upload a spreadsheet of MSISDNs, press one
button, and every survey answer is submitted for every number while the
responses stream back into the page.

Comes in two forms — a web page and a CLI — both driven by the same core
module, and with no dependencies to install.

```
tools/csat-msisdn/
├── server.js              serves the page and relays submissions past CORS
├── src/
│   ├── csat.js            the port of csat.py: parameters, submission loop
│   ├── xlsx-lite.js       reads .xlsx / .csv without a third-party library
│   └── cli.js             command-line runner
├── public/                the upload page (index.html, app.js, styles.css)
└── test/                  node --test suite and workbook fixtures
```

## Running the page

```bash
cd tools/csat-msisdn
npm start                  # or: node server.js --port 8787
```

Then open <http://127.0.0.1:8787>.

1. **MSISDN list** — drop an `.xlsx`, `.xlsm`, `.csv`, `.tsv` or `.txt` file, or
   paste numbers directly. The sheet is parsed in the browser; nothing is
   uploaded anywhere. The column with the most phone-like values is picked
   automatically, a header row such as `MSISDN` is skipped, separators are
   stripped (`962-79 123 4567` → `962791234567`), duplicates are removed and
   anything that is not a number is listed rather than silently dropped.
2. **Request settings** — endpoint, survey and channel IDs, HTTP method,
   timeout, an optional delay between calls, how many MSISDNs to run in
   parallel, and the `(question_id, answer_id)` table. `answer` follows
   `answer_id` until you type over it, matching the
   `# Change to 1 if required` note in the original script.
3. **Run** — the progress bar, counters and response table fill in live. Every
   response body is shown in the table and in a log formatted exactly like the
   Python output, and both can be exported to CSV or JSON.

The server must be running for the page to work: it hosts the ES modules and
provides the relay described below. Opening `index.html` straight off disk will
not work.

### Why the requests go through the server

The CSAT service is plain HTTP on an internal host and returns no CORS headers,
so a browser refuses to read its responses. `POST /api/submit` on the local
server performs the call from Node instead, where that restriction does not
apply, and hands the status and body back to the page.

Because that endpoint makes outbound requests on the page's behalf, it only
relays to known hosts — the CSAT host plus `localhost` — and listens on
`127.0.0.1` unless told otherwise:

| Variable | Effect |
| --- | --- |
| `PORT`, `HOST` | listen address (default `8787`, `127.0.0.1`) |
| `CSAT_ALLOWED_HOSTS` | extra relay targets, comma separated |
| `CSAT_ALLOW_ANY_HOST=1` | relay anywhere |

Switching **Send through** to *Browser directly* skips the relay; useful only if
the endpoint ever starts sending CORS headers.

## Running from the command line

The closest equivalent to the original script:

```bash
node src/cli.js --input msisdns.xlsx
```

```
Processing 962791234567
Q:335 A:3019 Status=200 Response={"status":"SUCCESS"}
Q:336 A:-1 Status=200 Response={"status":"SUCCESS"}
...
15 request(s) for 3 MSISDN(s): 15 ok, 0 failed, 0.4s
```

```bash
# specific sheet and column, GET like the Python version, saved results
node src/cli.js --input list.xlsx --sheet Subscribers --column MSISDN \
                --method GET --out results.csv

# numbers inline, and a look at the requests before sending any
node src/cli.js 962791234567 962791234568 --dry-run

# different survey and answers
node src/cli.js --input list.csv --survey 92 --channel 7 \
                --questions "335:3019,336:-1,337:3029"
```

`node src/cli.js --help` lists every option. The exit code is non-zero if any
request failed, so it drops straight into a shell pipeline.

## What changed from `csat.py`

| | `csat.py` | here |
| --- | --- | --- |
| MSISDNs | hard-coded empty list | Excel/CSV upload, paste, or CLI arguments |
| Method | `GET` | `POST` by default; `GET` and a JSON body are options |
| Responses | printed to stdout | live table, log, CSV/JSON export, stdout in the CLI |
| Failures | printed, loop continues | recorded per request, loop continues, counted in the summary |
| Pacing | none | optional delay, optional parallelism, stop button |

Request parameters are unchanged: `question_id`, `answer_id`, `answer`,
`survey_id`, `channel_id` and `msisdn`, with `accept: application/json`.

`POST` sends those parameters in the query string, exactly where the GET version
put them, since that is what the endpoint already accepts. Choose
*POST — JSON body* if the service expects a body instead.

## Tests

```bash
npm test
```

Builds workbooks byte by byte in the ZIP layout Excel produces and reads them
back, then covers MSISDN cleanup, request building, the submission loop, error
and cancellation handling, CSV export, and the relay server end to end.

## Notes on the spreadsheet reader

`src/xlsx-lite.js` walks the ZIP central directory and hands the compressed
parts to the platform's raw-DEFLATE decoder — `DecompressionStream` in the
browser, `zlib` in Node — so `.xlsx` support costs no third-party code. Numeric
cells keep the literal text stored in the file, so a long MSISDN is never
rounded or rendered as `9.62791e+11`.

It reads values only. Formulas come back as their last cached result, and
formatting, dates and charts are ignored — none of which matters for a column
of phone numbers. Very old `.xls` files are not supported; save them as `.xlsx`
or `.csv` first.
