"""Guards on serving the consumer landing page.

The family-facing page was ported from the other track (main @ 8b1fddc) as a
single self-contained file. Two things can silently break it:

  1. Someone swaps the explicit "/" route for a StaticFiles mount at "/", which
     sits in front of every unmatched path and turns API 404s into HTML.
  2. Someone edits the page and introduces an external font/script/image. The
     original deliberately inlines everything (base64 fonts), so it renders on
     a venue's flaky wifi. A CDN reference would break the demo silently.

Run: uv run python tests/test_landing.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def test_landing_is_served_at_root() -> None:
    r = client.get("/")
    check(r.status_code == 200, f"GET / returned {r.status_code}, want 200")
    check(
        r.headers.get("content-type", "").startswith("text/html"),
        f"GET / content-type is {r.headers.get('content-type')!r}, want text/html",
    )
    check("<title>Grace" in r.text, "GET / body is not the Grace landing page")


def test_landing_is_self_contained() -> None:
    body = client.get("/").text
    for ref in ('src="http', 'href="http', 'src="//', 'href="//'):
        check(ref not in body, f"landing page pulls an external resource ({ref})")


def test_landing_does_not_shadow_the_api() -> None:
    r = client.get("/health")
    check(r.status_code == 200 and r.json()["ok"] is True, "/health stopped working")

    # An unknown case must still 404 as JSON, not fall through to the page.
    r = client.get("/cases/does-not-exist")
    check(r.status_code == 404, f"/cases/<unknown> returned {r.status_code}, want 404")
    check(
        "<html" not in r.text.lower(),
        "/cases/<unknown> served HTML — is StaticFiles mounted at '/'?",
    )


def test_cta_dials_the_configured_number() -> None:
    """The button and the printed number must both reach GRACE_PHONE_NUMBER."""
    body = client.get("/").text
    href = f'href="tel:{settings.grace_phone_number}"'
    check(href in body, f"no CTA dials the configured number ({href})")
    check(
        settings.grace_phone_display in body,
        f"the number is never shown as text ({settings.grace_phone_display})",
    )


def test_no_unrendered_placeholders() -> None:
    """A renamed setting would otherwise ship a literal {{GRACE_PHONE}}."""
    body = client.get("/").text
    check("{{" not in body, "an unsubstituted {{...}} placeholder reached the page")


def test_no_dead_contact_flow() -> None:
    """The faked outbound flow is gone — nothing should promise a call back.

    Its markup and JS were removed; these ids surviving would mean a CTA still
    opens a sheet whose submit handler no longer exists.
    """
    body = client.get("/").text
    for gone in ('id="sheetRoot"', 'data-mode=', 'GRACE_SIMULATE_FAILURE', 'id="consent"'):
        check(gone not in body, f"dead outbound-contact markup survives: {gone}")


def test_footer_does_not_claim_calls_are_simulated() -> None:
    """The CTA dials a live number — the demo disclaimer must not deny that.

    The page arrived from the other track saying "no real calls are placed",
    which was true of its faked outbound flow and is now a lie.
    """
    body = client.get("/").text
    for lie in ("no real calls are placed", "requests on this page are simulated"):
        check(lie not in body, f"footer still claims calls are fake: {lie!r}")


def test_display_number_formatting() -> None:
    """US numbers are prettied; anything else passes through untouched."""
    from app.config import Settings

    check(
        Settings(grace_phone_number="+16507725745").grace_phone_display
        == "+1 (650) 772-5745",
        "US E.164 not formatted for display",
    )
    for odd in ("+442071838750", "not-a-number", ""):
        check(
            Settings(grace_phone_number=odd).grace_phone_display == odd,
            f"non-US number {odd!r} was mangled instead of passed through",
        )


def main() -> int:
    test_landing_is_served_at_root()
    test_landing_is_self_contained()
    test_landing_does_not_shadow_the_api()
    test_cta_dials_the_configured_number()
    test_no_unrendered_placeholders()
    test_no_dead_contact_flow()
    test_footer_does_not_claim_calls_are_simulated()
    test_display_number_formatting()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: landing page is served at /, self-contained, and shadows no API route")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
