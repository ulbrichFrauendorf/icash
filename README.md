# iCash

iCash is an offline desktop application for South African household budgets. Import CSV statements, review how transactions are classified, and compare actual spending with your monthly plan. Financial data is stored locally in encrypted household databases.

## Development

The release target is Windows x64. Use Node 24.22.1 (see `.nvmrc`) and npm 11.9.0. Dependency installation, the initial Electron binary download, and packaging require network access. The built application works offline.

```sh
npm ci
npx install-electron
npm run dev
```

`npm run dev` uses `local-data/dev` inside the checkout. On Linux a system keyring is required to open development profiles. The Electron smoke test uses a disposable synthetic profile and can run under `xvfb-run`. On Windows from PowerShell, use `npm run test:e2e` directly.

| Command | Purpose |
| --- | --- |
| `npm run lint` | Lint source, including process import boundaries |
| `npm run typecheck` | Strict TypeScript and Angular templates |
| `npm test` | Finance rules and encrypted SQLite integration |
| `npm run test:e2e` | Electron user workflow, restart, and encrypted backup recovery |
| `npm run make` | Forge distributables in `out/make` for the current platform |

On Windows, run `npm run make` and install the generated Squirrel setup executable under a standard Windows account. The default build is unsigned. Install an upgrade over the previous version and open the same household to verify that its ledger still reconciles.

## Household workflow

1. Create a household. The suggested categories and rules are editable. Each household has its own database.
2. Set up an account for each bank account or credit card. In **Import statements**, choose a CSV, review the detected columns and formats, and validate the preview. Absa posting dates such as `YYYYMMDD` are recognized automatically. The included synthetic fixtures exercise signed amounts and separate debit and credit columns. Absa layouts can vary. Exports are limited to 12 MiB, 60,000 records, 128 columns, and 16,384 characters per record.
3. iCash skips re-imported rows, repeated transactions in a statement, and matches that lack a running balance to distinguish them. Same-day purchases with the same description and amount remain separate when both running balances are present and differ. Review rejected rows or export them for correction. In **Accounts**, confirm coverage for a period only once all its posted activity is present.
4. In **Transactions**, correct categories, mark refunds as expenses in the original category, and pair opposite movements across your own accounts. Import both sides of credit-card settlements to classify the movements as a transfer. Card purchases remain expenses. A linked savings contribution counts once toward its goal.
5. In **Budgets**, select the month and enter allocations. Recommendations use complete prior months and show the underlying periods. Closing a month records a budget revision. Late changes appear as a difference until the month is reopened and closed again. In **Reports**, view and export monthly or annual summaries.
6. In **Settings**, save an encrypted backup before upgrading or moving to another device. Keep the passphrase separately. Restore creates a new household using the destination OS account's key protection. The passphrase is required even on the original device.

On Windows, open `%APPDATA%\iCash` to locate application data. Profiles under `profiles/` contain the encrypted ledger and an OS-protected key. A copied ledger requires its original key. Use portable backup export for migration or recovery. People sharing an unlocked OS account have access to its iCash profiles. CSV and JSON exports are ordinary files and should be stored accordingly. Close iCash before making a manual file copy. Keep a backup before uninstalling.

## Project layout

`src/features/` contains vertical slices with contracts, Electron handlers, domain logic, and standalone Angular components as needed. `src/app/` wires Electron, preload, and Angular together. `src/platform/main/` owns encrypted SQLite and migrations, and `src/shared/` owns the common finance and IPC contracts. New import sources can feed the same normalized transaction shape used by the CSV slice.

Use synthetic statements only in `tests/fixtures/`. Store any real statements, backups, exports, and signing files outside the checkout or in the ignored local folders. Append database migrations so existing installations can upgrade.

## Interface and dependencies

The renderer uses `invensys-ng` for its layout, form controls, tabs, cards, tables, charts, and dialogs. Feature templates live in adjacent `*.component.html` files. The global stylesheet loads the library theme and sets iCash's light and dark tokens. The Invensys brand artwork comes from `invensys.integraflow`, and PrimeIcons are bundled with the installer. Library usage guidance is available from the [Invensys NG MCP endpoint](https://ng.invensys.web.za/mcp).

`npm audit --omit=dev` checks the dependencies shipped to users. The full audit still reports [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) through the build toolchain because npm's registry has no fixed picomatch release. `postinstall` applies a version-checked mitigation to the pinned build dependency. It treats single-branch repeated wildcard patterns as literals. Remove the override and mitigation after upgrading to an upstream release that fixes the advisory.
