declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const requiredBaseFields = ["service_type", "full_name", "email", "contact"];
const requiredAirportFields = ["flight", "datetime", "pickup", "dropoff"];
const requiredCharterFields = ["charter_date", "hours", "areas"];
const allowedServiceTypes = new Set(["dropoff", "pickup", "charter"]);

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const isBlank = (value: string | null) =>
  typeof value !== "string" || value.trim().length === 0;

const missingFields = (formData: URLSearchParams, fields: string[]) =>
  fields.filter((field) => isBlank(formData.get(field)));

const hasValidEmail = (value: string | null) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export default async (request: Request) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const makeUrl = Netlify.env.get("MAKE_WEBHOOK_URL");
  if (!makeUrl) {
    return json({ error: "Server Error: Webhook URL not set." }, 500);
  }

  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return json({ error: "Missing form data." }, 400);
  }

  const formData = new URLSearchParams(rawBody);
  const serviceType = formData.get("service_type");

  if (!serviceType || !allowedServiceTypes.has(serviceType)) {
    return json({ error: "Invalid service type." }, 400);
  }

  const requiredFields = [
    ...requiredBaseFields,
    ...(serviceType === "charter" ? requiredCharterFields : requiredAirportFields),
  ];
  const missing = missingFields(formData, requiredFields);

  if (missing.length > 0) {
    return json({ error: "Missing required fields.", missing }, 400);
  }

  if (!hasValidEmail(formData.get("email"))) {
    return json({ error: "Invalid email address." }, 400);
  }

  const passengerCount = formData.get("passengers");
  const luggageCount = formData.get("luggage");

  if (passengerCount && Number(passengerCount) < 1) {
    return json({ error: "Passenger count must be at least 1." }, 400);
  }

  if (luggageCount && Number(luggageCount) < 0) {
    return json({ error: "Luggage count cannot be negative." }, 400);
  }

  const response = await fetch(makeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
  });

  if (!response.ok) {
    return json({ error: "Error from Make." }, response.status);
  }

  return json({ ok: true });
};
