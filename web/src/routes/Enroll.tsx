import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Info, ShieldCheck, TriangleAlert, ArrowRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Badge } from "../components/ui/badge";
import { disclosure } from "../lib/config";
import { isValidE164, maskPhone } from "../lib/utils";
import { api, ApiError, isApiConfigured } from "../lib/api";
import type { EnrollResponse } from "../types";

export default function Enroll() {
  const navigate = useNavigate();

  const [phone, setPhone] = useState("+1");
  const [smsConsent, setSmsConsent] = useState(false);
  const [processingConsent, setProcessingConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResponse | null>(null);

  const phoneValid = isValidE164(phone);
  const consentComplete = smsConsent && processingConsent;
  const canSubmit = phoneValid && consentComplete && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const res = await api.enroll({
        phone_e164: phone.trim(),
        scope: "demo_sms_and_ai_voice",
        disclosure_version: disclosure.disclosure_version,
        sms_opt_in: true,
        ai_voice_opt_in: true,
        transcription_opt_in: true,
        marketing_opt_in: false,
      });
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError) {
        // §4.1 allowlist: the backend rejects non-allowlisted numbers.
        if (err.status === 403 || /allowlist|allowed/i.test(err.message)) {
          setError(
            "This number is not in the demo allowlist. Grace never cold-texts or cold-calls; enroll only a pre-consented, allowlisted team number."
          );
        } else {
          setError(err.message);
        }
      } else {
        setError("Unexpected error. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="mx-auto max-w-xl">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-grace-ok" />
              <CardTitle>Enrollment recorded</CardTitle>
            </div>
            <CardDescription>
              A preference SMS has been queued to the allowlisted number. Grace
              will ask whether to continue by <strong>TEXT</strong> or{" "}
              <strong>CALL</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-grace-muted">Masked phone</dt>
                <dd className="font-mono">{maskPhone(result.masked_phone)}</dd>
              </div>
              <div>
                <dt className="text-grace-muted">Case status</dt>
                <dd>
                  <Badge tone="accent">{result.status}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-grace-muted">Disclosure version</dt>
                <dd className="font-mono text-xs">
                  {disclosure.disclosure_version}
                </dd>
              </div>
              <div>
                <dt className="text-grace-muted">Preferred channel</dt>
                <dd>{result.preferred_channel}</dd>
              </div>
            </dl>

            {result.first_sms_preview && (
              <div className="rounded-md bg-grace-accentSoft p-3 text-sm">
                <div className="mb-1 text-xs font-semibold text-grace-accent">
                  First SMS preview
                </div>
                {result.first_sms_preview}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={() => navigate(`/case/${result.case_id}`)}>
                Open case dashboard
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setResult(null);
                  setSmsConsent(false);
                  setProcessingConsent(false);
                  setTouched(false);
                }}
              >
                Enroll another number
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="rounded-md border border-grace-border bg-grace-accentSoft/60 p-3 text-sm text-grace-accent flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          This is a <strong>synthetic hackathon demo</strong>. Grace does not
          cold-text or cold-call. A team member enrolls a pre-consented,
          allowlisted U.S. number below. All case details are fabricated.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Consent &amp; enrollment</CardTitle>
          <CardDescription>
            Disclosure version{" "}
            <span className="font-mono">{disclosure.disclosure_version}</span>.
            Both consents are required before Grace may contact the number.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="phone" className="text-sm font-medium">
                Allowlisted phone number (E.164)
              </label>
              <Input
                id="phone"
                inputMode="tel"
                placeholder="+14155550123"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && !phoneValid}
              />
              {touched && !phoneValid ? (
                <p className="text-xs text-grace-danger">
                  Enter a valid E.164 number, e.g. +14155550123. It must be in
                  the demo allowlist.
                </p>
              ) : (
                <p className="text-xs text-grace-muted">
                  Must be a pre-consented number in the demo allowlist.
                </p>
              )}
            </div>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">
                Required consents
              </legend>

              <label className="flex cursor-pointer gap-3 rounded-md border border-grace-border p-3 text-sm">
                <Checkbox
                  checked={smsConsent}
                  onCheckedChange={setSmsConsent}
                />
                <span>
                  I consent to receive <strong>automated SMS messages</strong>{" "}
                  and <strong>AI voice calls</strong> from Grace for this demo.
                </span>
              </label>

              <label className="flex cursor-pointer gap-3 rounded-md border border-grace-border p-3 text-sm">
                <Checkbox
                  checked={processingConsent}
                  onCheckedChange={setProcessingConsent}
                />
                <span>
                  I consent to <strong>transcription and processing</strong> of
                  these messages and calls by Grace, Twilio, ElevenLabs, OpenAI,
                  and the hackathon team.
                </span>
              </label>

              {touched && !consentComplete && (
                <p className="text-xs text-grace-danger">
                  Both consent boxes are required.
                </p>
              )}
            </fieldset>

            <p className="text-xs text-grace-muted">
              Marketing opt-in is <strong>off</strong> and not collected. You can
              revoke at any time by replying STOP by SMS or cancelling in the
              console. Only a masked form of the number is displayed after
              enrollment (§9.7).
            </p>

            {!isApiConfigured() && (
              <div className="flex gap-2 rounded-md border border-grace-border bg-grace-bg p-3 text-xs text-grace-muted">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-grace-warn" />
                <span>
                  <code>VITE_APP_BASE_URL</code> is not set. Copy{" "}
                  <code>.env.example</code> to <code>.env</code> and point it at
                  your Grace Edge Functions to enable enrollment.
                </span>
              </div>
            )}

            {error && (
              <div className="flex gap-2 rounded-md border border-grace-danger/40 bg-grace-dangerSoft p-3 text-sm text-grace-danger">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
              {submitting ? "Enrolling…" : "Record consent & send preference SMS"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
