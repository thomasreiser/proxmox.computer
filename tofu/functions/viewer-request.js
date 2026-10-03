// CloudFront Function (cloudfront-js-2.0), viewer request.
//
// The static export writes every route as <route>/index.html and links to
// it as "/setup/". Behind origin access control, S3's index-document rule
// doesn't apply, so a request for "/setup/" would ask S3 for the key
// "setup/" and get a 403. This maps it to the file that exists:
//
//   /                 → /index.html
//   /setup/           → /setup/index.html
//   /setup            → 301 to /setup/ (one canonical url per page)
//   /_next/static/x.js, /favicon.ico → unchanged (the last segment has a dot)

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
    return request;
  }

  var last = uri.substring(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") !== -1) return request;

  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: { location: { value: uri + "/" + queryString(request.querystring) } },
  };
}

// event.request.querystring is { name: { value, multiValue? } }; rebuilt so
// the redirect keeps it. Values arrive url-encoded and stay that way.
function queryString(querystring) {
  var parts = [];
  for (var name in querystring) {
    var entry = querystring[name];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === "" ? name : name + "=" + values[i].value);
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}
