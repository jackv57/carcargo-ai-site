import { createHash } from "node:crypto";

declare const Netlify: {
  env: { get(name: string): string | undefined };
};

const requiredBaseFields = ["service_type", "full_name", "email", "contact", "contact_preference"];
const requiredAirportFields = ["flight", "datetime", "pickup", "dropoff"];
const requiredCharterFields = ["charter_date", "hours", "areas"];
const allowedServiceTypes = new Set(["dropoff", "pickup", "charter"]);
const allowedContactMethods = new Set(["line", "whatsapp", "email", "phone"]);
const inFlight = new Map<string, { payload: string; result: Promise<Response> }>();

const json = (body: Record<string, unknown>, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function validPhone(value: string) {
  return /^\+?[0-9][0-9 ().-]*$/.test(value) && /^\+?\d{7,15}$/.test(value.replace(/[ ().-]/g, ""));
}

async function sendToMake(url: string, payload: string, requestId: string) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });

    if (![200, 201, 202, 409].includes(response.status) ||
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "delivery_unknown" }, 502);
    }
    const receipt = await response.json();
    const code = response.status;
    if (receipt?.request_id !== requestId || receipt.code !== code) {
      return json({ error: "delivery_unknown" }, 502);
    }
    if ((code === 200 || code === 201) && receipt.status === "recorded" &&
        (receipt.order_id === `CCG-${requestId}` || receipt.order_id === `TCCG-${requestId}`)) {
      return json({ code, status: "recorded", request_id: requestId, order_id: receipt.order_id }, code);
    }
    if (receipt.order_id === "" && ((code === 202 && receipt.status === "processing") ||
        (code === 409 && receipt.status === "conflict"))) {
      return json({ code, status: receipt.status, request_id: requestId, order_id: "" }, code);
    }
    return json({ error: "delivery_unknown" }, 502);
  } catch {
    return json({ error: "delivery_unknown" }, 502);
  }
}

export default async (request: Request, context?: { deploy?: { context?: string } }) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const deployContext = context?.deploy?.context;
  const preview = deployContext === "deploy-preview";
  if (!preview && deployContext !== "production") return json({ error: "booking_unavailable" }, 503);

  if (!preview && Netlify.env.get("BOOKING_PRODUCTION_ENABLED") !== "true") {
    return json({ error: "booking_unavailable" }, 503);
  }

  let incoming: Record<string, unknown>;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "invalid_fields" }, 415);
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 16_384) return json({ error: "payload_too_large" }, 413);
    incoming = JSON.parse(body);
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return json({ error: "invalid_fields" }, 400);
    }
  } catch {
    return json({ error: "invalid_fields" }, 400);
  }

  const requestId = incoming.request_id;
  const serviceType = typeof incoming.service_type === "string" ? incoming.service_type.trim() : "";
  if (typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) ||
      !allowedServiceTypes.has(serviceType)) {
    return json({ error: "invalid_fields" }, 400);
  }

  const required = [
    ...requiredBaseFields,
    ...(serviceType === "charter" ? requiredCharterFields : requiredAirportFields),
  ];
  const form = new URLSearchParams();
  for (const key of [...required, "whatsapp", "passengers", "luggage", "notes"]) {
    const value = incoming[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return json({ error: "invalid_fields" }, 400);
    const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").trim();
    if (normalized) form.set(key, normalized);
  }

  const missing = required.filter((key) => !form.has(key));
  if (missing.length) return json({ error: "invalid_fields", missing }, 400);
  if (serviceType === "charter") {
    const areas = form.get("areas");
    const notes = form.get("notes");
    form.set("notes", "Planned areas: " + areas + (notes ? "\n\n" + notes : ""));
    form.delete("areas");
  }

  const whatsapp = form.get("whatsapp");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.get("email") ?? "") ||
      !validPhone(form.get("contact") ?? "") ||
      (whatsapp && !validPhone(whatsapp)) ||
      !allowedContactMethods.has(form.get("contact_preference") ?? "")) {
    return json({ error: "invalid_fields" }, 400);
  }
  for (const [key, min] of [["passengers", 1], ["luggage", 0]] as const) {
    const value = form.get(key);
    if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min)) {
      return json({ error: "invalid_fields" }, 400);
    }
  }

  const url = Netlify.env.get(preview ? "MAKE_PREVIEW_WEBHOOK_URL" : "MAKE_WEBHOOK_URL")?.trim();
  const pin = Netlify.env.get(preview ? "MAKE_PREVIEW_WEBHOOK_SHA256" : "MAKE_4066738_WEBHOOK_SHA256");
  // Require canonical Make host casing so the same receiver cannot have two URL digests.
  if (!url || !/^https:\/\/hook\.[a-z0-9-]+\.make\.com\/[A-Za-z0-9]+$/.test(url) ||
      createHash("sha256").update(url).digest("hex") !== pin) {
    return json({ error: "booking_unavailable" }, 503);
  }

  // The production digest is only a deny reference in Preview. Never read the production URL there.
  const otherPin = Netlify.env.get(preview ? "MAKE_4066738_WEBHOOK_SHA256" : "MAKE_PREVIEW_WEBHOOK_SHA256");
  if ((preview && !/^[a-f0-9]{64}$/.test(otherPin ?? "")) || pin === otherPin) {
    return json({ error: "booking_unavailable" }, 503);
  }

  form.sort();
  const requestFingerprint = createHash("sha256").update(form.toString(), "utf8").digest("hex");
  const payload = JSON.stringify({
    request_id: requestId,
    request_fingerprint: requestFingerprint,
    ...Object.fromEntries(form),
  });
  const inFlightKey = deployContext + ":" + requestId;
  let booking = inFlight.get(inFlightKey);
  if (booking && booking.payload !== payload) {
    return json({ code: 409, status: "conflict", request_id: requestId, order_id: "" }, 409);
  }
  if (!booking) {
    booking = {
      payload,
      result: sendToMake(url, payload, requestId).finally(() => inFlight.delete(inFlightKey)),
    };
    inFlight.set(inFlightKey, booking);
  }
  return (await booking.result).clone();
};
