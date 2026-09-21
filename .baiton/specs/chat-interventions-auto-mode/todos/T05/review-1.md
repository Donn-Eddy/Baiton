# Review T05

Verdict: **findings**

## Findings

- **must** `media/chat.js`:465 — In question cards with options and free text (allowFreeText === true), refresh() computes submit.disabled as 'locked || input.value.trim().length === 0', ignoring whether an option radio is checked. As a result, selecting an option radio while the text input is empty leaves the Submit button disabled, preventing the user from clicking Submit to submit their chosen option. According to step 4B and acceptance criteria ('submit is disabled when neither is present'), the Submit button should be enabled when either a radio is selected or non-whitespace text is entered.
- **should** `media/chat.js`:393 — In question cards with options and no free text (step 4A), option buttons are created without the 'intervention-option' class specified in the plan.

## Tests

- ran: true
- passed: true

```
912 passing (36s)
  1 pending
```
