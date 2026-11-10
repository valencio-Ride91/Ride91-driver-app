# Ride91 — Design

Last updated: 2026-11-10. How the apps look, read and behave.

## Principles

1. **Built for drivers on a phone in a car.** Big touch targets, few words, numbers first. Most drivers read Hindi or English, some Kannada.
2. **Plain words, no jargon.** "Cash you hold", not "outstanding liability". Error messages say what happened and what to do (`t.why[code]` in the Hub app).
3. **Never lose a tap.** The app shows the action as done straight away and sends it when it can; a small header pill shows anything still waiting.
4. **Show the working.** Money rows expand to show how a figure was reached (share, cash, advance, payable).
5. **Say how old a reading is.** Battery, location and tracking show "x min ago" and look stale when they are old.
6. **Ask before anything that cannot be undone** (remove a driver, delete for good, mark repaired, pay a withdrawal).

## Colours (`frontend/src/theme.ts`)

Taken from the Ride91 logo: its green and its charcoal.

| Token | Value | Use |
|---|---|---|
| `ink` | `#434343` | Text, dark surfaces |
| `paper` | `#F2F4F0` | Screen background |
| `card` | `#FFFFFF` | Cards |
| `line` | `#DADDD6` | Borders, dividers |
| `muted` | `#6E746B` | Secondary text |
| `brand` | `#69BC46` | Green **fills** (buttons, active pills) — with `onBrand` text |
| `onBrand` | `#1E2A18` | Text on a green fill (white on the logo green is too faint) |
| `brandTint` | `#E4F3DC` | Wash behind green text |
| `live` | `#3A7A1F` | Green **text** on white: paid, amounts, on track |
| `amber` | `#E8A317` | Warning |
| `alert` | `#BF3F2C` | Error, late, over the limit |

Platform colours: Ride91 green, Uber near-black `#26282B`, Rapido amber, Ola blue `#3B6FD4`, offline grey, charging blues. Labels and colours are in `platformColors` / `platformLabels`.

Hub app status tones (`src/hub/ui.tsx`): `ok`, `warn`, `bad`, `mute`, used by `Tag`, `Tile` and `STATUS_TONE`.

## Type and spacing

| Role | Font |
|---|---|
| Headings, big numbers | Bricolage Grotesque (Bold, SemiBold) |
| Body and buttons | IBM Plex Sans (Regular, Medium, Bold) |
| Figures, times, plates | IBM Plex Mono |

Radius: 8 / 12 / 16 / 20. Spacing scale: 4, 8, 12, 16, 24, 32.

## Shared components

Driver app (`frontend/src/components`): `AppHeader` (sync and tracking pills, language), `DutyStripe` (the day as a bar coloured by platform), `DriverMap`, `SalaryCard`, `DepositSheet` / `DepositByLink` / `CollectionQrCard`, `AttendanceCard`, `LoyaltyMilestonesCard`, `ShiftAlarmCard`, `DocumentsCard`, `ConsentsCard`, `BankAccountCard`, `ChangePasswordCard`, `LocationDisclosure`, `ErrorBoundary`.

Hub app (`frontend/src/hub`):
- `ui.tsx`: `HubHeader`, `SectionTitle`, `Tile`, `Tag`, `Btn`, `Empty`, `callPhone`.
- `kit.tsx`: `Icon` (Ionicons), `Avatar`, `Segmented`, `Chips`, `IconBtn`, `ProgressBar`, toasts.
- `sheets.tsx`: `AddCarSheet`, `ServiceSheet`, `BroadcastSheet`, `NotComingSheet`.
- `CashSheet`, `HubMap`.

Admin panel: plain React pages with shared `Layout` (side menu, owner storage warning) and cards such as `StorageCard`.

## Screen patterns

- **Tabs at the bottom**, with a count badge where something needs attention (Hub: Today attention, Money withdrawals, Inbox unread + requests).
- **Attention first.** Hub Today lists not coming, not started, no answer, late, then the rest.
- **Sheets** (slide-up panels) for short tasks: switch platform, close out, deposit cash, add a car, broadcast.
- **Search** appears when a list is long (cars: more than 5). Phone numbers and plates are matched without spaces or the country code.
- **Empty and failed states** always say something (an empty-list message, or a failed-load message with pull to refresh), never a blank screen.
- **Tests:** interactive elements carry `testID` / `data-testid` (for example `hub-tab-today`, `history-lifetime`, `rewards-leaders-card`).

## Words and languages

- Driver app strings: `frontend/src/i18n/index.ts` (English, Hindi, Kannada) and `frontend/src/i18n/cards.ts` (English, Hindi; Kannada falls back to English).
- Hub app strings: `frontend/src/hub/text.ts` (English, Hindi).
- Money is shown as ₹ with Indian grouping (₹1,00,000). Times are IST. Dates in Hindi use Hindi month names.
- Add every new string in English and Hindi together.
