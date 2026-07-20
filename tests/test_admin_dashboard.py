"""Guards on serving the built React dashboard under /admin.

The dashboard's router is rooted at "/" in dev, but "/" is the consumer landing
page, so it is served under /admin with a matching vite `base` and router
`basename`. Three things can break that quietly:

  1. Someone mounts StaticFiles at /admin instead of /admin/assets. The mount
     then answers every path under /admin itself, and a hard refresh on a
     client-side route like /admin/agents 404s.
  2. The SPA fallback is made greedy enough to swallow API routes.
  3. web/dist is missing (it is gitignored and shipped separately) and the app
     fails to start rather than just 404ing the dashboard.

Run: uv run python tests/test_admin_dashboard.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import WEB_DIST, app  # noqa: E402

settings.grace_phone_number = "+16505550123"

client = TestClient(app)
failures: list[str] = []
BUILT = (WEB_DIST / "index.html").is_file()


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def test_app_starts_without_a_build() -> None:
    """web/dist is gitignored — a missing build must not break the process."""
    check(client.get("/health").status_code == 200, "/health broke")
    check(client.get("/").status_code == 200, "landing page broke")


def test_client_side_routes_serve_the_shell() -> None:
    """A hard refresh on a react-router path must return index.html, not 404."""
    if not BUILT:
        print("SKIP: web/dist not built — run `npm run build` in web/")
        return
    for path in ("/admin", "/admin/agents", "/admin/case/case_123"):
        r = client.get(path)
        check(r.status_code == 200, f"{path} returned {r.status_code}, want 200")
        check(
            "<div id=\"root\">" in r.text or "root" in r.text,
            f"{path} did not return the SPA shell",
        )


def test_admin_does_not_shadow_the_api() -> None:
    """The /admin fallback must not swallow the routes the dashboard calls."""
    check(
        client.get("/agent-activity").status_code == 200,
        "/agent-activity stopped working",
    )
    r = client.get("/cases/does-not-exist")
    check(r.status_code == 404, f"/cases/<unknown> returned {r.status_code}")
    check("<html" not in r.text.lower(), "/cases/<unknown> served HTML")


def test_assets_are_served_with_the_admin_prefix() -> None:
    """vite `base` and the mount path have to agree, or the bundle 404s."""
    if not BUILT:
        return
    shell = client.get("/admin").text
    refs = [
        s.split('"')[0]
        for s in shell.split('src="')[1:] + shell.split('href="')[1:]
        if s.startswith("/admin/assets/")
    ]
    check(bool(refs), "index.html references no /admin/assets/* files — is vite base set?")
    for ref in refs:
        check(
            client.get(ref).status_code == 200,
            f"asset {ref} referenced by the shell is not served",
        )


def test_bundle_has_no_hardcoded_origin() -> None:
    """The bundle must call its own origin, not a dev or tunnel host.

    web/.env sets VITE_APP_BASE_URL for the Vite dev server. Building without
    clearing it bakes localhost into the deployed bundle, which then points at
    the *visitor's* machine and fails CORS.
    """
    if not BUILT:
        return
    for js in (WEB_DIST / "assets").glob("*.js"):
        body = js.read_text(encoding="utf-8", errors="ignore")
        for bad in ("localhost:8000", "ngrok-free.dev"):
            check(bad not in body, f"{js.name} has a hardcoded origin ({bad})")


def main() -> int:
    if not BUILT:
        print("note: web/dist absent — build-dependent checks skipped")
    test_app_starts_without_a_build()
    test_client_side_routes_serve_the_shell()
    test_admin_does_not_shadow_the_api()
    test_assets_are_served_with_the_admin_prefix()
    test_bundle_has_no_hardcoded_origin()

    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("PASS: /admin serves the SPA shell, assets resolve, API routes unshadowed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
