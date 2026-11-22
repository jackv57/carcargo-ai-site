import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublic } from "../scripts/build-public.mjs";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext, runInThisContext } from "node:vm";

const id = "b02f5770-057f-4d31-8b73-a2a3d2ece8e8";
const sample = {
  request_id: id, service_type: "pickup", full_name: "Café Rider",
  contact: "+886 912 345 678", email: "mock@example.test", whatsapp: "+1 202 555 0100",
  contact_preference: "whatsapp", flight: "ZZ123", datetime: "2030-01-01T10:00",
  pickup: "Mock Airport", dropoff: "Mock Hotel", passengers: "2", luggage: "0", notes: "A\nB",
};
const previewUrl = "https://" + "hook.us2.make.com" + "/" + "mockPreview";
const order = "TCCG-" + id;
const url = "https://" + "hook.us2.make.com" + "/" + "mockOnly";
const receipt = (code, status, orderId = "", requestId = id) =>
  Response.json({ code, status, order_id: orderId, request_id: requestId }, { status: code });

export async function runTests(root = new URL("../", import.meta.url)) {
  const file = name => readFile(new URL(name, root), "utf8");
  const source = stripTypeScriptTypes(await file("netlify/functions/submit.mts"));
  const build = runInThisContext("(createHash, Netlify, fetch, AbortSignal) => {" +
    source.replace(/^import[^\n]+\n/, "").replace("export default", "return") + "}");
  const markup = await file("index.html");
  const client = markup.match(/<script>([\s\S]*?)<\/script>/)[1];
  const tests = [];
  const test = (name, fn) => tests.push([name, fn]);

  function server(upstream = () => receipt(201, "recorded", order), pin = true) {
    const calls = [];
    const targets = [];
    const envReads = [];
    const values = { MAKE_WEBHOOK_URL: url, BOOKING_PRODUCTION_ENABLED: "true" };
    if (pin) values.MAKE_4066738_WEBHOOK_SHA256 = createHash("sha256").update(url).digest("hex");
    const submit = build(createHash, { env: { get: name => { envReads.push(name); return values[name]; } } }, (target, options) => {
      assert.ok([url, previewUrl].includes(target));
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.redirect, "error");
      const data = JSON.parse(options.body);
      calls.push(data);
      targets.push(target);
      return upstream(data, options);
    }, { timeout: ms => { assert.equal(ms, 12_000); return AbortSignal.timeout(10); } });
    return { calls, targets, values, envReads, send: (data = sample, context = { deploy: { context: "production" } }) => submit(new Request("http://localhost/submit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }), context) };
  }

  test("pin is required and mismatches fail closed", async () => {
    const s = server(undefined, false);
    assert.equal((await s.send()).status, 503);
    s.values.MAKE_4066738_WEBHOOK_SHA256 = "invalid";
    assert.equal((await s.send()).status, 503);
    assert.equal(s.calls.length, 0);
  });
  test("preview without isolated configuration never forwards to production", async () => {
    const s = server();
    const preview = { deploy: { context: "deploy-preview" } };
    assert.equal((await s.send(sample, preview)).status, 503);
    s.values.MAKE_PREVIEW_WEBHOOK_URL = url;
    s.values.MAKE_PREVIEW_WEBHOOK_SHA256 = s.values.MAKE_4066738_WEBHOOK_SHA256;
    assert.equal((await s.send(sample, preview)).status, 503);
    assert.equal(s.calls.length, 0);
    assert.equal(s.envReads.includes("MAKE_WEBHOOK_URL"), false);
  });
  test("preview uses only its verified test receiver", async () => {
    const s = server();
    s.values.MAKE_PREVIEW_WEBHOOK_URL = previewUrl;
    s.values.MAKE_PREVIEW_WEBHOOK_SHA256 = createHash("sha256").update(previewUrl).digest("hex");
    assert.equal((await s.send(sample, { deploy: { context: "deploy-preview" } })).status, 201);
    assert.equal(s.calls.length, 1);
    assert.equal(s.targets[0], previewUrl);
    assert.equal(s.envReads.includes("MAKE_WEBHOOK_URL"), false);
  });
  test("preview rejects missing or mismatched pins and same receiver without a production URL", async () => {
    const preview = { deploy: { context: "deploy-preview" } };
    const s = server();
    delete s.values.MAKE_WEBHOOK_URL;
    s.values.MAKE_PREVIEW_WEBHOOK_URL = previewUrl;
    assert.equal((await s.send(sample, preview)).status, 503);
    s.values.MAKE_PREVIEW_WEBHOOK_SHA256 = s.values.MAKE_4066738_WEBHOOK_SHA256;
    assert.equal((await s.send(sample, preview)).status, 503);
    s.values.MAKE_PREVIEW_WEBHOOK_URL = url;
    assert.equal((await s.send(sample, preview)).status, 503);
    delete s.values.MAKE_4066738_WEBHOOK_SHA256;
    assert.equal((await s.send(sample, preview)).status, 503);
    assert.equal(s.targets.length, 0);
    assert.equal(s.envReads.includes("MAKE_WEBHOOK_URL"), false);
  });
  test("production only routes to production and rejects an observable crossed receiver", async () => {
    const s = server();
    const previewPin = createHash("sha256").update(previewUrl).digest("hex");
    s.values.MAKE_PREVIEW_WEBHOOK_URL = previewUrl;
    s.values.MAKE_PREVIEW_WEBHOOK_SHA256 = previewPin;
    assert.equal((await s.send()).status, 201);
    delete s.values.MAKE_WEBHOOK_URL;
    assert.equal((await s.send()).status, 503);
    s.values.MAKE_WEBHOOK_URL = previewUrl;
    assert.equal((await s.send()).status, 503);
    s.values.MAKE_4066738_WEBHOOK_SHA256 = previewPin;
    assert.equal((await s.send()).status, 503);
    assert.deepEqual(s.targets, [url]);
    assert.equal(s.envReads.includes("MAKE_PREVIEW_WEBHOOK_URL"), false);
  });
  test("unknown, branch and local deploy contexts stop before sending", async () => {
    const s = server();
    s.values.CONTEXT = "production";
    for (const context of [{}, { deploy: { context: "branch-deploy" } }, { deploy: { context: "dev" } }]) {
      assert.equal((await s.send(sample, context)).status, 503);
    }
    assert.equal(s.calls.length, 0);
  });
  test("production stays closed until explicitly enabled", async () => {
    const s = server();
    delete s.values.BOOKING_PRODUCTION_ENABLED;
    assert.equal((await s.send()).status, 503);
    assert.equal(s.targets.length, 0);
    assert.equal(s.envReads.includes("MAKE_WEBHOOK_URL"), false);
  });
  test("validates required fields, enums and string types", async () => {
    const s = server();
    for (const patch of [{ whatsapp: 123 }, { email: "bad" }, { contact: "123" }, { luggage: "-1" },
      { contact_preference: "" }, { notes: [] }, { passengers: 2 }, { flight: "" }, { service_type: "invalid" }]) {
      assert.equal((await s.send({ ...sample, ...patch })).status, 400);
    }
    assert.equal(s.calls.length, 0);
  });
  test("JSON mapping and canonical SHA-256 vector", async () => {
    const s = server();
    await s.send({ ...sample, request_fingerprint: "ignored", extra: "ignored" });
    await s.send({ ...Object.fromEntries(Object.entries(sample).reverse()), full_name: " Cafe\u0301 Rider ", notes: " A\r\nB " });
    const canonical = "contact=%2B886+912+345+678&contact_preference=whatsapp&datetime=2030-01-01T10%3A00&dropoff=Mock+Hotel&email=mock%40example.test&flight=ZZ123&full_name=Caf%C3%A9+Rider&luggage=0&notes=A%0AB&passengers=2&pickup=Mock+Airport&service_type=pickup&whatsapp=%2B1+202+555+0100";
    const expected = createHash("sha256").update(canonical).digest("hex");
    assert.equal(expected, "ebbbaa4c1299c07934a7f261e7f20024a93dafa740fb167beb366ddb288dd79b");
    assert.equal(s.calls[0].request_fingerprint, expected);
    assert.equal(s.calls[1].request_fingerprint, expected);
    assert.equal(Object.keys(s.calls[0]).length, 15);
    assert.equal("extra" in s.calls[0], false);
    await s.send({ ...sample, notes: "Changed" });
    assert.notEqual(s.calls[2].request_fingerprint, expected);
  });
  test("airport variants and charter preserve their own fields", async () => {
    const s = server();
    await s.send({ ...sample, service_type: "dropoff" });
    await s.send({ ...sample, service_type: "charter", charter_date: "2030-01-01", hours: "4", areas: "Mock City", whatsapp: "" });
    assert.equal(s.calls[0].service_type, "dropoff");
    assert.equal(s.calls[1].notes, "Planned areas: Mock City\n\nA\nB");
    for (const key of ["areas", "flight", "whatsapp"]) assert.equal(key in s.calls[1], false);
  });
  for (const [code, status, number] of [[201, "recorded", order], [200, "recorded", order],
    [202, "processing", ""], [409, "conflict", ""]]) {
    test(`preserves Make receipt ${code} ${status}`, async () => {
      const result = await server(() => receipt(code, status, number)).send();
      assert.equal(result.status, code);
      assert.equal(JSON.stringify(await result.json()), JSON.stringify({ code, status, request_id: id, order_id: number }));
    });
  }
  test("rejects malformed, mismatched and unconfirmed receipts", async () => {
    for (const result of [
      () => new Response("Accepted"),
      () => new Response("{", { headers: { "Content-Type": "application/json" } }),
      () => receipt(201, "recorded", order, "wrong"),
      () => receipt(202, "processing", order),
      () => receipt(409, "conflict", "", "wrong"),
      () => receipt(201, "recorded", "TCCG-wrong"),
      () => Response.json({ code: 200, status: "recorded", order_id: order, request_id: id }, { status: 201 }),
      () => new Response(null, { status: 500 }),
    ]) assert.equal((await server(result).send()).status, 502);
  });
  test("timeout is uncertain and retry keeps the same fingerprint and ID", async () => {
    let first = true;
    const s = server((data, { signal }) => {
      if (!first) return receipt(200, "recorded", order);
      first = false;
      return new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("signal did not abort")), 500);
        signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
      });
    });
    const pending = await s.send();
    assert.equal(pending.status, 502);
    assert.equal((await pending.json()).error, "delivery_unknown");
    assert.equal((await s.send()).status, 200);
    assert.equal(JSON.stringify(s.calls[0]), JSON.stringify(s.calls[1]));
  });
  test("parallel duplicate merges and conflicting payload never forwards", async () => {
    const s = server(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return receipt(201, "recorded", order);
    });
    const results = await Promise.all([s.send(), s.send({ ...sample, notes: "changed" }), s.send()]);
    assert.equal(s.calls.length, 1);
    assert.equal(results[0].status, 201);
    assert.equal(results[1].status, 409);
    assert.equal((await results[1].json()).status, "conflict");
    assert.equal(results[2].status, 201);
  });

  function page(storage = new Map(), reply, draft = sample) {
    function element() {
      return { dataset: {}, style: {}, listeners: {}, classList: { add() {}, remove() {} },
        addEventListener(name, fn) { this.listeners[name] = fn; }, querySelectorAll() { return []; }, focus() {} };
    }
    const elements = new Map();
    const get = name => {
      if (!elements.has(name)) elements.set(name, element());
      return elements.get(name);
    };
    get("service_type_hidden").value = draft.service_type;
    get("charter-fields").querySelector = () => element();
    get("booking-form").querySelector = () => get("button");
    get("booking-number").querySelector = () => get("number");
    get("booking-mail").href = "mailto:mock@example.test";
    get("success-message").hidden = true;
    const calls = [];
    const { request_id, ...formData } = draft;
    const clipboard = [];
    const context = createContext({
      document: { getElementById: get, querySelector: () => element(), querySelectorAll: () => [], documentElement: {} },
      navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
      window: element(), crypto: webcrypto, TextEncoder, Uint8Array, URLSearchParams, AbortSignal,
      FormData: class { constructor() { return Object.entries(formData); } },
      sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
      fetch: (target, options) => {
        assert.equal(target, "/.netlify/functions/submit");
        assert.equal(options.headers["Content-Type"], "application/json");
        calls.push(JSON.parse(options.body));
        return reply(calls.at(-1));
      },
    });
    runInContext(client, context);
    return { get, calls, clipboard, submit: () => get("booking-form").listeners.submit({ preventDefault() {} }), context };
  }

  test("native form fallback cannot put booking details in a URL", () => {
    assert.match(markup, /<form id="booking-form" method="post" action="\/\.netlify\/functions\/submit">/);
    assert.match(markup, /<meta name="referrer" content="no-referrer"/);
  });
  test("front end supports four locale strings and phone copy", () => {
    const p = page();
    for (const [lang, tag] of Object.entries({ zh: "zh-TW", en: "en", jp: "ja", kr: "ko" })) {
      assert.equal(runInContext(`setLang("${lang}"); document.documentElement.lang`, p.context), tag);
      assert.ok(runInContext(`T.${lang}.request_conflict && T.${lang}.succ_retry && T.${lang}.retry_blocked && T.${lang}.succ_pending_title !== T.${lang}.succ_title`, p.context));
    }
    p.get("booking-contact").value = sample.contact;
    p.get("same-contact").checked = true;
    p.get("same-contact").listeners.change();
    assert.equal(p.get("booking-whatsapp").value, sample.contact);
  });
  test("front end shows the same confirmed number for 201 and 200 after reload", async () => {
    const storage = new Map();
    let number;
    for (const code of [201, 200]) {
      const p = page(storage, data => receipt(code, "recorded", "CCG-" + data.request_id, data.request_id));
      await p.submit();
      number ||= p.get("number").textContent;
      assert.equal(p.get("number").textContent, number);
      assert.equal(p.get("booking-processing").hidden, true);
      assert.equal(p.get("booking-result-title").dataset.i18n, "succ_title");
    }
  });
  test("front end 202 allows same-data retry and hides the order number", async () => {
    const p = page(new Map(), data => receipt(202, "processing", "", data.request_id));
    await p.submit();
    assert.equal(p.get("booking-number").hidden, true);
    assert.equal(p.get("booking-processing").hidden, false);
    assert.equal(p.get("booking-result-title").dataset.i18n, "succ_pending_title");
    assert.equal(p.get("reference-value").textContent, p.calls[0].request_id);
    assert.equal(p.get("booking-reference").hidden, false);
    p.get("booking-retry").listeners.click();
    await p.submit();
    assert.equal(p.calls[0].request_id, p.calls[1].request_id);
  });
  test("front end conflict is explicit and changed draft does not create a new request", async () => {
    const storage = new Map();
    const p = page(storage, data => receipt(409, "conflict", "", data.request_id));
    await p.submit();
    assert.equal(p.get("booking-error").dataset.i18n, "request_conflict");
    assert.equal(p.get("reference-value").textContent, p.calls[0].request_id);
    const changed = page(storage, null, { ...sample, notes: "changed" });
    await changed.submit();
    assert.equal(changed.get("booking-error").dataset.i18n, "retry_blocked");
    assert.equal(changed.calls.length, 0);
  });
  test("front end survives a timeout and reload without a second UUID", async () => {
    const storage = new Map();
    const first = page(storage, () => { throw Error("mock network failure"); });
    await first.submit();
    assert.equal(first.get("booking-error").dataset.i18n, "delivery_unknown");
    assert.equal(first.get("reference-value").textContent, first.calls[0].request_id);
    const next = page(storage, data => receipt(200, "recorded", "CCG-" + data.request_id, data.request_id));
    assert.equal(next.get("reference-value").textContent, first.calls[0].request_id);
    await next.submit();
    assert.equal(first.calls[0].request_id, next.calls[0].request_id);
  });
  test("front end rejects a mismatched receipt and does not send if storage fails", async () => {
    const p = page(new Map(), () => receipt(201, "recorded", order, "wrong"));
    await p.submit();
    assert.equal(p.get("success-message").hidden, true);
    assert.equal(p.get("booking-error").dataset.i18n, "delivery_unknown");
    const blocked = page({ get() { throw Error("storage disabled"); } }, null);
    await blocked.submit();
    assert.equal(blocked.calls.length, 0);
    assert.equal(blocked.get("booking-error").dataset.i18n, "retry_storage");
  });

  test("exception reference can be copied without adding booking details to contact URLs", async () => {
    const p = page(new Map(), data => receipt(409, "conflict", "", data.request_id));
    await p.submit();
    await p.get("copy-reference").listeners.click();
    assert.deepEqual(p.clipboard, [p.calls[0].request_id]);
    assert.match(markup, /href="mailto:support@carcargo-ai\.com"/);
    const contactLinks = [...markup.matchAll(/href="((?:mailto:|https:\/\/lin\.ee)[^"]+)"/g)];
    assert.ok(contactLinks.every(([, url]) => !url.includes("?")));
    assert.doesNotMatch(client, /\.href\s*=/);
  });

  test("static build publishes only public paths and rejects stray output", async () => {
    const target = await mkdtemp(join(tmpdir(), "ccg-public-test-"));
    try {
      await buildPublic(fileURLToPath(root), target);
      assert.equal((await readdir(target)).sort().join(","), "assets,index.html,llms.txt,robots.txt,sitemap.xml");
      await writeFile(join(target, "unexpected.private"), "");
      await assert.rejects(buildPublic(fileURLToPath(root), target), /Unexpected item/);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
  test("brand assets keep the entire 4:3 source and valid icon dimensions", async () => {
    for (const [name, width, height] of [["carcargo-logo-original", 1448, 1086],
      ["carcargo-logo", 256, 192], ["favicon", 48, 48], ["apple-touch-icon", 180, 180], ["carcargo-share", 1200, 630]]) {
      const png = await readFile(new URL("assets/" + name + ".png", root));
      assert.equal(png.toString("ascii", 12, 16), "IHDR");
      assert.equal(png.readUInt32BE(16), width);
      assert.equal(png.readUInt32BE(20), height);
    }
    assert.equal((markup.match(/src="assets\/carcargo-logo.png" width="256" height="192" alt="CAR CAR GO"/g) ?? []).length, 2);
    assert.match(markup, /\.brand-image \{[^}]*height: auto/);
  });
  const results = [];
  for (const [name, run] of tests) {
    await run();
    results.push(name);
  }
  return results;
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("/web-booking-v1.mjs")) {
  const passed = await runTests();
  console.log(passed.map(name => "PASS " + name).join("\n"));
  console.log(`${passed.length} passed`);
}
