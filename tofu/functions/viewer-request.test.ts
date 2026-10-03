import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The function file is a plain CloudFront script, not a module: it's
// uploaded as-is, so it's evaluated here the same way, by source.
type Query = Record<string, { value: string; multiValue?: { value: string }[] }>;
type Request = { uri: string; querystring: Query };
type Redirect = { statusCode: number; headers: { location: { value: string } } };

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "viewer-request.js"), "utf8");
const handler = new Function(`${source}\nreturn handler;`)() as (event: { request: Request }) => Request | Redirect;

function run(uri: string, querystring: Query = {}) {
  return handler({ request: { uri, querystring } });
}

describe("viewer-request", () => {
  it("serves the root's index", () => {
    expect(run("/")).toMatchObject({ uri: "/index.html" });
  });

  it("serves a route's index for its trailing-slash url", () => {
    expect(run("/setup/")).toMatchObject({ uri: "/setup/index.html" });
    expect(run("/setup/preview/network/")).toMatchObject({ uri: "/setup/preview/network/index.html" });
  });

  it("passes files through unchanged", () => {
    for (const uri of ["/favicon.ico", "/404.html", "/_next/static/chunks/0jvhpaew_uadu.js", "/setup/__next._full.txt"]) {
      expect(run(uri)).toMatchObject({ uri });
    }
  });

  it("redirects a route without its trailing slash", () => {
    const response = run("/setup") as Redirect;
    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe("/setup/");
  });

  it("only looks for a dot in the last segment", () => {
    const response = run("/v1.2/setup") as Redirect;
    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe("/v1.2/setup/");
  });

  it("keeps the query string on a redirect", () => {
    const response = run("/setup", {
      step: { value: "network" },
      flag: { value: "" },
      tag: { value: "a", multiValue: [{ value: "a" }, { value: "b%20c" }] },
    }) as Redirect;
    expect(response.headers.location.value).toBe("/setup/?step=network&flag&tag=a&tag=b%20c");
  });

  it("leaves the query string on a rewritten request alone", () => {
    const querystring = { _rsc: { value: "abc" } };
    expect(run("/setup/", querystring)).toEqual({ uri: "/setup/index.html", querystring });
  });
});
