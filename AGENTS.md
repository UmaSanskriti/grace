# AGENTS.md — instructions for AI agents working in this repo

Read `README.md` first; it is the source of truth for the frontend contract and API shapes.

Hard rules (product safety — do not "improve" these away):
- Never add code paths that book, sign, or authorize services, or that collect/process payments. Payment is family → funeral home, directly.
- Never trigger a call or text without the user's explicit consent action in the contact sheet.
- Honor STOP: it must end contact and erase the case.
- Negotiation asks must be user-approved; never fabricate quotes or fill unknowns — flag them.

Engineering conventions:
- `index.html` is intentionally a single self-contained file: no external requests, no CDNs, fonts embedded. Keep it that way unless the human owner says otherwise.
- No `<a>` elements anywhere (host sandboxes intercept them). Use `<button data-route=...>` for navigation and `<button data-mode="call|text">` for contact CTAs.
- Every CSS class is prefixed `g-`. Keep the namespace.
- All Call/Text CTAs must remain identical instances of the master `.g-btn` pair with `<use href="#i-call|#i-text">` icons — the QA harness enforces this.
- Backend wiring goes only at the two `── Integration point` comments (contact request; live CaseState render).

Before committing: `npm install && node qa.js` (also run `--no-hashchange` and `--hash='#arrangements-live'`). All 18 checks must pass.
