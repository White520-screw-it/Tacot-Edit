/*
 * editor.tacot.org -> Tacot Edit static editor, download origin, or installer storage.
 * The installer route and fallback pass-through preserve the existing behavior.
 */

const SITE = "https://tacot-edit-download-k7r7io.freebuff.site";
const INSTALLER_PATTERN = /^\/download\/TacotEdit-Setup-[0-9][0-9.]*\.exe$/;

function chunkKey(prefix, index) {
  return `${prefix}/part${String(index).padStart(2, "0")}`;
}

async function installer(request, env, url) {
  if (!env.DOWNLOADS) return new Response("installer storage is not configured", { status: 503 });
  const index = await env.DOWNLOADS.get("setup/index", { type: "json" });
  if (!index) return new Response("this build is not published yet", { status: 404 });
  const requested = url.pathname.split("/").pop();
  if (requested !== index.file) return Response.redirect(`${url.origin}/download/${index.file}`, 302);
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(index.bytes),
    "content-disposition": `attachment; filename="${index.file}"`,
    "cache-control": "public, max-age=3600",
    "x-installer-sha256": index.sha256,
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  let next = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (next >= index.parts) return controller.close();
      const part = await env.DOWNLOADS.get(chunkKey(index.prefix || "setup", next), { type: "arrayBuffer", cacheTtl: 86400 });
      if (!part) return controller.error(new Error(`installer chunk ${next} is missing`));
      controller.enqueue(new Uint8Array(part)); next += 1;
    },
  });
  return new Response(body, { status: 200, headers });
}

async function browserEditor(request, env, incoming) {
  if (incoming.pathname === "/editor") {
    const target = new URL(incoming);
    target.pathname = "/editor/";
    return Response.redirect(target, 308);
  }
  if (!env.ASSETS) return new Response("browser editor assets are not configured", { status: 503 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  // The editor is static and local-first. Do not pass site cookies or credentials into its asset handler.
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  const assetMethod = request.method === "HEAD" ? "GET" : request.method;
  const assetRequest = new Request(incoming, { method: assetMethod, headers, redirect: "manual" });
  const response = await env.ASSETS.fetch(assetRequest);
  const out = new Headers(response.headers);
  out.set("X-Content-Type-Options", "nosniff");
  out.set("Referrer-Policy", "strict-origin-when-cross-origin");
  out.set("Cache-Control", "no-cache");
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers: out });
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (INSTALLER_PATTERN.test(incoming.pathname)) return installer(request, env, incoming);
    if (incoming.pathname === "/editor" || incoming.pathname.startsWith("/editor/")) return browserEditor(request, env, incoming);

    const target = new URL(SITE);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = new Headers(request.headers);
    headers.delete("host"); headers.delete("cf-ray"); headers.delete("cf-visitor"); headers.delete("content-length");
    const visitorIp = request.headers.get("cf-connecting-ip");
    if (visitorIp) headers.set("x-forwarded-for", visitorIp);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
    const out = new Headers(response.headers);
    out.delete("content-encoding"); out.delete("content-length");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
  },
};
