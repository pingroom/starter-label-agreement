# PingRoom label agreement

Check whether two people apply the same rubric consistently. Supply a fixed set of examples and two or three category definitions. Each named assessor receives a separate PingRoom Question for each item. The local report shows paired labels, agreement counts, a confusion matrix, skipped items, and disagreements to discuss.

Neither assessor's label is treated as the correct answer. This starter does not train a model, approve work, or update business records.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux with private persistent storage. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm run demo
npm test
```

The demo uses the pinned SDK with a local mock transport: two scored pairs produce one agreement and one disagreement; a third item is skipped. It needs no credentials or network after installation and removes its temporary files. Package installation needs npm access.

## Connect and prepare a study

1. Install [PingRoom](https://pingroom.io/i). Use a **standard private room** containing the two assessors and the connecting account.
2. Run `npm run connect`, open the printed link, approve question and room-read access, and grant the shared room. Select that room as the connection's home room.
3. Run `npm run inspect` to list room member UUIDs and lookup names. Verify the intended people in the app and set their exact UUIDs and distinct display labels in your configuration. Names are not identity proof.
4. Copy and edit the examples:

```sh
cp config.example.json config.json
cp examples/study.json study.json
```

The study contains 1–12 items, a rubric, and 2–3 category definitions. `Skip` is added automatically. IDs start with a lowercase letter and use at most 40 lowercase letters, digits, underscores, or hyphens. Titles allow 40 printable ASCII characters, rubrics 60, item text 120, category names 20, and definitions 40. Assessor labels allow 60. Strings cannot have leading/trailing spaces. Category IDs, category names, and item IDs must each be unique; `skip` and `Skip` are reserved.

Pairing stores ignored `.pingroom/credentials.json` with private permissions. It preserves a pending link across interruptions and refuses to overwrite a saved connection. To use an existing connection, supply **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM` in the shell or `.env`. Defining either shell value selects the entire shell pair; a partial or blank pair fails rather than borrowing another credential source. With neither shell value present, `.env` is loaded. With neither value configured anywhere, saved pairing credentials are used.

## Collect and report

```sh
npm start
npm run status
npm run report
```

Each `start` creates at most one Question or reads the current Question once, then exits. Answer it in PingRoom and run `start` again to collect the answer. A later invocation advances to the next assessor/item. The fixed order is sorted item IDs, then the two assessors in configuration order. Maximum: 24 Questions. Each Question lasts 15 minutes; no background runner or scheduler is installed.

Questions contain the same rubric, item, and category definitions for both assessors. The starter never inserts one person's answer into the other's prompt. **This is not a blinded study:** the shared room, PingRoom visibility rules, or communication outside the app may reveal answers. Ask assessors to work separately if your study needs independent judgments. There is no anonymous response mode.

`status` reads saved observations without a credential or network. `report` also writes `.agreement/report.json`. Reports include:

- `pairedItemCount`: items with a valid non-Skip category from both assessors.
- `agreementCount`: paired items with equal labels. `agreementFraction` divides that count by `pairedItemCount`; with no paired items, the fraction is `null`.
- `confusion`: rows belong to the first configured assessor, columns to the second; `labelIds` fixes both category axes.
- `disputedItems`: paired items whose two labels differ, with their Question IDs.
- `skippedItems`: items with at least one explicit Skip. `incompleteItems` contains items missing a valid answer. These lists can overlap.
- `assessments`: every expected response, including unasked, pending, expired, cancelled, invalid, and uncertain creation states.

Skip, expiry, cancellation, and invalid answers never become a category or an agreement. `finished` means every Question was attempted and reached a locally recorded terminal outcome; check the denominator before interpreting the score. Agreement is not accuracy, a chance-adjusted statistic, or proof of a reliable rubric. Small, chosen samples may not represent later work. Discuss disagreements before revising definitions; revisions require a new study.

## Resume and recover

The saved study binds its full input hash, assessor identities/order, room, and credential fingerprint. Changed inputs are refused. One Question stays active at a time; terminal assessments are not reissued. Completed evidence replays locally without new requests.

Before a POST, the starter saves the exact request and idempotency key. A lost response leaves `create_unknown` and blocks further Questions. It does not automatically retry. Inspect the bounded recent list and attach only the exact matching Question:

```sh
npm run find-id
npm run recover -- QUESTION_UUID
```

Recovery checks the original prompt, options, item, target, room, asking registration, and timestamps. The recent list may omit old Questions; no match does not prove the POST failed. Preserve uncertain state while investigating. A failed state write after creation needs the same recovery. Deleting state or using another checkout can create duplicates; server idempotency is not a permanent exactly-once guarantee.

After all active/uncertain Questions are resolved, archive the whole private `.agreement/` directory before starting a revised study with a new study ID. Preserve old evidence. Original credentials are needed for question reads; do not reconnect to work around inaccessible Questions.

State and reports use atomic file replacement, file/directory sync, and a local `.agreement/.lock` directory. After a crash, inspect its `owner.json` and confirm the process stopped before removing only the stale lock. Pairing uses the same lock convention under `.pingroom/`. Corrupt state requires a valid backup. Directories use `0700` and files `0600`; keep backups private. Credentials, study/configuration files, and results are ignored by Git.

Input files are capped at 16 KiB, state/report files at 1 MiB, HTTP bodies at 512 KiB. Requests have a five-second deadline including body consumption and reject redirects. A new assessment makes at most three requests; a read or recovery makes one. There are no automatic network retries. Historical observations are a local record, not a tamper-proof audit trail or a guarantee that server access will remain available.

Exit codes: `0` for local commands or a finished fully paired study; `2` for an observed failed assessment or a finished incomplete study; `3` for ready/pending/interrupted work; `4` for uncertain creation; `1` for configuration, storage, or API failure. A scheduler should serialize runs and handle these outcomes explicitly.

## Adapt it

Import `step` from `src/engine.js` to drive collection from a workflow runner. `src/model.js` owns schema validation, question construction, and agreement calculations. No AI provider is required. Keep calculation and execution rules in code. To add more assessors or richer text, update the bounds, question schema, reporting denominators, and tests together.

[Data completion](https://github.com/pingroom/starter-data-completion) asks for missing business information. This starter compares two judgments to evaluate a rubric, without assigning ground truth or filling a record.

The [official SDK](https://github.com/pingroom/sdk) is pinned to `0.6.0` with a lockfile and `.npmrc` minimum release age of 14 days. CI runs tests and the offline demo on Node 22 and 24. Live phone delivery and assessor responses were not tested.

MIT licensed; see [LICENSE](LICENSE).
